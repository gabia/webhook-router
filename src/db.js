import Database from 'better-sqlite3';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_user_no TEXT NOT NULL UNIQUE,
      user_no TEXT,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('gitlab','sentry')),
      repo TEXT NOT NULL,
      actions TEXT NOT NULL,        -- JSON array
      authors TEXT NOT NULL,        -- JSON array, [] = all
      destinations TEXT NOT NULL,   -- JSON array of URLs
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS inbound_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      repo TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      matched INTEGER NOT NULL DEFAULT 0,
      delivered_ok INTEGER NOT NULL DEFAULT 0,
      delivered_fail INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS delivery_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success','fail')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // 기존 DB 마이그레이션: updated_at 없으면 추가하고 created_at 으로 채운다
  if (!db.prepare('PRAGMA table_info(rules)').all().some(c => c.name === 'updated_at')) {
    db.exec("ALTER TABLE rules ADD COLUMN updated_at TEXT");
    db.exec('UPDATE rules SET updated_at = created_at');
  }
  return db;
}
