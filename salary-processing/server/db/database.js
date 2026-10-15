'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function createDatabase(databasePath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'portal.sqlite')) {
    const resolvedPath = path.isAbsolute(databasePath)
        ? databasePath
        : path.resolve(__dirname, '..', databasePath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    const database = new Database(resolvedPath);
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');
    database.pragma('foreign_keys = ON');
    database.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const employeeColumns = new Set(
        database.prepare('PRAGMA table_info(payroll_employees)').all().map((column) => column.name)
    );
    if (!employeeColumns.has('salary_data_missing')) {
        database.exec(
            'ALTER TABLE payroll_employees ADD COLUMN salary_data_missing INTEGER NOT NULL DEFAULT 0 CHECK (salary_data_missing IN (0, 1))'
        );
    }
    if (!employeeColumns.has('leave_data_missing')) {
        database.exec(
            'ALTER TABLE payroll_employees ADD COLUMN leave_data_missing INTEGER NOT NULL DEFAULT 0 CHECK (leave_data_missing IN (0, 1))'
        );
        database.exec(`
            UPDATE payroll_employees
            SET leave_data_missing = 1
            WHERE EXISTS (
                SELECT 1 FROM payroll_import_issues
                WHERE code IN ('missing-leave-entitlements', 'provisional-leave-balances')
                    AND record_count > 0
            )
        `);
    }
    if (!employeeColumns.has('date_of_birth')) {
        database.exec('ALTER TABLE payroll_employees ADD COLUMN date_of_birth TEXT');
    }
    if (!employeeColumns.has('mobile')) {
        database.exec('ALTER TABLE payroll_employees ADD COLUMN mobile TEXT');
    }
    if (!employeeColumns.has('aadhaar')) {
        database.exec('ALTER TABLE payroll_employees ADD COLUMN aadhaar TEXT');
    }
    const advanceColumns = new Set(
        database.prepare('PRAGMA table_info(payroll_advances)').all().map((column) => column.name)
    );
    if (!advanceColumns.has('is_active')) {
        database.exec('ALTER TABLE payroll_advances ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))');
    }
    const pfPolicyMigration = 'organization-pf-wage-ceiling-25000';
    if (!database.prepare('SELECT 1 FROM portal_migrations WHERE id = ?').get(pfPolicyMigration)) {
        const migratePfPolicy = database.transaction(() => {
            database.prepare(`
                UPDATE payroll_settings SET value = '25000'
                WHERE key = 'pf_wage_ceiling' AND value = '15000'
            `).run();
            database.prepare('INSERT INTO portal_migrations (id) VALUES (?)').run(pfPolicyMigration);
        });
        migratePfPolicy();
    }
    return database;
}

function deleteUserSessions(database, userId) {
    const rows = database.prepare('SELECT sid, sess FROM portal_sessions').all();
    const remove = database.prepare('DELETE FROM portal_sessions WHERE sid = ?');
    const deleteMatching = database.transaction(() => {
        rows.forEach((row) => {
            try {
                if (String(JSON.parse(row.sess).userId) === String(userId)) remove.run(row.sid);
            } catch (error) {
                remove.run(row.sid);
            }
        });
    });
    deleteMatching();
}

module.exports = { createDatabase, deleteUserSessions };
