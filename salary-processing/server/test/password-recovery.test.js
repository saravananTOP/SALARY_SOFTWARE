'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-portal-password-recovery-'));
process.env.DATABASE_PATH = path.join(temporaryDirectory, 'portal.sqlite');
const { createDatabase } = require('../db/database');
const {
    MAX_KEY_ATTEMPTS,
    createPasswordRecoveryService,
    generateRecoveryKey,
    hashRecoveryKey
} = require('../lib/password-recovery');
const database = createDatabase();
const recoveryService = createPasswordRecoveryService(database);

test.before(async () => {
    const passwordHash = await bcrypt.hash('synthetic-old-password-123', 4);
    database.prepare(
        'INSERT INTO portal_users (email, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin@example.test', passwordHash, 'admin');
    database.prepare(
        'INSERT INTO portal_sessions (sid, sess, expire) VALUES (?, ?, ?)'
    ).run('admin-session', JSON.stringify({ userId: 1 }), Date.now() + 60000);
});

test.after(() => {
    database.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('high-entropy recovery key is stored hashed and resets the password once while revoking sessions', async () => {
    const recoveryKey = generateRecoveryKey();
    assert.match(recoveryKey, /^[A-Za-z0-9_-]{43}$/);
    database.prepare(`
        INSERT INTO portal_password_recovery_keys (user_id, key_hash, attempts, created_at)
        VALUES (?, ?, 0, ?)
    `).run(1, hashRecoveryKey(recoveryKey), Date.now());
    const stored = database.prepare(
        'SELECT key_hash FROM portal_password_recovery_keys WHERE user_id = 1'
    ).get();
    assert.notEqual(stored.key_hash, recoveryKey);

    assert.equal(await recoveryService.resetPassword('admin@example.test', generateRecoveryKey(), 'synthetic-new-password-456'), false);
    assert.equal(database.prepare('SELECT attempts FROM portal_password_recovery_keys WHERE user_id = 1').get().attempts, 1);
    assert.equal(await recoveryService.resetPassword('ADMIN@example.test', recoveryKey, 'synthetic-new-password-456'), true);

    const updated = database.prepare('SELECT password_hash FROM portal_users WHERE id = 1').get();
    assert.equal(await bcrypt.compare('synthetic-new-password-456', updated.password_hash), true);
    assert.equal(await bcrypt.compare('synthetic-old-password-123', updated.password_hash), false);
    assert.equal(database.prepare('SELECT 1 FROM portal_sessions WHERE sid = ?').get('admin-session'), undefined);
    assert.equal(database.prepare('SELECT 1 FROM portal_password_recovery_keys WHERE user_id = 1').get(), undefined);
    assert.equal(await recoveryService.resetPassword('admin@example.test', recoveryKey, 'synthetic-another-password-789'), false);
    assert.equal(database.prepare(
        "SELECT 1 FROM portal_audit_log WHERE user_email = ? AND action = 'account-password-reset'"
    ).get('admin@example.test') !== undefined, true);
});

test('recovery keys stop working after the maximum number of incorrect attempts', async () => {
    const recoveryKey = generateRecoveryKey();
    database.prepare(`
        INSERT INTO portal_password_recovery_keys (user_id, key_hash, attempts, created_at)
        VALUES (?, ?, 0, ?)
    `).run(1, hashRecoveryKey(recoveryKey), Date.now());
    for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt += 1) {
        assert.equal(await recoveryService.resetPassword(
            'admin@example.test',
            generateRecoveryKey(),
            'synthetic-another-password-789'
        ), false);
    }
    assert.equal(database.prepare('SELECT 1 FROM portal_password_recovery_keys WHERE user_id = 1').get(), undefined);
    assert.equal(await recoveryService.resetPassword('admin@example.test', recoveryKey, 'synthetic-another-password-789'), false);
});

test('disabled and unknown accounts cannot use password recovery', async () => {
    assert.equal(await recoveryService.resetPassword('missing@example.test', generateRecoveryKey(), 'synthetic-new-password-456'), false);
    database.prepare('UPDATE portal_users SET disabled_at = CURRENT_TIMESTAMP WHERE id = 1').run();
    assert.equal(await recoveryService.resetPassword('admin@example.test', generateRecoveryKey(), 'synthetic-new-password-456'), false);
});
