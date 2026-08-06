import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAuthorizeUrl, requireAuth } from '../src/auth.js';

const env = {
  AUTH_URL: 'https://auth-api.devoffice.hiworks.com',
  HIWORKS_CLIENT_ID: 'cid123',
  REDIRECT_URI: 'http://127.0.0.1:3000/auth/callback',
};

test('buildAuthorizeUrl composes oauth authorize URL', () => {
  const u = new URL(buildAuthorizeUrl(env));
  assert.equal(u.origin + u.pathname, 'https://auth-api.devoffice.hiworks.com/oauth/authorize');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), 'cid123');
  assert.equal(u.searchParams.get('redirect_uri'), env.REDIRECT_URI);
});

function fakeRes() {
  return {
    statusCode: 200, redirected: null, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    redirect(url) { this.redirected = url; },
  };
}

test('requireAuth: no session on /api → 401 json', () => {
  const res = fakeRes();
  requireAuth({ path: '/api/rules', session: {} }, res, () => assert.fail('must not call next'));
  assert.equal(res.statusCode, 401);
});

test('requireAuth: no session on page → redirect to /login.html', () => {
  const res = fakeRes();
  requireAuth({ path: '/', session: {} }, res, () => assert.fail('must not call next'));
  assert.equal(res.redirected, '/login.html');
});

test('requireAuth: session present → next with req.userId', () => {
  let called = false;
  const req = { path: '/api/rules', session: { userId: 7 } };
  requireAuth(req, fakeRes(), () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.userId, 7);
});
