'use strict';

const session = require('express-session');

class SqliteSessionStore extends session.Store {
    constructor(database, options = {}) {
        super();
        this.database = database;
        this.ttl = options.ttl || 8 * 60 * 60 * 1000;
        this.getStatement = database.prepare('SELECT sess, expire FROM portal_sessions WHERE sid = ?');
        this.setStatement = database.prepare(`
            INSERT INTO portal_sessions (sid, sess, expire) VALUES (?, ?, ?)
            ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire
        `);
        this.destroyStatement = database.prepare('DELETE FROM portal_sessions WHERE sid = ?');
        this.touchStatement = database.prepare('UPDATE portal_sessions SET expire = ? WHERE sid = ?');
        this.pruneStatement = database.prepare('DELETE FROM portal_sessions WHERE expire <= ?');
        this.pruneTimer = setInterval(() => this.pruneStatement.run(Date.now()), 15 * 60 * 1000);
        this.pruneTimer.unref();
    }

    get(sid, callback) {
        try {
            const row = this.getStatement.get(sid);
            if (!row) return callback(null, null);
            if (row.expire <= Date.now()) {
                this.destroyStatement.run(sid);
                return callback(null, null);
            }
            callback(null, JSON.parse(row.sess));
        } catch (error) {
            callback(error);
        }
    }

    set(sid, sess, callback) {
        try {
            const expiresAt = sess.cookie && sess.cookie.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + (sess.cookie && sess.cookie.maxAge || this.ttl);
            this.setStatement.run(sid, JSON.stringify(sess), expiresAt);
            if (callback) callback(null);
        } catch (error) {
            if (callback) callback(error);
            else this.emit('error', error);
        }
    }

    destroy(sid, callback) {
        try {
            this.destroyStatement.run(sid);
            if (callback) callback(null);
        } catch (error) {
            if (callback) callback(error);
            else this.emit('error', error);
        }
    }

    touch(sid, sess, callback) {
        try {
            const expiresAt = sess.cookie && sess.cookie.expires
                ? new Date(sess.cookie.expires).getTime()
                : Date.now() + (sess.cookie && sess.cookie.maxAge || this.ttl);
            this.touchStatement.run(expiresAt, sid);
            if (callback) callback(null);
        } catch (error) {
            if (callback) callback(error);
            else this.emit('error', error);
        }
    }

    close() {
        clearInterval(this.pruneTimer);
    }
}

module.exports = SqliteSessionStore;
