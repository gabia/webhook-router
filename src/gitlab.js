// GitLab webhook payload → {source, repo, action, author, title, url} | null
const ACTION_MAP = {
  merge_request: { open: 'mr.open', merge: 'mr.merge', close: 'mr.close' },
  issue: { open: 'issue.open', close: 'issue.close', update: 'issue.update', reopen: 'issue.update' },
};
const PIPELINE_STATUS = { success: 'pipeline.success', failed: 'pipeline.failed' };

export function normalizeGitlab(body) {
  if (!body || !body.project || !body.object_kind) return null;
  const repo = body.project.path_with_namespace;
  const author = body.user?.username ?? '';
  const attrs = body.object_attributes ?? {};

  if (body.object_kind === 'pipeline') {
    const action = PIPELINE_STATUS[attrs.status];
    if (!action) return null;
    return {
      source: 'gitlab', repo, action, author,
      title: attrs.ref ?? '',
      url: `${body.project.web_url}/-/pipelines/${attrs.id}`,
    };
  }

  const action = ACTION_MAP[body.object_kind]?.[attrs.action];
  if (!action) return null;
  return {
    source: 'gitlab', repo, action, author,
    title: attrs.title ?? '',
    url: attrs.url ?? '',
  };
}
