import { findActiveRules, logDelivery } from './rules-db.js';

const ACTION_LABEL = {
  push: '푸시', tag_push: '태그 푸시',
  'note.commit': '커밋 댓글', 'note.merge_request': 'MR 댓글', 'note.issue': '이슈 댓글', 'note.snippet': '스니펫 댓글',
  confidential_note: '비공개 댓글',
  'issue.open': '이슈 생성', 'issue.close': '이슈 종료', 'issue.reopen': '이슈 재오픈', 'issue.update': '이슈 변경',
  'confidential_issue.open': '비공개 이슈 생성', 'confidential_issue.close': '비공개 이슈 종료',
  'confidential_issue.reopen': '비공개 이슈 재오픈', 'confidential_issue.update': '비공개 이슈 변경',
  'mr.open': 'MR 생성', 'mr.merge': 'MR 병합', 'mr.close': 'MR 닫힘', 'mr.reopen': 'MR 재오픈',
  'mr.update': 'MR 변경', 'mr.approved': 'MR 승인', 'mr.unapproved': 'MR 승인 취소',
  'job.success': '잡 성공', 'job.failed': '잡 실패', 'job.canceled': '잡 취소', 'job.running': '잡 실행',
  'pipeline.success': '파이프라인 성공', 'pipeline.failed': '파이프라인 실패',
  'pipeline.canceled': '파이프라인 취소', 'pipeline.running': '파이프라인 실행',
  'wiki.create': '위키 생성', 'wiki.update': '위키 수정', 'wiki.delete': '위키 삭제',
  'deployment.success': '배포 성공', 'deployment.failed': '배포 실패',
  'deployment.canceled': '배포 취소', 'deployment.running': '배포 시작',
  feature_flag: '피처 플래그 변경',
  'release.create': '릴리즈 생성', 'release.update': '릴리즈 수정',
};
const GREEN = '#2EB67D', BLUE = '#36C5F0', RED = '#E01E5A';
function colorFor(action) {
  if (action.endsWith('.failed') || action.endsWith('.canceled')) return RED;
  if (action.endsWith('.success') || action === 'mr.merge' || action === 'mr.approved') return GREEN;
  return BLUE;
}

const bare = (a) => a.replace(/^@/, '').toLowerCase();

export function matchRules(rules, event) {
  return rules.filter(r =>
    r.active &&
    r.source === event.source &&
    (r.repos.length === 0 || r.repos.includes(event.repo)) &&  // 비우면 모든 프로젝트
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
      color: colorFor(event.action),
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
  let ok = 0, fail = 0;

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
      error ? fail++ : ok++;
      logDelivery(db, {
        rule_id: rule.id,
        summary: message.text.slice(0, 200),
        status: error ? 'fail' : 'success',
        error,
      });
    }
  }
  return { matched: rules.length, ok, fail };
}

// ---------- custom webhook (임의 payload) ----------

export function flattenPayload(obj, prefix = '', out = {}) {
  if (obj === null || typeof obj !== 'object') {
    if (prefix) out[prefix] = obj;
    return out;
  }
  const entries = Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj);
  if (entries.length === 0 && prefix) out[prefix] = Array.isArray(obj) ? '[]' : '{}';
  for (const [k, v] of entries) {
    const key = prefix ? `${prefix}.${k}` : String(k);
    if (v !== null && typeof v === 'object') flattenPayload(v, key, out);
    else out[key] = v;
  }
  return out;
}

const condStr = (v) => v == null ? '' : String(v);

function evalCondition(flat, { key, op, value }) {
  const v = condStr(flat[key]);
  if (op === 'eq') return v === value;
  if (op === 'ne') return v !== value;
  if (op === 'like') return v.toLowerCase().includes(String(value).toLowerCase());
  return false;
}

export function matchCustomRules(rules, customSourceId, flat) {
  return rules.filter(r =>
    r.active &&
    r.source === 'custom' &&
    r.custom_source_id === customSourceId &&
    (r.conditions ?? []).every(c => evalCondition(flat, c))
  );
}

export function formatCustomMessage(sourceName, flat) {
  const items = Object.entries(flat).slice(0, 10).map(([k, v]) => ({
    label: k.slice(0, 100),
    content: condStr(v).slice(0, 300) || '(빈 값)',
  }));
  return {
    text: `[${sourceName}] 커스텀 웹훅 수신`.slice(0, 4000),
    cards: [{ color: BLUE, items: items.length ? items : [{ label: 'payload', content: '(빈 객체)' }] }],
  };
}

export async function dispatchCustom(db, customSource, payload) {
  const flat = flattenPayload(payload);
  const rules = matchCustomRules(findActiveRules(db, 'custom'), customSource.id, flat);
  const message = formatCustomMessage(customSource.name, flat);
  let ok = 0, fail = 0;

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
      error ? fail++ : ok++;
      logDelivery(db, {
        rule_id: rule.id,
        summary: message.text.slice(0, 200),
        status: error ? 'fail' : 'success',
        error,
      });
    }
  }
  return { matched: rules.length, ok, fail };
}
