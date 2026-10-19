'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const express = require('express');
const ExcelJS = require('exceljs');
const { Readable } = require('node:stream');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { rateLimit } = require('express-rate-limit');
const helmet = require('helmet');
const { createDatabase } = require('./db/database');
const { createPasswordRecoveryService } = require('./lib/password-recovery');
const {
    AttendanceImportError,
    archivePayroll,
    createAdvance,
    createPayrollContext,
    employeeFixedData,
    loadSettings,
    nextPayrollPeriod,
    payrollPreview,
    portalData,
    registerPage,
    saveAttendanceImport,
    updateEmployeeFixedData,
    updateEmployeePayrollData,
    updatePayrollRules,
    updateAdvance,
    updateEsiCoverage,
    validateAttendanceImport
} = require('./lib/payroll-service');
const SqliteSessionStore = require('./lib/sqlite-session-store');

const app = express();
const database = createDatabase();
const sessionStore = new SqliteSessionStore(database);
const portalRoot = path.resolve(__dirname, '..');
const sessionSecret = process.env.SESSION_SECRET || '';
const passwordRecoveryService = createPasswordRecoveryService(database);
const appOrigin = process.env.APP_ORIGIN || '';
const cookieSecure = appOrigin.startsWith('https://');
const production = process.env.NODE_ENV === 'production';
const dummyPasswordHash = bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);

function assertConfiguration() {
    if (sessionSecret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters.');
    if (!appOrigin || !/^https?:\/\//i.test(appOrigin)) throw new Error('APP_ORIGIN must be the exact portal origin.');
    if (production && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS in production.');
    if (production && process.env.TRUST_PROXY !== 'true') {
        throw new Error('Set TRUST_PROXY=true when terminating HTTPS at a trusted reverse proxy.');
    }
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function safeEqual(left, right) {
    const leftBytes = Buffer.from(left || '');
    const rightBytes = Buffer.from(right || '');
    return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function requireSameOrigin(req, res, next) {
    const origin = req.get('origin');
    let allowed = false;
    try {
        const requestUrl = new URL(origin);
        const configuredUrl = new URL(appOrigin);
        allowed = safeEqual(requestUrl.origin, configuredUrl.origin);
        if (!allowed && !production) {
            const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
            allowed = requestUrl.protocol === configuredUrl.protocol
                && requestUrl.port === configuredUrl.port
                && localHosts.has(requestUrl.hostname)
                && localHosts.has(configuredUrl.hostname);
        }
    } catch {
        allowed = false;
    }
    if (!allowed) {
        return res.status(403).json({ error: 'Request origin was not allowed.' });
    }
    next();
}

const csrfProtection = (req, res, next) => {
    if (!req.session.csrfToken || !safeEqual(req.get('x-csrf-token'), req.session.csrfToken)) {
        return res.status(403).json({ error: 'Your session expired. Reload the portal and try again.' });
    }
    next();
};

const requireUser = asyncRoute(async (req, res, next) => {
    if (!req.session.userId) return res.status(401).json({ error: 'Sign in to continue.' });
    const user = database.prepare(
        'SELECT id, email, role FROM portal_users WHERE id = ? AND disabled_at IS NULL'
    ).get(req.session.userId);
    if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: 'This portal account is disabled. Contact an administrator.' });
    }
    req.user = user;
    next();
});

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Your portal account cannot perform this action.' });
        next();
    };
}

const attendanceHeaders = {
    employeeId: ['EMP ID', 'EMPLOYEE ID', 'EMPLOYEE CODE', 'EMPLOYEE NO'],
    workDays: ['WORK DAYS', 'WORKING DAYS'],
    leaveDays: ['LEAVE DAYS THIS MONTH', 'LEAVE DAYS'],
    longestContinuousSpell: ['LONGEST CONTINUOUS SPELL', 'LONGEST SPELL'],
    processAllowance: ['PROCESS ALLOWANCE'],
    punctualIncentive: ['PUNCTUAL INCENTIVE'],
    fullAttendanceBonus: ['FULL ATT BONUS', 'FULL ATTENDANCE BONUS']
};

