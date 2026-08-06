# 웹훅 미들웨어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitLab 웹훅을 수신해 사용자 규칙에 맞는 것만 메신저+ 카드 포맷으로 지정 URL에 재발송하는 단일 Node 서버.

**Architecture:** Express 단일 프로세스. Hiworks OAuth 세션(cookie-session) 뒤에 규칙 CRUD API + 목업 기반 대시보드. `POST /webhooks/gitlab`은 secret 검증 후 즉시 200, 비동기로 adapter 정규화 → 규칙 매칭 → 메신저+ `{text, cards}` POST(1회 재시도) → delivery_logs 기록.

**Tech Stack:** Node 18+ (global fetch, `node:test`), Express, better-sqlite3, cookie-session. 테스트 프레임워크 추가 설치 없음(`node --test`).

## Global Constraints

- 의존성은 `express`, `better-sqlite3`, `cookie-session` 3개만. 테스트는 `node:test` + `assert`.
- ESM (`"type": "module"`).
- 도메인/secret 하드코딩 금지 — 전부 env (`oauth-integration` 스킬 규칙).
- 웹훅 수신은 항상 200 반환(검증 실패 시에만 401), 처리는 응답 후 비동기.
- delivery_logs 및 콘솔 로그에 destination URL 전체를 남기지 않는다(호스트만).
- 메신저+ 제한: cards ≤ 10, 카드당 items ≤ 10, 전체 메시지 ≈5000자.
- 스펙: `docs/superpowers/specs/2026-08-06-webhook-middleware-design.md`

---

### Task 1: 스캐폴드 + DB 스키마

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `src/db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces: `openDb(path)` → better-sqlite3 Database 인스턴스, 스키마 생성 완료 상태. `':memory:'` 허용.

- [ ] **Step 1: package.json / .gitignore / .env.example 작성**

`package.json`:
```json
{
  "name": "webhook-middleware",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  }
}
```

`.gitignore`:
```
node_modules/
.env
*.db
```

`.env.example`:
```env
PORT=3000
DB_PATH=./data.db
SESSION_SECRET=change-me

# oauth-integration 스킬 기준 (로컬 Dev 공용 클라이언트)
HIWORKS_CLIENT_ID=Q6OTXYUFf8QFfNb7K352RqXcZ6rRyDdr
HIWORKS_CLIENT_SECRET=
REDIRECT_URI=http://127.0.0.1:3000/auth/callback
AUTH_URL=https://auth-api.devoffice.hiworks.com
TOKEN_URL=https://auth-api.devoffice.hiworks.com/oauth/token
ME_URL=https://cache-api.devoffice.hiworks.com/me

GITLAB_WEBHOOK_SECRET=change-me
```

- [ ] **Step 2: 의존성 설치**

Run: `npm install express better-sqlite3 cookie-session`
Expected: 성공, `package-lock.json` 생성.

- [ ] **Step 3: 실패하는 테스트 작성**

`test/db.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';

test('openDb creates schema', () => {
  const db = openDb(':memory:');
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map(r => r.name);
  assert.ok(tables.includes('users'));
  assert.ok(tables.includes('rules'));
  assert.ok(tables.includes('delivery_logs'));
});
```

- [ ] **Step 4: 테스트 실패 확인**

Run: `npm test`
Expected: FAIL — `Cannot find module '../src/db.js'`

- [ ] **Step 5: 구현**

`src/db.js`:
```js
import Database from 'better-sqlite3';

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      office_user_no TEXT NOT NULL UNIQUE,
      user_no TEXT,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('gitlab','sentry')),
      repo TEXT NOT NULL,
      actions TEXT NOT NULL,        -- JSON array
      authors TEXT NOT NULL,        -- JSON array, [] = all
      destinations TEXT NOT NULL,   -- JSON array of URLs
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS delivery_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_id INTEGER NOT NULL,
      summary TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('success','fail')),
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}
```

- [ ] **Step 6: 테스트 통과 확인**

Run: `npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example src/db.js test/db.test.js
git commit -m "feat: 프로젝트 스캐폴드 + SQLite 스키마"
```

---

### Task 2: GitLab adapter (payload 정규화)

**Files:**
- Create: `src/gitlab.js`
- Test: `test/gitlab.test.js`

**Interfaces:**
- Produces: `normalizeGitlab(body)` → `{source:'gitlab', repo, action, author, title, url} | null`.
  - `action`은 UI 코드와 동일: `issue.open|issue.close|issue.update`, `mr.open|mr.merge|mr.close`, `pipeline.success|pipeline.failed`
  - 매핑 불가 payload는 `null`.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/gitlab.test.js`:
