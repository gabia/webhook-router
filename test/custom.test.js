import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../src/db.js';
import {
  upsertUser, createRule, validateRule,
  createCustomSource, listCustomSources, deleteCustomSource,
  findCustomSourceByToken, saveLastPayload,
} from '../src/rules-db.js';
import { flattenPayload, matchCustomRules, formatCustomMessage } from '../src/dispatch.js';
import { createApp } from '../src/app.js';

function setup() {
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: '김개발' });
  return { db, user };
}

// ---------- custom source CRUD ----------

test('createCustomSource generates unique token, list shows mine flag', () => {
  const { db, user } = setup();
  const s1 = createCustomSource(db, user.id, '배포 알림');
  const s2 = createCustomSource(db, user.id, '모니터링');
  assert.ok(s1.token && s1.token.length >= 32);
  assert.notEqual(s1.token, s2.token);
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박' });
  const list = listCustomSources(db, other.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].mine, 0);
});

test('deleteCustomSource only by owner', () => {
  const { db, user } = setup();
  const s = createCustomSource(db, user.id, 'x');
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박' });
  assert.equal(deleteCustomSource(db, other.id, s.id), false);
  assert.equal(deleteCustomSource(db, user.id, s.id), true);
});

test('findCustomSourceByToken + saveLastPayload roundtrip', () => {
  const { db, user } = setup();
  const s = createCustomSource(db, user.id, 'x');
  saveLastPayload(db, s.id, { env: 'prod', result: { status: 'ok' } });
  const found = findCustomSourceByToken(db, s.token);
  assert.equal(found.id, s.id);
  assert.deepEqual(JSON.parse(found.last_payload), { env: 'prod', result: { status: 'ok' } });
  assert.equal(findCustomSourceByToken(db, 'nope'), undefined);
});

// ---------- validateRule custom branch ----------

const customRule = (over = {}) => ({
  name: 'c', description: '', source: 'custom', custom_source_id: 1,
  repos: [], actions: [], authors: [],
  conditions: [{ key: 'env', op: 'eq', value: 'prod' }],
  send_mode: 'messenger', template: null,
  destinations: ['https://d.example/h'], active: true, ...over,
});

test('validateRule: custom requires source id + valid conditions', () => {
  assert.equal(validateRule(customRule()).ok, true);
  assert.equal(validateRule(customRule({ conditions: [] })).ok, true); // [] = 모든 payload
  assert.equal(validateRule(customRule({ custom_source_id: null })).ok, false);
  assert.equal(validateRule(customRule({ conditions: [{ key: '', op: 'eq', value: 'x' }] })).ok, false);
  assert.equal(validateRule(customRule({ conditions: [{ key: 'k', op: 'gt', value: 'x' }] })).ok, false);
  assert.equal(validateRule(customRule({ conditions: 'bad' })).ok, false);
  assert.equal(validateRule(customRule({ send_mode: 'push' })).ok, false);
  assert.equal(validateRule(customRule({ send_mode: 'template', template: '{invalid' })).ok, false);
  assert.equal(validateRule(customRule({ send_mode: 'template', template: '{"text":"{{env}}"}' })).ok, true);
});

test('createRule persists custom fields', () => {
  const { db, user } = setup();
  const s = createCustomSource(db, user.id, 'x');
  const r = createRule(db, user.id, customRule({ custom_source_id: s.id }));
  assert.equal(r.source, 'custom');
  assert.equal(r.custom_source_id, s.id);
  assert.deepEqual(r.conditions, [{ key: 'env', op: 'eq', value: 'prod' }]);
});

// ---------- flatten + condition matching ----------

test('flattenPayload dot notation incl arrays', () => {
  const flat = flattenPayload({ a: 1, b: { c: 'x', d: [10, { e: true }] }, f: null });
  assert.deepEqual(flat, { a: 1, 'b.c': 'x', 'b.d.0': 10, 'b.d.1.e': true, f: null });
});

