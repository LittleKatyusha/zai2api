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

class TokenStore {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.isNative = false;
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
        'CREATE TABLE IF NOT EXISTS tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT UNIQUE)'
      );
      this.stmtGetNext = this.db.prepare('SELECT token FROM tokens ORDER BY id LIMIT 1');
      this.stmtDelete = this.db.prepare('DELETE FROM tokens WHERE token = ?');
      this.stmtCount = this.db.prepare('SELECT COUNT(*) as count FROM tokens');
      this.stmtInsert = this.db.prepare('INSERT OR IGNORE INTO tokens (token) VALUES (?)');
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
