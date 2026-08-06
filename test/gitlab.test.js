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

test('merge_request full action set', () => {
  for (const [glAction, expected] of [
    ['merge', 'mr.merge'], ['close', 'mr.close'], ['reopen', 'mr.reopen'],
    ['update', 'mr.update'], ['approved', 'mr.approved'], ['unapproved', 'mr.unapproved'],
  ]) {
    const ev = normalizeGitlab({ ...base, object_kind: 'merge_request', object_attributes: { action: glAction, title: 't', url: 'u' } });
    assert.equal(ev.action, expected, glAction);
  }
});

test('issue actions incl. reopen as own action', () => {
  for (const [glAction, expected] of [
    ['open', 'issue.open'], ['close', 'issue.close'], ['reopen', 'issue.reopen'], ['update', 'issue.update'],
  ]) {
    const ev = normalizeGitlab({ ...base, object_kind: 'issue', object_attributes: { action: glAction, title: 'Bug', url: 'u' } });
    assert.equal(ev.action, expected, glAction);
  }
});

test('confidential_issue maps with its own prefix', () => {
  const ev = normalizeGitlab({ ...base, object_kind: 'confidential_issue', object_attributes: { action: 'open', title: 'secret', url: 'u' } });
  assert.equal(ev.action, 'confidential_issue.open');
});

test('push event', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'push',
    user_username: 'pusher',
    user: undefined,
    ref: 'refs/heads/main',
    total_commits_count: 3,
  });
  assert.equal(ev.action, 'push');
  assert.equal(ev.author, 'pusher');
  assert.ok(ev.title.includes('main'));
  assert.ok(ev.title.includes('3'));
});

test('tag_push event', () => {
  const ev = normalizeGitlab({ ...base, object_kind: 'tag_push', ref: 'refs/tags/v1.2.0' });
  assert.equal(ev.action, 'tag_push');
  assert.equal(ev.title, 'v1.2.0');
});

test('note maps by noteable_type', () => {
  for (const [noteable, expected] of [
    ['Commit', 'note.commit'], ['MergeRequest', 'note.merge_request'], ['Issue', 'note.issue'], ['Snippet', 'note.snippet'],
  ]) {
    const ev = normalizeGitlab({
      ...base,
      object_kind: 'note',
      object_attributes: { noteable_type: noteable, note: 'nice work', url: 'u' },
      merge_request: noteable === 'MergeRequest' ? { title: 'MR title' } : undefined,
    });
    assert.equal(ev.action, expected, noteable);
  }
});

test('note on MR uses MR title', () => {
  const ev = normalizeGitlab({
    ...base,
    object_kind: 'note',
    object_attributes: { noteable_type: 'MergeRequest', note: 'lgtm', url: 'u' },
    merge_request: { title: 'Add login' },
  });
  assert.equal(ev.title, 'Add login');
});

test('confidential_note event', () => {
  const ev = normalizeGitlab({ ...base, object_kind: 'confidential_note', object_attributes: { note: 'secret comment', url: 'u' } });
  assert.equal(ev.action, 'confidential_note');
});

test('pipeline statuses success/failed/canceled/running', () => {
  for (const st of ['success', 'failed', 'canceled', 'running']) {
    const ev = normalizeGitlab({ ...base, object_kind: 'pipeline', object_attributes: { id: 42, status: st, ref: 'main' } });
    assert.equal(ev.action, `pipeline.${st}`, st);
  }
  assert.equal(normalizeGitlab({ ...base, object_kind: 'pipeline', object_attributes: { id: 1, status: 'pending', ref: 'main' } }), null);
});

test('pipeline url built from project web_url', () => {
  const ev = normalizeGitlab({ ...base, object_kind: 'pipeline', object_attributes: { id: 42, status: 'failed', ref: 'main' } });
  assert.equal(ev.url, 'https://gitlab.example.com/backend/api-gateway/-/pipelines/42');
});

test('job (build) event uses project_name fallback for repo', () => {
  const ev = normalizeGitlab({
    object_kind: 'build',
    project_name: 'backend / api-gateway',
    user: { username: 'dohyun' },
    build_id: 7, build_name: 'unit-test', build_status: 'failed', ref: 'main',
  });
  assert.equal(ev.action, 'job.failed');
  assert.equal(ev.repo, 'backend/api-gateway');
  assert.ok(ev.title.includes('unit-test'));
});

test('wiki_page actions', () => {
  for (const a of ['create', 'update', 'delete']) {
    const ev = normalizeGitlab({ ...base, object_kind: 'wiki_page', object_attributes: { action: a, title: 'Home', url: 'u' } });
    assert.equal(ev.action, `wiki.${a}`, a);
  }
});

test('deployment statuses', () => {
  const ev = normalizeGitlab({ ...base, object_kind: 'deployment', status: 'success', environment: 'production' });
  assert.equal(ev.action, 'deployment.success');
  assert.equal(ev.title, 'production');
});

test('feature_flag event', () => {
  const ev = normalizeGitlab({ ...base, object_kind: 'feature_flag', object_attributes: { name: 'new-nav' } });
  assert.equal(ev.action, 'feature_flag');
  assert.equal(ev.title, 'new-nav');
});

test('release create/update', () => {
  for (const a of ['create', 'update']) {
    const ev = normalizeGitlab({ ...base, object_kind: 'release', action: a, name: 'v2.0', url: 'https://rel' });
    assert.equal(ev.action, `release.${a}`, a);
  }
});

test('unknown object_kind returns null', () => {
  assert.equal(normalizeGitlab({ ...base, object_kind: 'emoji' }), null);
});

test('malformed payload returns null', () => {
  assert.equal(normalizeGitlab({}), null);
  assert.equal(normalizeGitlab(null), null);
});