test('matchCustomRules: eq/ne/like, AND of all conditions, source id scoped', () => {
  const flat = flattenPayload({ env: 'production', result: { status: 'OK' }, count: 3 });
  const base = { id: 1, source: 'custom', custom_source_id: 7, active: 1, conditions: [], destinations: ['https://d/h'] };
  const m = (conds, srcId = 7) => matchCustomRules([{ ...base, conditions: conds }], srcId, flat).length;
  assert.equal(m([]), 1); // 조건 없음 = 전부
  assert.equal(m([{ key: 'env', op: 'eq', value: 'production' }]), 1);
  assert.equal(m([{ key: 'env', op: 'ne', value: 'production' }]), 0);
  assert.equal(m([{ key: 'env', op: 'like', value: 'PROD' }]), 1); // 대소문자 무시 부분일치
  assert.equal(m([{ key: 'result.status', op: 'eq', value: 'OK' }, { key: 'count', op: 'eq', value: '3' }]), 1);
  assert.equal(m([{ key: 'result.status', op: 'eq', value: 'OK' }, { key: 'count', op: 'eq', value: '4' }]), 0);
  assert.equal(m([{ key: 'missing', op: 'eq', value: 'x' }]), 1); // 없는 key = 조건 통과
  assert.equal(m([{ key: 'missing', op: 'ne', value: 'x' }]), 1); // op 무관하게 통과
  assert.equal(m([], 8), 0); // 다른 소스
});

test('formatCustomMessage: name in text, flat keys as card items max 10', () => {
  const flat = flattenPayload(Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i])));
  const msg = formatCustomMessage('배포 알림', flat);
  assert.ok(msg.text.includes('배포 알림'));
  assert.equal(msg.cards.length, 1);
  assert.equal(msg.cards[0].items.length, 10);
});

// ---------- inbound endpoint E2E ----------

test('POST /webhooks/custom/:token → 매칭 규칙 destination 으로 발송 + last payload 저장', async () => {
  const received = [];
  const dest = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { received.push(JSON.parse(b)); res.writeHead(200); res.end(); });
  });
  dest.listen(0); await once(dest, 'listening');
  const destUrl = `http://127.0.0.1:${dest.address().port}/hook`;

  const { db, user } = setup();
  const src = createCustomSource(db, user.id, '배포봇');
  createRule(db, user.id, customRule({
    custom_source_id: src.id,
    conditions: [{ key: 'env', op: 'eq', value: 'prod' }],
    destinations: [destUrl],
  }));
  const app = createApp(db, {
    SESSION_SECRET: 's', GITLAB_WEBHOOK_SECRET: 'gl',
    AUTH_URL: 'https://a', TOKEN_URL: 'https://a/t', ME_URL: 'https://a/m',
    HIWORKS_CLIENT_ID: 'c', HIWORKS_CLIENT_SECRET: '', REDIRECT_URI: 'http://r',
  }, { testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); } });
  const server = app.listen(0); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  // 조건 불일치 → 발송 없음
  let r = await fetch(`${base}/webhooks/custom/${src.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: 'dev' }),
  });
  assert.equal(r.status, 200);
  // 조건 일치 → 발송
  r = await fetch(`${base}/webhooks/custom/${src.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env: 'prod', version: 'v1.2' }),
  });
  assert.equal(r.status, 200);
  // 잘못된 토큰 → 404
  r = await fetch(`${base}/webhooks/custom/badtoken`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 404);

  for (let i = 0; i < 50 && received.length === 0; i++) await sleep(100);
  const logs = await (await fetch(`${base}/api/inbound-logs`)).json();
  const sources = await (await fetch(`${base}/api/custom-sources`)).json();
  server.close(); dest.close();

  assert.equal(received.length, 1);
  assert.ok(received[0].text.includes('배포봇'));
  assert.ok(logs.length >= 2);
  assert.ok(JSON.parse(sources[0].last_payload).version === 'v1.2');
});

// ---------- migration: 기존 gitlab/sentry 전용 rules 테이블 → custom 지원 ----------

