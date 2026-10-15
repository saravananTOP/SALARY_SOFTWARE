'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { createDatabase } = require('../db/database');

const COMPANY_SHEETS = [
    { sheetName: 'Employee Master - FA', companyId: 'flavors-india', staffType: 'active' },
    { sheetName: 'Employee Master - FR', companyId: 'flavors-india', staffType: 'retainer' },
    { sheetName: 'Employee Master - SA', companyId: 'supreme-aromatics', staffType: 'retainer' }
];

const COMPANIES = [
    { id: 'flavors-india', name: 'THE FLAVORS INDIA PVT LTD', shortName: 'The Flavors India' },
    { id: 'supreme-aromatics', name: 'THE SUPREME AROMATICS PVT LTD', shortName: 'The Supreme Aromatics' }
];

function normalizeHeader(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function headerIndex(headers, names, required = true) {
    const normalizedNames = names.map(normalizeHeader);
    const index = headers.findIndex((header) => {
        const normalized = normalizeHeader(header);
        return normalizedNames.some((name) => normalized === name || normalized.startsWith(name));
    });
    if (index < 0 && required) {
        throw new Error(`Required workbook column is missing: ${names[0]}.`);
    }
    return index;
}

function cellValue(row, index, label, required = false) {
    if (index < 0) return null;
    const value = row.getCell(index + 1).value;
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        if (Object.hasOwn(value, 'result')) return value.result;
        if (required) throw new Error(`A required ${label} cell has no saved value. Recalculate or correct the workbook before importing.`);
        return null;
    }
    if ((value === null || value === undefined || value === '') && required) {
        throw new Error(`A required ${label} cell is blank.`);
    }
    return value;
}

function textValue(value) {
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    if (typeof value === 'object' && value && Array.isArray(value.richText)) {
        return value.richText.map((item) => item.text).join('').trim();
    }
    return String(value ?? '').trim();
}

function numberValue(value, label, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0) throw new Error(`Invalid non-negative value in ${label}.`);
    return result;
}

function yesNo(value, label) {
    const normalized = textValue(value).toLowerCase();
    if (!normalized || ['n', 'no', 'false', '0'].includes(normalized)) return 'N';
    if (['y', 'yes', 'true', '1'].includes(normalized)) return 'Y';
    throw new Error(`Invalid yes/no value in ${label}.`);
}

function asIsoDate(value, label, optional = true) {
    if (value === null || value === undefined || value === '') {
        if (optional) return null;
        throw new Error(`${label} is required.`);
    }
    if (optional && typeof value === 'string'
        && ['-', 'n/a', 'na', 'not applicable'].includes(value.trim().toLowerCase())) {
        return null;
    }
    const dayFirst = typeof value === 'string'
        ? value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
        : null;
    const date = value instanceof Date
        ? value
        : (dayFirst
            ? new Date(Date.UTC(Number(dayFirst[3]), Number(dayFirst[2]) - 1, Number(dayFirst[1])))
            : new Date(value));
    if (Number.isNaN(date.valueOf())) throw new Error(`Invalid date in ${label}.`);
    return date.toISOString().slice(0, 10);
}

function periodValue(value) {
    if (value instanceof Date) return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}`;
    const text = textValue(value);
    const iso = text.match(/^(20\d{2})[-/](\d{1,2})/);
    if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, '0')}`;
    const named = text.match(/^([A-Za-z]+)\s+(20\d{2})$/);
    if (named) {
        const month = new Date(`${named[1]} 1, ${named[2]}`).getMonth() + 1;
        if (month > 0) return `${named[2]}-${String(month).padStart(2, '0')}`;
    }
    throw new Error('A payroll month in the workbook could not be recognized.');
}

function periodEnd(period) {
    const [year, month] = period.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

function monthLabel(period) {
    const [year, month] = period.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    }).toUpperCase();
}

