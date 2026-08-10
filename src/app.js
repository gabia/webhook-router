import express from 'express';
import cookieSession from 'cookie-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRouter, requireAuth } from './auth.js';
import { listRules, createRule, updateRule, deleteRule, validateRule, logInbound, listInbound } from './rules-db.js';
import { normalizeGitlab } from './gitlab.js';
import { dispatchEvent } from './dispatch.js';

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

  app.get('/api/inbound-logs', requireAuth, (req, res) => res.json(listInbound(db, 10)));

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
