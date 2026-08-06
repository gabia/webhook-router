import { findActiveRules, logDelivery } from './rules-db.js';

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
