import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRules, formatMessage } from '../src/dispatch.js';

const event = {
  source: 'gitlab', repo: 'backend/api-gateway', action: 'mr.open',
  author: 'dohyun', title: 'Add login', url: 'https://gitlab.example.com/mr/1',
};
const rule = (over = {}) => ({
  id: 1, source: 'gitlab', repos: ['backend/api-gateway'],
  actions: ['mr.open'], authors: [], destinations: ['https://dest.example/hook'],
  active: 1, ...over,
});

test('matches source+repo+action, empty authors = all', () => {
  assert.equal(matchRules([rule()], event).length, 1);
});

test('inactive rule excluded', () => {
  assert.equal(matchRules([rule({ active: 0 })], event).length, 0);
});

test('repo mismatch excluded', () => {
  assert.equal(matchRules([rule({ repos: ['other/repo'] })], event).length, 0);
});

test('multi-repo rule matches any listed repo', () => {
  const r = rule({ repos: ['other/repo', 'backend/api-gateway'] });
  assert.equal(matchRules([r], event).length, 1);
  assert.equal(matchRules([r], { ...event, repo: 'nope/x' }).length, 0);
});

test('empty repos = 모든 프로젝트', () => {
  const r = rule({ repos: [] });
  assert.equal(matchRules([r], event).length, 1);
  assert.equal(matchRules([r], { ...event, repo: 'any/other' }).length, 1);
});

test('action mismatch excluded', () => {
  assert.equal(matchRules([rule({ actions: ['issue.open'] })], event).length, 0);
});

test('author filter: @handle and bare both match', () => {
  assert.equal(matchRules([rule({ authors: ['@dohyun'] })], event).length, 1);
  assert.equal(matchRules([rule({ authors: ['dohyun'] })], event).length, 1);
  assert.equal(matchRules([rule({ authors: ['@minjun'] })], event).length, 0);
});

test('formatMessage builds messenger+ card', () => {
  const msg = formatMessage(event);
  assert.ok(msg.text.includes('backend/api-gateway'));
  assert.ok(msg.text.includes('Add login'));
  assert.equal(msg.cards.length, 1);
  const labels = msg.cards[0].items.map(i => i.label);
  assert.deepEqual(labels, ['프로젝트', '작성자', '링크']);
  assert.match(msg.cards[0].color, /^#[0-9A-F]{6}$/i);
});

test('failure events get red, success green, others blue', () => {
  assert.equal(formatMessage({ ...event, action: 'pipeline.failed' }).cards[0].color, '#E01E5A');
  assert.equal(formatMessage({ ...event, action: 'pipeline.success' }).cards[0].color, '#2EB67D');
  assert.equal(formatMessage({ ...event, action: 'mr.merge' }).cards[0].color, '#2EB67D');
  assert.equal(formatMessage({ ...event, action: 'issue.open' }).cards[0].color, '#36C5F0');
});

test('text is truncated to 4000 chars', () => {
  const msg = formatMessage({ ...event, title: 'x'.repeat(6000) });
  assert.ok(msg.text.length <= 4000);
});

test('author filter is case-insensitive', () => {
  assert.equal(matchRules([rule({ authors: ['@DoHyun'] })], event).length, 1);
  assert.equal(matchRules([rule({ authors: ['dohyun'] })], { ...event, author: 'DOHYUN' }).length, 1);
});

test('canceled/failed variants red, job/deployment success green', () => {
  assert.equal(formatMessage({ ...event, action: 'pipeline.canceled' }).cards[0].color, '#E01E5A');
  assert.equal(formatMessage({ ...event, action: 'job.failed' }).cards[0].color, '#E01E5A');
  assert.equal(formatMessage({ ...event, action: 'deployment.success' }).cards[0].color, '#2EB67D');
  assert.equal(formatMessage({ ...event, action: 'push' }).cards[0].color, '#36C5F0');
});