function attendanceEmployeeIndex(headers) {
    return {
        employeeId: headerIndex(headers, ['EMP ID', 'Employee ID']),
        workDays: headerIndex(headers, ['WORK DAYS']),
        leaveDays: headerIndex(headers, ['LEAVE DAYS THIS MONTH']),
        longestContinuousSpell: headerIndex(headers, ['LONGEST CONTINUOUS SPELL']),
        processAllowance: headerIndex(headers, ['PROCESS ALLOWANCE']),
        punctualIncentive: headerIndex(headers, ['PUNCTUAL INCENTIVE']),
        fullAttendanceBonus: headerIndex(headers, ['FULL ATT BONUS'])
    };
}

function parseOpeningBalances(filename, employeeIds) {
    if (!filename) {
        throw new Error('Provide validated opening balances with --opening-balances <csv>. Required columns: employeeId,elBalance,clBalance.');
    }
    const lines = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
    if (lines.length < 2) throw new Error('The opening-balances CSV must include a header and one row per employee.');
    const headers = lines[0].split(',').map((value) => value.trim());
    const indices = {
        employeeId: headerIndex(headers, ['employeeId', 'EMP ID']),
        elBalance: headerIndex(headers, ['elBalance', 'EL BALANCE']),
        clBalance: headerIndex(headers, ['clBalance', 'CL BALANCE'])
    };
    const balances = new Map();
    lines.slice(1).forEach((line) => {
        const fields = line.split(',').map((value) => value.trim());
        const id = fields[indices.employeeId];
        if (!id || balances.has(id)) throw new Error('The opening-balances CSV contains a blank or duplicate employee ID.');
        balances.set(id, {
            elBalance: numberValue(fields[indices.elBalance], 'opening EL balance'),
            clBalance: numberValue(fields[indices.clBalance], 'opening CL balance')
        });
    });
    if (balances.size !== employeeIds.size || [...employeeIds].some((id) => !balances.has(id))) {
        throw new Error('The opening-balances CSV must contain exactly one row for every imported employee.');
    }
    return balances;
}

