'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { createDatabase } = require('../db/database');
const { importWorkbook } = require('../scripts/import-workbook');
const {
    archivePayroll,
    nextPayrollPeriod,
    portalData,
    payrollPreview,
    registerPage,
    updateEmployeePayrollData,
    updateEsiCoverage
} = require('../lib/payroll-service');

const employeeHeaders = [
    'EMP ID', 'NAME', 'DESIGNATION', 'DATE OF JOINING', 'STAFF TYPE', 'PAN', 'UAN NO.',
    'BANK A/C NO.', 'BASIC', 'FIXED ALLOWANCE', 'PER DAY RATE', 'PF APPL? (Y/N)',
    'ESI EXEMPT? (LOP, Y/N)', 'HEALTH INSURANCE', 'L.I.C.', 'EL ENTITLEMENT',
    'CL ENTITLEMENT', 'EL BALANCE', 'CL BALANCE', 'EL TAKEN', 'CL TAKEN', 'STATUS',
    'EFFECTIVE DATE', 'BANK NAME', 'ESI COVERAGE STATUS (this period)', 'ESI STATUS LAST SET/REVIEWED',
    'DATE OF BIRTH', 'MOBILE NUMBER', 'AADHAAR NUMBER'
];

function appendHeaders(sheet, row, headers) {
    headers.forEach((header, index) => {
        sheet.getRow(row).getCell(index + 1).value = header;
    });
}

function setRow(sheet, row, values) {
    values.forEach((value, index) => {
        sheet.getRow(row).getCell(index + 1).value = value;
    });
}

function createWorkbook() {
    const workbook = new ExcelJS.Workbook();
    const settings = workbook.addWorksheet('Settings');
    settings.getCell('B4').value = 'SEPTEMBER 2026';
    settings.getCell('B5').value = 30;
    [
        [8, 15000], [9, 0.12], [10, 0.0833], [11, 1250], [12, 21000], [13, 0.0075],
        [14, 0.0325], [15, 11], [16, 11], [17, 3], [18, 'JANUARY'], [19, 7000],
        [20, 0.0833], [21, 15], [22, 5], [23, 75000], [24, 'JULY 2026'], [25, 5],
        [26, 'APRIL 2026 - SEPTEMBER 2026']
    ].forEach(([row, value]) => {
        settings.getCell(row, 2).value = value;
    });
    [[0, 400000, 0], [400000, 800000, 0.05], [800000, null, 0.1]].forEach((slab, index) => {
        slab.forEach((value, column) => {
            if (value !== null) settings.getCell(30 + index, column + 1).value = value;
        });
    });

    const active = workbook.addWorksheet('Employee Master - FA');
    appendHeaders(active, 4, employeeHeaders);
    setRow(active, 5, [
        'FA-TEST', 'Synthetic Employee', 'Staff', new Date('2020-01-01T00:00:00Z'),
        'Active', 'ABCDE1234F', '10000000', '1234567890', 30000, 3000, 100, 'Y', 'N',
        0, 0, 11, 11, 0, 0, 0, 0, 'Active', null, 'Synthetic Bank', 'Y', 'APRIL 2026',
        new Date('1990-02-03T00:00:00Z'), '9876543210', '123412341234'
    ]);
    for (const name of ['Employee Master - FR', 'Employee Master - SA']) {
        appendHeaders(workbook.addWorksheet(name), 4, employeeHeaders);
    }

    const attendance = workbook.addWorksheet('Attendance');
    appendHeaders(attendance, 4, [
        'EMP ID', 'NAME', 'COMPANY', 'WORK DAYS', 'LOP (Rs)', 'LEAVE DAYS THIS MONTH',
        'LONGEST CONTINUOUS SPELL (days)', 'CL BAL. BEFORE', 'EL BAL. BEFORE',
        'CL USED THIS MONTH', 'EL USED THIS MONTH', 'PROCESS ALLOWANCE (Rs)',
        'NO. OF LOP DAYS', 'PUNCTUAL INCENTIVE (Rs)', 'FULL ATT. BONUS (Rs)', 'CHECK',
        'ELIGIBLE DAYS', 'TOTAL LATE DAYS', 'LATE DEDUCTION DAYS', 'CL USED (LATE)',
        'EL USED (LATE)', 'SALARY DEDUCTION DAYS (LATE)', 'LATE ATT. DEDUCTION (Rs)',
        'LATE ATTENDANCE DESCRIPTION', 'TOTAL CL USED', 'TOTAL EL USED'
    ]);
    setRow(attendance, 5, [
        'FA-TEST', 'Synthetic Employee', 'THE FLAVORS INDIA PVT LTD', 25, 0, 2,
        1, 10, 1, 0, 0, 100, 0, 50, 50, '', '', 0, 0, 0, 0, 0, 0, '', 0, 0
    ]);

    const history = workbook.addWorksheet('Payroll History');
    appendHeaders(history, 4, [
        'Month', 'EMP ID', 'NAME', 'COMPANY', 'BASIC TOTAL', 'HRA', 'FIXED ALLOWANCE',
        'LTW', 'PUNCTUAL TOTAL', 'PROCESS ALLOWANCE', 'GROSS', 'PF', 'ESI',
        'HEALTH INSURANCE', 'REG ADVANCE', 'SCHOOL ADVANCE', 'LIC', 'TOTAL DEDUCTION',
        'NET', 'CL USED', 'EL USED'
    ]);

    const advances = workbook.addWorksheet('Advance & Loan');
    appendHeaders(advances, 4, [
        'EMP ID', 'NAME', 'COMPANY', 'ADVANCE TYPE', 'OPENING BALANCE', 'MONTHLY DEDUCTION',
        'ALREADY RECOVERED SINCE', 'CURRENT BALANCE', 'NEXT MONTH DEDUCTION',
        'BALANCE AFTER NEXT DEDUCTION', 'REMARKS'
    ]);
    return workbook;
}

