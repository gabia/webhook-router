import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { openDb } from '../src/db.js';
import { upsertUser, createRule } from '../src/rules-db.js';
import { createApp } from '../src/app.js';

test('gitlab webhook → messenger+ payload arrives at destination', async () => {
  // mock destination
  const received = [];
  const dest = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { received.push(JSON.parse(body)); res.writeHead(200); res.end(); });
  });
  dest.listen(0);
  await once(dest, 'listening');
  const destUrl = `http://127.0.0.1:${dest.address().port}/hook`;

  // app + rule
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: 'n' });
  createRule(db, user.id, {
    name: 'MR 알림', description: '', source: 'gitlab', repos: ['backend/api-gateway'],
    actions: ['mr.open'], authors: [], destinations: [destUrl], active: true,
  });
  const app = createApp(db, {
    SESSION_SECRET: 's', GITLAB_WEBHOOK_SECRET: 'gl',
    AUTH_URL: 'https://a', TOKEN_URL: 'https://a/t', ME_URL: 'https://a/m',
    HIWORKS_CLIENT_ID: 'c', HIWORKS_CLIENT_SECRET: '', REDIRECT_URI: 'http://r',
  });
  const server = app.listen(0);
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const res = await fetch(`${base}/webhooks/gitlab`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Gitlab-Token': 'gl' },
    body: JSON.stringify({
      object_kind: 'merge_request',
      project: { path_with_namespace: 'backend/api-gateway', web_url: 'https://gitlab.example.com/backend/api-gateway' },
      user: { username: 'dohyun' },
      object_attributes: { action: 'open', title: 'Add login', url: 'https://gitlab.example.com/backend/api-gateway/-/merge_requests/1' },
    }),
  });
  assert.equal(res.status, 200);

  // 비동기 dispatch 대기
  for (let i = 0; i < 50 && received.length === 0; i++) await sleep(100);
  server.close(); dest.close();

  assert.equal(received.length, 1);
  assert.ok(received[0].text.includes('MR 생성'));
  assert.equal(received[0].cards[0].items[0].content, 'backend/api-gateway');
  assert.equal(db.prepare('SELECT status FROM delivery_logs').get().status, 'success');
});
