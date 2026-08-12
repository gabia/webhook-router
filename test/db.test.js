import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb } from '../src/db.js';

test('openDb creates schema', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('rules'));
  assert.ok(tables.includes('delivery_logs'));
});

test('migrates legacy repo column into repos JSON array', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'webhook-db-')), 'legacy.db');
  const old = new Database(path);
  old.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, office_user_no TEXT NOT NULL UNIQUE, user_no TEXT, name TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, repo TEXT NOT NULL,
      actions TEXT NOT NULL, authors TEXT NOT NULL, destinations TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    INSERT INTO rules (user_id, name, source, repo, actions, authors, destinations)
    VALUES (1, 'old', 'gitlab', 'a/b', '["mr.open"]', '[]', '["https://x/y"]');
  `);
  old.close();

  const db = openDb(path);
  const row = db.prepare('SELECT * FROM rules').get();
  assert.deepEqual(JSON.parse(row.repos), ['a/b']);
  assert.equal('repo' in row, false);
});
