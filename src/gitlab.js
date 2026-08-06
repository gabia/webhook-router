// GitLab webhook payload → {source, repo, action, author, title, url} | null
const ACTION_MAP = {
  merge_request: {
    open: 'mr.open', merge: 'mr.merge', close: 'mr.close', reopen: 'mr.reopen',
    update: 'mr.update', approved: 'mr.approved', unapproved: 'mr.unapproved',
  },
  issue: { open: 'issue.open', close: 'issue.close', reopen: 'issue.reopen', update: 'issue.update' },
  confidential_issue: {
    open: 'confidential_issue.open', close: 'confidential_issue.close',
    reopen: 'confidential_issue.reopen', update: 'confidential_issue.update',
  },
  wiki_page: { create: 'wiki.create', update: 'wiki.update', delete: 'wiki.delete' },
};
const STATUS_MAP = {
  pipeline: { success: 'pipeline.success', failed: 'pipeline.failed', canceled: 'pipeline.canceled', running: 'pipeline.running' },
  build: { success: 'job.success', failed: 'job.failed', canceled: 'job.canceled', running: 'job.running' },
  deployment: { success: 'deployment.success', failed: 'deployment.failed', canceled: 'deployment.canceled', running: 'deployment.running' },
};
const NOTEABLE_MAP = { Commit: 'note.commit', MergeRequest: 'note.merge_request', Issue: 'note.issue', Snippet: 'note.snippet' };
const RELEASE_MAP = { create: 'release.create', update: 'release.update' };

export function normalizeGitlab(body) {
  if (!body || !body.object_kind) return null;
  // job(build) 이벤트는 project 블록 없이 project_name("group / project")만 옴
  const repo = body.project?.path_with_namespace
    ?? (typeof body.project_name === 'string' ? body.project_name.replace(/\s*\/\s*/g, '/') : null);
  if (!repo) return null;
  const author = body.user?.username ?? body.user_username ?? '';
  const attrs = body.object_attributes ?? {};
  const webUrl = body.project?.web_url ?? '';
  const base = { source: 'gitlab', repo, author };

  switch (body.object_kind) {
    case 'push':
      return {
        ...base, action: 'push',
        title: `${(body.ref ?? '').replace('refs/heads/', '')} (${body.total_commits_count ?? 0} commits)`,
        url: webUrl,
      };
    case 'tag_push':
      return { ...base, action: 'tag_push', title: (body.ref ?? '').replace('refs/tags/', ''), url: webUrl };
    case 'note': {
      const action = NOTEABLE_MAP[attrs.noteable_type];
      if (!action) return null;
      const title = body.merge_request?.title ?? body.issue?.title ?? (attrs.note ?? '').slice(0, 80);
      return { ...base, action, title, url: attrs.url ?? '' };
    }
    case 'confidential_note':
      return { ...base, action: 'confidential_note', title: (attrs.note ?? '').slice(0, 80), url: attrs.url ?? '' };
    case 'pipeline': {
      const action = STATUS_MAP.pipeline[attrs.status];
      if (!action) return null;
      return { ...base, action, title: attrs.ref ?? '', url: `${webUrl}/-/pipelines/${attrs.id}` };
    }
    case 'build': {
      const action = STATUS_MAP.build[body.build_status];
      if (!action) return null;
      return { ...base, action, title: `${body.build_name ?? ''} (${body.ref ?? ''})`, url: webUrl ? `${webUrl}/-/jobs/${body.build_id}` : '' };
    }
    case 'deployment': {
      const action = STATUS_MAP.deployment[body.status];
      if (!action) return null;
      return { ...base, action, title: body.environment ?? '', url: body.deployable_url ?? webUrl };
    }
    case 'feature_flag':
      return { ...base, action: 'feature_flag', title: attrs.name ?? '', url: webUrl };
    case 'release': {
      const action = RELEASE_MAP[body.action];
      if (!action) return null;
      return { ...base, action, title: body.name ?? body.tag ?? '', url: body.url ?? webUrl };
    }
    default: {
      const action = ACTION_MAP[body.object_kind]?.[attrs.action];
      if (!action) return null;
      return { ...base, action, title: attrs.title ?? '', url: attrs.url ?? '' };
    }
  }
}