function employeeRow(sheet, group, row, headers, period) {
    const index = {
        id: headerIndex(headers, ['EMP ID']),
        name: headerIndex(headers, ['NAME']),
        title: headerIndex(headers, ['DESIGNATION', 'TITLE'], false),
        joiningDate: headerIndex(headers, ['DATE OF JOINING']),
        dateOfBirth: headerIndex(headers, ['DATE OF BIRTH', 'DOB'], false),
        mobile: headerIndex(headers, ['MOBILE NUMBER', 'MOBILE NO', 'MOBILE', 'PHONE'], false),
        aadhaar: headerIndex(headers, ['AADHAAR NUMBER', 'AADHAR NUMBER', 'AADHAAR NO', 'AADHAR NO', 'AADHAAR', 'AADHAR'], false),
        staffType: headerIndex(headers, ['STAFF TYPE'], false),
        pan: headerIndex(headers, ['PAN'], false),
        uan: headerIndex(headers, ['UAN NO', 'UAN'], false),
        bankAccount: headerIndex(headers, ['BANK A/C NO', 'BANK ACCOUNT NO'], false),
        basicSalary: headerIndex(headers, ['BASIC']),
        fixedAllowance: headerIndex(headers, ['FIXED ALLOWANCE']),
        perDayRate: headerIndex(headers, ['PER DAY RATE']),
        pfApplicable: headerIndex(headers, ['PF APPL', 'PF APPLICABLE']),
        esiExempt: headerIndex(headers, ['ESI EXEMPT']),
        healthInsurance: headerIndex(headers, ['HEALTH INSURANCE']),
        licDeduction: headerIndex(headers, ['LIC']),
        elEntitlement: headerIndex(headers, ['EL ENTITLEMENT']),
        clEntitlement: headerIndex(headers, ['CL ENTITLEMENT']),
        status: headerIndex(headers, ['STATUS']),
        effectiveDate: headerIndex(headers, ['EFFECTIVE DATE'], false),
        bankName: headerIndex(headers, ['BANK NAME'], false),
        esiCoverageStatus: headerIndex(headers, ['ESI COVERAGE STATUS'], false),
        esiStatusReviewed: headerIndex(headers, ['ESI STATUS LAST SET REVIEWED'], false)
    };
    const id = textValue(cellValue(row, index.id, 'employee ID', true));
    const name = textValue(cellValue(row, index.name, 'employee name', true));
    const staffText = textValue(cellValue(row, index.staffType, 'staff type')).toLowerCase();
    const staffType = staffText.includes('retainer')
        ? 'retainer'
        : (staffText.includes('active') ? 'active' : group.staffType);
    const joiningDate = asIsoDate(
        cellValue(row, index.joiningDate, 'date of joining'),
        'date of joining'
    );
    const effectiveDate = asIsoDate(
        cellValue(row, index.effectiveDate, 'effective date'),
        'effective date'
    );
    const rawStatus = textValue(cellValue(row, index.status, 'employee status', true)).toLowerCase();
    const inactiveStatus = ['inactive', 'terminated', 'resigned'].some((status) => rawStatus.includes(status));
    const status = inactiveStatus && (!effectiveDate || effectiveDate < `${period}-01`) ? 'inactive' : 'active';
    const rawBasicSalary = cellValue(row, index.basicSalary, 'basic salary');
    const rawElEntitlement = cellValue(row, index.elEntitlement, 'EL entitlement');
    const rawClEntitlement = cellValue(row, index.clEntitlement, 'CL entitlement');

    return {
        id,
        companyId: group.companyId,
        name,
        title: textValue(cellValue(row, index.title, 'designation')),
        staffType,
        joiningDate,
        dateOfBirth: asIsoDate(
            cellValue(row, index.dateOfBirth, 'date of birth'),
            'date of birth'
        ),
        mobile: textValue(cellValue(row, index.mobile, 'mobile number')),
        aadhaar: textValue(cellValue(row, index.aadhaar, 'Aadhaar number')),
        basicSalary: numberValue(rawBasicSalary, 'basic salary'),
        salaryDataMissing: rawBasicSalary === null || rawBasicSalary === undefined || rawBasicSalary === '' ? 1 : 0,
        fixedAllowance: numberValue(cellValue(row, index.fixedAllowance, 'fixed allowance'), 'fixed allowance'),
        perDayRate: numberValue(cellValue(row, index.perDayRate, 'per-day rate'), 'per-day rate'),
        pfApplicable: yesNo(cellValue(row, index.pfApplicable, 'PF applicable'), 'PF applicable') === 'Y' ? 1 : 0,
        esiExempt: yesNo(cellValue(row, index.esiExempt, 'ESI exempt'), 'ESI exempt') === 'Y' ? 1 : 0,
        healthInsurance: numberValue(cellValue(row, index.healthInsurance, 'health insurance'), 'health insurance'),
        licDeduction: numberValue(cellValue(row, index.licDeduction, 'LIC deduction'), 'LIC deduction'),
        elEntitlement: numberValue(rawElEntitlement, 'EL entitlement'),
        clEntitlement: numberValue(rawClEntitlement, 'CL entitlement'),
        leaveEntitlementsMissing: rawElEntitlement == null || rawClEntitlement == null
            || rawElEntitlement === '' || rawClEntitlement === '',
        status,
        effectiveDate,
        pan: textValue(cellValue(row, index.pan, 'PAN')),
        uan: textValue(cellValue(row, index.uan, 'UAN')),
        bankAccount: textValue(cellValue(row, index.bankAccount, 'bank account')),
        bankName: textValue(cellValue(row, index.bankName, 'bank name')),
        esiCoverageStatus: yesNo(cellValue(row, index.esiCoverageStatus, 'ESI coverage status'), 'ESI coverage status'),
        esiStatusReviewed: textValue(cellValue(row, index.esiStatusReviewed, 'ESI review date'))
    };
}

function settingValue(sheet, row, label, required = true) {
    const value = sheet.getRow(row).getCell(2).value;
    if (value === null || value === undefined || value === '') {
        if (required) throw new Error(`The payroll setting "${label}" is blank.`);
        return null;
    }
    return value;
}

