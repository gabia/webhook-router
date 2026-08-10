import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import {
  upsertUser, listRules, createRule, updateRule, deleteRule,
  findActiveRules, logDelivery, validateRule,
} from '../src/rules-db.js';

const data = {
  name: '테스트 규칙', description: '', source: 'gitlab', repo: 'a/b',
  actions: ['mr.open'], authors: [], destinations: ['https://dest.example/hook'], active: true,
};

function setup() {
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: '김개발' });
  return { db, user };
}

test('upsertUser is idempotent by office_user_no', () => {
  const { db, user } = setup();
  const again = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: '김개발' });
  assert.equal(user.id, again.id);
});

test('create + list roundtrip with parsed arrays', () => {
  const { db, user } = setup();
  const created = createRule(db, user.id, data);
  assert.ok(created.id);
  const rules = listRules(db, user.id);
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].actions, ['mr.open']);
  assert.deepEqual(rules[0].destinations, ['https://dest.example/hook']);
});

test('list shows every users rules, flagged by ownership', () => {
  const { db, user } = setup();
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박해커' });
  createRule(db, user.id, data);
  createRule(db, other.id, { ...data, name: '남의 규칙' });
  const rules = listRules(db, user.id);
  assert.equal(rules.length, 2);
  assert.deepEqual(
    rules.map(r => [r.name, r.owner_name, r.mine]),
    [['남의 규칙', '박해커', 0], ['테스트 규칙', '김개발', 1]],
  );
});

test('list is ordered by last modified', () => {
  const { db, user } = setup();
  const first = createRule(db, user.id, { ...data, name: '먼저' });
  createRule(db, user.id, { ...data, name: '나중' });
  // datetime('now') 은 초 단위라 같은 초에 만들면 구분이 안 된다 — 과거로 밀어 차이를 만든다
  db.prepare("UPDATE rules SET updated_at = datetime('now','-1 hour')").run();
  updateRule(db, user.id, first.id, { ...data, name: '먼저(수정됨)' });
  assert.deepEqual(listRules(db, user.id).map(r => r.name), ['먼저(수정됨)', '나중']);
});

test('update only by owner', () => {
  const { db, user } = setup();
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박해커' });
  const r = createRule(db, user.id, data);
  assert.equal(updateRule(db, other.id, r.id, { ...data, name: '탈취' }), null);
  const updated = updateRule(db, user.id, r.id, { ...data, name: '변경됨', active: false });
  assert.equal(updated.name, '변경됨');
  assert.equal(updated.active, 0);
});

test('delete only by owner', () => {
  const { db, user } = setup();
  const other = upsertUser(db, { office_user_no: 'o2', user_no: 'u2', name: '박해커' });
  const r = createRule(db, user.id, data);
  assert.equal(deleteRule(db, other.id, r.id), false);
  assert.equal(deleteRule(db, user.id, r.id), true);
  assert.equal(listRules(db, user.id).length, 0);
});

test('findActiveRules returns all users active rules for source', () => {
  const { db, user } = setup();
  createRule(db, user.id, data);
  createRule(db, user.id, { ...data, active: false });
  createRule(db, user.id, { ...data, source: 'sentry', repo: 'sentry/x' });
  assert.equal(findActiveRules(db, 'gitlab').length, 1);
});

test('logDelivery writes row', () => {
  const { db, user } = setup();
  const r = createRule(db, user.id, data);
  logDelivery(db, { rule_id: r.id, summary: '[a/b] MR 생성', status: 'fail', error: 'HTTP 500' });
  const row = db.prepare('SELECT * FROM delivery_logs').get();
  assert.equal(row.status, 'fail');
});

test('validateRule rejects bad input', () => {
  assert.equal(validateRule(data).ok, true);
  assert.equal(validateRule({ ...data, name: ' ' }).ok, false);
  assert.equal(validateRule({ ...data, actions: [] }).ok, false);
  assert.equal(validateRule({ ...data, destinations: [] }).ok, false);
  assert.equal(validateRule({ ...data, destinations: ['ftp://x'] }).ok, false);
  assert.equal(validateRule({ ...data, source: 'jira' }).ok, false);
});

test('logInbound/listInbound roundtrip, newest first', async () => {
  const { logInbound, listInbound } = await import('../src/rules-db.js');
  const { openDb } = await import('../src/db.js');
  const db = openDb(':memory:');
  logInbound(db, { source: 'gitlab', repo: 'a/b', action: 'mr.open', author: 'u1', title: 't1', url: 'x', matched: 2, delivered_ok: 2, delivered_fail: 0 });
  logInbound(db, { source: 'gitlab', repo: '', action: '(미지원: push_hook)', author: '', title: '', url: '', matched: 0, delivered_ok: 0, delivered_fail: 0 });
  const rows = listInbound(db, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].action, '(미지원: push_hook)');
  assert.equal(rows[1].matched, 2);
});
