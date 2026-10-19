'use strict';

const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { deleteUserSessions } = require('../db/database');

const MAX_KEY_ATTEMPTS = 5;

function generateRecoveryKey() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashRecoveryKey(recoveryKey) {
    return crypto.createHash('sha256').update(recoveryKey).digest('hex');
}

function matchesRecoveryKey(storedHash, recoveryKey) {
    const expected = Buffer.from(hashRecoveryKey(recoveryKey), 'hex');
    const stored = Buffer.from(storedHash, 'hex');
    return stored.length === expected.length && crypto.timingSafeEqual(stored, expected);
}

function createPasswordRecoveryService(database) {
    async function resetPassword(rawEmail, recoveryKey, password) {
        const email = rawEmail.trim().toLowerCase();
        const user = database.prepare(
            'SELECT id, email FROM portal_users WHERE email = ? AND disabled_at IS NULL'
        ).get(email);
        if (!user) return false;

        const savedKey = database.prepare(
            'SELECT key_hash, attempts FROM portal_password_recovery_keys WHERE user_id = ?'
        ).get(user.id);
        if (!savedKey || savedKey.attempts >= MAX_KEY_ATTEMPTS) return false;
        if (!matchesRecoveryKey(savedKey.key_hash, recoveryKey)) {
            const recordFailure = database.transaction(() => {
                const currentKey = database.prepare(
                    'SELECT attempts FROM portal_password_recovery_keys WHERE user_id = ?'
                ).get(user.id);
                if (!currentKey) return;
                if (currentKey.attempts + 1 >= MAX_KEY_ATTEMPTS) {
                    database.prepare('DELETE FROM portal_password_recovery_keys WHERE user_id = ?').run(user.id);
                } else {
                    database.prepare(
                        'UPDATE portal_password_recovery_keys SET attempts = attempts + 1 WHERE user_id = ?'
                    ).run(user.id);
                }
            });
            recordFailure();
            return false;
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const completeReset = database.transaction(() => {
            const currentUser = database.prepare(
                'SELECT id, email FROM portal_users WHERE id = ? AND disabled_at IS NULL'
            ).get(user.id);
            const currentKey = database.prepare(
                'SELECT key_hash, attempts FROM portal_password_recovery_keys WHERE user_id = ?'
            ).get(user.id);
            if (!currentUser || !currentKey || currentKey.attempts >= MAX_KEY_ATTEMPTS
                || !matchesRecoveryKey(currentKey.key_hash, recoveryKey)) return false;

            database.prepare(
                'UPDATE portal_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            ).run(passwordHash, user.id);
            database.prepare('DELETE FROM portal_password_recovery_keys WHERE user_id = ?').run(user.id);
            deleteUserSessions(database, user.id);
            database.prepare(
                'INSERT INTO portal_audit_log (user_id, user_email, action, target) VALUES (?, ?, ?, ?)'
            ).run(user.id, user.email, 'account-password-reset', user.email);
            return true;
        });
        return completeReset();
    }

    return { resetPassword };
}

module.exports = {
    MAX_KEY_ATTEMPTS,
    createPasswordRecoveryService,
    generateRecoveryKey,
    hashRecoveryKey
};
