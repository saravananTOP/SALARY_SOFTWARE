'use strict';

const { calculatePayroll } = require('./payroll');

class AttendanceImportError extends Error {}

const REGISTER_NAMES = [
    'Company Master',
    'Employee Master - FA',
    'Employee Master - FR',
    'Employee Master - SA',
    'Leave Master',
    'Attendance',
    'Advance & Loan',
    'Flavors India - Active',
    'Flavors India - Retainers',
    'Supreme Aromatics - Retainers',
    'Salary Register',
    'PF Register - Flavors India',
    'PF Register - Supreme Aromatics',
    'ESI Register',
    'Bonus Register',
    'Gratuity Register',
    'TDS Register',
    'Payslip',
    'Payroll History',
    'Reports',
    'ESI Verification Checklist'
];

const PROTECTED_COLUMNS = [
    { key: 'dateOfBirth', label: 'Date of birth' },
    { key: 'pan', columnNumber: 6, label: 'PAN' },
    { key: 'mobile', label: 'Mobile number' },
    { key: 'aadhaar', label: 'Aadhaar number' },
    { key: 'uan', columnNumber: 7, label: 'UAN' },
    { key: 'bankAccount', columnNumber: 8, label: 'Bank account number' },
    { key: 'bankName', columnNumber: 24, label: 'Bank name' }
];

function numberSetting(settings, key) {
    const value = Number(settings[key]);
    if (!Number.isFinite(value) || value < 0) throw new Error(`Payroll setting ${key} is missing or invalid.`);
    return value;
}

function loadSettings(database) {
    const stored = Object.fromEntries(database.prepare('SELECT key, value FROM payroll_settings').all()
        .map((row) => [row.key, row.value]));
    if (!stored.payroll_period) throw new Error('Payroll data has not been imported. Import the workbook before opening payroll.');
    const taxSlabs = database.prepare(
        'SELECT lower_bound AS lowerBound, upper_bound AS upperBound, rate FROM payroll_tax_slabs ORDER BY lower_bound'
    ).all();
    if (!taxSlabs.length) throw new Error('Income tax slabs are missing. Import payroll settings before opening payroll.');
    const [year, month] = stored.payroll_period.split('-').map(Number);
    return {
        period: stored.payroll_period,
        periodLabel: stored.period_label,
        calendarDays: numberSetting(stored, 'calendar_days'),
        maxContinuousClDays: numberSetting(stored, 'max_continuous_cl_days'),
        pfWageCeiling: numberSetting(stored, 'pf_wage_ceiling'),
        pfEmployeeRate: numberSetting(stored, 'pf_employee_rate'),
        epsEmployerRate: numberSetting(stored, 'eps_employer_rate'),
        epsEmployerCap: numberSetting(stored, 'eps_employer_cap'),
        esiWageCeiling: numberSetting(stored, 'esi_wage_ceiling'),
        esiEmployeeRate: numberSetting(stored, 'esi_employee_rate'),
        esiEmployerRate: numberSetting(stored, 'esi_employer_rate'),
        standardDeduction: numberSetting(stored, 'standard_deduction'),
        bonusWageCeiling: numberSetting(stored, 'bonus_wage_ceiling'),
        bonusRate: numberSetting(stored, 'bonus_rate'),
        gratuityDaysPerYear: numberSetting(stored, 'gratuity_days_per_year'),
        gratuityMinimumYears: numberSetting(stored, 'gratuity_minimum_years'),
        esiContributionPeriod: stored.esi_contribution_period || '',
        salaryPaymentDay: numberSetting(stored, 'salary_payment_day'),
        asOfDate: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
        taxSlabs
    };
}

function maskValue(value) {
    const text = String(value || '');
    if (!text) return 'Not provided';
    return `${'*'.repeat(Math.max(4, text.length - 4))}${text.slice(-4)}`;
}

function employeePayrollDataMissing(employee) {
    return employee.salaryDataMissing || employee.leaveDataMissing;
}

function protectedFields(employee) {
    return PROTECTED_COLUMNS
        .map(({ key, columnNumber, label }) => ({
            key,
            columnNumber,
            label,
            maskedValue: maskValue(employee[key])
        }));
}

function createPayrollContext(database, settings = loadSettings(database)) {
    const companies = database.prepare(
        'SELECT id, name, short_name AS shortName FROM payroll_companies ORDER BY id'
    ).all();
    const employees = database.prepare(`
        SELECT
            id, company_id AS companyId, name, title, staff_type AS staffType,
            joining_date AS joiningDate, date_of_birth AS dateOfBirth, mobile, aadhaar,
            basic_salary AS baseSalary,
            salary_data_missing AS salaryDataMissing,
            fixed_allowance AS fixedAllowance, per_day_rate AS perDayRate,
            pf_applicable AS pfApplicable, esi_exempt AS esiExempt,
            health_insurance AS healthInsurance, lic_deduction AS licDeduction,
            el_entitlement AS elEntitlement, cl_entitlement AS clEntitlement,
            el_balance AS elBalance, cl_balance AS clBalance,
            el_taken AS elTaken, cl_taken AS clTaken, status, effective_date AS effectiveDate,
            leave_data_missing AS leaveDataMissing,
            pan, uan, bank_account AS bankAccount, bank_name AS bankName,
            esi_coverage_status AS esiCoverageStatus, esi_coverage_period AS esiCoveragePeriod,
            esi_status_reviewed AS esiStatusReviewed
        FROM payroll_employees
        ORDER BY name
    `).all();
    const attendanceRows = database.prepare(`
        SELECT employee_id AS employeeId, work_days AS workDays, leave_days AS leaveDays,
            longest_continuous_spell AS longestContinuousSpell, process_allowance AS processAllowance,
            punctual_incentive AS punctualIncentive, full_attendance_bonus AS fullAttendanceBonus
        FROM payroll_attendance WHERE period = ?
    `).all(settings.period);
    const attendanceById = new Map(attendanceRows.map((row) => [row.employeeId, row]));
    const advances = database.prepare(`
        SELECT id, employee_id AS employeeId, advance_type AS advanceType,
            current_balance AS currentBalance, monthly_deduction AS monthlyDeduction
        FROM payroll_advances WHERE is_active = 1 ORDER BY id
    `).all();
    const advancesById = new Map();
    advances.forEach((advance) => {
        if (!advancesById.has(advance.employeeId)) advancesById.set(advance.employeeId, []);
        advancesById.get(advance.employeeId).push(advance);
    });

    const payrollById = new Map();
    const esiReviewRequired = employees.filter((employee) =>
        employee.status === 'active'
        && employee.esiCoveragePeriod !== settings.esiContributionPeriod);
    employees.forEach((employee) => {
        const input = attendanceById.get(employee.id) || {
            workDays: 0,
            leaveDays: 0,
            longestContinuousSpell: 0,
            processAllowance: 0,
            punctualIncentive: 0,
            fullAttendanceBonus: 0
        };
        const result = calculatePayroll({
            ...employee,
            basicSalary: employee.baseSalary
        }, input, settings, advancesById.get(employee.id) || []);
        payrollById.set(employee.id, { input, result });
    });
    return { settings, companies, employees, payrollById, advances, esiReviewRequired };
}