function normalizedAttendanceHeader(value) {
    return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

function attendanceCellText(cell) {
    const value = cell.value;
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
        if (typeof value.text === 'string') return value.text.trim();
        if (Object.hasOwn(value, 'result')) return attendanceCellText({ value: value.result });
    }
    return String(value).trim();
}

async function parseAttendanceFile(buffer, filename) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new AttendanceImportError('Choose a non-empty CSV or .xlsx attendance file.');
    }
    if (buffer.length > 10 * 1024 * 1024) {
        throw new AttendanceImportError('Attendance files must be 10 MB or smaller.');
    }
    const extension = filename.toLowerCase().split('.').pop();
    if (!['csv', 'xlsx'].includes(extension)) {
        throw new AttendanceImportError('Attendance import supports CSV and .xlsx files only.');
    }
    const workbook = new ExcelJS.Workbook();
    try {
        if (extension === 'csv') {
            await workbook.csv.read(Readable.from([buffer]));
        } else {
            await workbook.xlsx.load(buffer);
        }
    } catch {
        throw new AttendanceImportError('The file could not be read as CSV or .xlsx. Check the file contents and try again.');
    }
    const worksheet = workbook.worksheets[0];
    if (!worksheet || worksheet.rowCount < 2) {
        throw new AttendanceImportError('The attendance file needs a header row and at least one employee row.');
    }
    const headerRow = worksheet.getRow(1);
    const columns = {};
    for (const [field, aliases] of Object.entries(attendanceHeaders)) {
        const matching = [];
        headerRow.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
            if (aliases.includes(normalizedAttendanceHeader(attendanceCellText(cell)))) {
                matching.push(columnNumber);
            }
        });
        if (matching.length !== 1) {
            throw new AttendanceImportError(`The attendance file must have exactly one "${aliases[0]}" column.`);
        }
        columns[field] = matching[0];
    }
    const rows = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
        const row = worksheet.getRow(rowNumber);
        const employeeId = attendanceCellText(row.getCell(columns.employeeId));
        const fieldTexts = Object.fromEntries(
            Object.keys(attendanceHeaders).filter((field) => field !== 'employeeId')
                .map((field) => [field, attendanceCellText(row.getCell(columns[field]))])
        );
        if (!employeeId && Object.values(fieldTexts).every((value) => !value)) continue;
        if (!employeeId) throw new AttendanceImportError(`Attendance row ${rowNumber} is missing an employee ID.`);
        const values = { employeeId };
        for (const [field, text] of Object.entries(fieldTexts)) {
            const optionalAmount = ['processAllowance', 'punctualIncentive', 'fullAttendanceBonus'].includes(field);
            if (!text && !optionalAmount) {
                throw new AttendanceImportError(`Attendance row ${rowNumber} is missing ${field}.`);
            }
            const number = text ? Number(text.replace(/[₹,\s]/g, '')) : 0;
            if (!Number.isFinite(number)) throw new AttendanceImportError(`Attendance row ${rowNumber} has an invalid ${field}.`);
            values[field] = number;
        }
        rows.push(values);
    }
    return rows;
}

async function audit(user, action, target = null) {
    database.prepare(
        'INSERT INTO portal_audit_log (user_id, user_email, action, target) VALUES (?, ?, ?, ?)'
    ).run(user.id || null, user.email, action, target);
}

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            baseUri: ["'self'"],
            frameAncestors: ["'none'"],
            formAction: ["'self'"]
        }
    },
    referrerPolicy: { policy: 'no-referrer' }
}));
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});
app.use(express.json({ limit: '2mb', strict: true }));
app.use(session({
    name: 'salary.portal.session',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000
    }
}));

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Wait a while and try again.' }
});

const passwordResetCompleteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many password reset attempts. Wait a while and try again.' }
});

