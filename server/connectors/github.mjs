const ISSUE_KINDS = new Map([
  ['opened', 'issue.opened'],
  ['reopened', 'issue.reopened'],
  ['labeled', 'issue.labeled'],
  ['edited', 'issue.updated'],
]);

const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const COMMAND_PATTERN = /(?:^|\s)(?:\/loop|@self-loop|\/self-loop)\b/i;

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

function issueLabels(issue) {
  return Array.isArray(issue?.labels)
    ? issue.labels
        .map((label) => (typeof label === 'string' ? label : label?.name))
        .filter(Boolean)
    : [];
}

function reviewCommentTask(eventName, payload) {
  const action = typeof payload.action === 'string' ? payload.action : '';
  const issue = payload.issue;
  const pullRequest = payload.pull_request;
  const number = Number(issue?.number || pullRequest?.number || 0);
  const comment = payload.comment || payload.review || {};
  const body = String(comment.body || '').trim();
  const isReviewComment = eventName === 'pull_request_review_comment'
    || eventName === 'pull_request_review'
    || Boolean(issue?.pull_request);
  if (!isReviewComment || !number) return null;
  if (action && action !== 'created') {
    return {
      eventInput: {
        kind: `github.${eventName}.${action || 'unknown'}`,
        title: `GitHub ${eventName}`,
        body: '',
        actor: payload.sender?.login || 'github',
        externalId: `GH-${number}-${eventName}`,
        labels: [],
      },
      ignoredReason: `评论 action 不创建任务：${action}`,
    };
  }
  if (!COMMAND_PATTERN.test(body)) {
    return {
      eventInput: {
        kind: `github.${eventName}.comment`,
        title: `GitHub ${eventName}`,
        body,
        actor: payload.sender?.login || 'github',
        externalId: `GH-${number}-${eventName}-${comment.id || 'comment'}`,
        labels: [],
      },
      ignoredReason: '评论未包含 /loop 或 @self-loop 指令',
    };
  }
  const commentKind = eventName === 'pull_request_review'
    ? 'review'
    : eventName === 'pull_request_review_comment'
      ? 'review-comment'
      : 'comment';
  const commentId = comment.id || payload.review?.id || payload.comment?.id;
  const externalId = `GH-${number}-${commentKind.toUpperCase()}-${commentId || 'unknown'}`;
  const commandText = body
    .replace(COMMAND_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    eventInput: {
      kind: 'task.created',
      title: commandText
        ? commandText.slice(0, 100)
        : `PR #${number} review follow-up`,
      body: [
        commandText || body,
        '',
        `> Source: ${comment.html_url || pullRequest?.html_url || issue?.html_url || ''}`,
        `> Author: @${payload.sender?.login || comment.user?.login || 'github'}`,
        '',
        '## Acceptance',
        `- [ ] 处理 PR #${number} 的评论要求`,
        `- [ ] 在 PR #${number} 中说明修改结果`,
      ].join('\n'),
      actor: payload.sender?.login || comment.user?.login || 'github',
      externalId,
      externalKey: `pr-${number}-${commentKind}-${commentId || 'unknown'}`,
      labels: ['review-feedback', ...issueLabels(issue || pullRequest)],
      acceptance: [
        `处理 PR #${number} 的评论要求`,
        `在 PR #${number} 中说明修改结果`,
      ],
      scope: payload.repository?.full_name ? [payload.repository.full_name] : [],
      risk: 'medium',
      connector: {
        prNumber: number,
        commentId: commentId || null,
        commentKind,
        commentUrl: comment.html_url || null,
      },
      url: comment.html_url || pullRequest?.html_url || issue?.html_url || '',
    },
    ignoredReason: null,
  };
}

export function normalizeGitHubEvent(eventName, payload = {}) {
  const issue = payload.issue;
  const action = typeof payload.action === 'string' ? payload.action : '';
  const kind = ISSUE_KINDS.get(action);
  const labels = issueLabels(issue);
  const externalId = Number.isInteger(issue?.number) ? `GH-${issue.number}` : null;

  const commentTask = reviewCommentTask(eventName, payload);
  if (commentTask) return commentTask;

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
