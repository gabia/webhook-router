import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { openDb } from '../src/db.js';
import { upsertUser, createRule } from '../src/rules-db.js';
import { dispatchEvent } from '../src/dispatch.js';

const event = {
  source: 'gitlab', repo: 'a/b', action: 'mr.open',
  author: 'dohyun', title: 'T', url: 'https://gitlab.example.com/mr/1',
};

async function startDest(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(body) });
      handler(received.length, res);
    });
  });
  server.listen(0);
  await once(server, 'listening');
  return { server, received, url: `http://127.0.0.1:${server.address().port}/hook` };
}

function setupRule(db, destinations) {
  const user = upsertUser(db, { office_user_no: 'o1', user_no: 'u1', name: 'n' });
  return createRule(db, user.id, {
    name: 'r', description: '', source: 'gitlab', repo: 'a/b',
    actions: ['mr.open'], authors: [], destinations, active: true,
  });
}

test('sends messenger+ json to destination and logs success', async () => {
  const db = openDb(':memory:');
  const dest = await startDest((n, res) => { res.writeHead(200); res.end(); });
  setupRule(db, [dest.url]);

  await dispatchEvent(db, event);
  dest.server.close();

  assert.equal(dest.received.length, 1);
  assert.equal(dest.received[0].headers['content-type'], 'application/json');
  assert.ok(dest.received[0].body.text.includes('a/b'));
  assert.ok(Array.isArray(dest.received[0].body.cards));

  const log = db.prepare('SELECT * FROM delivery_logs').get();
  assert.equal(log.status, 'success');
});

test('retries once on 500 then succeeds', async () => {
  const db = openDb(':memory:');
  const dest = await startDest((n, res) => {
    res.writeHead(n === 1 ? 500 : 200); res.end();
  });
  setupRule(db, [dest.url]);

  await dispatchEvent(db, event);
  dest.server.close();

  assert.equal(dest.received.length, 2);
  assert.equal(db.prepare('SELECT * FROM delivery_logs').get().status, 'success');
});

test('logs fail after two failures, error has no full URL', async () => {
  const db = openDb(':memory:');
  const dest = await startDest((n, res) => { res.writeHead(500); res.end(); });
  setupRule(db, [dest.url + '?secret=abc']);

  await dispatchEvent(db, event);
  dest.server.close();

  const log = db.prepare('SELECT * FROM delivery_logs').get();
  assert.equal(log.status, 'fail');
  assert.ok(!log.error.includes('secret=abc'));
});

test('no matching rule → no request, no log', async () => {
  const db = openDb(':memory:');
  await dispatchEvent(db, { ...event, repo: 'no/match' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM delivery_logs').get().c, 0);
});