function companyReports(context) {
    return context.companies.map((company) => {
        const group = context.employees.filter((employee) =>
            employee.companyId === company.id && employee.status === 'active');
        const totals = group.reduce((accumulator, employee) => {
            const result = context.payrollById.get(employee.id).result;
            accumulator.basicTotal += result.basicTotal;
            accumulator.grossSalary += result.grossSalary;
            accumulator.employeePf += result.employeePf;
            accumulator.employeeEsi += result.employeeEsi;
            accumulator.totalDeductions += result.totalDeductions;
            accumulator.netPayable += result.netPayable;
            accumulator.annualBonus += result.annualBonusEstimate;
            accumulator.gratuityEstimate += result.gratuityEstimate;
            accumulator.annualTds += result.annualTdsEstimate;
            return accumulator;
        }, {
            basicTotal: 0,
            grossSalary: 0,
            employeePf: 0,
            employeeEsi: 0,
            totalDeductions: 0,
            netPayable: 0,
            annualBonus: 0,
            gratuityEstimate: 0,
            annualTds: 0
        });
        if (group.some(employeePayrollDataMissing)) {
            Object.keys(totals).forEach((key) => {
                totals[key] = null;
            });
        }
        return {
            companyId: company.id,
            companyLabel: company.name,
            employees: group.length,
            ...totals
        };
    });
}

function portalData(database, user) {
    const context = createPayrollContext(database);
    const importIssues = database.prepare(
        'SELECT message, record_count AS recordCount FROM payroll_import_issues ORDER BY code'
    ).all();
    const salaryDataMissingCount = context.employees.filter((employee) => employee.salaryDataMissing).length;
    const leaveDataMissingCount = context.employees.filter((employee) => employee.leaveDataMissing).length;
    const employees = context.employees.map((employee, index) => {
        const {
            dateOfBirth, mobile, aadhaar, pan, uan, bankAccount, bankName,
            ...publicEmployee
        } = employee;
        const { input, result } = context.payrollById.get(employee.id);
        const company = context.companies.find((item) => item.id === employee.companyId);
        return {
            ...publicEmployee,
            salaryDataMissing: Boolean(employee.salaryDataMissing),
            leaveDataMissing: Boolean(employee.leaveDataMissing),
            baseSalary: employee.salaryDataMissing ? null : employee.baseSalary,
            fixedAllowance: employee.salaryDataMissing ? null : employee.fixedAllowance,
            perDayRate: employee.salaryDataMissing ? null : employee.perDayRate,
            healthInsurance: employee.salaryDataMissing ? null : employee.healthInsurance,
            licDeduction: employee.salaryDataMissing ? null : employee.licDeduction,
            joiningDate: employee.joiningDate || '',
            ageAtJoining: null,
            pfApplicable: Boolean(employee.pfApplicable),
            esiExempt: Boolean(employee.esiExempt),
            initials: employee.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(),
            color: ['#eeeafd', '#e4f3ed', '#fff0e2', '#e8effc', '#f9e9ee', '#f0eafa', '#e5f3f4', '#fff2df'][index % 8],
            protectedFields: protectedFields(employee),
            leaveBalance: {
                clTaken: employee.leaveDataMissing ? null : employee.clTaken,
                clEntitlement: employee.leaveDataMissing ? null : employee.clEntitlement,
                clBalance: employee.leaveDataMissing ? null : employee.clBalance,
                elTaken: employee.leaveDataMissing ? null : employee.elTaken,
                elEntitlement: employee.leaveDataMissing ? null : employee.elEntitlement,
                elBalance: employee.leaveDataMissing ? null : employee.elBalance
            },
            attendance: {
                ...input,
                lopDays: employee.leaveDataMissing ? null : result.lopDays,
                lopAmount: employeePayrollDataMissing(employee) ? null : result.lopAmount,
                clUsed: employee.leaveDataMissing ? null : result.clUsed,
                elUsed: employee.leaveDataMissing ? null : result.elUsed,
                companyName: company?.name || ''
            }
        };
    });
    const reports = companyReports(context);
    const companyTotals = reports.map((report) => ({
        companyId: report.companyId,
        grossSalary: report.grossSalary,
        employeeCount: report.employees
    }));
    const payrollRuns = database.prepare(`
        SELECT h.period, h.company_id AS companyId, SUM(h.gross_salary) AS total,
            COUNT(*) AS employeeCount, r.archived_at AS createdAt, c.name AS companyLabel
        FROM payroll_history h
        LEFT JOIN payroll_runs r ON r.period = h.period
        LEFT JOIN payroll_companies c ON c.id = h.company_id
        GROUP BY h.period, h.company_id
        ORDER BY h.period DESC, h.company_id
    `).all().map((run) => ({
        id: `${run.period}-${run.companyId}`,
        period: run.period,
        companyId: run.companyId,
        companyLabel: run.companyLabel,
        total: run.total,
        status: 'Archived',
        createdAt: run.createdAt || `${run.period}-01`,
        employeeIds: database.prepare(
            'SELECT employee_id AS id FROM payroll_history WHERE period = ? AND company_id = ? ORDER BY employee_name'
        ).all(run.period, run.companyId).map((row) => row.id)
    }));
    const advances = database.prepare(`
        SELECT a.id, a.employee_id AS employeeId, e.name AS employeeName,
            a.advance_type AS advanceType, a.opening_balance AS openingBalance,
            a.recovered_before_migration AS alreadyRecovered,
            a.current_balance AS currentBalance, a.monthly_deduction AS monthlyDeduction,
            a.remarks, a.is_active AS isActive
        FROM payroll_advances a
        JOIN payroll_employees e ON e.id = a.employee_id
        ORDER BY e.name, a.id
    `).all().map((advance) => ({ ...advance, isActive: Boolean(advance.isActive) }));
    return {
        mode: 'sqlite',
        userEmail: user.email,
        userRole: user.role,
        canRevealSensitive: user.role === 'admin',
        canUpdateAttendance: user.role !== 'read-only',
        companies: context.companies,
        employees,
        payrollRuns,
        advances,
        leaveRequests: [],
        companyTotals,
        companyReports: reports,
        payrollRules: {
            pfWageCeiling: context.settings.pfWageCeiling,
            pfEmployeeRate: context.settings.pfEmployeeRate,
            epsEmployerRate: context.settings.epsEmployerRate,
            epsEmployerCap: context.settings.epsEmployerCap,
            esiWageCeiling: context.settings.esiWageCeiling,
            esiEmployeeRate: context.settings.esiEmployeeRate,
            esiEmployerRate: context.settings.esiEmployerRate,
            bonusWageCeiling: context.settings.bonusWageCeiling,
            bonusRate: context.settings.bonusRate,
            gratuityDaysPerYear: context.settings.gratuityDaysPerYear,
            gratuityMinimumYears: context.settings.gratuityMinimumYears,
            standardDeduction: context.settings.standardDeduction,
            salaryPaymentDay: context.settings.salaryPaymentDay,
            maxContinuousClDays: context.settings.maxContinuousClDays
        },
        payrollPeriod: context.settings.period,
        periodLabel: context.settings.periodLabel,
        calendarDays: context.settings.calendarDays,
        warnings: [
            ...(context.esiReviewRequired.length
                ? [`${context.esiReviewRequired.length} ESI coverage status(es) need review for the current contribution period.`]
                : []),
            ...(salaryDataMissingCount
                ? [`${salaryDataMissingCount} employee salary record(s) need administrator review.`]
                : []),
            ...(leaveDataMissingCount
                ? [`${leaveDataMissingCount} employee leave entitlement or opening balance record(s) need administrator review.`]
                : []),
            ...importIssues.filter((issue) => issue.message.includes('Payroll history rows')).map((issue) => issue.message)
        ],
        dataReview: {
            salaryMissingCount: salaryDataMissingCount,
            leaveMissingCount: leaveDataMissingCount,
            pendingCount: context.employees.filter((employee) =>
                employee.salaryDataMissing || employee.leaveDataMissing).length
        },
        canManageEmployeeData: user.role === 'admin',
        canManagePayrollRules: user.role === 'admin',
        canManageAdvances: user.role === 'admin',
        esiReviewRequiredCount: context.esiReviewRequired.length,
        esiReviewRequiredEmployees: context.esiReviewRequired.map((employee) => ({
            id: employee.id,
            name: employee.name,
            status: employee.esiCoverageStatus
        })),
        canReviewEsi: user.role === 'admin',
        periodArchived: Boolean(database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(context.settings.period))
    };
}

