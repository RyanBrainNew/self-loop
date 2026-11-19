// Optional GitHub Actions adapter: turn one repository event into one durable
// inbox event, then let the Router tick. The core scripts stay scheduler-free.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepo } from '../../scripts/lib.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const repoRoot = resolveRepo({ repo: process.env.SELF_LOOP_REPO || process.env.GITHUB_WORKSPACE || process.cwd() });
const eventName = process.env.GITHUB_EVENT_NAME || 'schedule';
const eventFile = process.env.GITHUB_EVENT_PATH;
const payload = eventFile ? JSON.parse(readFileSync(eventFile, 'utf8')) : {};

function linkedIssue(text = '') {
  const match = String(text).match(/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/i);
  return match ? Number(match[1]) : null;
}

function branchIssue(branch = '') {
  const match = String(branch).match(/(?:^|\/)(?:loop|self-loop)\/(\d+)-/i);
  return match ? Number(match[1]) : null;
}

function mapEvent() {
  if (eventName === 'issues') {
    const issue = payload.issue || {};
    return {
      type: 'issue',
      action: payload.action || '',
      ticket: issue.number || null,
      data: {
        issue: {
          number: issue.number || null,
          title: issue.title || '',
          body: issue.body || '',
          state: issue.state || '',
          state_reason: issue.state_reason || null,
          html_url: issue.html_url || '',
          updated_at: issue.updated_at || '',
          labels: (issue.labels || []).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean),
          assignees: (issue.assignees || []).map((user) => user.login).filter(Boolean),
        },
      },
    };
  }
  if (eventName === 'pull_request') {
    const pr = payload.pull_request || {};
    const ticket = linkedIssue(`${pr.title || ''}\n${pr.body || ''}`) || branchIssue(pr.head?.ref);
    return {
      type: 'pull_request',
      action: payload.action || '',
      ticket,
      data: {
        pull_request: {
          number: pr.number || null,
          state: pr.state || '',
          merged: Boolean(pr.merged),
          html_url: pr.html_url || '',
          body: pr.body || '',
          head: {
            sha: pr.head?.sha || '',
            ref: pr.head?.ref || '',
          },
        },
      },
    };
  }
  if (eventName === 'issue_comment') {
    return {
      type: 'issue',
      action: 'commented',
      ticket: payload.issue?.number || null,
      data: {
        issue: {
          number: payload.issue?.number || null,
          title: payload.issue?.title || '',
          state: payload.issue?.state || '',
          html_url: payload.issue?.html_url || '',
        },
        comment: payload.comment?.body || '',
      },
    };
  }
  if (eventName === 'check_run' || eventName === 'workflow_run') {
    return {
      type: 'verify',
      action: payload.action || 'completed',
      ticket: null,
      data: {
        conclusion: payload.check_run?.conclusion || payload.workflow_run?.conclusion || '',
        html_url: payload.check_run?.html_url || payload.workflow_run?.html_url || '',
      },
    };
  }
  return { type: 'schedule', action: eventName, ticket: null, data: {} };
}

const event = mapEvent();
const eventId = process.env.GITHUB_DELIVERY
  || `${eventName}-${event.action}-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
const temp = mkdtempSync(join(tmpdir(), 'self-loop-event-'));
const tempFile = join(temp, 'event.json');
writeFileSync(tempFile, JSON.stringify(event.data));

const postArgs = [
  join(skillRoot, 'scripts', 'run.mjs'),
  'router',
  'post',
  '--repo',
  repoRoot,
  '--type',
  event.type,
  '--action',
  event.action,
  '--id',
  eventId,
  '--file',
  tempFile,
];
if (event.ticket) postArgs.push('--ticket', String(event.ticket));

try {
  const post = spawnSync(process.execPath, postArgs, { stdio: 'inherit', env: process.env });
  if (post.error) throw post.error;
  if (post.status !== 0) process.exit(post.status ?? 2);

  const tick = spawnSync(process.execPath, [
    join(skillRoot, 'scripts', 'run.mjs'),
    'router',
    'tick',
    '--repo',
    repoRoot,
  ], { stdio: 'inherit', env: process.env });
  if (tick.error) throw tick.error;
  // Exit 3 means "no eligible issue", which is a successful no-op here.
  if (tick.status !== 0 && tick.status !== 3) process.exit(tick.status ?? 2);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
