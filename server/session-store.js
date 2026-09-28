import session from 'express-session';
import { db } from './db.js';

/** Сессии в SQLite — переживают перезапуск сервера. */
export class SqliteStore extends session.Store {
  constructor() {
    super();
    this.stmt = {
      get: db.prepare('SELECT data, expires FROM sessions WHERE sid = ?'),
      set: db.prepare(
        `INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
         ON CONFLICT (sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`,
      ),
      destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
      touch: db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?'),
      sweep: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
    };
    setInterval(() => this.stmt.sweep.run(Date.now()), 3600_000).unref();
  }

  #expiry(sess) {
    return sess?.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 86_400_000;
  }

  get(sid, cb) {
    try {
      const row = this.stmt.get.get(sid);
      if (!row) return cb(null, null);
      if (row.expires <= Date.now()) {
        this.stmt.destroy.run(sid);
        return cb(null, null);
      }
      cb(null, JSON.parse(row.data));
    } catch (err) {
      cb(err);
    }
  }

  set(sid, sess, cb) {
    try {
      this.stmt.set.run(sid, JSON.stringify(sess), this.#expiry(sess));
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  destroy(sid, cb) {
    try {
      this.stmt.destroy.run(sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }

  touch(sid, sess, cb) {
    try {
      this.stmt.touch.run(this.#expiry(sess), sid);
      cb(null);
    } catch (err) {
      cb(err);
    }
  }
}
