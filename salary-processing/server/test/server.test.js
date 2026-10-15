'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-portal-server-test-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portal.sqlite');
process.env.SESSION_SECRET = 'synthetic-test-session-secret-long-enough';
process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
process.env.NODE_ENV = 'test';

const { app, database, sessionStore } = require('../server');
let server;
let baseUrl;

test.before(async () => {
    const passwordHash = await bcrypt.hash('synthetic-test-password-123', 4);
    database.prepare(
        'INSERT INTO portal_users (email, password_hash, role) VALUES (?, ?, ?)'
    ).run('reader@example.test', passwordHash, 'read-only');
    const adminPasswordHash = await bcrypt.hash('synthetic-admin-password-123', 4);
    database.prepare(
        'INSERT INTO portal_users (email, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin@example.test', adminPasswordHash, 'admin');
    database.prepare(
        'INSERT INTO payroll_companies (id, name, short_name) VALUES (?, ?, ?)'
    ).run('synthetic-company', 'Synthetic Company', 'Synthetic');
    database.prepare(`
        INSERT INTO payroll_employees (
            id, company_id, name, staff_type, basic_salary, salary_data_missing, leave_data_missing
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('SYNTHETIC-1', 'synthetic-company', 'Synthetic Employee', 'active', 0, 1, 1);
    const settings = {
        payroll_period: '2026-08',
        period_label: 'AUGUST 2026',
        calendar_days: '31',
        max_continuous_cl_days: '3',
        pf_wage_ceiling: '25000',
        pf_employee_rate: '0.12',
        eps_employer_rate: '0.0833',
        eps_employer_cap: '1250',
        esi_wage_ceiling: '21000',
        esi_employee_rate: '0.0075',
        esi_employer_rate: '0.0325',
        standard_deduction: '75000',
        bonus_wage_ceiling: '7000',
        bonus_rate: '0.0833',
        gratuity_days_per_year: '15',
        gratuity_minimum_years: '5',
        salary_payment_day: '5',
        esi_contribution_period: 'APRIL 2026 - SEPTEMBER 2026'
    };
    const saveSetting = database.prepare('INSERT INTO payroll_settings (key, value) VALUES (?, ?)');
    Object.entries(settings).forEach(([key, value]) => saveSetting.run(key, value));
    database.prepare(
        'INSERT INTO payroll_tax_slabs (lower_bound, upper_bound, rate) VALUES (0, NULL, 0)'
    ).run();
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    sessionStore.close();
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('portal serves the local sign-in page and rejects unauthenticated data requests', async () => {
    const pageResponse = await fetch(baseUrl);
    const page = await pageResponse.text();
    assert.equal(pageResponse.status, 200);
    assert.match(page, /Sign in to your portal/);
    assert.doesNotMatch(page, /Sign in with Google|Continue with Google|Google OAuth/);

    const dataResponse = await fetch(`${baseUrl}/api/portal-data`);
    assert.equal(dataResponse.status, 401);
    assert.equal((await dataResponse.json()).error, 'Sign in to continue.');
});

test('local login issues a session and read-only accounts cannot reveal or update payroll data', async () => {
    const rejected = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { Origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.test', password: 'wrong-password' })
    });

    test('only administrators can save verified employee salary and leave source data', async () => {
        const loginResponse = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { Origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'admin@example.test', password: 'synthetic-admin-password-123' })
        });
        assert.equal(loginResponse.status, 200);
        const login = await loginResponse.json();
        const sessionCookie = loginResponse.headers.getSetCookie()[0].split(';', 1)[0];
        const headers = {
            Origin: process.env.APP_ORIGIN,
            Cookie: sessionCookie,
            'X-CSRF-Token': login.csrfToken,
            'Content-Type': 'application/json'
        };
        const values = {
            basicSalary: 30000,
            fixedAllowance: 3000,
            perDayRate: 100,
            healthInsurance: 0,
            licDeduction: 0,
            elEntitlement: 11,
            clEntitlement: 11,
            elBalance: 8,
            clBalance: 9
        };

        const invalidResponse = await fetch(`${baseUrl}/api/employee-payroll-data`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                employeeId: 'SYNTHETIC-1',
                values: { ...values, elBalance: 12 },
                confirmed: true
            })
        });
        assert.equal(invalidResponse.status, 400);
        const unconfirmedResponse = await fetch(`${baseUrl}/api/employee-payroll-data`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ employeeId: 'SYNTHETIC-1', values, confirmed: false })
        });
        assert.equal(unconfirmedResponse.status, 400);

        const saveResponse = await fetch(`${baseUrl}/api/employee-payroll-data`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ employeeId: 'SYNTHETIC-1', values, confirmed: true })
        });
        assert.equal(saveResponse.status, 200);
        assert.deepEqual(database.prepare(`
            SELECT basic_salary, salary_data_missing, el_balance, cl_balance, el_taken, cl_taken, leave_data_missing
            FROM payroll_employees WHERE id = ?
        `).get('SYNTHETIC-1'), {
            basic_salary: 30000,
            salary_data_missing: 0,
            el_balance: 8,
            cl_balance: 9,
            el_taken: 3,
            cl_taken: 2,
            leave_data_missing: 0
        });
        assert.equal(database.prepare(
            "SELECT COUNT(*) AS count FROM portal_audit_log WHERE action = 'employee-payroll-data-verified'"
        ).get().count, 1);

        const fixedData = {
            dateOfBirth: '1990-02-03',
            mobile: '9876543210',
            aadhaar: '123412341234',
            pan: 'ABCDE1234F',
            uan: '10000000',
            bankAccount: '001234567890',
            bankName: 'Synthetic Bank'
        };
        const fixedSave = await fetch(`${baseUrl}/api/employee-fixed-data`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ employeeId: 'SYNTHETIC-1', values: fixedData, confirmed: true })
        });
        assert.equal(fixedSave.status, 200);
        const fixedRead = await fetch(`${baseUrl}/api/employee-fixed-data/read`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ employeeId: 'SYNTHETIC-1' })
        });
        assert.equal(fixedRead.status, 200);
        assert.deepEqual((await fixedRead.json()).values, fixedData);
        assert.equal(database.prepare(
            "SELECT COUNT(*) AS count FROM portal_audit_log WHERE action = 'employee-fixed-data-updated'"
        ).get().count, 1);

        const payrollRules = {
            pfWageCeiling: 25000,
            pfEmployeeRate: 0.12,
            epsEmployerRate: 0.0833,
            epsEmployerCap: 1250,
            esiWageCeiling: 21000,
            esiEmployeeRate: 0.0075,
            esiEmployerRate: 0.0325,
            bonusWageCeiling: 7000,
            bonusRate: 0.0833,
            gratuityDaysPerYear: 15,
            gratuityMinimumYears: 5,
            standardDeduction: 75000,
            salaryPaymentDay: 5,
            maxContinuousClDays: 3
        };
        const rulesSave = await fetch(`${baseUrl}/api/payroll-rules`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ values: payrollRules })
        });
        assert.equal(rulesSave.status, 200);
        assert.equal(database.prepare(
            "SELECT value FROM payroll_settings WHERE key = 'pf_wage_ceiling'"
        ).get().value, '25000');

        const advanceCreate = await fetch(`${baseUrl}/api/advances`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                values: {
                    employeeId: 'SYNTHETIC-1',
                    advanceType: 'regular',
                    openingBalance: 12000,
                    alreadyRecovered: 2000,
                    monthlyDeduction: 1000,
                    remarks: 'Synthetic test'
                }
            })
        });
        assert.equal(advanceCreate.status, 201);
        const createdAdvance = await advanceCreate.json();
        assert.equal(database.prepare(
            'SELECT current_balance FROM payroll_advances WHERE id = ?'
        ).get(createdAdvance.id).current_balance, 10000);
        const advanceUpdate = await fetch(`${baseUrl}/api/advances/${createdAdvance.id}`, {
            method: 'PATCH',
            headers,
            body: JSON.stringify({
                values: { monthlyDeduction: 1500, remarks: 'Updated test', isActive: true }
            })
        });
        assert.equal(advanceUpdate.status, 200);
        assert.equal(database.prepare(
            'SELECT monthly_deduction FROM payroll_advances WHERE id = ?'
        ).get(createdAdvance.id).monthly_deduction, 1500);
        const portalDataResponse = await fetch(`${baseUrl}/api/portal-data`, {
            headers: { Cookie: sessionCookie }
        });
        assert.equal(portalDataResponse.status, 200);
        const portalData = await portalDataResponse.json();
        assert.equal(portalData.canManageAdvances, true);
        assert.equal(portalData.advances.length, 1);
        assert.equal(Object.hasOwn(portalData.employees[0], 'dateOfBirth'), false);
        assert.deepEqual(portalData.employees[0].protectedFields.map((field) => field.key), [
            'dateOfBirth', 'pan', 'mobile', 'aadhaar', 'uan', 'bankAccount', 'bankName'
        ]);
        assert.notEqual(portalData.employees[0].protectedFields[0].maskedValue, '1990-02-03');
        assert.match(portalData.employees[0].protectedFields[0].maskedValue, /^\*+/);

        database.prepare(`
            INSERT INTO payroll_employees (
                id, company_id, name, staff_type, basic_salary, salary_data_missing, leave_data_missing
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('SYNTHETIC-2', 'synthetic-company', 'Second Synthetic Employee', 'active', 0, 1, 1);
        const csv = Buffer.from([
            'EMP ID,WORK DAYS,LEAVE DAYS THIS MONTH,LONGEST CONTINUOUS SPELL,PROCESS ALLOWANCE,PUNCTUAL INCENTIVE,FULL ATT. BONUS',
            'SYNTHETIC-1,25,2,2,100,50,500',
            'SYNTHETIC-2,24,3,2,0,25,0'
        ].join('\r\n'));
        const uploadHeaders = {
            ...headers,
            'Content-Type': 'text/csv',
            'X-Upload-Filename': 'synthetic-attendance.csv'
        };
        const previewResponse = await fetch(`${baseUrl}/api/attendance/preview`, {
            method: 'POST',
            headers: uploadHeaders,
            body: csv
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json();
        assert.equal(preview.rows.length, 2);
        assert.equal(preview.rows[0].employeeId, 'SYNTHETIC-1');
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM payroll_attendance').get().count, 0);

        const incompletePreview = await fetch(`${baseUrl}/api/attendance/preview`, {
            method: 'POST',
            headers: uploadHeaders,
            body: Buffer.from([
                'EMP ID,WORK DAYS,LEAVE DAYS THIS MONTH,LONGEST CONTINUOUS SPELL,PROCESS ALLOWANCE,PUNCTUAL INCENTIVE,FULL ATT. BONUS',
                'SYNTHETIC-1,25,2,2,100,50,500'
            ].join('\r\n'))
        });
        assert.equal(incompletePreview.status, 400);
        assert.match((await incompletePreview.json()).error, /missing 1 active employee/);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM payroll_attendance').get().count, 0);

        const duplicatePreview = await fetch(`${baseUrl}/api/attendance/preview`, {
            method: 'POST',
            headers: uploadHeaders,
            body: Buffer.from([
                'EMP ID,WORK DAYS,LEAVE DAYS THIS MONTH,LONGEST CONTINUOUS SPELL,PROCESS ALLOWANCE,PUNCTUAL INCENTIVE,FULL ATT. BONUS',
                'SYNTHETIC-1,25,2,2,100,50,500',
                'SYNTHETIC-1,25,2,2,100,50,500'
            ].join('\r\n'))
        });
        assert.equal(duplicatePreview.status, 400);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM payroll_attendance').get().count, 0);

        const invalidImportResponse = await fetch(`${baseUrl}/api/attendance/import`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                rows: [preview.rows[0], { ...preview.rows[1], workDays: 32 }]
            })
        });
        assert.equal(invalidImportResponse.status, 400);
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM payroll_attendance').get().count, 0);

        const importResponse = await fetch(`${baseUrl}/api/attendance/import`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ rows: preview.rows })
        });
        assert.equal(importResponse.status, 200);
        assert.deepEqual(database.prepare(`
            SELECT work_days, leave_days, longest_continuous_spell, process_allowance,
                punctual_incentive, full_attendance_bonus
            FROM payroll_attendance
            WHERE period = ? AND employee_id = ?
        `).get(preview.period, 'SYNTHETIC-1'), {
            work_days: 25,
            leave_days: 2,
            longest_continuous_spell: 2,
            process_allowance: 100,
            punctual_incentive: 50,
            full_attendance_bonus: 500
        });

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Attendance');
        sheet.addRow([
            'EMP ID', 'WORK DAYS', 'LEAVE DAYS THIS MONTH', 'LONGEST CONTINUOUS SPELL',
            'PROCESS ALLOWANCE', 'PUNCTUAL INCENTIVE', 'FULL ATT. BONUS'
        ]);
        sheet.addRow(['SYNTHETIC-1', 24, 3, 2, 0, 25, 0]);
        sheet.addRow(['SYNTHETIC-2', 24, 3, 2, 0, 25, 0]);
        const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
        const xlsxPreviewResponse = await fetch(`${baseUrl}/api/attendance/preview`, {
            method: 'POST',
            headers: {
                ...headers,
                'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'X-Upload-Filename': 'synthetic-attendance.xlsx'
            },
            body: xlsx
        });
        assert.equal(xlsxPreviewResponse.status, 200);
        assert.equal((await xlsxPreviewResponse.json()).rows[0].workDays, 24);
    });

    test('development sign-in accepts localhost and loopback origin aliases only', async () => {
        const accepted = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { Origin: 'http://localhost:3000', 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'reader@example.test', password: 'synthetic-test-password-123' })
        });
        assert.equal(accepted.status, 200);

        const rejected = await fetch(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { Origin: 'http://localhost.attacker.test:3000', 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'reader@example.test', password: 'synthetic-test-password-123' })
        });
        assert.equal(rejected.status, 403);
    });
    assert.equal(rejected.status, 401);

    const loginResponse = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { Origin: process.env.APP_ORIGIN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.test', password: 'synthetic-test-password-123' })
    });
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    assert.equal(login.user.role, 'read-only');
    const sessionCookie = loginResponse.headers.getSetCookie()[0].split(';', 1)[0];
    const csrfHeaders = {
        Origin: process.env.APP_ORIGIN,
        Cookie: sessionCookie,
        'X-CSRF-Token': login.csrfToken,
        'Content-Type': 'application/json'
    };

    const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: sessionCookie } });
    assert.equal(sessionResponse.status, 200);

    const revealResponse = await fetch(`${baseUrl}/api/reveal`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({ employeeId: 'SYNTHETIC-1', columnNumber: 1 })
    });
    assert.equal(revealResponse.status, 403);

    const attendanceResponse = await fetch(`${baseUrl}/api/attendance`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({ employeeId: 'SYNTHETIC-1', fields: { workDays: 10 } })
    });
    assert.equal(attendanceResponse.status, 403);
    const attendanceImportResponse = await fetch(`${baseUrl}/api/attendance/preview`, {
        method: 'POST',
        headers: {
            ...csrfHeaders,
            'Content-Type': 'text/csv',
            'X-Upload-Filename': 'blocked.csv'
        },
        body: Buffer.from('EMP ID')
    });
    assert.equal(attendanceImportResponse.status, 403);

    const employeeDataResponse = await fetch(`${baseUrl}/api/employee-payroll-data`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({})
    });
    assert.equal(employeeDataResponse.status, 403);

    const fixedDataReadResponse = await fetch(`${baseUrl}/api/employee-fixed-data/read`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({ employeeId: 'SYNTHETIC-1' })
    });
    assert.equal(fixedDataReadResponse.status, 403);

    const fixedDataUpdateResponse = await fetch(`${baseUrl}/api/employee-fixed-data`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({})
    });
    assert.equal(fixedDataUpdateResponse.status, 403);

    const payrollRulesResponse = await fetch(`${baseUrl}/api/payroll-rules`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({ values: {} })
    });
    assert.equal(payrollRulesResponse.status, 403);
    const advanceCreateResponse = await fetch(`${baseUrl}/api/advances`, {
        method: 'POST',
        headers: csrfHeaders,
        body: JSON.stringify({ values: {} })
    });
    assert.equal(advanceCreateResponse.status, 403);

    const logoutResponse = await fetch(`${baseUrl}/api/logout`, {
        method: 'POST',
        headers: csrfHeaders
    });
    assert.equal(logoutResponse.status, 200);

    const expiredSessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { Cookie: sessionCookie } });
    assert.equal(expiredSessionResponse.status, 401);
});
