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
