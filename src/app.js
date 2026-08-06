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

  // GitLab 프로젝트 typeahead — 토큰 미설정 시 빈 목록 (자동완성만 비활성)
  app.get('/api/gitlab/projects', requireAuth, async (req, res) => {
    const q = (req.query.q ?? '').toString().trim();
    if (!q || !env.GITLAB_URL || !env.GITLAB_TOKEN) return res.json([]);
    try {
      const u = new URL('/api/v4/projects', env.GITLAB_URL);
      u.searchParams.set('search', q);
      u.searchParams.set('simple', 'true');
      u.searchParams.set('per_page', '20');
      u.searchParams.set('order_by', 'similarity');
      const glRes = await fetch(u, {
        headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN },
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
