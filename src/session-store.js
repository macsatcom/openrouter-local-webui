import session from 'express-session';

class SQLiteSessionStore extends session.Store {
  constructor(db, options = {}) {
    super(options);
    this.db = db;
    this.ttl = options.ttl || 30 * 24 * 60 * 60;

    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expired DATETIME NOT NULL
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired)');

    this._cleanupInterval = setInterval(() => {
      try {
        db.exec("DELETE FROM sessions WHERE expired < datetime('now')");
      } catch (e) {}
    }, 60 * 60 * 1000).unref();
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare("SELECT sess FROM sessions WHERE sid = ? AND expired > datetime('now')").get(sid);
      cb(null, row ? JSON.parse(row.sess) : null);
    } catch (e) {
      cb(e);
    }
  }

  set(sid, session, cb) {
    try {
      const expires = session.cookie && session.cookie.expires
        ? new Date(session.cookie.expires).toISOString()
        : new Date(Date.now() + this.ttl * 1000).toISOString();
      const sess = JSON.stringify(session);
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expired) VALUES (?, ?, ?)').run(sid, sess, expires);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }

  touch(sid, session, cb) {
    try {
      const expires = session.cookie && session.cookie.expires
        ? new Date(session.cookie.expires).toISOString()
        : new Date(Date.now() + this.ttl * 1000).toISOString();
      this.db.prepare('UPDATE sessions SET expired = ? WHERE sid = ?').run(expires, sid);
      cb(null);
    } catch (e) {
      cb(e);
    }
  }
}

export default SQLiteSessionStore;