test('legacy rules table (no custom) is migrated preserving rows', async () => {
  const { default: Database } = await import('better-sqlite3');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const fs = await import('node:fs');
  const file = pathMod.join(os.tmpdir(), `mig-test-${process.pid}-${Math.floor(Math.random() * 1e9)}.db`);
  const raw = new Database(file);
  raw.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_user_no TEXT NOT NULL UNIQUE,
      user_no TEXT, name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('gitlab','sentry')),
      repos TEXT NOT NULL,
      actions TEXT NOT NULL,
      authors TEXT NOT NULL,
      destinations TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    INSERT INTO users (office_user_no) VALUES ('o1');
    INSERT INTO rules (user_id,name,source,repos,actions,authors,destinations)
      VALUES (1,'r1','gitlab','["a/b"]','["mr.open"]','[]','["https://d/h"]');
  `);
  raw.close();

  const db = openDb(file);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='rules'").get().sql;
  assert.ok(sql.includes("'custom'"));
  const row = db.prepare('SELECT * FROM rules WHERE id = 1').get();
  assert.equal(row.name, 'r1');
  assert.equal(row.conditions, '[]');
  assert.equal(row.custom_source_id, null);
  // custom 규칙 삽입 가능해야 함
  const user = { id: 1 };
  const src = createCustomSource(db, user.id, 'mig');
  const r = createRule(db, user.id, customRule({ custom_source_id: src.id }));
  assert.equal(r.source, 'custom');
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(file + '-wal', { force: true });
  fs.rmSync(file + '-shm', { force: true });
});

test('renderTemplate: 정확히 하나면 타입 보존, 문장 속은 문자열, 없는 key 빈값', async () => {
  const { renderTemplate } = await import('../src/dispatch.js');
  const payload = { env: 'prod', count: 3, ok: true, nested: { arr: [1, 2] } };
  const out = renderTemplate({
    text: '배포 {{env}} 완료 ({{count}}건)',
    num: '{{count}}',
    flag: '{{ok}}',
    obj: '{{nested}}',
    missing: '{{nope}}',
    mixedMissing: 'x-{{nope}}-y',
    fixed: 1,
  }, payload);
  assert.equal(out.text, '배포 prod 완료 (3건)');
  assert.equal(out.num, 3);
  assert.equal(out.flag, true);
  assert.deepEqual(out.obj, { arr: [1, 2] });
  assert.equal(out.missing, '');
  assert.equal(out.mixedMissing, 'x--y');
  assert.equal(out.fixed, 1);
});

test('template 모드 규칙은 치환된 payload 를 그대로 발송', async () => {
  const received = [];
  const dest = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => { received.push(JSON.parse(b)); res.writeHead(200); res.end(); });
  });
  dest.listen(0); await once(dest, 'listening');
  const destUrl = `http://127.0.0.1:${dest.address().port}/hook`;

  const { db, user } = setup();
  const src = createCustomSource(db, user.id, '템플릿봇');
  createRule(db, user.id, customRule({
    custom_source_id: src.id, conditions: [],
    send_mode: 'template',
    template: JSON.stringify({ text: '{{env}} 배포', level: '{{count}}' }),
    destinations: [destUrl],
  }));
  const { dispatchCustom } = await import('../src/dispatch.js');
  const r = await dispatchCustom(db, src, { env: 'prod', count: 2 });
  dest.close();
  assert.equal(r.ok, 1);
  assert.deepEqual(received[0], { text: 'prod 배포', level: 2 });
});

test('secret 설정된 웹훅은 X-Webhook-Secret 검증', async () => {
  const { db, user } = setup();
  const src = createCustomSource(db, user.id, '보안봇', 'topsecret');
  const app = createApp(db, {
    SESSION_SECRET: 's', GITLAB_WEBHOOK_SECRET: 'gl',
    AUTH_URL: 'https://a', TOKEN_URL: 'https://a/t', ME_URL: 'https://a/m',
    HIWORKS_CLIENT_ID: 'c', HIWORKS_CLIENT_SECRET: '', REDIRECT_URI: 'http://r',
  }, { testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); } });
  const server = app.listen(0); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const noHeader = await fetch(`${base}/webhooks/custom/${src.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(noHeader.status, 401);
  const okReq = await fetch(`${base}/webhooks/custom/${src.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': 'topsecret' }, body: '{}',
  });
  assert.equal(okReq.status, 200);
  server.close();
});

test('남의 웹훅은 token/secret 이 가려진다', () => {
  const { db, user } = setup();
  createCustomSource(db, user.id, 'x', 'sec');
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박' });
  const asOther = listCustomSources(db, other.id)[0];
  assert.equal(asOther.token, null);
  assert.equal(asOther.secret, null);
  const asMine = listCustomSources(db, user.id)[0];
  assert.ok(asMine.token);
  assert.equal(asMine.secret, 'sec');
});

test('custom 규칙은 본인 웹훅에만 생성 가능 (서버 검증)', async () => {
  const { db, user } = setup();
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박' });
  const src = createCustomSource(db, other.id, '남의 웹훅');
  const app = createApp(db, {
    SESSION_SECRET: 's', GITLAB_WEBHOOK_SECRET: 'gl',
    AUTH_URL: 'https://a', TOKEN_URL: 'https://a/t', ME_URL: 'https://a/m',
    HIWORKS_CLIENT_ID: 'c', HIWORKS_CLIENT_SECRET: '', REDIRECT_URI: 'http://r',
  }, { testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); } });
  const server = app.listen(0); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/rules`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(customRule({ custom_source_id: src.id })),
  });
  server.close();
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error.includes('본인'));
});
