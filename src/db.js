// src/db.js — SQLite token store supporting native node:sqlite or better-sqlite3
const fs = require('fs');
const path = require('path');

function createDbInstance(dbPath) {
  // 1. Try native node:sqlite (zero C++ compilation required, built into Node >= 22)
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync === 'function') {
      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL;');
      db.exec('PRAGMA busy_timeout = 10000;');
      return { db, isNative: true };
    }
  } catch (e) {}

  // 2. Try better-sqlite3
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { timeout: 10000 });
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 10000');
    return { db, isNative: false };
  } catch (e) {
    throw new Error('Neither node:sqlite nor better-sqlite3 is available: ' + e.message);
  }
}

function extractEmail(token) {
  try {
    const parts = (token || '').split('.');
    if (parts.length < 2) return '';
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return payload.email || payload.id || '';
  } catch (e) {
    return '';
  }
}

class TokenStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.isNative = false;
    this.accountIndex = 0;
    this.init();
  }

  init() {
    try {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const { db, isNative } = createDbInstance(this.dbPath);
      this.db = db;
      this.isNative = isNative;
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE);' +
        'CREATE TABLE IF NOT EXISTS account_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE, email TEXT);'
      );
      this.stmtGetNext = this.db.prepare('SELECT token FROM tokens ORDER BY id LIMIT 1');
      this.stmtDelete = this.db.prepare('DELETE FROM tokens WHERE token = ?');
      this.stmtCount = this.db.prepare('SELECT COUNT(*) as count FROM tokens');
      this.stmtInsert = this.db.prepare('INSERT OR IGNORE INTO tokens (token) VALUES (?)');

      this.stmtAccountInsert = this.db.prepare('INSERT OR IGNORE INTO account_tokens (token, email) VALUES (?, ?)');
      this.stmtAccountAll = this.db.prepare('SELECT id, token, email FROM account_tokens ORDER BY id ASC');
      this.stmtAccountCount = this.db.prepare('SELECT COUNT(*) as count FROM account_tokens');
      this.stmtAccountDelete = this.db.prepare('DELETE FROM account_tokens WHERE id = ? OR token = ?');
    } catch (err) {
      console.error(`[TokenStore] Failed to initialize ${this.dbPath}:`, err.message);
      this.db = null;
    }
  }

  count() {
    if (!this.db) return 0;
    try {
      const row = this.stmtCount.get();
      return row ? Number(row.count) : 0;
    } catch (err) {
      console.error('[TokenStore] count error:', err.message);
      return 0;
    }
  }

  getNext() {
    if (!this.db) return null;
    try {
      const row = this.stmtGetNext.get();
      return row ? row.token : null;
    } catch (err) {
      console.error('[TokenStore] getNext error:', err.message);
      return null;
    }
  }

  remove(token) {
    if (!this.db || !token) return;
    try {
      this.stmtDelete.run(token);
    } catch (err) {
      console.error('[TokenStore] remove error:', err.message);
    }
  }

  insertBatch(tokens) {
    if (!this.db || !Array.isArray(tokens)) return 0;
    try {
      this.db.exec('BEGIN TRANSACTION;');
      for (const t of tokens) {
        if (t && typeof t === 'string' && t.trim()) {
          this.stmtInsert.run(t.trim());
        }
      }
      this.db.exec('COMMIT;');
      return this.count();
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (e) {}
      console.error('[TokenStore] insertBatch error:', err.message);
      return 0;
    }
  }

  countAccountTokens() {
    if (!this.db) return 0;
    try {
      const row = this.stmtAccountCount.get();
      return row ? Number(row.count) : 0;
    } catch (err) {
      console.error('[TokenStore] countAccountTokens error:', err.message);
      return 0;
    }
  }

  getAccountTokens() {
    if (!this.db) return [];
    try {
      const rows = this.stmtAccountAll.all();
      return rows.map((r) => ({ id: Number(r.id), token: r.token, email: r.email || '' }));
    } catch (err) {
      console.error('[TokenStore] getAccountTokens error:', err.message);
      return [];
    }
  }

  // ponytail: in-memory round robin, reset on restart. Persist index when multi-worker balancing required.
  getNextAccountToken() {
    if (!this.db) return null;
    try {
      const list = this.getAccountTokens();
      if (!list || list.length === 0) return null;
      const item = list[this.accountIndex % list.length];
      this.accountIndex = (this.accountIndex + 1) % list.length;
      return item;
    } catch (err) {
      console.error('[TokenStore] getNextAccountToken error:', err.message);
      return null;
    }
  }

  insertAccountTokens(tokens) {
    if (!this.db || !Array.isArray(tokens)) return 0;
    try {
      this.db.exec('BEGIN TRANSACTION;');
      for (const t of tokens) {
        if (t && typeof t === 'string' && t.trim()) {
          const clean = t.trim();
          this.stmtAccountInsert.run(clean, extractEmail(clean));
        }
      }
      this.db.exec('COMMIT;');
      return this.countAccountTokens();
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (e) {}
      console.error('[TokenStore] insertAccountTokens error:', err.message);
      return 0;
    }
  }

  removeAccountToken(idOrToken) {
    if (!this.db || idOrToken == null) return 0;
    try {
      this.stmtAccountDelete.run(idOrToken, String(idOrToken));
      return this.countAccountTokens();
    } catch (err) {
      console.error('[TokenStore] removeAccountToken error:', err.message);
      return 0;
    }
  }

  close() {
    if (this.db) {
      try {
        this.db.close();
      } catch (e) {}
      this.db = null;
    }
  }
}

module.exports = TokenStore;
