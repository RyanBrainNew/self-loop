const ISSUE_KINDS = new Map([
  ['opened', 'issue.opened'],
  ['reopened', 'issue.reopened'],
  ['labeled', 'issue.labeled'],
  ['edited', 'issue.updated'],
]);

const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);

function normalizedPriority(labels) {
  for (const label of labels) {
    const name = label.toLowerCase();
    if (PRIORITIES.has(name)) return name;
    if (name.startsWith('priority:')) {
      const value = name.slice('priority:'.length);
      if (PRIORITIES.has(value)) return value;
    }
  }
  return 'normal';
}

export function normalizeGitHubEvent(eventName, payload = {}) {
  const issue = payload.issue;
  const action = typeof payload.action === 'string' ? payload.action : '';
  const kind = ISSUE_KINDS.get(action);
  const labels = Array.isArray(issue?.labels)
    ? issue.labels
        .map((label) => (typeof label === 'string' ? label : label?.name))
        .filter(Boolean)
    : [];
  const externalId = Number.isInteger(issue?.number) ? `GH-${issue.number}` : null;

  if (eventName !== 'issues') {
    return {
      eventInput: {
        kind: `github.${eventName || 'unknown'}`,
        title: `GitHub ${eventName || 'unknown'}`,
        body: '',
        actor: payload.sender?.login || 'github',
        externalId,
        labels,
      },
      ignoredReason: `不支持的 GitHub 事件：${eventName || 'unknown'}`,
    };
  }

  if (!kind || !issue) {
    return {
      eventInput: {
        kind: `github.${eventName}.${action || 'unknown'}`,
        title: issue?.title || `GitHub ${eventName}`,
        body: issue?.body || '',
        actor: payload.sender?.login || 'github',
        externalId,
        labels,
      },
      ignoredReason: `不支持的 issue action：${action || 'unknown'}`,
    };
  }

  return {
    eventInput: {
      kind,
      title: issue.title || `GitHub issue #${issue.number}`,
      body: issue.body || '',
      actor: payload.sender?.login || 'github',
      externalId,
      labels,
      priority: normalizedPriority(labels),
      acceptance: [],
      scope: payload.repository?.full_name ? [payload.repository.full_name] : [],
      risk: 'medium',
    },
    ignoredReason:
      action === 'edited' ? 'GitHub issue 字段更新不单独创建 Ticket' : null,
  };
}