```js
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/gitlab.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 구현**

`src/gitlab.js`:
```js
// GitLab webhook payload → {source, repo, action, author, title, url} | null
const ACTION_MAP = {
  merge_request: { open: 'mr.open', merge: 'mr.merge', close: 'mr.close' },
  issue: { open: 'issue.open', close: 'issue.close', update: 'issue.update', reopen: 'issue.update' },
};
const PIPELINE_STATUS = { success: 'pipeline.success', failed: 'pipeline.failed' };

export function normalizeGitlab(body) {
  if (!body || !body.project || !body.object_kind) return null;
  const repo = body.project.path_with_namespace;
  const author = body.user?.username ?? '';
  const attrs = body.object_attributes ?? {};

  if (body.object_kind === 'pipeline') {
    const action = PIPELINE_STATUS[attrs.status];
    if (!action) return null;
    return {
      source: 'gitlab', repo, action, author,
      title: attrs.ref ?? '',
      url: `${body.project.web_url}/-/pipelines/${attrs.id}`,
    };
  }

  const action = ACTION_MAP[body.object_kind]?.[attrs.action];
  if (!action) return null;
  return {
    source: 'gitlab', repo, action, author,
    title: attrs.title ?? '',
    url: attrs.url ?? '',
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/gitlab.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gitlab.js test/gitlab.test.js
git commit -m "feat: GitLab 웹훅 payload 정규화 adapter"
```

---

### Task 3: 규칙 매칭 + 메신저+ 포맷터

**Files:**
- Create: `src/dispatch.js` (순수 함수 부분)
- Test: `test/dispatch.test.js`

**Interfaces:**
- Consumes: Task 2의 event 형태 `{source, repo, action, author, title, url}`
- Produces:
  - `matchRules(rules, event)` → 매칭된 rule 배열. rule은 파싱된 형태 `{id, source, repo, actions:[], authors:[], destinations:[], active}`
  - `formatMessage(event)` → 메신저+ `{text, cards}` 객체

- [ ] **Step 1: 실패하는 테스트 작성**

`test/dispatch.test.js`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchRules, formatMessage } from '../src/dispatch.js';

const event = {
  source: 'gitlab', repo: 'backend/api-gateway', action: 'mr.open',
  author: 'dohyun', title: 'Add login', url: 'https://gitlab.example.com/mr/1',
};
const rule = (over = {}) => ({
  id: 1, source: 'gitlab', repo: 'backend/api-gateway',
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
  assert.equal(matchRules([rule({ repo: 'other/repo' })], event).length, 0);
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/dispatch.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 구현**

`src/dispatch.js`:
```js
const ACTION_LABEL = {
  'issue.open': '이슈 생성', 'issue.close': '이슈 종료', 'issue.update': '이슈 변경',
  'mr.open': 'MR 생성', 'mr.merge': 'MR 병합', 'mr.close': 'MR 닫힘',
  'pipeline.success': '파이프라인 성공', 'pipeline.failed': '파이프라인 실패',
};
const GREEN = '#2EB67D', BLUE = '#36C5F0', RED = '#E01E5A';
const COLOR = {
  'pipeline.failed': RED,
  'pipeline.success': GREEN,
  'mr.merge': GREEN,
};

const bare = (a) => a.replace(/^@/, '');

export function matchRules(rules, event) {
  return rules.filter(r =>
    r.active &&
    r.source === event.source &&
    r.repo === event.repo &&
    r.actions.includes(event.action) &&
    (r.authors.length === 0 || r.authors.map(bare).includes(bare(event.author)))
  );
}

export function formatMessage(event) {
  const label = ACTION_LABEL[event.action] ?? event.action;
  const text = `[${event.repo}] ${label}: ${event.title} (@${event.author})`.slice(0, 4000);
  return {
    text,
    cards: [{
      color: COLOR[event.action] ?? BLUE,
      items: [
        { label: '프로젝트', content: event.repo },
        { label: '작성자', content: `@${event.author}` },
        { label: '링크', content: event.url },
      ],
    }],
  };
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/dispatch.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js test/dispatch.test.js
git commit -m "feat: 규칙 매칭 + 메신저+ 카드 포맷터"
```

---

### Task 4: 규칙 CRUD DB 레이어 + 검증

**Files:**
- Create: `src/rules-db.js`
- Test: `test/rules-db.test.js`

**Interfaces:**
- Consumes: Task 1 `openDb`
- Produces (모두 `db`를 첫 인자로 받음):
  - `upsertUser(db, {office_user_no, user_no, name})` → user row `{id, ...}`
  - `listRules(db, userId)` → 파싱된 rule 배열 (actions/authors/destinations는 배열)
  - `createRule(db, userId, data)` → 생성된 rule (파싱된 형태)
  - `updateRule(db, userId, id, data)` → 갱신된 rule | null(소유자 아님/없음)
  - `deleteRule(db, userId, id)` → boolean
  - `findActiveRules(db, source)` → 파싱된 rule 배열 (dispatcher용, 전체 사용자)
  - `logDelivery(db, {rule_id, summary, status, error})`
  - `validateRule(data)` → `{ok: true}` | `{ok: false, error}` — name/repo/actions≥1/destinations≥1(http(s)만), source ∈ gitlab|sentry

- [ ] **Step 1: 실패하는 테스트 작성**

`test/rules-db.test.js`:
```js
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/rules-db.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 구현**

`src/rules-db.js`:
```js
function parse(row) {
  if (!row) return null;
  return {
    ...row,
    actions: JSON.parse(row.actions),
    authors: JSON.parse(row.authors),
    destinations: JSON.parse(row.destinations),
  };
}

export function upsertUser(db, { office_user_no, user_no, name }) {
  db.prepare(`
    INSERT INTO users (office_user_no, user_no, name) VALUES (?, ?, ?)
    ON CONFLICT(office_user_no) DO UPDATE SET user_no=excluded.user_no, name=excluded.name
  `).run(office_user_no, user_no, name);
  return db.prepare('SELECT * FROM users WHERE office_user_no = ?').get(office_user_no);
}

export function validateRule(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: '잘못된 요청' };
  if (!d.name?.trim()) return { ok: false, error: '이름은 필수입니다' };
  if (!['gitlab', 'sentry'].includes(d.source)) return { ok: false, error: '지원하지 않는 소스' };
  if (!d.repo?.trim()) return { ok: false, error: '프로젝트는 필수입니다' };
  if (!Array.isArray(d.actions) || d.actions.length === 0) return { ok: false, error: 'Action을 1개 이상 선택하세요' };
  if (!Array.isArray(d.authors)) return { ok: false, error: '잘못된 작성자 목록' };
  if (!Array.isArray(d.destinations) || d.destinations.length === 0) return { ok: false, error: 'URL을 1개 이상 등록하세요' };
  for (const url of d.destinations) {
    try {
      const u = new URL(url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    } catch {
      return { ok: false, error: `잘못된 URL: ${String(url).slice(0, 80)}` };
    }
  }
  return { ok: true };
}

export function createRule(db, userId, d) {
  const info = db.prepare(`
    INSERT INTO rules (user_id, name, description, source, repo, actions, authors, destinations, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId, d.name.trim(), d.description ?? '', d.source, d.repo.trim(),
    JSON.stringify(d.actions), JSON.stringify(d.authors ?? []),
    JSON.stringify(d.destinations), d.active ? 1 : 0,
  );
  return parse(db.prepare('SELECT * FROM rules WHERE id = ?').get(info.lastInsertRowid));
}

export function listRules(db, userId) {
  return db.prepare('SELECT * FROM rules WHERE user_id = ? ORDER BY id DESC').all(userId).map(parse);
}

export function updateRule(db, userId, id, d) {
  const info = db.prepare(`
    UPDATE rules SET name=?, description=?, repo=?, actions=?, authors=?, destinations=?, active=?
    WHERE id = ? AND user_id = ?
  `).run(
    d.name.trim(), d.description ?? '', d.repo.trim(),
    JSON.stringify(d.actions), JSON.stringify(d.authors ?? []),
    JSON.stringify(d.destinations), d.active ? 1 : 0,
    id, userId,
  );
  if (info.changes === 0) return null;
  return parse(db.prepare('SELECT * FROM rules WHERE id = ?').get(id));
}

export function deleteRule(db, userId, id) {
  return db.prepare('DELETE FROM rules WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function findActiveRules(db, source) {
  return db.prepare('SELECT * FROM rules WHERE active = 1 AND source = ?').all(source).map(parse);
}

export function logDelivery(db, { rule_id, summary, status, error }) {
  db.prepare('INSERT INTO delivery_logs (rule_id, summary, status, error) VALUES (?, ?, ?, ?)')
    .run(rule_id, summary, status, error ?? null);
}
```

주: `source`는 생성 후 변경 불가(스펙) — `updateRule`의 SET 목록에서 의도적으로 제외.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/rules-db.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/rules-db.js test/rules-db.test.js
git commit -m "feat: 규칙 CRUD DB 레이어 + 입력 검증"
```

---

### Task 5: Hiworks OAuth 인증

**Files:**
- Create: `src/auth.js`
- Test: `test/auth.test.js`

**Interfaces:**
- Consumes: Task 4 `upsertUser`
- Produces:
  - `buildAuthorizeUrl(env)` → 인가 URL 문자열 (env = `{AUTH_URL, HIWORKS_CLIENT_ID, REDIRECT_URI}`)
  - `authRouter(db, env)` → Express Router: `GET /login`, `GET /auth/callback`, `POST /logout`
  - `requireAuth(req, res, next)` — 세션 없으면 `/api/*`는 401 JSON, 그 외 `/login.html` redirect. 있으면 `req.userId` 설정.
- 세션: cookie-session, `req.session.userId`에 users.id 저장.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/auth.test.js`:
```js
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/auth.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 구현**

`src/auth.js`:
```js
import { Router } from 'express';
import { upsertUser } from './rules-db.js';

export function buildAuthorizeUrl(env) {
  const u = new URL('/oauth/authorize', env.AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.HIWORKS_CLIENT_ID);
  u.searchParams.set('redirect_uri', env.REDIRECT_URI);
  return u.toString();
}

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: '로그인이 필요합니다' });
    return res.redirect('/login.html');
  }
  req.userId = req.session.userId;
  next();
}

export function authRouter(db, env) {
  const router = Router();

  router.get('/login', (req, res) => res.redirect(buildAuthorizeUrl(env)));

  router.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('code 누락');
    try {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: env.HIWORKS_CLIENT_ID,
        redirect_uri: env.REDIRECT_URI,
      });
      if (env.HIWORKS_CLIENT_SECRET) body.set('client_secret', env.HIWORKS_CLIENT_SECRET);

      const tokenRes = await fetch(env.TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      if (!tokenRes.ok) throw new Error(`token exchange ${tokenRes.status}`);
      const token = await tokenRes.json();
      const accessToken = token.access_token ?? token.data?.access_token;
      if (!accessToken) throw new Error('access_token 없음');

      const meRes = await fetch(env.ME_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!meRes.ok) throw new Error(`me ${meRes.status}`);
      const meBody = await meRes.json();
      const me = meBody.data ?? meBody;

      const user = upsertUser(db, {
        office_user_no: String(me.office_user_no ?? me.user_no),
        user_no: String(me.user_no ?? ''),
        name: me.name ?? me.user_name ?? '',
      });
      req.session.userId = user.id;
      res.redirect('/');
    } catch (err) {
      console.error('OAuth callback 실패:', err.message);
      res.status(502).send('로그인 실패. 다시 시도해주세요.');
    }
  });

  router.post('/logout', (req, res) => {
    req.session = null;
    res.redirect('/login.html');
  });

  return router;
}
```

주: `/me` 응답 필드명은 dev 환경에서 실제 호출로 확인 후 필요 시 조정 (`hiworks auth call --url "$ME_URL"` 로 확인 가능). `data` 래핑/비래핑 둘 다 수용하도록 작성됨.

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/auth.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/auth.js test/auth.test.js
git commit -m "feat: Hiworks OAuth 로그인 + 세션 미들웨어"
```

---

### Task 6: 발송기 (send + retry + log)

**Files:**
- Modify: `src/dispatch.js` (순수 함수에 발송 로직 추가)
- Test: `test/dispatch-send.test.js`

**Interfaces:**
- Consumes: Task 3 `matchRules`/`formatMessage`, Task 4 `findActiveRules`/`logDelivery`
- Produces: `dispatchEvent(db, event)` → Promise<void>. 매칭 규칙별 × destination별 POST, 실패 시 1회 재시도, 결과를 delivery_logs에 기록. 로그의 error에는 URL 호스트만 포함.

- [ ] **Step 1: 실패하는 테스트 작성**

`test/dispatch-send.test.js`:
```js
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/dispatch-send.test.js`
Expected: FAIL — `dispatchEvent` is not exported

- [ ] **Step 3: 구현 — `src/dispatch.js`에 추가**

```js
import { findActiveRules, logDelivery } from './rules-db.js';

// ... 기존 matchRules / formatMessage 유지 ...

async function post(url, message) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function dispatchEvent(db, event) {
  const rules = matchRules(findActiveRules(db, event.source), event);
  const message = formatMessage(event);

  for (const rule of rules) {
    for (const url of rule.destinations) {
      const host = (() => { try { return new URL(url).host; } catch { return '?'; } })();
      let error = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await post(url, message);
          error = null;
          break;
        } catch (err) {
          error = `${host}: ${err.message}`;
        }
      }
      logDelivery(db, {
        rule_id: rule.id,
        summary: message.text.slice(0, 200),
        status: error ? 'fail' : 'success',
        error,
      });
    }
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/dispatch-send.test.js` 그리고 `npm test` (기존 테스트 회귀 확인)
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/dispatch.js test/dispatch-send.test.js
git commit -m "feat: 매칭 규칙 destination 발송 + 1회 재시도 + delivery log"
```

---

### Task 7: 서버 조립 — API 라우터 + 웹훅 수신

**Files:**
- Create: `src/server.js`, `src/app.js`
- Test: `test/app.test.js`

**Interfaces:**
- Consumes: 모든 이전 태스크
- Produces:
  - `createApp(db, env)` → Express app (테스트용, listen 안 함)
    - `GET /api/me` → `{id, name}`
    - `GET/POST /api/rules`, `PUT/DELETE /api/rules/:id` (requireAuth, validateRule)
    - `POST /webhooks/gitlab` — `X-Gitlab-Token` 검증(불일치 401), 200 즉시 응답 후 `dispatchEvent` fire-and-forget
    - `public/` 정적 서빙, `/`는 requireAuth
  - `src/server.js` — env 로드 + openDb + listen (엔트리포인트)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/app.test.js`:
```js
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
      name: 'r1', description: '', source: 'gitlab', repo: 'a/b',
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
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/app.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: 구현**

`src/app.js`:
```js
import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { listRules, createRule, updateRule, deleteRule, validateRule } from './rules-db.js';
import { normalizeGitlab } from './gitlab.js';
import { dispatchEvent } from './dispatch.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');

export function createApp(db, env, { testSession } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 웹훅은 세션/인증 밖 (GitLab이 호출)
  app.post('/webhooks/gitlab', (req, res) => {
    if (req.get('X-Gitlab-Token') !== env.GITLAB_WEBHOOK_SECRET) return res.status(401).end();
    res.status(200).end();
    const event = normalizeGitlab(req.body);
    if (event) dispatchEvent(db, event).catch(err => console.error('dispatch 실패:', err.message));
  });

  app.use(testSession ?? cookieSession({
    name: 'session',
    secret: env.SESSION_SECRET,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  }));
  app.use(authRouter(db, env));

  app.get('/api/me', requireAuth, (req, res) => {
    const me = db.prepare('SELECT id, name FROM users WHERE id = ?').get(req.userId);
    res.json(me);
  });

  app.get('/api/rules', requireAuth, (req, res) => res.json(listRules(db, req.userId)));

  app.post('/api/rules', requireAuth, (req, res) => {
    const v = validateRule(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    res.status(201).json(createRule(db, req.userId, req.body));
  });

  app.put('/api/rules/:id', requireAuth, (req, res) => {
    const v = validateRule(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    const rule = updateRule(db, req.userId, Number(req.params.id), req.body);
    if (!rule) return res.status(404).json({ error: '규칙을 찾을 수 없습니다' });
    res.json(rule);
  });

  app.delete('/api/rules/:id', requireAuth, (req, res) => {
    if (!deleteRule(db, req.userId, Number(req.params.id))) {
      return res.status(404).json({ error: '규칙을 찾을 수 없습니다' });
    }
    res.status(204).end();
  });

  // 대시보드는 로그인 필수, login.html/정적 자원은 공개
  app.get('/', requireAuth, (req, res) => res.sendFile(path.join(publicDir, 'index.html')));
  app.use(express.static(publicDir));

  return app;
}
```

`src/server.js`:
```js
import process from 'node:process';
import { openDb } from './db.js';
import { createApp } from './app.js';

const required = ['SESSION_SECRET', 'GITLAB_WEBHOOK_SECRET', 'HIWORKS_CLIENT_ID', 'REDIRECT_URI', 'AUTH_URL', 'TOKEN_URL', 'ME_URL'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('환경변수 누락:', missing.join(', '));
  process.exit(1);
}

const db = openDb(process.env.DB_PATH ?? './data.db');
const app = createApp(db, process.env);
const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`webhook-middleware listening on :${port}`));
```

`package.json` scripts의 start를 env 로드 포함으로 변경:
```json
"start": "node --env-file=.env src/server.js"
```
(Node 20.6+의 `--env-file`. dotenv 의존성 불필요.)

- [ ] **Step 4: 테스트 통과 확인**

Run: `npm test`
Expected: 전부 PASS

- [ ] **Step 5: Commit**

```bash
git add src/app.js src/server.js package.json test/app.test.js
git commit -m "feat: Express 앱 조립 — 규칙 API + GitLab 웹훅 수신"
```

---

### Task 8: 프론트엔드 연결 (목업 → API)

**Files:**
- Create: `public/index.html` (목업 복사 + 수정), `public/support.js` (복사), `public/login.html` (임시)
- Modify: 없음

**Interfaces:**
- Consumes: Task 7 API (`GET/POST /api/rules`, `PUT/DELETE /api/rules/:id`)
- Produces: 로그인된 사용자가 `/`에서 규칙 CRUD 가능한 대시보드.

수정 방침 — 목업의 DCLogic `Component` 클래스 내부만 고친다. 마크업/스타일 불변, 예외 2곳:
1. repo `<select>` → free-text `<input>` (실제 GitLab repo 목록을 서버가 모름). `sc-for repoOptions` 블록 삭제.
2. `<script src="./support.js">` 경로는 복사 후 그대로 동작.

- [ ] **Step 1: 파일 복사**

```bash
mkdir -p public
cp "GitLab 웹훅 필터링 시스템/Webhook Rules.dc.html" public/index.html
cp "GitLab 웹훅 필터링 시스템/support.js" public/support.js
```

- [ ] **Step 2: 임시 로그인 페이지 작성** (정식 HTML은 추후 사용자 제공분으로 교체)

`public/login.html`:
```html
<!DOCTYPE html>
<html lang="ko">
<head><meta charset="utf-8"><title>Webhook 필터링</title></head>
<body style="display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:system-ui;background:#f6f7f9">
  <a href="/login" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">하이웍스로 로그인</a>
</body>
</html>
```

- [ ] **Step 3: index.html의 Component를 API 연동으로 수정**

`public/index.html` 내 `class Component` 수정 지점:

(a) `seed()` 제거, 초기 규칙 빈 배열 + 로드:
```js
constructor(props){
  super(props);
  // this.sources = { ... }  // 유지, 단 projects 배열은 더 이상 사용 안 함
  this.state = {
    rules: [], page: 1, query: '', selectedId: null,
    modalOpen: false, editingId: null, step: 1,
    draft: this.emptyDraft(), destInput: '', authorInput: '',
  };
  this.load();
}
async load(){
  const res = await fetch('/api/rules');
  if (res.status === 401) { location.href = '/login.html'; return; }
  const rules = await res.json();
  this.setState({ rules });
}
async api(method, url, body){
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { location.href = '/login.html'; return null; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    window.alert(err.error || '요청 실패');
    return null;
  }
  return res.status === 204 ? true : res.json();
}
```

(b) mutation 메서드를 API 호출로 교체:
```js
async toggleActive(id){
  const r = this.state.rules.find(x => x.id === id);
  if (!r) return;
  const updated = await this.api('PUT', '/api/rules/' + id, { ...r, active: !r.active });
  if (updated) this.setState(s => ({ rules: s.rules.map(x => x.id === id ? updated : x) }));
}
async del(id){
  if (!window.confirm('이 규칙을 삭제할까요?')) return;
  if (await this.api('DELETE', '/api/rules/' + id)) {
    this.setState(s => ({ rules: s.rules.filter(r => r.id !== id), selectedId: s.selectedId === id ? null : s.selectedId }));
  }
}
async save(){
  if (!this.canSave()) return;
  const d = { ...this.state.draft, name: this.state.draft.name.trim() };
  if (this.state.editingId) {
    const updated = await this.api('PUT', '/api/rules/' + this.state.editingId, d);
    if (updated) this.setState(s => ({ rules: s.rules.map(r => r.id === s.editingId ? updated : r), modalOpen: false, editingId: null }));
  } else {
    const created = await this.api('POST', '/api/rules', d);
    if (created) this.setState(s => ({ rules: [created, ...s.rules], modalOpen: false, page: 1 }));
  }
}
```

(c) `active`는 서버에서 0/1 정수로 옴 — 기존 코드 `r.active` truthy 판정이라 그대로 동작. `draft`로 복사 시에도 문제없음 (`active: !!r.active`로 openEdit에서 보정):
```js
openEdit(id){
  const r = this.state.rules.find(x => x.id === id);
  if (!r) return;
  this.setState({
    modalOpen: true, editingId: id, step: 2,
    draft: { ...r, active: !!r.active, actions: [...r.actions], authors: [...r.authors], destinations: [...r.destinations] },
    destInput: '', authorInput: '', selectedId: null,
  });
}
```

(d) repo 입력을 select → input으로 교체. 마크업에서:
```html
<select value="{{ draft_repo }}" onChange="{{ onDraftRepo }}" ...>...</select>
```
전체(`sc-for repoOptions` 포함)를 다음으로 교체:
```html
<input value="{{ draft_repo }}" onChange="{{ onDraftRepo }}" placeholder="{{ draft_projectPlaceholder }}" style="width:100%;padding:9px 12px;border:1px solid #d0d5dd;border-radius:8px;font-size:13px;font-family:'IBM Plex Mono',monospace" />
```
그리고 `renderVals()`에서 `repoOptions` 관련 라인 삭제, sources의 `projectPlaceholder`를 `'group/project 경로 입력'`으로 변경.

- [ ] **Step 4: 수동 검증**

```bash
cp .env.example .env   # 값 확인 (Dev 클라이언트 기본값으로 충분)
npm start
```

브라우저에서 `http://127.0.0.1:3000` 접속:
1. 미로그인 → `/login.html` 리다이렉트 확인
2. 하이웍스 로그인 → 대시보드 표시
3. 규칙 추가(소스 GitLab → 이름/repo/action/URL 입력) → 목록 반영
4. 토글/수정/삭제 동작
5. 새로고침 후에도 규칙 유지(DB 저장 확인)

webapp-testing 스킬(Playwright) 사용 가능하면 3~5를 자동 확인해도 됨. OAuth는 실제 하이웍스 로그인이 필요하므로 수동 확인이 기본.

- [ ] **Step 5: Commit**

```bash
git add public/
git commit -m "feat: 대시보드 목업 API 연동 + 임시 로그인 페이지"
```

---

### Task 9: E2E 스모크 + README

**Files:**
- Create: `test/e2e.test.js`, `README.md`

**Interfaces:**
- Consumes: 전체 시스템

- [ ] **Step 1: E2E 테스트 작성** — 서버 기동 → GitLab payload POST → mock destination이 메신저+ 포맷 수신

`test/e2e.test.js`:
```js
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
    name: 'MR 알림', description: '', source: 'gitlab', repo: 'backend/api-gateway',
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
```

- [ ] **Step 2: 실행 확인**

Run: `npm test`
Expected: 전부 PASS

- [ ] **Step 3: README 작성**

`README.md`:
```markdown
# webhook-middleware

GitLab 웹훅을 수신해 사용자별 규칙에 맞는 이벤트만 Hiworks 메신저+ webhook URL로 재발송하는 미들웨어.

## 실행

​```bash
npm install
cp .env.example .env   # 값 채우기
npm start              # http://127.0.0.1:3000
​```

Node 20.6+ 필요 (`--env-file`).

## 테스트

​```bash
npm test
​```

## 설정 흐름

1. 하이웍스 로그인 → 대시보드에서 규칙 생성 (repo 경로, action, 메신저+ webhook URL)
2. GitLab repo → Settings → Webhooks: URL `https://<서버>/webhooks/gitlab`, Secret token은 `.env`의 `GITLAB_WEBHOOK_SECRET`과 동일하게. Trigger는 Issues / Merge requests / Pipelines 체크.
3. 메신저+ 채팅방에서 웹훅 생성해 URL 발급 → 규칙의 전송 대상 URL에 등록.

## 운영 배포 메모

- 운영 OAuth 클라이언트 등록 절차: `.claude/skills/oauth-integration/SKILL.md`
- env를 운영값으로 교체 (`gabiaoffice` 도메인, 발급받은 client_id/secret, 실서버 REDIRECT_URI)
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.js README.md
git commit -m "test: E2E 스모크 + README"
```

---

## Self-Review 결과

- 스펙 커버리지: 인증(Task 5), 규칙 CRUD+UI(4,7,8), GitLab 수신+매칭+포맷+발송+로그(2,3,6,7), 보안(secret 검증 7, URL 마스킹 6, 소유자 검사 4), E2E(9). Sentry는 스펙대로 UI만(목업에 이미 존재, 수신 어댑터 없음 — 의도적).
- 미구현으로 남긴 것(스펙 합의 사항): 로그인 정식 HTML(추후 사용자 제공), Sentry 수신 어댑터, 운영 배포(VM 주소 미정).
- 타입 일관성: event 형태 `{source, repo, action, author, title, url}` 전 태스크 동일. rule 파싱 형태 동일. `dispatchEvent(db, event)` 시그니처 6/7/9 일치.