function employeePayroll(database, employeeId, context) {
    const current = context || createPayrollContext(database);
    const employee = current.employees.find((item) => item.id === employeeId);
    if (!employee) throw new Error('The employee was not found.');
    return { employee, ...current.payrollById.get(employeeId) };
}

function registerData(database, registerName, context) {
    if (!REGISTER_NAMES.includes(registerName)) throw new Error('Choose a supported payroll register.');
    const current = context || createPayrollContext(database);
    const rows = [];
    const addEmployees = (filter = () => true) => current.employees.filter(filter).map((employee) => {
        const payroll = current.payrollById.get(employee.id).result;
        return { employee, payroll };
    });
    const addPayrollHistory = () => database.prepare(`
        SELECT period, employee_id, employee_name, company_id, basic_total, hra, fixed_allowance,
            ltw_allowance, punctual_total, process_allowance, gross_salary, employee_pf, employee_esi,
            health_insurance, regular_advance, school_advance, lic_deduction, total_deductions,
            net_payable, cl_used, el_used
        FROM payroll_history ORDER BY period DESC, employee_name
    `).all();

    let columns;
    switch (registerName) {
        case 'Company Master':
            columns = ['Company Code', 'Company Name', 'Address', 'PF Code', 'ESI Code', 'Employee Count'];
            current.companies.forEach((company) => rows.push([
                company.id,
                company.name,
                '',
                '',
                '',
                current.employees.filter((employee) => employee.companyId === company.id).length
            ]));
            break;
        case 'Employee Master - FA':
        case 'Employee Master - FR':
        case 'Employee Master - SA': {
            const companyId = registerName === 'Employee Master - SA' ? 'supreme-aromatics' : 'flavors-india';
            const staffType = registerName === 'Employee Master - FA' ? 'active' : 'retainer';
            columns = ['EMP ID', 'NAME', 'DESIGNATION', 'DATE OF JOINING', 'DATE OF BIRTH', 'MOBILE', 'AADHAAR', 'STAFF TYPE', 'PAN', 'UAN NO.', 'BANK A/C NO.', 'BASIC', 'FIXED ALLOWANCE', 'PER DAY RATE', 'PF APPL? (Y/N)', 'ESI EXEMPT? (LOP, Y/N)', 'HEALTH INSURANCE', 'L.I.C.', 'EL ENTITLEMENT', 'CL ENTITLEMENT', 'EL BALANCE', 'CL BALANCE', 'EL TAKEN', 'CL TAKEN', 'STATUS', 'EFFECTIVE DATE', 'BANK NAME', 'ESI COVERAGE STATUS', 'ESI STATUS LAST REVIEWED'];
            addEmployees((employee) => employee.companyId === companyId && employee.staffType === staffType)
                .forEach(({ employee }) => rows.push([
                    employee.id, employee.name, employee.title, employee.joiningDate,
                    employee.dateOfBirth ? 'Protected' : '', maskValue(employee.mobile), maskValue(employee.aadhaar),
                    employee.staffType, maskValue(employee.pan), maskValue(employee.uan),
                    maskValue(employee.bankAccount), employee.salaryDataMissing ? 'Review source' : employee.baseSalary,
                    employee.salaryDataMissing ? '' : employee.fixedAllowance,
                    employee.salaryDataMissing ? '' : employee.perDayRate, employee.pfApplicable ? 'Y' : 'N',
                    employee.esiExempt ? 'Y' : 'N',
                    employee.salaryDataMissing ? '' : employee.healthInsurance,
                    employee.salaryDataMissing ? '' : employee.licDeduction,
                    employee.leaveDataMissing ? '' : employee.elEntitlement,
                    employee.leaveDataMissing ? '' : employee.clEntitlement,
                    employee.leaveDataMissing ? '' : employee.elBalance,
                    employee.leaveDataMissing ? '' : employee.clBalance,
                    employee.leaveDataMissing ? '' : employee.elTaken,
                    employee.leaveDataMissing ? '' : employee.clTaken,
                    employee.status, employee.effectiveDate || '',
                    maskValue(employee.bankName), employee.esiCoverageStatus, employee.esiStatusReviewed || ''
                ]));
            break;
        }
        case 'Leave Master':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'EL ENTITLEMENT', 'EL TAKEN', 'EL BALANCE', 'CL ENTITLEMENT', 'CL TAKEN', 'CL BALANCE'];
            addEmployees().forEach(({ employee }) => rows.push([
                employee.id, employee.name, companyName(current.companies, employee.companyId),
                employee.leaveDataMissing ? '' : employee.elEntitlement,
                employee.leaveDataMissing ? '' : employee.elTaken,
                employee.leaveDataMissing ? '' : employee.elBalance,
                employee.leaveDataMissing ? '' : employee.clEntitlement,
                employee.leaveDataMissing ? '' : employee.clTaken,
                employee.leaveDataMissing ? '' : employee.clBalance
            ]));
            break;
        case 'Attendance':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'WORK DAYS', 'LOP (Rs)', 'LEAVE DAYS THIS MONTH', 'LONGEST CONTINUOUS SPELL', 'CL BAL. BEFORE', 'EL BAL. BEFORE', 'CL USED THIS MONTH', 'EL USED THIS MONTH', 'PROCESS ALLOWANCE (Rs)', 'NO. OF LOP DAYS', 'PUNCTUAL INCENTIVE (Rs)', 'FULL ATT. BONUS (Rs)'];
            addEmployees().forEach(({ employee, payroll }) => {
                const input = current.payrollById.get(employee.id).input;
                rows.push([
                    employee.id, employee.name, companyName(current.companies, employee.companyId),
                    input.workDays, employeePayrollDataMissing(employee) ? '' : payroll.lopAmount,
                    input.leaveDays, input.longestContinuousSpell,
                    employee.leaveDataMissing ? '' : employee.clBalance,
                    employee.leaveDataMissing ? '' : employee.elBalance,
                    employee.leaveDataMissing ? '' : payroll.clUsed,
                    employee.leaveDataMissing ? '' : payroll.elUsed,
                    input.processAllowance,
                    employee.leaveDataMissing ? '' : payroll.lopDays,
                    input.punctualIncentive,
                    input.fullAttendanceBonus
                ]);
            });
            break;
        case 'Advance & Loan':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'ADVANCE TYPE', 'OPENING BALANCE', 'MONTHLY DEDUCTION', 'ALREADY RECOVERED', 'CURRENT BALANCE', 'NEXT MONTH DEDUCTION', 'BALANCE AFTER NEXT DEDUCTION', 'REMARKS', 'STATUS'];
            database.prepare(`
                SELECT a.*, e.name, e.company_id AS companyId
                FROM payroll_advances a JOIN payroll_employees e ON e.id = a.employee_id ORDER BY e.name, a.id
            `).all().forEach((advance) => rows.push([
                advance.employee_id, advance.name, companyName(current.companies, advance.companyId),
                advance.advance_type === 'school' ? 'School Advance' : 'Regular Advance',
                advance.opening_balance, advance.monthly_deduction, advance.recovered_before_migration,
                advance.current_balance,
                advance.is_active ? Math.min(advance.monthly_deduction, advance.current_balance) : 0,
                advance.is_active ? Math.max(0, advance.current_balance - advance.monthly_deduction) : advance.current_balance,
                advance.remarks, advance.is_active ? 'Active' : 'Closed'
            ]));
            break;
        case 'Salary Register':
        case 'Flavors India - Active':
        case 'Flavors India - Retainers':
        case 'Supreme Aromatics - Retainers':
        case 'Payslip': {
            columns = ['EMP ID', 'NAME', 'COMPANY', 'BASIC TOTAL', 'GROSS SALARY', 'P.F.', 'E.S.I.', 'TOTAL DEDUCTION', 'NET AMT. PAYABLE', 'REFERENCE GROSS'];
            const filter = registerName === 'Flavors India - Active'
                ? (employee) => employee.companyId === 'flavors-india' && employee.staffType === 'active'
                : (registerName === 'Flavors India - Retainers'
                    ? (employee) => employee.companyId === 'flavors-india' && employee.staffType === 'retainer'
                    : (registerName === 'Supreme Aromatics - Retainers'
                        ? (employee) => employee.companyId === 'supreme-aromatics'
                        : () => true));
            addEmployees(filter).forEach(({ employee, payroll }) => {
                rows.push(employeePayrollDataMissing(employee)
                    ? [employee.id, employee.name, companyName(current.companies, employee.companyId), 'Review source', '', '', '', '', '', '']
                    : [
                        employee.id, employee.name, companyName(current.companies, employee.companyId),
                        payroll.basicTotal, payroll.grossSalary, payroll.employeePf, payroll.employeeEsi,
                        payroll.totalDeductions, payroll.netPayable, payroll.grossSalary
                    ]);
            });
            break;
        }
        case 'PF Register - Flavors India':
        case 'PF Register - Supreme Aromatics': {
            const companyId = registerName.endsWith('Supreme Aromatics') ? 'supreme-aromatics' : 'flavors-india';
            columns = ['EMP ID', 'NAME', 'UAN NO.', 'STAFF TYPE', 'BASIC TOTAL', 'PF WAGE', 'EMPLOYEE PF', 'EMPLOYER EPS', 'EMPLOYER EPF DIFF', 'EMPLOYER TOTAL', 'TOTAL PF REMITTED'];
            addEmployees((employee) => employee.companyId === companyId && employee.pfApplicable)
                .forEach(({ employee, payroll }) => {
                    rows.push(employeePayrollDataMissing(employee)
                        ? [employee.id, employee.name, maskValue(employee.uan), employee.staffType, 'Review source', '', '', '', '', '', '']
                        : [
                            employee.id, employee.name, maskValue(employee.uan), employee.staffType,
                            payroll.basicTotal, payroll.pfWage, payroll.employeePf,
                            payroll.employerEps, payroll.employerEpf,
                            payroll.employerEps + payroll.employerEpf,
                            payroll.employeePf + payroll.employerEps + payroll.employerEpf
                        ]);
                });
            break;
        }
        case 'ESI Register':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'GROSS SALARY', 'ESI EMPLOYEE', 'ESI EMPLOYER', 'TOTAL ESI', 'REFERENCE GROSS'];
            addEmployees().forEach(({ employee, payroll }) => {
                rows.push(employeePayrollDataMissing(employee)
                    ? [employee.id, employee.name, companyName(current.companies, employee.companyId), 'Review source', '', '', '', '']
                    : [
                        employee.id, employee.name, companyName(current.companies, employee.companyId),
                        payroll.grossSalary, payroll.employeeEsi, payroll.employerEsi,
                        payroll.employeeEsi + payroll.employerEsi, payroll.grossSalary
                    ]);
            });
            break;
        case 'Bonus Register':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'BASIC TOTAL', 'BONUS WAGE', 'ANNUAL BONUS ESTIMATE'];
            addEmployees().forEach(({ employee, payroll }) => {
                rows.push(employeePayrollDataMissing(employee)
                    ? [employee.id, employee.name, companyName(current.companies, employee.companyId), 'Review source', '', '']
                    : [
                        employee.id, employee.name, companyName(current.companies, employee.companyId),
                        payroll.basicTotal, Math.min(payroll.basicTotal, current.settings.bonusWageCeiling),
                        payroll.annualBonusEstimate
                    ]);
            });
            break;
        case 'Gratuity Register':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'DATE OF JOINING', 'COMPLETED YEARS', 'ELIGIBLE?', 'LAST DRAWN BASIC', 'GRATUITY ESTIMATE'];
            addEmployees().forEach(({ employee, payroll }) => {
                rows.push(employeePayrollDataMissing(employee)
                    ? [employee.id, employee.name, companyName(current.companies, employee.companyId),
                        employee.joiningDate || '', payroll.completedServiceYears, 'Review source', '', '']
                    : [
                        employee.id, employee.name, companyName(current.companies, employee.companyId),
                        employee.joiningDate || '', payroll.completedServiceYears,
                        payroll.gratuityEstimate ? 'Y' : 'N', payroll.basicTotal, payroll.gratuityEstimate
                    ]);
            });
            break;
        case 'TDS Register':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'MONTHLY GROSS', 'ANNUALIZED GROSS', 'STANDARD DEDUCTION', 'TAXABLE INCOME', 'ANNUAL TAX ESTIMATE'];
            addEmployees().forEach(({ employee, payroll }) => {
                rows.push(employeePayrollDataMissing(employee)
                    ? [employee.id, employee.name, companyName(current.companies, employee.companyId), 'Review source', '', '', '', '']
                    : [
                        employee.id, employee.name, companyName(current.companies, employee.companyId),
                        payroll.grossSalary, payroll.annualizedGross, current.settings.standardDeduction,
                        payroll.taxableIncome, payroll.annualTdsEstimate
                    ]);
            });
            break;
        case 'Payroll History': {
            const history = addPayrollHistory();
            columns = ['MONTH', 'EMP ID', 'NAME', 'COMPANY', 'BASIC TOTAL', 'HRA', 'FIXED ALLOWANCE', 'LTW', 'PUNCTUAL TOTAL', 'PROCESS ALLOWANCE', 'GROSS', 'PF', 'ESI', 'HEALTH INSURANCE', 'REG ADVANCE', 'SCHOOL ADVANCE', 'LIC', 'TOTAL DEDUCTION', 'NET', 'CL USED', 'EL USED'];
            history.forEach((row) => rows.push([
                row.period, row.employee_id, row.employee_name, companyName(current.companies, row.company_id),
                row.basic_total, row.hra, row.fixed_allowance, row.ltw_allowance, row.punctual_total,
                row.process_allowance, row.gross_salary, row.employee_pf, row.employee_esi,
                row.health_insurance, row.regular_advance, row.school_advance, row.lic_deduction,
                row.total_deductions, row.net_payable, row.cl_used, row.el_used
            ]));
            break;
        }
        case 'Reports':
            columns = ['COMPANY', 'EMPLOYEES', 'GROSS', 'EMPLOYEE PF', 'EMPLOYEE ESI', 'TOTAL DEDUCTIONS', 'NET PAYABLE', 'ANNUAL BONUS', 'GRATUITY ESTIMATE', 'ANNUAL TDS'];
            companyReports(current).forEach((report) => rows.push([
                report.companyLabel, report.employees, report.grossSalary, report.employeePf,
                report.employeeEsi, report.totalDeductions, report.netPayable, report.annualBonus,
                report.gratuityEstimate, report.annualTds
            ]));
            break;
        case 'ESI Verification Checklist':
            columns = ['EMP ID', 'NAME', 'COMPANY', 'REFERENCE GROSS', 'COVERAGE STATUS', 'CONTRIBUTION PERIOD', 'LAST REVIEWED'];
            addEmployees().forEach(({ employee, payroll }) => rows.push([
                employee.id, employee.name, companyName(current.companies, employee.companyId),
                employeePayrollDataMissing(employee) ? 'Review source' : payroll.grossSalary,
                employee.esiCoverageStatus, current.settings.esiContributionPeriod,
                employee.esiStatusReviewed || ''
            ]));
            break;
        default:
            throw new Error('Choose a supported payroll register.');
    }
    return { columns, rows };
}

