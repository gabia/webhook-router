import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { upsertUser } from './rules-db.js';

export function buildAuthorizeUrl(env, state) {
  const u = new URL('/oauth/authorize', env.AUTH_URL);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', env.HIWORKS_CLIENT_ID);
  u.searchParams.set('redirect_uri', env.REDIRECT_URI);
  if (state) u.searchParams.set('state', state);
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

  router.get('/login', (req, res) => {
    const state = randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(buildAuthorizeUrl(env, state));
  });

  router.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    const expectedState = req.session.oauthState;
    req.session.oauthState = null;
    if (!req.query.state || req.query.state !== expectedState) {
      console.error('state 검증 실패:', {
        host: req.get('host'),
        queryStateExists: Boolean(req.query.state),
        sessionStateExists: Boolean(expectedState),
        cookieHeaderExists: Boolean(req.get('cookie')),
      });
      return res.status(400).send('state 불일치');
    }
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
      if (me.office_user_no == null && me.user_no == null) {
        throw new Error('me 응답에 사용자 식별자 없음');
      }

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