app.get('/api/session', requireUser, (req, res) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.json({
        authenticated: true,
        user: { id: req.user.id, email: req.user.email, role: req.user.role },
        csrfToken: req.session.csrfToken
    });
});

app.post('/api/login', requireSameOrigin, loginLimiter, asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!email || email.length > 254 || !password || password.length > 1024) {
        return res.status(400).json({ error: 'Enter your account email and password.' });
    }
    const user = database.prepare(
        'SELECT id, email, role, password_hash FROM portal_users WHERE email = ? AND disabled_at IS NULL'
    ).get(email);
    const passwordHash = user ? user.password_hash : await dummyPasswordHash;
    const validPassword = await bcrypt.compare(password, passwordHash);
    if (!user || !validPassword) {
        try {
            await audit({ id: null, email }, 'login-failed');
        } catch (error) {
            console.warn('Could not write the failed-login audit event:', error.message);
        }
        return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    await new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    database.prepare('UPDATE portal_users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
    await audit(user, 'login-succeeded');
    res.json({
        authenticated: true,
        user: { id: user.id, email: user.email, role: user.role },
        csrfToken: req.session.csrfToken
    });
}));

app.post('/api/password-reset/complete', requireSameOrigin, passwordResetCompleteLimiter, asyncRoute(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const recoveryKey = typeof req.body.recoveryKey === 'string' ? req.body.recoveryKey : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254
        || !/^[A-Za-z0-9_-]{43}$/.test(recoveryKey) || password.length < 12 || password.length > 1024) {
        return res.status(400).json({ error: 'Enter a valid email, recovery key, and password of at least 12 characters.' });
    }
    if (!await passwordRecoveryService.resetPassword(email, recoveryKey, password)) {
        return res.status(400).json({ error: 'The recovery key is invalid or has already been used.' });
    }
    res.json({ message: 'Your password was reset. Sign in with your new password.' });
}));

app.post('/api/logout', requireSameOrigin, requireUser, csrfProtection, asyncRoute(async (req, res) => {
    await audit(req.user, 'logout');
    await new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
    res.clearCookie('salary.portal.session', { httpOnly: true, secure: cookieSecure, sameSite: 'strict' });
    res.json({ authenticated: false });
}));

app.get('/api/portal-data', requireUser, asyncRoute(async (req, res) => {
    res.json(portalData(database, req.user));
}));

app.get('/api/register', requireUser, asyncRoute(async (req, res) => {
    try {
        res.json(registerPage(database, String(req.query.registerName || ''), req.query.startRow || 5));
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}));

app.post('/api/reveal', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const id = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
    const fieldNames = new Map([
        ['dateOfBirth', 'date_of_birth'],
        ['pan', 'pan'],
        ['mobile', 'mobile'],
        ['aadhaar', 'aadhaar'],
        ['uan', 'uan'],
        ['bankAccount', 'bank_account'],
        ['bankName', 'bank_name']
    ]);
    const legacyColumns = new Map([[6, 'pan'], [7, 'uan'], [8, 'bank_account'], [24, 'bank_name']]);
    const field = typeof body.fieldKey === 'string'
        ? fieldNames.get(body.fieldKey)
        : legacyColumns.get(Number(body.columnNumber));
    if (!id || id.length > 40 || !field) {
        return res.status(400).json({ error: 'The protected field request is invalid.' });
    }
    const employee = database.prepare(`SELECT ${field} AS value FROM payroll_employees WHERE id = ?`).get(id);
    if (!employee || !employee.value) return res.status(404).json({ error: 'The protected value was not found.' });
    await audit(req.user, 'sensitive-field-revealed', `${id}:${field}`);
    const value = employee.value;
    res.json({ value });
}));