function companyName(companies, companyId) {
    return companies.find((company) => company.id === companyId)?.name || '';
}

function registerPage(database, registerName, startRow) {
    const start = Number(startRow);
    if (!Number.isInteger(start) || start < 5) throw new Error('The requested register page is invalid.');
    const { columns, rows } = registerData(database, registerName);
    const offset = start - 5;
    const pageSize = 100;
    const pageRows = rows.slice(offset, offset + pageSize).map((values, index) => ({
        rowNumber: start + index,
        values
    }));
    return {
        registerName,
        columns,
        rows: pageRows,
        startRow: start,
        nextStartRow: start + pageRows.length,
        totalRows: rows.length,
        hasMore: offset + pageSize < rows.length
    };
}

function payrollPreview(database, employeeIds, period) {
    const context = createPayrollContext(database);
    if (period !== context.settings.period) {
        throw new Error('Choose the current payroll period before preparing a preview.');
    }
    if (context.esiReviewRequired.length) {
        throw new Error('Review ESI coverage statuses for the current contribution period before preparing payroll.');
    }
    if (!Array.isArray(employeeIds) || employeeIds.length < 1 || employeeIds.length > 100) {
        throw new Error('Select between 1 and 100 employees for a payroll preview.');
    }
    if (new Set(employeeIds).size !== employeeIds.length) throw new Error('Selected employee IDs must be unique.');
    return employeeIds.map((employeeId) => {
        const { employee, result } = employeePayroll(database, employeeId, context);
        if (employee.status !== 'active') throw new Error('An inactive employee cannot be included in a payroll preview.');
        if (employeePayrollDataMissing(employee)) {
            throw new Error('Payroll source data is incomplete: verify employee salary and leave records before previewing payroll.');
        }
        if (employee.leaveDataMissing) {
            throw new Error('Payroll source data is incomplete: verify employee salary and leave records before previewing payroll.');
        }
        return {
            employeeId: employee.id,
            name: employee.name,
            companyId: employee.companyId,
            staffType: employee.staffType,
            basicTotal: result.basicTotal,
            grossSalary: result.grossSalary,
            employeePf: result.employeePf,
            employeeEsi: result.employeeEsi,
            totalDeductions: result.totalDeductions,
            netPayable: result.netPayable
        };
    });
}

