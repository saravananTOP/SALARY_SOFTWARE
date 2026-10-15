'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDatabase, deleteUserSessions } = require('../db/database');
const SqliteSessionStore = require('../lib/sqlite-session-store');

function createTestDatabase(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-portal-test-'));
    const database = createDatabase(path.join(directory, 'portal.sqlite'));
    t.after(() => {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });
    return database;
}

function setSession(store, id, value) {
    return new Promise((resolve, reject) => {
        store.set(id, value, (error) => error ? reject(error) : resolve());
    });
}

function getSession(store, id) {
    return new Promise((resolve, reject) => {
        store.get(id, (error, value) => error ? reject(error) : resolve(value));
    });
}

test('SQLite creates local-account and audit tables with unique email accounts', (t) => {
    const database = createTestDatabase(t);
    database.prepare(
        'INSERT INTO portal_users (email, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin@example.test', 'synthetic-hash', 'admin');

    assert.equal(database.prepare('SELECT role FROM portal_users WHERE email = ?').get('admin@example.test').role, 'admin');
    assert.throws(() => database.prepare(
        'INSERT INTO portal_users (email, password_hash, role) VALUES (?, ?, ?)'
    ).run('admin@example.test', 'another-hash', 'admin'));
});

test('SQLite resolves relative database paths from the server directory', (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'salary-portal-test-'));
    const serverDirectory = path.resolve(__dirname, '..');
    const relativeDatabasePath = path.join(path.relative(serverDirectory, directory), 'portal.sqlite');
    const database = createDatabase(relativeDatabasePath);
    t.after(() => {
        database.close();
        fs.rmSync(directory, { recursive: true, force: true });
    });

    assert.equal(fs.existsSync(path.join(directory, 'portal.sqlite')), true);
});

test('SQLite session store persists sessions and expires old sessions', async (t) => {
    const database = createTestDatabase(t);
    const store = new SqliteSessionStore(database);
    t.after(() => store.close());

    await setSession(store, 'active-session', {
        userId: 7,
        cookie: { expires: new Date(Date.now() + 60000).toISOString() }
    });
    assert.equal((await getSession(store, 'active-session')).userId, 7);

    await setSession(store, 'expired-session', {
        userId: 7,
        cookie: { expires: new Date(Date.now() - 1000).toISOString() }
    });
    assert.equal(await getSession(store, 'expired-session'), null);
});

test('disabling/resetting an account removes only that user’s sessions', (t) => {
    const database = createTestDatabase(t);
    const store = new SqliteSessionStore(database);
    t.after(() => store.close());
    const insert = database.prepare('INSERT INTO portal_sessions (sid, sess, expire) VALUES (?, ?, ?)');
    insert.run('user-seven', JSON.stringify({ userId: 7 }), Date.now() + 60000);
    insert.run('user-eight', JSON.stringify({ userId: 8 }), Date.now() + 60000);

    deleteUserSessions(database, 7);

    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM portal_sessions WHERE sid = ?').get('user-seven').count, 0);
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM portal_sessions WHERE sid = ?').get('user-eight').count, 1);
});
