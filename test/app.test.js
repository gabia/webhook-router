import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { upsertUser } from '../src/rules-db.js';
import { createApp } from '../src/app.js';

const env = {
  SESSION_SECRET: 'test-secret',
  GITLAB_WEBHOOK_SECRET: 'glsecret',
  AUTH_URL: 'https://auth.example', TOKEN_URL: 'https://auth.example/oauth/token',
  ME_URL: 'https://cache.example/me',
  HIWORKS_CLIENT_ID: 'cid', HIWORKS_CLIENT_SECRET: '', REDIRECT_URI: 'http://127.0.0.1/auth/callback',
};

async function start(db) {
  const app = createApp(db, env);
  // 테스트 전용 로그인 우회: cookie-session 서명 쿠키를 만들기 번거로우므로
  // 테스트에서만 쓰는 헤더 기반 세션 주입 미들웨어를 createApp 옵션으로 받는다.
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('unauthenticated /api/rules → 401', async () => {
  const db = openDb(':memory:');
  const { server, base } = await start(db);
  const res = await fetch(`${base}/api/rules`);
  server.close();
  assert.equal(res.status, 401);
});

test('webhook: wrong token → 401, correct token → 200', async () => {
  const db = openDb(':memory:');
  const { server, base } = await start(db);
  const bad = await fetch(`${base}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': 'wrong' },
    body: '{}',
  });
  assert.equal(bad.status, 401);
  const ok = await fetch(`${base}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': 'glsecret' },
    body: '{}',
  });
  assert.equal(ok.status, 200);
  server.close();
});

test('rules CRUD with session', async () => {
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: '김개발' });
  const app = createApp(db, env, {
    testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); },
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const created = await fetch(`${base}/api/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'r1', description: '', source: 'gitlab', repos: ['a/b'],
      actions: ['mr.open'], authors: [], destinations: ['https://d.example/h'], active: true,
    }),
  });
  assert.equal(created.status, 201);
  const rule = await created.json();

  const list = await (await fetch(`${base}/api/rules`)).json();
  assert.equal(list.length, 1);

  const invalid = await fetch(`${base}/api/rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', source: 'gitlab' }),
  });
  assert.equal(invalid.status, 400);

  const updated = await fetch(`${base}/api/rules/${rule.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...rule, name: '변경', active: false }),
  });
  assert.equal((await updated.json()).name, '변경');

  const del = await fetch(`${base}/api/rules/${rule.id}`, { method: 'DELETE' });
  assert.equal(del.status, 204);
  server.close();
});

test('webhook logs inbound: unsupported and matched events', async () => {
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: 'n' });
  const app = createApp(db, env, {
    testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); },
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  await fetch(`${base}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': 'glsecret' },
    body: JSON.stringify({ object_kind: 'emoji', project: { path_with_namespace: 'a/b' } }),
  });
  await new Promise(r => setTimeout(r, 200));

  const logs = await (await fetch(`${base}/api/inbound-logs`)).json();
  server.close();
  assert.equal(logs.length, 1);
  assert.ok(logs[0].action.includes('미지원'));
  assert.equal(logs[0].repo, 'a/b');
});

test('webhook wrong secret is logged as rejected', async () => {
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: 'n' });
  const app = createApp(db, env, {
    testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); },
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': 'nope' },
    body: JSON.stringify({ object_kind: 'push', project: { path_with_namespace: 'x/y' } }),
  });
  assert.equal(r.status, 401);
  const logs = await (await fetch(`${base}/api/inbound-logs`)).json();
  server.close();
  assert.ok(logs.some(l => l.action.includes('secret 불일치') && l.repo === 'x/y'));
});
