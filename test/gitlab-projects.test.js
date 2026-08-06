import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { upsertUser } from '../src/rules-db.js';
import { createApp } from '../src/app.js';

const baseEnv = {
  SESSION_SECRET: 's', GITLAB_WEBHOOK_SECRET: 'gl',
  AUTH_URL: 'https://a', TOKEN_URL: 'https://a/t', ME_URL: 'https://a/m',
  HIWORKS_CLIENT_ID: 'c', HIWORKS_CLIENT_SECRET: '', REDIRECT_URI: 'http://r',
};

async function startApp(env) {
  const db = openDb(':memory:');
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: 'n' });
  const app = createApp(db, env, {
    testSession: (req, _res, next) => { req.session = { userId: user.id }; next(); },
  });
  const server = app.listen(0);
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('proxies search to gitlab and returns path list', async () => {
  const seen = [];
  const gitlab = http.createServer((req, res) => {
    seen.push(req);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      { id: 1, path_with_namespace: 'hiworks/approval-api-v5' },
      { id: 2, path_with_namespace: 'hiworks/approval-web' },
    ]));
  });
  gitlab.listen(0);
  await once(gitlab, 'listening');

  const { server, base } = await startApp({
    ...baseEnv,
    GITLAB_URL: `http://127.0.0.1:${gitlab.address().port}`,
    GITLAB_TOKEN: 'glpat-test',
  });

  const res = await fetch(`${base}/api/gitlab/projects?q=approval`);
  const body = await res.json();
  server.close(); gitlab.close();

  assert.equal(res.status, 200);
  assert.deepEqual(body, ['hiworks/approval-api-v5', 'hiworks/approval-web']);
  const u = new URL(seen[0].url, 'http://x');
  assert.equal(u.pathname, '/api/v4/projects');
  assert.equal(u.searchParams.get('search'), 'approval');
  assert.equal(seen[0].headers['private-token'], 'glpat-test');
});

test('returns [] when GITLAB_TOKEN not configured', async () => {
  const { server, base } = await startApp(baseEnv);
  const res = await fetch(`${base}/api/gitlab/projects?q=x`);
  const body = await res.json();
  server.close();
  assert.equal(res.status, 200);
  assert.deepEqual(body, []);
});

test('returns [] for empty query without calling gitlab', async () => {
  let called = false;
  const gitlab = http.createServer((_req, res) => { called = true; res.writeHead(200); res.end('[]'); });
  gitlab.listen(0);
  await once(gitlab, 'listening');
  const { server, base } = await startApp({
    ...baseEnv,
    GITLAB_URL: `http://127.0.0.1:${gitlab.address().port}`,
    GITLAB_TOKEN: 't',
  });
  const res = await fetch(`${base}/api/gitlab/projects`);
  const body = await res.json();
  server.close(); gitlab.close();
  assert.deepEqual(body, []);
  assert.equal(called, false);
});

test('gitlab error → 502 json', async () => {
  const gitlab = http.createServer((_req, res) => { res.writeHead(500); res.end(); });
  gitlab.listen(0);
  await once(gitlab, 'listening');
  const { server, base } = await startApp({
    ...baseEnv,
    GITLAB_URL: `http://127.0.0.1:${gitlab.address().port}`,
    GITLAB_TOKEN: 't',
  });
  const res = await fetch(`${base}/api/gitlab/projects?q=x`);
  server.close(); gitlab.close();
  assert.equal(res.status, 502);
});