function buildSettings(sheet) {
    const period = periodValue(settingValue(sheet, 4, 'Payroll Month'));
    const [year, month] = period.split('-').map(Number);
    const calendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const settings = {
        payroll_period: period,
        period_label: monthLabel(period),
        calendar_days: calendarDays,
        pf_wage_ceiling: 25000,
        pf_employee_rate: numberValue(settingValue(sheet, 9, 'PF Employee Rate'), 'PF Employee Rate'),
        eps_employer_rate: numberValue(settingValue(sheet, 10, 'EPS Employer Rate'), 'EPS Employer Rate'),
        eps_employer_cap: numberValue(settingValue(sheet, 11, 'EPS Employer Cap'), 'EPS Employer Cap'),
        esi_wage_ceiling: numberValue(settingValue(sheet, 12, 'ESI Wage Ceiling'), 'ESI Wage Ceiling'),
        esi_employee_rate: numberValue(settingValue(sheet, 13, 'ESI Employee Rate'), 'ESI Employee Rate'),
        esi_employer_rate: numberValue(settingValue(sheet, 14, 'ESI Employer Rate'), 'ESI Employer Rate'),
        default_el_entitlement: numberValue(settingValue(sheet, 15, 'EL Days / Year'), 'EL Days / Year'),
        default_cl_entitlement: numberValue(settingValue(sheet, 16, 'CL Days / Year'), 'CL Days / Year'),
        max_continuous_cl_days: numberValue(settingValue(sheet, 17, 'Max Continuous CL Days'), 'Max Continuous CL Days'),
        leave_year_start_month: new Date(`${textValue(settingValue(sheet, 18, 'Leave Year Start Month'))} 1, 2020`).getMonth() + 1,
        bonus_wage_ceiling: numberValue(settingValue(sheet, 19, 'Bonus Calculation Ceiling'), 'Bonus Calculation Ceiling'),
        bonus_rate: numberValue(settingValue(sheet, 20, 'Bonus Rate'), 'Bonus Rate'),
        gratuity_days_per_year: numberValue(settingValue(sheet, 21, 'Gratuity Rate'), 'Gratuity Rate'),
        gratuity_minimum_years: numberValue(settingValue(sheet, 22, 'Gratuity Minimum Years'), 'Gratuity Minimum Years'),
        standard_deduction: numberValue(settingValue(sheet, 23, 'Income Tax Standard Deduction'), 'Income Tax Standard Deduction'),
        advance_balance_as_of: textValue(settingValue(sheet, 24, 'Advance balance opening date')),
        salary_payment_day: numberValue(settingValue(sheet, 25, 'Salary Payment Date'), 'Salary Payment Date'),
        esi_contribution_period: textValue(settingValue(sheet, 26, 'ESI Contribution Period')),
        as_of_date: periodEnd(period)
    };
    if (!settings.leave_year_start_month) throw new Error('The leave-year start month is invalid.');
    if (calendarDays !== Number(settingValue(sheet, 5, 'Total Calendar Days', false))) {
        console.warn('Workbook Settings B5 does not match the calendar days in the payroll month; SQLite will use the date-derived calendar-day count.');
    }
    const taxSlabs = [];
    for (let row = 30; row <= sheet.rowCount; row++) {
        const lower = sheet.getRow(row).getCell(1).value;
        const upper = sheet.getRow(row).getCell(2).value;
        const rate = sheet.getRow(row).getCell(3).value;
        if (lower === null || lower === undefined || lower === '' || rate === null || rate === undefined || rate === '') break;
        taxSlabs.push({
            lowerBound: numberValue(lower, 'tax slab lower bound'),
            upperBound: upper === null || upper === undefined || upper === '' ? null : numberValue(upper, 'tax slab upper bound'),
            rate: numberValue(rate, 'tax slab rate')
        });
    }
    if (!taxSlabs.length) throw new Error('At least one income-tax slab must be configured.');
    return { period, settings, taxSlabs };
}

function workbookRows(sheet, headerRow = 4) {
    const headers = sheet.getRow(headerRow).values.slice(1).map((value) => textValue(value));
    const rowCount = Math.max(0, sheet.rowCount - headerRow);
    return { headers, rows: rowCount ? sheet.getRows(headerRow + 1, rowCount) : [] };
}

