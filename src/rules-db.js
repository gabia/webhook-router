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

export function logInbound(db, { source, repo, action, author, title, url, matched, delivered_ok, delivered_fail }) {
  db.prepare(`
    INSERT INTO inbound_logs (source, repo, action, author, title, url, matched, delivered_ok, delivered_fail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, repo ?? '', action ?? '', author ?? '', title ?? '', url ?? '', matched ?? 0, delivered_ok ?? 0, delivered_fail ?? 0);
}

export function listInbound(db, limit = 50) {
  return db.prepare('SELECT * FROM inbound_logs ORDER BY id DESC LIMIT ?').all(limit);
}
