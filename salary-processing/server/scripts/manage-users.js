'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const readline = require('node:readline');
const bcrypt = require('bcryptjs');
const { createDatabase, deleteUserSessions } = require('../db/database');
const { generateRecoveryKey, hashRecoveryKey } = require('../lib/password-recovery');

const roles = new Set(['admin', 'payroll', 'read-only']);

function promptSecret(label) {
    if (!process.stdin.isTTY) throw new Error('Password entry requires an interactive terminal.');
    return new Promise((resolve, reject) => {
        const input = process.stdin;
        readline.emitKeypressEvents(input);
        input.setRawMode(true);
        let value = '';
        process.stdout.write(`${label}: `);
        const onKeypress = (character, key = {}) => {
            if (key.ctrl && key.name === 'c') {
                cleanup();
                reject(new Error('Cancelled.'));
            } else if (key.name === 'return' || key.name === 'enter') {
                process.stdout.write('\n');
                cleanup();
                resolve(value);
            } else if (key.name === 'backspace') {
                value = value.slice(0, -1);
            } else if (character && !key.ctrl && !key.meta) {
                value += character;
            }
        };
        const cleanup = () => {
            input.removeListener('keypress', onKeypress);
            input.setRawMode(false);
        };
        input.on('keypress', onKeypress);
    });
}

async function getPassword() {
    const password = await promptSecret('Password');
    const confirmation = await promptSecret('Confirm password');
    if (password !== confirmation) throw new Error('Passwords do not match.');
    if (password.length < 12 || password.length > 1024) {
        throw new Error('Password must contain at least 12 characters and no more than 1024.');
    }
    return password;
}

async function main() {
    const [action, rawEmail, role] = process.argv.slice(2);
    const database = createDatabase();
    try {
        if (action === 'list' && !rawEmail) {
            const users = database.prepare(
                'SELECT email, role, disabled_at, created_at, last_login_at FROM portal_users ORDER BY email'
            ).all();
            users.forEach((user) => {
                console.log(`${user.email}\t${user.role}\t${user.disabled_at ? 'disabled' : 'active'}\tlast login: ${user.last_login_at || 'never'}`);
            });
            return;
        }

        const email = String(rawEmail || '').trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
            throw new Error('Provide a valid account email.');
        }
        if (action === 'create') {
            if (!roles.has(role)) throw new Error('Choose role: admin, payroll, or read-only.');
            const passwordHash = await bcrypt.hash(await getPassword(), 12);
            database.transaction(() => {
                database.prepare(
                    'INSERT INTO portal_users (email, password_hash, role) VALUES (?, ?, ?)'
                ).run(email, passwordHash, role);
                database.prepare(
                    'INSERT INTO portal_audit_log (user_email, action, target) VALUES (?, ?, ?)'
                ).run('system-cli', 'account-created', `${email}:${role}`);
            })();
            console.log(`Created ${role} account for ${email}.`);
            return;
        }
        if (action === 'reset-password') {
            const passwordHash = await bcrypt.hash(await getPassword(), 12);
            const user = database.prepare(
                'SELECT id FROM portal_users WHERE email = ? AND disabled_at IS NULL'
            ).get(email);
            if (!user) throw new Error('No active account exists for that email.');
            database.transaction(() => {
                database.prepare(
                    'UPDATE portal_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                ).run(passwordHash, user.id);
                deleteUserSessions(database, user.id);
                database.prepare(
                    'INSERT INTO portal_audit_log (user_email, action, target) VALUES (?, ?, ?)'
                ).run('system-cli', 'account-password-reset', email);
            })();
            console.log(`Updated password for ${email}.`);
            return;
        }
        if (action === 'recovery-key') {
            const user = database.prepare(
                'SELECT id FROM portal_users WHERE email = ? AND disabled_at IS NULL'
            ).get(email);
            if (!user) throw new Error('No active account exists for that email.');
            const recoveryKey = generateRecoveryKey();
            database.transaction(() => {
                database.prepare(`
                    INSERT INTO portal_password_recovery_keys (user_id, key_hash, attempts, created_at)
                    VALUES (?, ?, 0, ?)
                    ON CONFLICT(user_id) DO UPDATE SET
                        key_hash = excluded.key_hash,
                        attempts = 0,
                        created_at = excluded.created_at
                `).run(user.id, hashRecoveryKey(recoveryKey), Date.now());
                database.prepare(
                    'INSERT INTO portal_audit_log (user_id, user_email, action, target) VALUES (?, ?, ?, ?)'
                ).run(user.id, email, 'account-recovery-key-issued', email);
            })();
            console.log(`Recovery key for ${email} (shown once; store it somewhere secure):`);
            console.log(recoveryKey);
            return;
        }
        if (action === 'disable') {
            database.transaction(() => {
                const user = database.prepare(
                    'SELECT id, role FROM portal_users WHERE email = ? AND disabled_at IS NULL'
                ).get(email);
                if (!user) throw new Error('No active account exists for that email.');
                if (user.role === 'admin') {
                    const admins = database.prepare(
                        "SELECT COUNT(*) AS count FROM portal_users WHERE role = 'admin' AND disabled_at IS NULL"
                    ).get();
                    if (admins.count <= 1) throw new Error('Create another active administrator before disabling the last one.');
                }
                database.prepare(
                    'UPDATE portal_users SET disabled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                ).run(user.id);
                deleteUserSessions(database, user.id);
                database.prepare(
                    'INSERT INTO portal_audit_log (user_id, user_email, action, target) VALUES (?, ?, ?, ?)'
                ).run(user.id, email, 'account-disabled', email);
            })();
            console.log(`Disabled account for ${email}.`);
            return;
        }
        if (action === 'set-role') {
            if (!roles.has(role)) throw new Error('Choose role: admin, payroll, or read-only.');
            database.transaction(() => {
                const user = database.prepare(
                    'SELECT id, role FROM portal_users WHERE email = ? AND disabled_at IS NULL'
                ).get(email);
                if (!user) throw new Error('No active account exists for that email.');
                if (user.role === 'admin' && role !== 'admin') {
                    const admins = database.prepare(
                        "SELECT COUNT(*) AS count FROM portal_users WHERE role = 'admin' AND disabled_at IS NULL"
                    ).get();
                    if (admins.count <= 1) throw new Error('Create another active administrator before changing the last one.');
                }
                database.prepare(
                    'UPDATE portal_users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
                ).run(role, user.id);
                deleteUserSessions(database, user.id);
                database.prepare(
                    'INSERT INTO portal_audit_log (user_id, user_email, action, target) VALUES (?, ?, ?, ?)'
                ).run(user.id, email, 'account-role-changed', role);
            })();
            console.log(`Changed ${email} to ${role}; the user must sign in again.`);
            return;
        }
        throw new Error('Usage: npm run users -- list | create <email> <role> | reset-password <email> | recovery-key <email> | disable <email> | set-role <email> <role>');
    } finally {
        database.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