function addHistory(database, workbook, employeeById, periodSet) {
    const sheet = workbook.getWorksheet('Payroll History');
    if (!sheet) return 0;
    const { headers, rows } = workbookRows(sheet);
    const columns = {
        period: headerIndex(headers, ['Month']),
        employeeId: headerIndex(headers, ['EMP ID']),
        name: headerIndex(headers, ['NAME']),
        basicTotal: headerIndex(headers, ['BASIC TOTAL']),
        hra: headerIndex(headers, ['HRA']),
        fixedAllowance: headerIndex(headers, ['FIXED ALLOWANCE']),
        ltw: headerIndex(headers, ['LTW']),
        punctual: headerIndex(headers, ['PUNCTUAL TOTAL']),
        processAllowance: headerIndex(headers, ['PROCESS ALLOWANCE']),
        gross: headerIndex(headers, ['GROSS']),
        employeePf: headerIndex(headers, ['PF']),
        employeeEsi: headerIndex(headers, ['ESI']),
        healthInsurance: headerIndex(headers, ['HEALTH INSURANCE']),
        regularAdvance: headerIndex(headers, ['REG ADVANCE']),
        schoolAdvance: headerIndex(headers, ['SCHOOL ADVANCE']),
        lic: headerIndex(headers, ['LIC']),
        deductions: headerIndex(headers, ['TOTAL DEDUCTION']),
        net: headerIndex(headers, ['NET']),
        clUsed: headerIndex(headers, ['CL USED']),
        elUsed: headerIndex(headers, ['EL USED'])
    };
    const insert = database.prepare(`
        INSERT INTO payroll_history (
            period, employee_id, employee_name, company_id, basic_total, hra, fixed_allowance,
            ltw_allowance, punctual_total, process_allowance, gross_salary, employee_pf, employee_esi,
            health_insurance, regular_advance, school_advance, lic_deduction, total_deductions,
            net_payable, cl_used, el_used
        ) VALUES (
            @period, @employeeId, @name, @companyId, @basicTotal, @hra, @fixedAllowance,
            @ltw, @punctual, @processAllowance, @gross, @employeePf, @employeeEsi,
            @healthInsurance, @regularAdvance, @schoolAdvance, @lic, @deductions,
            @net, @clUsed, @elUsed
        )
    `);
    let count = 0;
    let skippedCount = 0;
    rows.forEach((row) => {
        const rawId = cellValue(row, columns.employeeId, 'payroll history employee ID');
        if (!rawId) return;
        const id = textValue(rawId);
        const employee = employeeById.get(id);
        if (!employee) throw new Error('Payroll History contains an employee not found in the employee masters.');
        const period = periodValue(cellValue(row, columns.period, 'payroll history period', true));
        const requiredValues = [
            cellValue(row, columns.basicTotal, 'historical basic total'),
            cellValue(row, columns.gross, 'historical gross salary'),
            cellValue(row, columns.deductions, 'historical total deductions'),
            cellValue(row, columns.net, 'historical net payable')
        ];
        if (requiredValues.some((value) => value === null || value === undefined || value === '')) {
            skippedCount++;
            return;
        }
        const amount = (key, label, required = false) =>
            numberValue(cellValue(row, columns[key], label, required), label);
        insert.run({
            period,
            employeeId: id,
            name: textValue(cellValue(row, columns.name, 'historical employee name')) || employee.name,
            companyId: employee.companyId,
            basicTotal: amount('basicTotal', 'historical basic total', true),
            hra: amount('hra', 'historical HRA'),
            fixedAllowance: amount('fixedAllowance', 'historical fixed allowance'),
            ltw: amount('ltw', 'historical LTW allowance'),
            punctual: amount('punctual', 'historical punctual total'),
            processAllowance: amount('processAllowance', 'historical process allowance'),
            gross: amount('gross', 'historical gross salary', true),
            employeePf: amount('employeePf', 'historical PF'),
            employeeEsi: amount('employeeEsi', 'historical ESI'),
            healthInsurance: amount('healthInsurance', 'historical health insurance'),
            regularAdvance: amount('regularAdvance', 'historical regular advance'),
            schoolAdvance: amount('schoolAdvance', 'historical school advance'),
            lic: amount('lic', 'historical LIC'),
            deductions: amount('deductions', 'historical total deductions', true),
            net: amount('net', 'historical net payable', true),
            clUsed: amount('clUsed', 'historical CL used'),
            elUsed: amount('elUsed', 'historical EL used')
        });
        periodSet.add(period);
        count++;
    });
    return { count, skippedCount };
}