function updateEmployeePayrollData(database, employeeId, values) {
    const employee = database.prepare('SELECT id FROM payroll_employees WHERE id = ?').get(employeeId);
    if (!employee) throw new Error('The employee was not found.');
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
        throw new Error('Salary and leave source values are required.');
    }
    const moneyFields = ['basicSalary', 'fixedAllowance', 'perDayRate', 'healthInsurance', 'licDeduction'];
    for (const field of moneyFields) {
        if (!Number.isFinite(values[field]) || values[field] < 0 || values[field] > 100000000) {
            throw new Error(`${field} must be between 0 and 100,000,000.`);
        }
    }
    if (values.basicSalary <= 0) throw new Error('Basic salary must be greater than zero.');
    for (const field of ['elEntitlement', 'clEntitlement', 'elBalance', 'clBalance']) {
        if (!Number.isFinite(values[field]) || values[field] < 0 || values[field] > 366) {
            throw new Error(`${field} must be between 0 and 366 days.`);
        }
    }
    if (values.elBalance > values.elEntitlement || values.clBalance > values.clEntitlement) {
        throw new Error('Leave balances cannot exceed their employee entitlements.');
    }
    database.prepare(`
        UPDATE payroll_employees
        SET basic_salary = @basicSalary,
            salary_data_missing = 0,
            fixed_allowance = @fixedAllowance,
            per_day_rate = @perDayRate,
            health_insurance = @healthInsurance,
            lic_deduction = @licDeduction,
            el_entitlement = @elEntitlement,
            cl_entitlement = @clEntitlement,
            el_balance = @elBalance,
            cl_balance = @clBalance,
            el_taken = @elEntitlement - @elBalance,
            cl_taken = @clEntitlement - @clBalance,
            leave_data_missing = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @employeeId
    `).run({ ...values, employeeId });
    return { employeeId };
}