app.post('/api/employee-fixed-data/read', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const id = typeof body.employeeId === 'string' ? body.employeeId.trim() : '';
    if (!id || id.length > 40) return res.status(400).json({ error: 'The employee request is invalid.' });
    try {
        const values = employeeFixedData(database, id);
        await audit(req.user, 'employee-fixed-data-viewed', id);
        res.json({ values });
    } catch (error) {
        if (error.message.includes('employee was not found')) {
            return res.status(404).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/employee-fixed-data', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { employeeId, values, confirmed } = body;
    const id = typeof employeeId === 'string' ? employeeId.trim() : '';
    if (!id || id.length > 40 || confirmed !== true) {
        return res.status(400).json({ error: 'Confirm the employee record update.' });
    }
    try {
        const result = updateEmployeeFixedData(database, id, values);
        await audit(req.user, 'employee-fixed-data-updated', id);
        res.json({ saved: true, ...result });
    } catch (error) {
        if (error.message.includes('employee was not found')) {
            return res.status(404).json({ error: error.message });
        }
        if (error.message.includes('required') || error.message.includes('must be')) {
            return res.status(400).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/payroll-rules', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    try {
        const result = updatePayrollRules(database, req.body?.values);
        await audit(req.user, 'shared-payroll-rules-updated');
        res.json({ saved: true, ...result });
    } catch (error) {
        if (error.message.includes('required') || error.message.includes('must be between')) {
            return res.status(400).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/advances', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    try {
        const result = createAdvance(database, req.body?.values);
        await audit(req.user, 'advance-created', String(result.id));
        res.status(201).json({ saved: true, ...result });
    } catch (error) {
        if (error.message.includes('required') || error.message.includes('Choose')
            || error.message.includes('must be') || error.message.includes('cannot exceed')
            || error.message.includes('greater than zero')) {
            return res.status(400).json({ error: error.message });
        }
        throw error;
    }
}));

app.patch('/api/advances/:id', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    try {
        const result = updateAdvance(database, req.params.id, req.body?.values);
        await audit(req.user, 'advance-updated', String(result.id));
        res.json({ saved: true, ...result });
    } catch (error) {
        if (error.message.includes('invalid') || error.message.includes('required')
            || error.message.includes('must be') || error.message.includes('must include')
            || error.message.includes('cannot be')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.includes('was not found')) {
            return res.status(404).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/employee-payroll-data', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const { employeeId, values, confirmed } = body;
    const id = typeof employeeId === 'string' ? employeeId.trim() : '';
    const allowedFields = [
        'basicSalary',
        'fixedAllowance',
        'perDayRate',
        'healthInsurance',
        'licDeduction',
        'elEntitlement',
        'clEntitlement',
        'elBalance',
        'clBalance'
    ];
    if (!id || id.length > 40 || confirmed !== true || !values || typeof values !== 'object'
        || Array.isArray(values)
        || Object.keys(values).length !== allowedFields.length
        || Object.keys(values).some((key) => !allowedFields.includes(key))
        || allowedFields.some((key) => typeof values[key] !== 'number' || !Number.isFinite(values[key]))) {
        return res.status(400).json({ error: 'Enter and confirm all salary and leave source values.' });
    }
    try {
        const result = updateEmployeePayrollData(database, id, values);
        await audit(req.user, 'employee-payroll-data-verified', id);
        res.json({ saved: true, ...result });
    } catch (error) {
        if (error.message.includes('employee was not found')) {
            return res.status(404).json({ error: error.message });
        }
        if (error.message.includes('must be between') || error.message.includes('greater than zero')
            || error.message.includes('cannot exceed')) {
            return res.status(400).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/payroll-preview', requireSameOrigin, requireUser, csrfProtection, asyncRoute(async (req, res) => {
    if (!Array.isArray(req.body.employeeIds)
        || req.body.employeeIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 40)
        || new Set(req.body.employeeIds).size !== req.body.employeeIds.length
        || typeof req.body.period !== 'string'
        || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(req.body.period)) {
        return res.status(400).json({ error: 'The payroll preview request is invalid.' });
    }
    try {
        res.json(payrollPreview(database, req.body.employeeIds, req.body.period));
    } catch (error) {
        if (error.message.includes('ESI coverage statuses')) {
            return res.status(409).json({ error: error.message });
        }
        if (error.message.includes('current payroll period')) {
            return res.status(409).json({ error: error.message });
        }
        if (error.message.includes('inactive employee')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.includes('Payroll source data is incomplete')) {
            return res.status(409).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/attendance', requireSameOrigin, requireUser, csrfProtection, requireRole('admin', 'payroll'), asyncRoute(async (req, res) => {
    const { employeeId, fields } = req.body;
    const id = typeof employeeId === 'string' ? employeeId.trim() : '';
    const allowedFields = [
        'workDays',
        'leaveDays',
        'longestContinuousSpell',
        'processAllowance',
        'punctualIncentive',
        'fullAttendanceBonus'
    ];
    if (!id || id.length > 40 || !fields || typeof fields !== 'object' || Array.isArray(fields)
        || Object.keys(fields).length !== allowedFields.length
        || Object.keys(fields).some((key) => !allowedFields.includes(key))) {
        return res.status(400).json({ error: 'The attendance update is invalid.' });
    }
    const settings = loadSettings(database);
    if (database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(settings.period)) {
        return res.status(409).json({ error: 'This payroll period is already archived.' });
    }
    const employee = database.prepare('SELECT id FROM payroll_employees WHERE id = ?').get(id);
    if (!employee) return res.status(404).json({ error: 'The employee was not found.' });
    const values = {};
    for (const key of allowedFields) {
        const value = Number(fields[key]);
        const max = key.endsWith('Allowance') || key === 'punctualIncentive' || key === 'fullAttendanceBonus'
            ? 10000000
            : settings.calendarDays;
        if (!Number.isFinite(value) || value < 0 || value > max) {
            return res.status(400).json({ error: `Attendance field ${key} must be between 0 and ${max}.` });
        }
        values[key] = value;
    }
    if (values.workDays + values.leaveDays > settings.calendarDays) {
        return res.status(400).json({ error: 'Work days plus leave days cannot exceed calendar days.' });
    }
    if (values.longestContinuousSpell > values.leaveDays) {
        return res.status(400).json({ error: 'Longest continuous spell cannot exceed leave days.' });
    }
    database.prepare(`
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
    `).run(
        settings.period,
        id,
        values.workDays,
        values.leaveDays,
        values.longestContinuousSpell,
        values.processAllowance,
        values.punctualIncentive,
        values.fullAttendanceBonus,
        req.user.id
    );
    await audit(req.user, 'attendance-updated', id);
    res.json({ saved: true });
}));

app.post(
    '/api/attendance/preview',
    requireSameOrigin,
    requireUser,
    csrfProtection,
    requireRole('admin', 'payroll'),
    express.raw({ type: () => true, limit: '10mb' }),
    asyncRoute(async (req, res) => {
        try {
            const filename = req.get('x-upload-filename') || '';
            if (!filename || filename.length > 255) {
                return res.status(400).json({ error: 'Choose a CSV or .xlsx attendance file.' });
            }
            const rows = await parseAttendanceFile(req.body, filename);
            const preview = validateAttendanceImport(database, rows);
            res.json({
                period: preview.period,
                calendarDays: preview.calendarDays,
                rows: preview.rows
            });
        } catch (error) {
            if (error instanceof AttendanceImportError && error.message.includes('already archived')) {
                return res.status(409).json({ error: error.message });
            }
            if (error instanceof AttendanceImportError) return res.status(400).json({ error: error.message });
            throw error;
        }
    })
);

app.post('/api/attendance/import', requireSameOrigin, requireUser, csrfProtection, requireRole('admin', 'payroll'), asyncRoute(async (req, res) => {
    try {
        const result = saveAttendanceImport(database, req.user.id, req.body?.rows);
        await audit(req.user, 'attendance-imported', result.period);
        res.json({ saved: true, ...result });
    } catch (error) {
        if (error instanceof AttendanceImportError && error.message.includes('already archived')) {
            return res.status(409).json({ error: error.message });
        }
        if (error instanceof AttendanceImportError) return res.status(400).json({ error: error.message });
        throw error;
    }
}));

app.post('/api/archive', requireSameOrigin, requireUser, csrfProtection, requireRole('admin', 'payroll'), asyncRoute(async (req, res) => {
    const settings = loadSettings(database);
    if (database.prepare('SELECT 1 FROM payroll_runs WHERE period = ?').get(settings.period)) {
        return res.status(409).json({ error: 'This payroll period is already archived.' });
    }
    const context = createPayrollContext(database, settings);
    if (context.esiReviewRequired.length) {
        return res.status(409).json({ error: 'Review ESI coverage statuses for the current contribution period before archiving payroll.' });
    }
    if (context.employees.some((employee) =>
        employee.status === 'active' && (employee.salaryDataMissing || employee.leaveDataMissing))) {
        return res.status(409).json({ error: 'Payroll source data is incomplete: verify all active employee salary and leave records before archiving payroll.' });
    }
    const result = archivePayroll(database, req.user.id);
    await audit(req.user, 'payroll-archived', result.period);
    res.json({ archived: true, ...result });
}));

app.post('/api/payroll-period', requireSameOrigin, requireUser, csrfProtection, requireRole('admin', 'payroll'), asyncRoute(async (req, res) => {
    const period = typeof req.body.period === 'string' ? req.body.period : '';
    try {
        const result = nextPayrollPeriod(database, period);
        await audit(req.user, 'payroll-period-started', result.period);
        res.json(result);
    } catch (error) {
        if (error.message.includes('Archive the current payroll')) {
            return res.status(409).json({ error: error.message });
        }
        if (error.message.includes('already archived')) {
            return res.status(409).json({ error: error.message });
        }
        if (error.message.includes('next payroll period must be')) {
            return res.status(400).json({ error: error.message });
        }
        if (error.message.includes('valid payroll month')) {
            return res.status(400).json({ error: error.message });
        }
        throw error;
    }
}));

app.post('/api/esi-coverage', requireSameOrigin, requireUser, csrfProtection, requireRole('admin'), asyncRoute(async (req, res) => {
    const employeeId = typeof req.body.employeeId === 'string' ? req.body.employeeId.trim() : '';
    const status = typeof req.body.status === 'string' ? req.body.status.toUpperCase() : '';
    if (!employeeId || employeeId.length > 40 || !['Y', 'N'].includes(status)) {
        return res.status(400).json({ error: 'The ESI coverage update is invalid.' });
    }
    try {
        const result = updateEsiCoverage(database, employeeId, status);
        await audit(req.user, 'esi-coverage-reviewed', `${employeeId}:${status}`);
        res.json(result);
    } catch (error) {
        if (error.message.includes('employee was not found')) {
            return res.status(404).json({ error: error.message });
        }
        if (error.message.includes('only be reviewed')) {
            return res.status(409).json({ error: error.message });
        }
        throw error;
    }
}));

app.use(['/server', '/apps-script'], (req, res) => res.sendStatus(404));
app.use(express.static(portalRoot, {
    index: 'index.html',
    dotfiles: 'deny',
    etag: true,
    maxAge: production ? '1h' : 0,
    setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
    }
}));

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    console.error('Portal request failed:', error.message);
    res.status(500).json({ error: 'The portal could not complete this request. Contact an administrator if the problem continues.' });
});

async function start() {
    assertConfiguration();
    const port = Number(process.env.PORT || 3000);
    const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
        console.log(`Salary portal listening on ${process.env.HOST || '127.0.0.1'}:${port}`);
    });
    const close = () => server.close(() => {
        sessionStore.close();
        database.close();
    });
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
}

if (require.main === module) {
    start().catch((error) => {
        console.error('Salary portal startup failed:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { app, assertConfiguration, database, sessionStore };
