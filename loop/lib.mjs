// Shared helpers for the Orca-driven loops.
// The loop is project-agnostic: nothing here knows about app/, npm, or a product.
import { execFileSync } from 'node:child_process';

export const MATT_ROLES = [
  'needs-triage',
  'needs-info',
  'ready-for-agent',
  'ready-for-human',
  'wontfix',
];

// These roles always win over any policy: the loop must not implement them.
export const ALWAYS_BLOCKED_ROLES = new Set(['needs-info', 'ready-for-human', 'wontfix']);

export function run(cmd, args = [], opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return '';
  }
}

export function parseArgs(argv = []) {
  const values = {};
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) values[key] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) values[key] = argv[++i];
    else flags[key] = true;
  }
  return { values, flags, rest };
}

export function repoSlug(cwd = process.cwd()) {
  const url = run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : '';
}

export function git(cwd, args) {
  return run('git', ['-C', cwd, ...args]);
}

export function resolveToken() {
  const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (envToken) return envToken;
  return run('gh', ['auth', 'token']);
}

export async function ghJson(repo, path, token, { method = 'GET', body } = {}) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'orca-loop',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${method} ${path}`);
  return res.json();
}

export async function resolveSelfLogin(repo, token) {
  if (process.env.LOOP_SELF_LOGIN) return process.env.LOOP_SELF_LOGIN;
  if (!token) return '';
  try {
    const user = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'orca-loop' },
      signal: AbortSignal.timeout(15000),
    });
    if (!user.ok) return '';
    return (await user.json()).login || '';
  } catch {
    return '';
  }
}

export async function listOpenIssues(repo, token, { pages = 5 } = {}) {
  const issues = [];
  for (let page = 1; page <= pages; page++) {
    const batch = await ghJson(repo, `/issues?state=open&per_page=100&page=${page}`, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    issues.push(...batch.filter((item) => !item.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

export async function listOpenPrs(repo, token) {
  const prs = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await ghJson(repo, `/pulls?state=open&per_page=100&page=${page}`, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    prs.push(...batch);
    if (batch.length < 100) break;
  }
  return prs;
}

export function labelNames(labels = []) {
  return labels.map((label) => (typeof label === 'string' ? label : label?.name)).filter(Boolean);
}

export function roleOf(labels = []) {
  const names = labelNames(labels);
  return MATT_ROLES.find((role) => names.includes(role)) || 'unlabeled';
}

export function linkedPrNumbers(prs = []) {
  const links = new Map();
  for (const pr of prs) {
    const text = `${pr.title || ''}\n${pr.body || ''}`;
    const pattern = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;
    let match;
    while ((match = pattern.exec(text))) links.set(Number(match[1]), pr.number);
    const branch = String(pr.head?.ref || '');
    const byBranch = branch.match(/(?:^|\/)loop\/(\d+)-/i);
    if (byBranch) links.set(Number(byBranch[1]), pr.number);
  }
  return links;
}

export function parsePolicy(raw = 'ready-for-agent') {
  const value = String(raw || '').trim();
  if (!value) return { raw: 'ready-for-agent', kind: 'label', label: 'ready-for-agent' };
  if (value === 'off' || value === 'none') return { raw: value, kind: 'off' };
  if (value === 'do' || value === 'verdict') return { raw: value, kind: 'verdict' };
  if (value.startsWith('label:')) return { raw: value, kind: 'label', label: value.slice(6) };
  return { raw: value, kind: 'label', label: value };
}

function normalizeTimestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Why an issue is not eligible for this run. Returns '' when it is eligible.
 * Policy is supplied by the Orca automation, never hard-coded here.
 */
export function ineligibleReason(issue, options = {}) {
  const {
    policy = parsePolicy(),
    selfLogin = '',
    now = Date.now(),
    claimTtlMinutes = Number(process.env.LOOP_CLAIM_TTL_MINUTES || 180),
  } = options;

  if (policy.kind === 'off') return 'policy is off';
  if (issue.hasOpenPR) return `already has open PR #${issue.linkedPR}`;

  const labels = labelNames(issue.labels);
  const blocked = labels.find((label) => ALWAYS_BLOCKED_ROLES.has(label));
  if (blocked) return `blocked by label ${blocked}`;
  if (labels.includes('needs-triage')) return 'needs triage first';

  if (policy.kind === 'label' && !labels.includes(policy.label)) {
    return `missing label ${policy.label}`;
  }
  if (policy.kind === 'verdict' && issue.verdict !== 'do') {
    return `triage verdict is ${issue.verdict || 'unknown'}, not do`;
  }

  const assignees = (issue.assignees || []).filter(Boolean);
  const others = selfLogin ? assignees.filter((login) => login !== selfLogin) : assignees;
  if (others.length > 0) return `assigned to ${others.join(', ')}`;
  if (selfLogin && assignees.includes(selfLogin)) {
    const ageMinutes = (now - normalizeTimestamp(issue.updatedAt)) / 60000;
    if (ageMinutes < claimTtlMinutes) return `claimed recently (${Math.round(ageMinutes)}m ago)`;
  }

  return '';
}

/** Oldest first, deterministic across runs. */
export function selectCandidate(issues = [], options = {}) {
  const ordered = [...issues].sort((a, b) => normalizeTimestamp(a.createdAt) - normalizeTimestamp(b.createdAt));
  return ordered.find((issue) => ineligibleReason(issue, options) === '') || null;
}