test('workbook importer reads source inputs and stores validated leave opening balances', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-import-test-'));
    const workbookPath = path.join(directory, 'synthetic.xlsx');
    const openingBalancesPath = path.join(directory, 'opening-balances.csv');
    const database = createDatabase(path.join(directory, 'portal.sqlite'));
    t.after(() => {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    test('missing source salary data remains visible but blocks payroll actions', async (t) => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-import-missing-test-'));
        const workbookPath = path.join(directory, 'synthetic.xlsx');
        const openingBalancesPath = path.join(directory, 'opening-balances.csv');
        const database = createDatabase(path.join(directory, 'portal.sqlite'));
        t.after(() => {
            database.close();
            fs.rmSync(directory, { recursive: true, force: true });
        });

        const workbook = createWorkbook();
        workbook.getWorksheet('Employee Master - FA').getCell('I5').value = null;
        await workbook.xlsx.writeFile(workbookPath);
        fs.writeFileSync(openingBalancesPath, 'employeeId,elBalance,clBalance\nFA-TEST,0,0\n');
        await importWorkbook({ workbookPath, openingBalancesPath, openingBalancesProvisional: true, database });

        const data = portalData(database, { email: 'admin@example.test', role: 'admin' });
        assert.equal(data.employees.length, 1);
        assert.equal(data.employees[0].baseSalary, null);
        assert.equal(data.employees[0].fixedAllowance, null);
        assert.equal(data.employees[0].perDayRate, null);
        assert.equal(data.employees[0].leaveBalance.elBalance, null);
        assert.equal(data.companyTotals.find((item) => item.companyId === 'flavors-india').grossSalary, null);
        assert.ok(data.warnings.some((message) => message.includes('employee salary record')));
        assert.ok(data.warnings.some((message) => message.includes('leave entitlement or opening balance')));
        assert.equal(registerPage(database, 'Salary Register', 5).rows[0].values[3], 'Review source');
        assert.equal(registerPage(database, 'Leave Master', 5).rows[0].values[3], '');
        assert.throws(() => payrollPreview(database, ['FA-TEST'], '2026-09'), /source data is incomplete/);
        assert.throws(() => archivePayroll(database, null), /source data is incomplete/);
        assert.throws(() => updateEmployeePayrollData(database, 'FA-TEST', {
            basicSalary: 30000,
            fixedAllowance: 3000,
            perDayRate: 100,
            healthInsurance: 0,
            licDeduction: 0,
            elEntitlement: 11,
            clEntitlement: 11,
            elBalance: 12,
            clBalance: 11
        }), /cannot exceed/);
        updateEmployeePayrollData(database, 'FA-TEST', {
            basicSalary: 30000,
            fixedAllowance: 3000,
            perDayRate: 100,
            healthInsurance: 0,
            licDeduction: 0,
            elEntitlement: 11,
            clEntitlement: 11,
            elBalance: 0,
            clBalance: 0
        });
        const corrected = portalData(database, { email: 'admin@example.test', role: 'admin' });
        assert.equal(corrected.dataReview.pendingCount, 0);
        assert.equal(corrected.employees[0].baseSalary, 30000);
        assert.equal(corrected.employees[0].leaveBalance.elBalance, 0);
        assert.ok(!corrected.warnings.some((message) => message.includes('salary record')));
        assert.ok(!corrected.warnings.some((message) => message.includes('leave entitlement')));
        assert.equal(payrollPreview(database, ['FA-TEST'], '2026-09').length, 1);
    });
    await createWorkbook().xlsx.writeFile(workbookPath);
    fs.writeFileSync(openingBalancesPath, 'employeeId,elBalance,clBalance\nFA-TEST,11,11\n');

    const result = await importWorkbook({ workbookPath, openingBalancesPath, database });

    assert.equal(result.employeeCount, 1);
    assert.equal(result.attendanceCount, 1);
    assert.equal(result.historyCount, 0);
    assert.equal(database.prepare('SELECT basic_salary FROM payroll_employees WHERE id = ?').get('FA-TEST').basic_salary, 30000);
    assert.equal(database.prepare('SELECT value FROM payroll_settings WHERE key = ?').get('calendar_days').value, '30');
    assert.equal(database.prepare('SELECT value FROM payroll_settings WHERE key = ?').get('pf_wage_ceiling').value, '25000');
    assert.deepEqual(database.prepare(
        'SELECT date_of_birth, mobile, aadhaar FROM payroll_employees WHERE id = ?'
    ).get('FA-TEST'), {
        date_of_birth: '1990-02-03',
        mobile: '9876543210',
        aadhaar: '123412341234'
    });
    const directoryEmployee = portalData(database, { email: 'reader@example.test', role: 'read-only' })
        .employees.find((employee) => employee.id === 'FA-TEST');
    for (const value of ['1990-02-03', '9876543210', '123412341234', 'ABCDE1234F', '10000000', '1234567890']) {
        assert.equal(JSON.stringify(directoryEmployee).includes(value), false);
    }
    assert.equal(database.prepare('SELECT work_days FROM payroll_attendance WHERE employee_id = ?').get('FA-TEST').work_days, 25);

    const preview = payrollPreview(database, ['FA-TEST'], '2026-09');
    assert.equal(preview[0].grossSalary, 38200);
    const attendanceRegister = registerPage(database, 'Attendance', 5);
    assert.equal(attendanceRegister.rows[0].values[3], 25);

    assert.deepEqual(archivePayroll(database, null), { period: '2026-09', employeeCount: 1 });
    assert.equal(database.prepare('SELECT cl_balance FROM payroll_employees WHERE id = ?').get('FA-TEST').cl_balance, 9);
    assert.equal(database.prepare('SELECT leave_days FROM payroll_attendance WHERE period = ? AND employee_id = ?')
        .get('2026-09', 'FA-TEST').leave_days, 0);
    assert.throws(() => archivePayroll(database, null), /already archived/);

    assert.equal(nextPayrollPeriod(database, '2026-10').period, '2026-10');
    assert.throws(() => payrollPreview(database, ['FA-TEST'], '2026-10'), /ESI coverage statuses/);
    assert.deepEqual(updateEsiCoverage(database, 'FA-TEST', 'N'), {
        employeeId: 'FA-TEST',
        status: 'N',
        contributionPeriod: 'OCTOBER 2026 - MARCH 2027'
    });
    assert.equal(payrollPreview(database, ['FA-TEST'], '2026-10')[0].employeeEsi, 0);
});