function employeeFixedData(database, employeeId) {
    const employee = database.prepare(`
        SELECT date_of_birth AS dateOfBirth, mobile, aadhaar, pan, uan,
            bank_account AS bankAccount, bank_name AS bankName
        FROM payroll_employees WHERE id = ?
    `).get(employeeId);
    if (!employee) throw new Error('The employee was not found.');
    return employee;
}

function updateEmployeeFixedData(database, employeeId, values) {
    const employee = database.prepare('SELECT id FROM payroll_employees WHERE id = ?').get(employeeId);
    if (!employee) throw new Error('The employee was not found.');
    const fields = ['dateOfBirth', 'mobile', 'aadhaar', 'pan', 'uan', 'bankAccount', 'bankName'];
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).length !== fields.length
        || Object.keys(values).some((key) => !fields.includes(key))) {
        throw new Error('All fixed employee record fields are required.');
    }
    for (const field of fields) {
        if (typeof values[field] !== 'string' || values[field].length > 120) {
            throw new Error(`${field} must be text no longer than 120 characters.`);
        }
    }
    const dateOfBirth = values.dateOfBirth.trim();
    if (dateOfBirth) {
        const date = new Date(`${dateOfBirth}T00:00:00Z`);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)
            || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== dateOfBirth) {
            throw new Error('Date of birth must be a valid date.');
        }
    }
    database.prepare(`
        UPDATE payroll_employees
        SET date_of_birth = @dateOfBirth, mobile = @mobile, aadhaar = @aadhaar,
            pan = @pan, uan = @uan, bank_account = @bankAccount, bank_name = @bankName,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @employeeId
    `).run({
        ...Object.fromEntries(fields.map((field) => [field, values[field].trim()])),
        dateOfBirth: dateOfBirth || null,
        employeeId
    });
    return { employeeId };
}

