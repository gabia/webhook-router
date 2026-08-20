import { randomBytes } from 'node:crypto';
function parse(row) {
  if (!row) return null;
  return {
    ...row,
    repos: JSON.parse(row.repos),
    actions: JSON.parse(row.actions),
    authors: JSON.parse(row.authors),
    destinations: JSON.parse(row.destinations),
    conditions: JSON.parse(row.conditions ?? '[]'),
  };
}

const cleanRepos = (repos) => [...new Set(repos.map(r => r.trim()).filter(Boolean))];

export function upsertUser(db,{ office_user_no, user_no, name }) {
  db.prepare(`
    INSERT INTO users (office_user_no, user_no, name) VALUES (?, ?, ?)
    ON CONFLICT(office_user_no) DO UPDATE SET user_no=excluded.user_no, name=excluded.name
  `).run(office_user_no, user_no, name);
  return db.prepare('SELECT * FROM users WHERE office_user_no = ?').get(office_user_no);
}

export function validateRule(d) {
  if (!d || typeof d !== 'object') return { ok: false, error: '잘못된 요청' };
  if (!d.name?.trim()) return { ok: false, error: '이름은 필수입니다' };
  if (!['gitlab', 'sentry', 'custom'].includes(d.source)) return { ok: false, error: '지원하지 않는 소스' };
  if (d.source === 'custom') {
    if (!Number.isInteger(d.custom_source_id)) return { ok: false, error: '커스텀 웹훅을 선택하세요' };
    if (!Array.isArray(d.conditions)) return { ok: false, error: '잘못된 조건 목록' };
    for (const c of d.conditions) {
      if (!c || typeof c !== 'object' || !c.key?.trim() || !['eq', 'ne', 'like'].includes(c.op) || typeof c.value !== 'string') {
        return { ok: false, error: '조건은 key · operator(eq/ne/like) · value 형식입니다' };
      }
    }
    if (!['messenger', 'template'].includes(d.send_mode)) return { ok: false, error: '발신 방식을 선택하세요' };
    if (d.send_mode === 'template') {
      try {
        const t = JSON.parse(d.template);
        if (t === null || typeof t !== 'object') throw new Error();
      } catch {
        return { ok: false, error: '템플릿은 유효한 JSON 객체여야 합니다' };
      }
    }
  } else {
    if (!Array.isArray(d.repos)) return { ok: false, error: '잘못된 프로젝트 목록' };  // [] = 모든 프로젝트
    if (!Array.isArray(d.actions) || d.actions.length === 0) return { ok: false, error: 'Action을 1개 이상 선택하세요' };
    if (!Array.isArray(d.authors)) return { ok: false, error: '잘못된 작성자 목록' };
  }
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
    INSERT INTO rules (user_id, name, description, source, repos, actions, authors, destinations, custom_source_id, conditions, send_mode, template, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    userId, d.name.trim(), d.description ?? '', d.source, JSON.stringify(cleanRepos(d.repos ?? [])),
    JSON.stringify(d.actions ?? []), JSON.stringify(d.authors ?? []),
    JSON.stringify(d.destinations), d.source === 'custom' ? d.custom_source_id : null,
    JSON.stringify(d.conditions ?? []),
    d.source === 'custom' ? (d.send_mode ?? 'messenger') : 'messenger',
    d.send_mode === 'template' ? d.template : null,
    d.active ? 1 : 0,
  );
  return parse(db.prepare('SELECT * FROM rules WHERE id = ?').get(info.lastInsertRowid));
}

// 규칙은 전체 공개(팀 공용). 수정/삭제는 소유자만 — mine 플래그로 UI가 판단
export function listRules(db, userId) {
  return db.prepare(`
    SELECT r.*, u.name AS owner_name, (r.user_id = ?) AS mine
    FROM rules r JOIN users u ON u.id = r.user_id
    ORDER BY COALESCE(r.updated_at, r.created_at) DESC, r.id DESC
  `).all(userId).map(parse);
}

export function updateRule(db, userId, id, d) {
  const info = db.prepare(`
    UPDATE rules SET name=?, description=?, repos=?, actions=?, authors=?, destinations=?, conditions=?, send_mode=?, template=?, active=?, updated_at=datetime('now')
    WHERE id = ? AND user_id = ?
  `).run(
    d.name.trim(), d.description ?? '', JSON.stringify(cleanRepos(d.repos ?? [])),
    JSON.stringify(d.actions ?? []), JSON.stringify(d.authors ?? []),
    JSON.stringify(d.destinations), JSON.stringify(d.conditions ?? []),
    d.send_mode ?? 'messenger', d.send_mode === 'template' ? d.template : null,
    d.active ? 1 : 0,
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

export function logInbound(db, { source, repo, action, author, title, url, matched, delivered_ok, delivered_fail }) {
  db.prepare(`
    INSERT INTO inbound_logs (source, repo, action, author, title, url, matched, delivered_ok, delivered_fail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, repo ?? '', action ?? '', author ?? '', title ?? '', url ?? '', matched ?? 0, delivered_ok ?? 0, delivered_fail ?? 0);
}

export function listInbound(db, limit = 50, repo = '') {
  const q = repo.trim();
  if (!q) return db.prepare('SELECT * FROM inbound_logs ORDER BY id DESC LIMIT ?').all(limit);
  // LIKE 이스케이프: 사용자가 친 % _ 는 와일드카드가 아니라 글자로 취급
  const pattern = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
  return db.prepare(`
    SELECT * FROM inbound_logs WHERE repo LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT ?
  `).all(pattern, limit);
}

// ---------- custom webhook sources ----------

export function createCustomSource(db, userId, name, secret = '') {
  const token = randomBytes(20).toString('hex');
  const info = db.prepare('INSERT INTO custom_sources (user_id, name, token, secret) VALUES (?, ?, ?, ?)')
    .run(userId, String(name).trim(), token, String(secret ?? '').trim() || null);
  return db.prepare('SELECT * FROM custom_sources WHERE id = ?').get(info.lastInsertRowid);
}

// 규칙과 동일하게 전체 공개, 삭제는 소유자만
export function listCustomSources(db, userId) {
  return db.prepare(`
    SELECT s.*, u.name AS owner_name, (s.user_id = ?) AS mine
    FROM custom_sources s JOIN users u ON u.id = s.user_id
    ORDER BY s.id DESC
  `).all(userId).map(s2 => s2.mine ? s2 : { ...s2, token: null, secret: null });
}

export function deleteCustomSource(db, userId, id) {
  return db.prepare('DELETE FROM custom_sources WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

export function findCustomSourceByToken(db, token) {
  return db.prepare('SELECT * FROM custom_sources WHERE token = ?').get(token);
}

export function saveLastPayload(db, id, payload) {
  db.prepare('UPDATE custom_sources SET last_payload = ? WHERE id = ?')
    .run(JSON.stringify(payload).slice(0, 100_000), id);
}