async function importWorkbook({
    workbookPath,
    openingBalancesPath,
    openingBalancesProvisional = false,
    database
}) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookPath);
    const settingsSheet = workbook.getWorksheet('Settings');
    if (!settingsSheet) throw new Error('The workbook is missing the Settings sheet.');
    const { period, settings, taxSlabs } = buildSettings(settingsSheet);
    const importedCount = database.prepare('SELECT COUNT(*) AS count FROM payroll_employees').get().count;
    if (importedCount) throw new Error('Payroll data already exists in this database; refusing to overwrite it.');

    const employeeRows = [];
    for (const group of COMPANY_SHEETS) {
        const sheet = workbook.getWorksheet(group.sheetName);
        if (!sheet) throw new Error(`The workbook is missing ${group.sheetName}.`);
        const { headers, rows } = workbookRows(sheet);
        rows.forEach((row) => {
            if (!cellValue(row, headerIndex(headers, ['EMP ID']), 'employee ID')) return;
            employeeRows.push(employeeRow(sheet, group, row, headers, period));
        });
    }
    const employeeById = new Map();
    employeeRows.forEach((employee) => {
        if (employeeById.has(employee.id)) throw new Error('Duplicate employee IDs exist across employee masters.');
        employee.esiCoveragePeriod = settings.esi_contribution_period;
        employeeById.set(employee.id, employee);
    });
    if (!employeeRows.length) throw new Error('No employee records were found in the workbook.');

    const openingBalances = parseOpeningBalances(openingBalancesPath, new Set(employeeById.keys()));
    employeeRows.forEach((employee) => {
        const balances = openingBalances.get(employee.id);
        if (balances.elBalance > employee.elEntitlement || balances.clBalance > employee.clEntitlement) {
            throw new Error('An opening leave balance exceeds its employee entitlement.');
        }
        employee.elBalance = balances.elBalance;
        employee.clBalance = balances.clBalance;
        employee.elTaken = employee.elEntitlement - balances.elBalance;
        employee.clTaken = employee.clEntitlement - balances.clBalance;
        employee.leaveDataMissing = employee.leaveEntitlementsMissing || openingBalancesProvisional ? 1 : 0;
    });

    const attendanceSheet = workbook.getWorksheet('Attendance');
    if (!attendanceSheet) throw new Error('The workbook is missing the Attendance sheet.');
    const { headers: attendanceHeaders, rows: attendanceRows } = workbookRows(attendanceSheet);
    const attendanceColumns = attendanceEmployeeIndex(attendanceHeaders);
    const attendanceById = new Map();
    attendanceRows.forEach((row) => {
        const id = textValue(cellValue(row, attendanceColumns.employeeId, 'attendance employee ID'));
        if (!id) return;
        if (!employeeById.has(id)) throw new Error('Attendance contains an employee not found in the employee masters.');
        if (attendanceById.has(id)) throw new Error('Attendance contains duplicate employee IDs.');
        const amount = (key, label) => numberValue(cellValue(row, attendanceColumns[key], label), label);
        attendanceById.set(id, {
            workDays: amount('workDays', 'attendance work days'),
            leaveDays: amount('leaveDays', 'attendance leave days'),
            longestContinuousSpell: amount('longestContinuousSpell', 'attendance longest continuous spell'),
            processAllowance: amount('processAllowance', 'attendance process allowance'),
            punctualIncentive: amount('punctualIncentive', 'attendance punctual incentive'),
            fullAttendanceBonus: amount('fullAttendanceBonus', 'attendance full-attendance bonus')
        });
    });

    const advancesSheet = workbook.getWorksheet('Advance & Loan');
    const { headers: advanceHeaders, rows: advanceRows } = advancesSheet
        ? workbookRows(advancesSheet)
        : { headers: [], rows: [] };
    const advanceColumns = advancesSheet ? {
        employeeId: headerIndex(advanceHeaders, ['EMP ID']),
        type: headerIndex(advanceHeaders, ['ADVANCE TYPE']),
        opening: headerIndex(advanceHeaders, ['OPENING BALANCE']),
        monthly: headerIndex(advanceHeaders, ['MONTHLY DEDUCTION']),
        recovered: headerIndex(advanceHeaders, ['ALREADY RECOVERED SINCE']),
        remarks: headerIndex(advanceHeaders, ['REMARKS'], false)
    } : null;
    const preparedAdvances = [];
    if (advanceColumns) {
        advanceRows.forEach((row) => {
            const rawId = cellValue(row, advanceColumns.employeeId, 'advance employee ID');
            if (!rawId) return;
            const employeeId = textValue(rawId);
            if (!employeeById.has(employeeId)) throw new Error('An advance references an employee not found in the employee masters.');
            const kind = textValue(cellValue(row, advanceColumns.type, 'advance type')).toLowerCase();
            const advanceType = kind.includes('school') ? 'school' : (kind.includes('regular') ? 'regular' : null);
            if (!advanceType) throw new Error('An advance type must be Regular Advance or School Advance.');
            const openingBalance = numberValue(cellValue(row, advanceColumns.opening, 'advance opening balance'), 'advance opening balance');
            const recovered = numberValue(cellValue(row, advanceColumns.recovered, 'advance recovered amount'), 'advance recovered amount');
            if (recovered > openingBalance) throw new Error('An advance recovered amount exceeds its opening balance.');
            preparedAdvances.push({
                employeeId,
                advanceType,
                openingBalance,
                recovered,
                currentBalance: openingBalance - recovered,
                monthlyDeduction: numberValue(cellValue(row, advanceColumns.monthly, 'advance monthly deduction'), 'advance monthly deduction'),
                remarks: textValue(cellValue(row, advanceColumns.remarks, 'advance remarks'))
            });
        });
    }

    const transaction = database.transaction(() => {
        const insertCompany = database.prepare(
            'INSERT INTO payroll_companies (id, name, short_name) VALUES (?, ?, ?)'
        );
        COMPANIES.forEach((company) => insertCompany.run(company.id, company.name, company.shortName));
        const insertEmployee = database.prepare(`
            INSERT INTO payroll_employees (
                id, company_id, name, title, staff_type, joining_date, date_of_birth, basic_salary, fixed_allowance,
                salary_data_missing,
                per_day_rate, pf_applicable, esi_exempt, health_insurance, lic_deduction,
                el_entitlement, cl_entitlement, el_balance, cl_balance, el_taken, cl_taken, status,
                leave_data_missing,
                effective_date, pan, mobile, aadhaar, uan, bank_account, bank_name, esi_coverage_status,
                esi_coverage_period, esi_status_reviewed
            ) VALUES (
                @id, @companyId, @name, @title, @staffType, @joiningDate, @dateOfBirth, @basicSalary, @fixedAllowance,
                @salaryDataMissing,
                @perDayRate, @pfApplicable, @esiExempt, @healthInsurance, @licDeduction,
                @elEntitlement, @clEntitlement, @elBalance, @clBalance, @elTaken, @clTaken, @status,
                @leaveDataMissing,
                @effectiveDate, @pan, @mobile, @aadhaar, @uan, @bankAccount, @bankName, @esiCoverageStatus,
                @esiCoveragePeriod, @esiStatusReviewed
            )
        `);
        employeeRows.forEach((employee) => insertEmployee.run(employee));

        const insertAttendance = database.prepare(`
            INSERT INTO payroll_attendance (
                period, employee_id, work_days, leave_days, longest_continuous_spell,
                process_allowance, punctual_incentive, full_attendance_bonus
            ) VALUES (@period, @employeeId, @workDays, @leaveDays, @longestContinuousSpell,
                @processAllowance, @punctualIncentive, @fullAttendanceBonus)
        `);
        employeeRows.forEach((employee) => insertAttendance.run({
            period,
            employeeId: employee.id,
            ...(attendanceById.get(employee.id) || {
                workDays: 0,
                leaveDays: 0,
                longestContinuousSpell: 0,
                processAllowance: 0,
                punctualIncentive: 0,
                fullAttendanceBonus: 0
            })
        }));

        const insertSetting = database.prepare('INSERT INTO payroll_settings (key, value) VALUES (?, ?)');
        Object.entries(settings).forEach(([key, value]) => insertSetting.run(key, String(value)));
        const insertSlab = database.prepare(
            'INSERT INTO payroll_tax_slabs (lower_bound, upper_bound, rate) VALUES (?, ?, ?)'
        );
        taxSlabs.forEach((slab) => insertSlab.run(slab.lowerBound, slab.upperBound, slab.rate));

        const insertAdvance = database.prepare(`
            INSERT INTO payroll_advances (
                employee_id, advance_type, opening_balance, recovered_before_migration,
                current_balance, monthly_deduction, remarks
            ) VALUES (
                @employeeId, @advanceType, @openingBalance, @recovered, @currentBalance, @monthlyDeduction, @remarks
            )
        `);
        preparedAdvances.forEach((advance) => insertAdvance.run(advance));

        const archivedPeriods = new Set();
        const history = addHistory(database, workbook, employeeById, archivedPeriods);
        const insertRun = database.prepare(
            "INSERT INTO payroll_runs (period, status) VALUES (?, 'archived')"
        );
        archivedPeriods.forEach((archivedPeriod) => {
            if (archivedPeriod < period) insertRun.run(archivedPeriod);
        });
        const importIssues = [
            {
                code: 'missing-salary',
                message: 'Salary values were missing in the source workbook. Payroll preview and archive are disabled until these employee records are corrected.',
                recordCount: employeeRows.filter((employee) => employee.salaryDataMissing).length
            },
            {
                code: 'missing-leave-entitlements',
                message: 'Employee leave entitlements were missing in the source workbook and imported as zero; review and correct them before payroll.',
                recordCount: employeeRows.filter((employee) => employee.leaveEntitlementsMissing).length
            },
            {
                code: 'incomplete-history',
                message: 'Payroll history rows without saved calculation results were omitted from the imported archive.',
                recordCount: history.skippedCount
            },
            ...(openingBalancesProvisional ? [{
                code: 'provisional-leave-balances',
                message: 'Opening leave balances were unavailable and initialized to zero; validate and correct them before payroll.',
                recordCount: employeeRows.length
            }] : [])
        ].filter((issue) => issue.recordCount > 0);
        const insertIssue = database.prepare(
            'INSERT INTO payroll_import_issues (code, message, record_count) VALUES (?, ?, ?)'
        );
        importIssues.forEach((issue) => insertIssue.run(issue.code, issue.message, issue.recordCount));
        return { historyCount: history.count, skippedHistoryCount: history.skippedCount };
    });

    const history = transaction();
    return {
        employeeCount: employeeRows.length,
        attendanceCount: attendanceById.size,
        advanceCount: preparedAdvances.length,
        historyCount: history.historyCount,
        skippedHistoryCount: history.skippedHistoryCount
    };
}

async function main() {
    const args = process.argv.slice(2);
    const workbookPath = args[0];
    let openingBalancesPath;
    for (let index = 1; index < args.length; index++) {
        if (args[index] === '--opening-balances') openingBalancesPath = args[++index];
        else throw new Error(`Unknown argument: ${args[index]}`);
    }
    if (!workbookPath || !fs.existsSync(workbookPath)) {
        throw new Error('Usage: npm run import-workbook -- <workbook.xlsx> --opening-balances <employee-balances.csv>');
    }
    if (!openingBalancesPath || !fs.existsSync(openingBalancesPath)) {
        throw new Error('Provide a readable opening-balances CSV with employeeId,elBalance,clBalance columns.');
    }
    const database = createDatabase();
    try {
        const result = await importWorkbook({ workbookPath: path.resolve(workbookPath), openingBalancesPath, database });
        console.log(`Imported ${result.employeeCount} employees, ${result.attendanceCount} attendance rows, ${result.advanceCount} advances, and ${result.historyCount} archived payroll rows.`);
    } finally {
        database.close();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`Payroll import failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { importWorkbook, normalizeHeader, parseOpeningBalances, periodValue };