function createAdvance(database, values) {
    const fields = ['employeeId', 'advanceType', 'openingBalance', 'alreadyRecovered', 'monthlyDeduction', 'remarks'];
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).length !== fields.length
        || Object.keys(values).some((key) => !fields.includes(key))) {
        throw new Error('All advance details are required.');
    }
    const employeeId = typeof values.employeeId === 'string' ? values.employeeId.trim() : '';
    const employee = employeeId && employeeId.length <= 40
        ? database.prepare('SELECT status FROM payroll_employees WHERE id = ?').get(employeeId)
        : null;
    if (!employee || employee.status !== 'active') {
        throw new Error('Choose an employee in the portal.');
    }
    if (!['regular', 'school'].includes(values.advanceType)) {
        throw new Error('Advance type must be regular or school.');
    }
    for (const field of ['openingBalance', 'alreadyRecovered', 'monthlyDeduction']) {
        if (typeof values[field] !== 'number' || !Number.isFinite(values[field])
            || values[field] < 0 || values[field] > 100000000) {
            throw new Error(`${field} must be between 0 and 100,000,000.`);
        }
    }
    if (values.openingBalance <= 0) throw new Error('Original amount must be greater than zero.');
    if (values.alreadyRecovered > values.openingBalance) {
        throw new Error('Already recovered cannot exceed the original amount.');
    }
    if (typeof values.remarks !== 'string' || values.remarks.length > 500) {
        throw new Error('Remarks must be text up to 500 characters.');
    }
    const result = database.prepare(`
        INSERT INTO payroll_advances (
            employee_id, advance_type, opening_balance, recovered_before_migration,
            current_balance, monthly_deduction, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        employeeId,
        values.advanceType,
        values.openingBalance,
        values.alreadyRecovered,
        values.openingBalance - values.alreadyRecovered,
        values.monthlyDeduction,
        values.remarks.trim()
    );
    return { id: Number(result.lastInsertRowid), employeeId };
}

function updateAdvance(database, advanceId, values) {
    const id = Number(advanceId);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('The advance request is invalid.');
    const advance = database.prepare(
        'SELECT id, current_balance AS currentBalance FROM payroll_advances WHERE id = ?'
    ).get(id);
    if (!advance) throw new Error('The advance was not found.');
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).length !== 3
        || !['monthlyDeduction', 'remarks', 'isActive'].every((key) => Object.hasOwn(values, key))) {
        throw new Error('Advance updates must include the monthly deduction, remarks, and status.');
    }
    if (typeof values.monthlyDeduction !== 'number' || !Number.isFinite(values.monthlyDeduction)
        || values.monthlyDeduction < 0 || values.monthlyDeduction > 100000000) {
        throw new Error('Monthly deduction must be between 0 and 100,000,000.');
    }
    if (typeof values.remarks !== 'string' || values.remarks.length > 500) {
        throw new Error('Remarks must be text up to 500 characters.');
    }
    if (typeof values.isActive !== 'boolean' || (values.isActive && advance.currentBalance <= 0)) {
        throw new Error('A closed or paid advance cannot be reopened without a positive balance.');
    }
    database.prepare(`
        UPDATE payroll_advances
        SET monthly_deduction = ?, remarks = ?, is_active = ?
        WHERE id = ?
    `).run(values.monthlyDeduction, values.remarks.trim(), values.isActive ? 1 : 0, id);
    return { id };
}

function validateAttendanceImport(database, rows) {
    const settings = loadSettings(database);
    if (database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(settings.period)) {
        throw new AttendanceImportError('This payroll period is already archived.');
    }
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5000) {
        throw new AttendanceImportError('The attendance file must contain employee rows.');
    }
    const allEmployees = database.prepare(
        'SELECT id, name, status FROM payroll_employees'
    ).all();
    const employeeById = new Map(allEmployees.map((employee) => [employee.id, employee]));
    const activeIds = new Set(allEmployees
        .filter((employee) => employee.status === 'active')
        .map((employee) => employee.id));
    const seen = new Set();
    const fields = [
        'workDays',
        'leaveDays',
        'longestContinuousSpell',
        'processAllowance',
        'punctualIncentive',
        'fullAttendanceBonus'
    ];
    const normalized = rows.map((row, index) => {
        const rowNumber = index + 2;
        if (!row || typeof row !== 'object' || Array.isArray(row)
            || Object.keys(row).length !== fields.length + 1
            || !['employeeId', ...fields].every((field) => Object.hasOwn(row, field))) {
            throw new AttendanceImportError(`Attendance row ${rowNumber} is missing required fields.`);
        }
        const employeeId = typeof row.employeeId === 'string' ? row.employeeId.trim() : '';
        const employee = employeeById.get(employeeId);
        if (!employee) throw new AttendanceImportError(`Attendance row ${rowNumber} has unknown employee ID "${employeeId}".`);
        if (employee.status !== 'active') {
            throw new AttendanceImportError(`Attendance row ${rowNumber} belongs to inactive employee ${employeeId}.`);
        }
        if (seen.has(employeeId)) throw new AttendanceImportError(`Employee ${employeeId} appears more than once in the attendance file.`);
        seen.add(employeeId);
        const values = { employeeId };
        for (const field of fields) {
            const value = row[field];
            const max = ['processAllowance', 'punctualIncentive', 'fullAttendanceBonus']
                .includes(field) ? 10000000 : settings.calendarDays;
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
                throw new AttendanceImportError(`Attendance row ${rowNumber}: ${field} must be between 0 and ${max}.`);
            }
            values[field] = value;
        }
        if (values.workDays + values.leaveDays > settings.calendarDays) {
            throw new AttendanceImportError(`Attendance row ${rowNumber}: work days plus leave days cannot exceed ${settings.calendarDays}.`);
        }
        if (values.longestContinuousSpell > values.leaveDays) {
            throw new AttendanceImportError(`Attendance row ${rowNumber}: longest continuous spell cannot exceed leave days.`);
        }
        return values;
    });
    const missing = [...activeIds].filter((employeeId) => !seen.has(employeeId));
    if (missing.length) {
        throw new AttendanceImportError(`Attendance file is missing ${missing.length} active employee${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`);
    }
    if (seen.size !== activeIds.size) {
        throw new AttendanceImportError('Attendance file must contain exactly one row for every active employee.');
    }
    return { period: settings.period, calendarDays: settings.calendarDays, rows: normalized };
}

function saveAttendanceImport(database, userId, rows) {
    const transaction = database.transaction(() => {
        const validated = validateAttendanceImport(database, rows);
        const save = database.prepare(`
            INSERT INTO payroll_attendance (
                period, employee_id, work_days, leave_days, longest_continuous_spell,
                process_allowance, punctual_incentive, full_attendance_bonus, updated_by, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT (period, employee_id) DO UPDATE SET
                work_days = excluded.work_days,
                leave_days = excluded.leave_days,
                longest_continuous_spell = excluded.longest_continuous_spell,
                process_allowance = excluded.process_allowance,
                punctual_incentive = excluded.punctual_incentive,
                full_attendance_bonus = excluded.full_attendance_bonus,
                updated_by = excluded.updated_by,
                updated_at = CURRENT_TIMESTAMP
        `);
        validated.rows.forEach((row) => save.run(
            validated.period,
            row.employeeId,
            row.workDays,
            row.leaveDays,
            row.longestContinuousSpell,
            row.processAllowance,
            row.punctualIncentive,
            row.fullAttendanceBonus,
            userId
        ));
        return { period: validated.period, importedCount: validated.rows.length };
    });
    return transaction();
}

function updatePayrollRules(database, values) {
    const definitions = {
        pfWageCeiling: { key: 'pf_wage_ceiling', min: 0, max: 100000000 },
        pfEmployeeRate: { key: 'pf_employee_rate', min: 0, max: 1 },
        epsEmployerRate: { key: 'eps_employer_rate', min: 0, max: 1 },
        epsEmployerCap: { key: 'eps_employer_cap', min: 0, max: 100000000 },
        esiWageCeiling: { key: 'esi_wage_ceiling', min: 0, max: 100000000 },
        esiEmployeeRate: { key: 'esi_employee_rate', min: 0, max: 1 },
        esiEmployerRate: { key: 'esi_employer_rate', min: 0, max: 1 },
        bonusWageCeiling: { key: 'bonus_wage_ceiling', min: 0, max: 100000000 },
        bonusRate: { key: 'bonus_rate', min: 0, max: 1 },
        gratuityDaysPerYear: { key: 'gratuity_days_per_year', min: 0, max: 31 },
        gratuityMinimumYears: { key: 'gratuity_minimum_years', min: 0, max: 80 },
        standardDeduction: { key: 'standard_deduction', min: 0, max: 100000000 },
        salaryPaymentDay: { key: 'salary_payment_day', min: 1, max: 31 },
        maxContinuousClDays: { key: 'max_continuous_cl_days', min: 0, max: 31 }
    };
    if (!values || typeof values !== 'object' || Array.isArray(values)
        || Object.keys(values).length !== Object.keys(definitions).length
        || Object.keys(values).some((key) => !Object.hasOwn(definitions, key))) {
        throw new Error('All shared payroll rule values are required.');
    }
    for (const [field, definition] of Object.entries(definitions)) {
        const value = values[field];
        if (typeof value !== 'number' || !Number.isFinite(value)
            || value < definition.min || value > definition.max) {
            throw new Error(`${field} must be between ${definition.min} and ${definition.max}.`);
        }
    }
    const save = database.prepare(`
        INSERT INTO payroll_settings (key, value) VALUES (?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `);
    const transaction = database.transaction(() => {
        Object.entries(definitions).forEach(([field, definition]) => {
            save.run(definition.key, String(values[field]));
        });
    });
    transaction();
    return { updated: Object.keys(definitions) };
}

function archivePayroll(database, userId) {
    const context = createPayrollContext(database);
    if (context.esiReviewRequired.length) {
        throw new Error('Review ESI coverage statuses for the current contribution period before archiving payroll.');
    }
    if (database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(context.settings.period)) {
        throw new Error('This payroll period is already archived.');
    }
    const activeEmployees = context.employees.filter((employee) => employee.status === 'active');
    if (activeEmployees.some((employee) => employee.salaryDataMissing || employee.leaveDataMissing)) {
        throw new Error('Payroll source data is incomplete: verify all active employee salary and leave records before archiving payroll.');
    }
    const insertRun = database.prepare(
        "INSERT INTO payroll_runs (period, status, archived_by) VALUES (?, 'archived', ?)"
    );
    const insertHistory = database.prepare(`
        INSERT INTO payroll_history (
            period, employee_id, employee_name, company_id, basic_total, hra, fixed_allowance,
            ltw_allowance, punctual_total, process_allowance, gross_salary, employee_pf, employee_esi,
            health_insurance, regular_advance, school_advance, lic_deduction, total_deductions,
            net_payable, cl_used, el_used, lop_days, lop_amount
        ) VALUES (
            @period, @employeeId, @employeeName, @companyId, @basicTotal, @hra, @fixedAllowance,
            @ltwAllowance, @punctualTotal, @processAllowance, @grossSalary, @employeePf, @employeeEsi,
            @healthInsurance, @regularAdvance, @schoolAdvance, @licDeduction, @totalDeductions,
            @netPayable, @clUsed, @elUsed, @lopDays, @lopAmount
        )
    `);
    const updateLeave = database.prepare(`
        UPDATE payroll_employees
        SET cl_balance = MAX(0, cl_balance - @clUsed),
            el_balance = MAX(0, el_balance - @elUsed),
            cl_taken = cl_taken + @clUsed,
            el_taken = el_taken + @elUsed,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = @employeeId
    `);
    const updateAdvance = database.prepare(`
        UPDATE payroll_advances
        SET current_balance = MAX(0, current_balance - MIN(current_balance, monthly_deduction))
        WHERE employee_id = ? AND advance_type = ? AND is_active = 1
    `);
    const resetMonthlyLeave = database.prepare(`
        UPDATE payroll_attendance SET leave_days = 0, longest_continuous_spell = 0
        WHERE period = ?
    `);
    const transaction = database.transaction(() => {
        insertRun.run(context.settings.period, userId);
        activeEmployees.forEach((employee) => {
            const { input, result } = context.payrollById.get(employee.id);
            insertHistory.run({
                period: context.settings.period,
                employeeId: employee.id,
                employeeName: employee.name,
                companyId: employee.companyId,
                ...result,
                processAllowance: input.processAllowance,
                clUsed: result.clUsed,
                elUsed: result.elUsed
            });
            updateLeave.run({
                employeeId: employee.id,
                clUsed: result.clUsed,
                elUsed: result.elUsed
            });
            updateAdvance.run(employee.id, 'regular');
            updateAdvance.run(employee.id, 'school');
        });
        resetMonthlyLeave.run(context.settings.period);
    });
    transaction();
    return { period: context.settings.period, employeeCount: activeEmployees.length };
}

function esiContributionPeriodForPeriod(period) {
    const [year, month] = period.split('-').map(Number);
    if (month >= 4 && month <= 9) return `APRIL ${year} - SEPTEMBER ${year}`;
    if (month >= 10) return `OCTOBER ${year} - MARCH ${year + 1}`;
    return `OCTOBER ${year - 1} - MARCH ${year}`;
}

function nextPayrollPeriod(database, period) {
    const current = loadSettings(database);
    const next = /^20\d{2}-(0[1-9]|1[0-2])$/.test(period) ? period : '';
    if (!next) throw new Error('Choose a valid payroll month.');
    if (!database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(current.period)) {
        throw new Error('Archive the current payroll period before starting the next month.');
    }
    const [year, month] = current.period.split('-').map(Number);
    const expectedDate = new Date(Date.UTC(year, month, 1));
    const expected = `${expectedDate.getUTCFullYear()}-${String(expectedDate.getUTCMonth() + 1).padStart(2, '0')}`;
    if (next !== expected) throw new Error(`The next payroll period must be ${expected}.`);
    if (database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(next)) {
        throw new Error('That payroll period is already archived.');
    }
    const [nextYear, nextMonth] = next.split('-').map(Number);
    const calendarDays = new Date(Date.UTC(nextYear, nextMonth, 0)).getUTCDate();
    const periodLabel = new Date(Date.UTC(nextYear, nextMonth - 1, 1)).toLocaleString('en-US', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    }).toUpperCase();
    const esiPeriod = esiContributionPeriodForPeriod(next);
    const updateSetting = database.prepare(
        'INSERT INTO payroll_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'
    );
    const insertAttendance = database.prepare(`
        INSERT INTO payroll_attendance (period, employee_id) VALUES (?, ?)
        ON CONFLICT (period, employee_id) DO NOTHING
    `);
    const transaction = database.transaction(() => {
        [
            ['payroll_period', next],
            ['calendar_days', String(calendarDays)],
            ['period_label', periodLabel],
            ['as_of_date', new Date(Date.UTC(nextYear, nextMonth, 0)).toISOString().slice(0, 10)],
            ['esi_contribution_period', esiPeriod]
        ].forEach(([key, value]) => updateSetting.run(key, value));
        database.prepare('SELECT id FROM payroll_employees').all()
            .forEach(({ id }) => insertAttendance.run(next, id));
    });
    transaction();
    return { period: next, periodLabel, calendarDays, esiContributionPeriod: esiPeriod };
}

function updateEsiCoverage(database, employeeId, status) {
    if (!['Y', 'N'].includes(status)) throw new Error('ESI coverage status must be Y or N.');
    const settings = loadSettings(database);
    const employee = database.prepare(
        'SELECT id, joining_date FROM payroll_employees WHERE id = ?'
    ).get(employeeId);
    if (!employee) throw new Error('The employee was not found.');
    const month = Number(settings.period.slice(5, 7));
    const joiningPeriod = employee.joining_date?.slice(0, 7) === settings.period;
    if (![4, 10].includes(month) && !joiningPeriod) {
        throw new Error('ESI coverage can only be reviewed at the start of a contribution period or when an employee joins.');
    }
    database.prepare(`
        UPDATE payroll_employees
        SET esi_coverage_status = ?, esi_coverage_period = ?, esi_status_reviewed = date('now'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
    `).run(status, settings.esiContributionPeriod, employeeId);
    return { employeeId, status, contributionPeriod: settings.esiContributionPeriod };
}

module.exports = {
    REGISTER_NAMES,
    AttendanceImportError,
    archivePayroll,
    createAdvance,
    createPayrollContext,
    employeeFixedData,
    esiContributionPeriodForPeriod,
    employeePayroll,
    loadSettings,
    nextPayrollPeriod,
    payrollPreview,
    portalData,
    registerPage,
    saveAttendanceImport,
    updateEmployeePayrollData,
    updateEmployeeFixedData,
    updatePayrollRules,
    updateAdvance,
    updateEsiCoverage,
    validateAttendanceImport
};
