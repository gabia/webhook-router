import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitlab } from '../src/gitlab.js';

const base = {
  project: { path_with_namespace: 'backend/api-gateway', web_url: 'https://gitlab.example.com/backend/api-gateway' },
  user: { username: 'dohyun' },
};

test('merge_request open', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'merge_request',
    object_attributes: { action: 'open', title: 'Add login', url: 'https://gitlab.example.com/backend/api-gateway/-/merge_requests/1' },
  });
  assert.deepEqual(ev, {
    source: 'gitlab',
    repo: 'backend/api-gateway',
    action: 'mr.open',
    author: 'dohyun',
    title: 'Add login',
    url: 'https://gitlab.example.com/backend/api-gateway/-/merge_requests/1',
  });
});

test('merge_request merge action', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'merge_request',
    object_attributes: { action: 'merge', title: 't', url: 'u' },
  });
  assert.equal(ev.action, 'mr.merge');
});

test('issue close', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'issue',
    object_attributes: { action: 'close', title: 'Bug', url: 'https://gitlab.example.com/backend/api-gateway/-/issues/2' },
  });
  assert.equal(ev.action, 'issue.close');
  assert.equal(ev.title, 'Bug');
});

test('issue reopen maps to update', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'issue',
    object_attributes: { action: 'reopen', title: 't', url: 'u' },
  });
  assert.equal(ev.action, 'issue.update');
});

test('pipeline failed', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'pipeline',
    object_attributes: { id: 42, status: 'failed', ref: 'main' },
  });
  assert.equal(ev.action, 'pipeline.failed');
  assert.equal(ev.title, 'main');
  assert.equal(ev.url, 'https://gitlab.example.com/backend/api-gateway/-/pipelines/42');
});

test('pipeline running is ignored', () => {
  assert.equal(normalizeGitlab({
    ...base,
    object_kind: 'pipeline',
    object_attributes: { id: 1, status: 'running', ref: 'main' },
  }), null);
});

test('unknown object_kind returns null', () => {
  assert.equal(normalizeGitlab({ ...base, object_kind: 'push' }), null);
});

test('malformed payload returns null', () => {
  assert.equal(normalizeGitlab({}), null);
  assert.equal(normalizeGitlab(null), null);
});
