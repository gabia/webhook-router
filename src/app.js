import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { listRules, createRule, updateRule, deleteRule, validateRule, logInbound, listInbound, createCustomSource, listCustomSources, deleteCustomSource, findCustomSourceByToken, saveLastPayload } from './rules-db.js';
import { normalizeGitlab } from './gitlab.js';
import { dispatchEvent, dispatchCustom } from './dispatch.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../public');

export function createApp(db, env, { testSession } = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // 웹훅은 세션/인증 밖 (GitLab이 호출)
  app.post('/webhooks/gitlab', (req, res) => {
    if (req.get('X-Gitlab-Token') !== env.GITLAB_WEBHOOK_SECRET) {
      logInbound(db, {
        source: 'gitlab',
        repo: req.body?.project?.path_with_namespace ?? '',
        action: '(거부: secret 불일치)',
      });
      return res.status(401).end();
    }
    res.status(200).end();
    const event = normalizeGitlab(req.body);
    if (!event) {
      logInbound(db, {
        source: 'gitlab',
        repo: req.body?.project?.path_with_namespace ?? '',
        action: `(미지원: ${req.body?.object_kind ?? '?'})`,
      });
      return;
    }
    dispatchEvent(db, event)
      .then(r => logInbound(db, { ...event, matched: r.matched, delivered_ok: r.ok, delivered_fail: r.fail }))
      .catch(err => console.error('dispatch 실패:', err.message));
  });

  // 커스텀 웹훅 수신 — 토큰이 곧 인증 (메신저+ incoming webhook 방식)
  app.post('/webhooks/custom/:token', (req, res) => {
    const source = findCustomSourceByToken(db, req.params.token);
    if (!source) return res.status(404).json({ error: '유효하지 않은 웹훅 URL입니다' });
    if (source.secret && req.get('X-Webhook-Secret') !== source.secret) {
      logInbound(db, { source: 'custom', repo: source.name, action: '(거부: secret 불일치)' });
      return res.status(401).json({ error: 'secret 불일치' });
    }
    res.status(200).json({ ok: true });
    const payload = (req.body && typeof req.body === 'object') ? req.body : {};
    saveLastPayload(db, source.id, payload);
    dispatchCustom(db, source, payload)
      .then(r => logInbound(db, {
        source: 'custom', repo: source.name, action: 'custom',
        title: Object.keys(payload).slice(0, 5).join(', '), url: '',
        matched: r.matched, delivered_ok: r.ok, delivered_fail: r.fail,
      }))
      .catch(err => console.error('custom dispatch 실패:', err.message));
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
    // 웹훅 시크릿은 여기서만 내려준다 — index.html 은 정적 서빙이라 인증이 걸리지 않는다
    res.json({ ...me, webhook_secret: env.GITLAB_WEBHOOK_SECRET });
  });

  app.get('/api/rules', requireAuth, (req, res) => res.json(listRules(db, req.userId)));

  app.get('/api/custom-sources', requireAuth, (req, res) => res.json(listCustomSources(db, req.userId)));

  app.post('/api/custom-sources', requireAuth, (req, res) => {
    const name = (req.body?.name ?? '').toString().trim();
    if (!name) return res.status(400).json({ error: '이름은 필수입니다' });
    res.status(201).json(createCustomSource(db, req.userId, name, (req.body?.secret ?? '').toString()));
  });

  app.delete('/api/custom-sources/:id', requireAuth, (req, res) => {
    if (!deleteCustomSource(db, req.userId, Number(req.params.id))) {
      return res.status(404).json({ error: '웹훅을 찾을 수 없습니다' });
    }
    res.status(204).end();
  });

  app.get('/api/inbound-logs', requireAuth, (req, res) =>
    res.json(listInbound(db, 10, (req.query.repo ?? '').toString())));

  // GitLab 프로젝트 typeahead — 토큰 미설정 시 빈 목록 (자동완성만 비활성)
  // env 규약은 gabia-dev-mcp-gitlab-* 스킬과 동일: GITLAB_API_URL(/api/v4 포함) + GITLAB_TOKEN
  app.get('/api/gitlab/projects', requireAuth, async (req, res) => {
    const q = (req.query.q ?? '').toString().trim();
    if (!q || !env.GITLAB_API_URL || !env.GITLAB_TOKEN) return res.json([]);
    try {
      const u = new URL(`${env.GITLAB_API_URL.replace(/\/$/, '')}/projects`);
      u.searchParams.set('search', q);
      u.searchParams.set('simple', 'true');
      u.searchParams.set('per_page', '5');
      u.searchParams.set('order_by', 'similarity');
      const glRes = await fetch(u, {
        headers: {
          Authorization: `Bearer ${env.GITLAB_TOKEN}`,
          'PRIVATE-TOKEN': env.GITLAB_TOKEN,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!glRes.ok) throw new Error(`gitlab ${glRes.status}`);
      const projects = await glRes.json();
      res.json(projects.map(p => p.path_with_namespace));
    } catch (err) {
      console.error('gitlab 프로젝트 검색 실패:', err.message);
      res.status(502).json({ error: 'GitLab 조회 실패' });
    }
  });

  // GitLab 사용자(LDAP 계정) typeahead — 작성자 필터용
  app.get('/api/gitlab/users', requireAuth, async (req, res) => {
    const q = (req.query.q ?? '').toString().trim();
    if (!q || !env.GITLAB_API_URL || !env.GITLAB_TOKEN) return res.json([]);
    try {
      const u = new URL(`${env.GITLAB_API_URL.replace(/\/$/, '')}/users`);
      u.searchParams.set('search', q);
      u.searchParams.set('per_page', '5');
      u.searchParams.set('active', 'true');
      const glRes = await fetch(u, {
        headers: {
          Authorization: `Bearer ${env.GITLAB_TOKEN}`,
          'PRIVATE-TOKEN': env.GITLAB_TOKEN,
        },
        signal: AbortSignal.timeout(5_000),
      });
      if (!glRes.ok) throw new Error(`gitlab ${glRes.status}`);
      const users = await glRes.json();
      res.json(users.map(({ username, name }) => ({ username, name })));
    } catch (err) {
      console.error('gitlab 사용자 검색 실패:', err.message);
      res.status(502).json({ error: 'GitLab 조회 실패' });
    }
  });

  // custom 규칙은 본인 소유 웹훅에만 걸 수 있다
  const ownsCustomSource = (userId, sourceId) => {
    const row = db.prepare('SELECT user_id FROM custom_sources WHERE id = ?').get(sourceId);
    return !!row && row.user_id === userId;
  };

  app.post('/api/rules', requireAuth, (req, res) => {
    const v = validateRule(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    if (req.body.source === 'custom' && !ownsCustomSource(req.userId, req.body.custom_source_id)) {
      return res.status(400).json({ error: '본인이 만든 커스텀 웹훅에만 규칙을 걸 수 있습니다' });
    }
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
