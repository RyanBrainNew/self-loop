// Deterministic control plane for self-loop.
// It owns Ticket state, claims, leases, context packets, gates, and dispatch.
// It never writes business code and never merges.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ghJson,
  git,
  isMain,
  labelNames,
  parseArgs,
  parsePolicy,
  repoRelativePath,
  resolveRepo,
  resolveSelfLogin,
  resolveSettings,
  resolveToken,
} from './lib.mjs';
import { selectOne } from './select.mjs';
import { discoverVerifierCommands, runVerifier } from './verifier.mjs';

export const ROUTER_STATE_VERSION = 1;
export const STATUS_MARKER = '<!-- self-loop:status -->';
export const RESULT_STATES = new Set([
  'progress',
  'waiting',
  'ready',
  'blocked',
  'failed',
  'dropped',
  'timeout',
  'undeliverable',
]);

const ACTIVE_STATES = new Set(['queued', 'claimed', 'working', 'verifying', 'blocked', 'failed', 'awaiting_review']);
const TERMINAL_STATES = new Set(['done', 'dropped']);
const skillRoot = fileURLToPath(new URL('..', import.meta.url));

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function gitOrThrow(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON at ${file}: ${error.message}`);
  }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export function statePath(settings) {
  return join(settings.outDir, 'state.json');
}

export function emptyState(settings) {
  return {
    version: ROUTER_STATE_VERSION,
    repo: settings.githubRepo || '',
    activeTicket: null,
    tickets: {},
    updatedAt: nowIso(),
  };
}

export function loadState(settings) {
  const state = readJson(statePath(settings), emptyState(settings));
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('router state must be a JSON object');
  }
  if (!state.tickets || typeof state.tickets !== 'object' || Array.isArray(state.tickets)) {
    state.tickets = {};
  }
  if (state.activeTicket !== null && state.activeTicket !== undefined) {
    state.activeTicket = Number(state.activeTicket);
  }
  return state;
}

export function saveState(settings, state) {
  mkdirSync(settings.outDir, { recursive: true });
  state.updatedAt = nowIso();
  writeJsonAtomic(statePath(settings), state);
}

export async function withStateLock(settings, fn) {
  mkdirSync(settings.outDir, { recursive: true });
  const lock = join(settings.outDir, 'lock');
  let owned = false;
  try {
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: nowIso() })}\n`);
    closeSync(fd);
    owned = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let stale = false;
    try {
      stale = Date.now() - statSync(lock).mtimeMs > settings.router.lockMinutes * 60 * 1000;
    } catch {
      stale = true;
    }
    if (!stale) throw new Error(`router lock is held: ${lock}`);
    rmSync(lock, { force: true });
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: nowIso() })}\n`);
    closeSync(fd);
    owned = true;
  }

  try {
    return await fn();
  } finally {
    if (owned) rmSync(lock, { force: true });
  }
}

export function activeTicket(state) {
  if (state.activeTicket !== null && state.tickets[String(state.activeTicket)]) {
    const ticket = state.tickets[String(state.activeTicket)];
    if (ACTIVE_STATES.has(ticket.state)) return ticket;
  }
  return Object.values(state.tickets)
    .filter((ticket) => ACTIVE_STATES.has(ticket.state))
    .sort((a, b) => a.number - b.number)[0] || null;
}

function ticketPath(settings, ticket) {
  return join(settings.outDir, 'tickets', `${ticket.number}.json`);
}

function saveTicket(settings, ticket) {
  mkdirSync(join(settings.outDir, 'tickets'), { recursive: true });
  writeJsonAtomic(ticketPath(settings, ticket), ticket);
}

function artifactRoot(settings, ticket) {
  return join(settings.outDir, 'artifacts', String(ticket.number));
}

function artifactDir(settings, ticket, attempt = ticket.attempts || 1) {
  return join(artifactRoot(settings, ticket), `attempt-${attempt}`);
}

function slugify(value) {
  return String(value || 'issue')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'issue';
}

function defaultBranch(repoRoot) {
  const remoteHead = git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (remoteHead) return remoteHead.replace(/^origin\//, '');
  for (const name of ['main', 'master']) {
    if (git(repoRoot, ['show-ref', '--verify', `refs/heads/${name}`]) !== '') return name;
  }
  return git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
}

function repoHead(repoRoot) {
  return git(repoRoot, ['rev-parse', 'HEAD']) || '';
}

export function leaseExpired(ticket, now = Date.now()) {
  const expiresAt = ticket?.lease?.expiresAt;
  if (!expiresAt) return false;
  const time = new Date(expiresAt).getTime();
  return Number.isFinite(time) && time <= now;
}

function branchRef(repoRoot, branch) {
  if (!branch) return '';
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (git(repoRoot, ['show-ref', '--verify', ref]) !== '') return ref;
  }
  return '';
}

function branchHasCommits(repoRoot, branch) {
  const ref = branchRef(repoRoot, branch);
  if (!ref) return false;
  const base = defaultBranch(repoRoot);
  const baseRef = branchRef(repoRoot, base) || `refs/heads/${base}`;
  const count = Number(git(repoRoot, ['rev-list', '--count', `${baseRef}..${ref}`]));
  return Number.isFinite(count) && count > 0;
}

export function createTicket(candidate, settings, now = Date.now()) {
  const number = Number(candidate.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error('candidate.number is required');
  return {
    number,
    title: candidate.title || `Issue #${number}`,
    body: candidate.body || '',
    url: candidate.url || '',
    labels: labelNames(candidate.labels || []),
    repo: settings.githubRepo || '',
    state: 'queued',
    attempts: 0,
    maxAttempts: settings.router.maxAttempts,
    manualRecoveries: 0,
    claim: {
      by: candidate.claimedBy || '',
      at: candidate.claimedAt || nowIso(now),
    },
    lease: null,
    branch: candidate.branch || null,
    worktree: null,
    pr: candidate.pr || null,
    prHead: candidate.prHead || null,
    lastResult: null,
    verification: null,
    artifacts: [],
    humanQuestion: null,
    createdAt: nowIso(now),
    updatedAt: nowIso(now),
  };
}

export function extractAcceptance(body = '') {
  const lines = String(body || '').split(/\r?\n/);
  const values = [];
  let section = false;
  for (const line of lines) {
    if (/^\s*#{1,6}\s+.*(acceptance|acceptance criteria|验收)/i.test(line)) {
      section = true;
      continue;
    }
    if (section && /^\s*#{1,6}\s+/.test(line)) section = false;
    const checkbox = line.match(/^\s*[-*]\s*\[[ xX]\]\s+(.+)$/);
    if (checkbox) {
      values.push(checkbox[1].trim());
      continue;
    }
    if (section) {
      const item = line.match(/^\s*[-*]\s+(.+)$/);
      if (item) values.push(item[1].trim());
    }
  }
  return [...new Set(values.filter(Boolean))];
}

export function buildTaskCard({ ticket, settings } = {}) {
  const acceptance = extractAcceptance(ticket.body);
  const commands = discoverVerifierCommands({ repoRoot: ticket.repoRoot || settings.repoRoot, settings });
  return {
    ticket: ticket.number,
    goal: ticket.title,
    inScope: ticket.inScope || ['**'],
    outOfScope: ticket.outOfScope || [],
    acceptance,
    requiredChecks: settings.verifier.commands?.length ? settings.verifier.commands : commands,
    risk: ticket.risk || '',
    rollback: ticket.rollback || 'Close the branch and pull request.',
    assumptions: acceptance.length ? [] : ['No explicit acceptance criteria were found in the Issue.'],
    blockedReason: acceptance.length ? null : 'No concrete, verifiable acceptance criteria were found.',
  };
}

function truncate(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, Math.max(0, maxChars - 40))}\n...[context truncated]`,
    truncated: true,
  };
}

function memoryExcerpt(repoRoot, file, maxChars) {
  const relative = repoRelativePath(repoRoot, file);
  if (!existsSync(file)) return { path: relative, present: false, excerpt: '', truncated: false };
  const result = truncate(readFileSync(file, 'utf8'), maxChars);
  return { path: relative, present: true, excerpt: result.text, truncated: result.truncated };
}

function contextMemory({ repoRoot, settings, chars }) {
  return {
    agents: memoryExcerpt(repoRoot, join(repoRoot, 'AGENTS.md'), chars),
    lessons: memoryExcerpt(repoRoot, settings.lessonsPath, chars),
    codeStandards: memoryExcerpt(repoRoot, settings.codeStandardsPath, chars),
    decisions: memoryExcerpt(repoRoot, settings.decisionsPath, chars),
  };
}

function projectFacts(repoRoot, settings) {
  return {
    root: repoRoot,
    github: settings.githubRepo || '',
    head: repoHead(repoRoot),
    defaultBranch: defaultBranch(repoRoot),
  };
}

export function buildContextPacket({
  repoRoot,
  settings,
  ticket,
  taskCard,
  role = 'worker',
  extra = {},
  now = Date.now(),
} = {}) {
  const chars = role === 'router'
    ? settings.router.context.routerChars
    : settings.router.context.workerChars;
  const packet = {
    version: 1,
    asOf: nowIso(now),
    role,
    repo: projectFacts(repoRoot, settings),
    ticket: {
      number: ticket.number,
      title: ticket.title,
      url: ticket.url,
      labels: ticket.labels,
      state: ticket.state,
      attempt: ticket.attempts,
      branch: ticket.branch,
      worktree: ticket.worktree,
      pr: ticket.pr,
    },
    taskCard: role === 'worker' ? taskCard : undefined,
    memory: contextMemory({ repoRoot, settings, chars }),
    artifacts: ticket.artifacts || [],
    constraints: {
      noMerge: true,
      noDefaultPush: true,
      maxAttempts: settings.router.maxAttempts,
      leaseMinutes: settings.router.leaseMinutes,
    },
    clarify: ticket.humanQuestion ? { question: ticket.humanQuestion } : null,
    ...extra,
  };
  if (role === 'router') delete packet.taskCard;
  return packet;
}

export function writeTicketContext({ repoRoot, settings, ticket, taskCard, extra } = {}) {
  const dir = artifactRoot(settings, ticket);
  const attempt = artifactDir(settings, ticket);
  mkdirSync(dir, { recursive: true });
  mkdirSync(attempt, { recursive: true });
  const cardPath = join(dir, 'task-card.json');
  const routerPath = join(attempt, 'context.router.json');
  const workerPath = join(attempt, 'context.worker.json');
  writeJsonAtomic(cardPath, taskCard);
  writeJsonAtomic(routerPath, buildContextPacket({
    repoRoot, settings, ticket, taskCard, role: 'router', extra,
  }));
  writeJsonAtomic(workerPath, buildContextPacket({
    repoRoot, settings, ticket, taskCard, role: 'worker', extra,
  }));
  return { cardPath, routerPath, workerPath };
}

export function validateResultEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('result envelope must be an object');
  }
  const ticket = Number(value.ticket);
  if (!Number.isInteger(ticket) || ticket <= 0) throw new Error('result.ticket must be a positive integer');
  if (!RESULT_STATES.has(value.state)) throw new Error(`invalid result.state: ${value.state}`);
  if (typeof value.humanText !== 'string') throw new Error('result.humanText must be a string');
  const artifactRefs = value.artifactRefs ?? [];
  if (!Array.isArray(artifactRefs)) throw new Error('result.artifactRefs must be an array');
  for (const ref of artifactRefs) {
    if (!ref || typeof ref !== 'object' || !ref.path) {
      throw new Error('each artifactRef must contain path');
    }
  }
  if (value.error !== null && value.error !== undefined) {
    if (typeof value.error !== 'object' || !value.error.code) {
      throw new Error('result.error must contain code');
    }
  }
  if (value.clarify !== null && value.clarify !== undefined) {
    if (typeof value.clarify !== 'object' || typeof value.clarify.question !== 'string') {
      throw new Error('result.clarify must contain one question');
    }
  }
  return {
    ticket,
    attempt: Number(value.attempt) || 1,
    state: value.state,
    humanText: value.humanText,
    artifactRefs,
    error: value.error ?? null,
    clarify: value.clarify ?? null,
    notify: value.notify !== false,
    pr: value.pr ? Number(value.pr) : null,
    prHead: value.prHead || null,
    asOf: value.asOf || nowIso(),
  };
}

function addArtifacts(ticket, refs = []) {
  const known = new Set((ticket.artifacts || []).map((ref) => ref.path));
  for (const ref of refs) {
    if (!known.has(ref.path)) {
      ticket.artifacts = [...(ticket.artifacts || []), ref];
      ticket.artifacts.sort((a, b) => String(a.id || a.path).localeCompare(String(b.id || b.path)));
      known.add(ref.path);
    }
  }
}

export function buildIssueStatusComment(ticket) {
  const lines = [
    STATUS_MARKER,
    `## self-loop status: \`${ticket.state}\``,
    '',
    `- Ticket: #${ticket.number} ${ticket.title || ''}`.trimEnd(),
    `- Attempt: ${ticket.attempts || 0}/${ticket.maxAttempts || 2}`,
  ];
  if (ticket.branch) lines.push(`- Branch: \`${ticket.branch}\``);
  if (ticket.pr) lines.push(`- Pull request: #${ticket.pr}`);
  if (ticket.verification?.status) lines.push(`- Independent verification: \`${ticket.verification.status}\``);
  if (ticket.humanQuestion) lines.push('', `> ${ticket.humanQuestion}`);
  lines.push('', '_This comment is maintained by self-loop; a person still decides whether to merge._');
  return lines.join('\n');
}

/**
 * Keep one status comment per Issue. The marker makes repeated ticks
 * idempotent; comment failure is a notification failure, not a gate failure.
 */
export async function publishIssueStatus({ settings, ticket, token = resolveToken() } = {}) {
  if (!settings.router.comments) return { status: 'disabled' };
  if (!ticket?.number || !settings.githubRepo) return { status: 'skipped' };
  if (!token) return { status: 'no-token' };
  const body = buildIssueStatusComment(ticket);
  const comments = await ghJson(settings.githubRepo, `/issues/${ticket.number}/comments?per_page=100`, token);
  const existing = Array.isArray(comments) ? comments.find((comment) => String(comment.body || '').includes(STATUS_MARKER)) : null;
  if (existing) {
    await ghJson(settings.githubRepo, `/issues/comments/${existing.id}`, token, {
      method: 'PATCH',
      body: { body },
    });
    return { status: 'updated', comment: existing.id };
  }
  const created = await ghJson(settings.githubRepo, `/issues/${ticket.number}/comments`, token, {
    method: 'POST',
    body: { body },
  });
  return { status: 'created', comment: created.id };
}

export function applyResultToTicket(ticket, result) {
  ticket.lastResult = result;
  ticket.attempts = Math.max(ticket.attempts || 0, result.attempt || 0);
  ticket.pr = result.pr || ticket.pr || null;
  ticket.prHead = result.prHead || ticket.prHead || null;
  addArtifacts(ticket, result.artifactRefs);
  ticket.lease = null;
  ticket.updatedAt = nowIso();
  if (result.state === 'ready') {
    ticket.state = 'verifying';
  } else if (result.state === 'blocked' || result.state === 'timeout' || result.state === 'undeliverable') {
    ticket.state = 'blocked';
    ticket.humanQuestion = result.clarify?.question || result.humanText || 'The Worker could not continue.';
  } else if (result.state === 'failed') {
    if ((ticket.attempts || 0) < (ticket.maxAttempts || 2)) {
      ticket.state = 'queued';
      ticket.humanQuestion = null;
    } else {
      ticket.state = 'blocked';
      ticket.humanQuestion = result.clarify?.question || 'Retry budget exhausted; review and run router recover.';
    }
  } else if (result.state === 'dropped') {
    ticket.state = 'done';
    ticket.humanQuestion = null;
  } else {
    ticket.state = 'working';
  }
  return ticket;
}

function ensureWorktree({ repoRoot, settings, ticket }) {
  if (settings.router.worktreeMode === 'external') {
    return ticket.worktree || repoRoot;
  }
  const path = join(settings.router.worktreeDir, String(ticket.number));
  if (existsSync(path)) return path;
  const branch = ticket.branch || `loop/${ticket.number}-${slugify(ticket.title)}`;
  ticket.branch = branch;
  mkdirSync(join(path, '..'), { recursive: true });
  const branchExists = git(repoRoot, ['show-ref', '--verify', `refs/heads/${branch}`]) !== '';
  if (branchExists) {
    gitOrThrow(repoRoot, ['worktree', 'add', path, branch]);
  } else {
    gitOrThrow(repoRoot, ['worktree', 'add', '-b', branch, path, defaultBranch(repoRoot)]);
  }
  ticket.worktree = path;
  return path;
}

function executorInvocation(settings, workReference) {
  const configured = settings.executor.command;
  if (!configured) return null;
  if (Array.isArray(configured)) {
    if (configured.length === 0) return null;
    return {
      file: String(configured[0]),
      args: [
        ...configured.slice(1).map(String),
        ...(settings.executor.args || []),
        workReference,
      ],
      shell: false,
    };
  }
  return {
    file: String(configured),
    args: [...(settings.executor.args || []), workReference],
    shell: true,
  };
}

export function prepareDispatch({ repoRoot, settings, state, ticket, now = Date.now() } = {}) {
  const taskCard = buildTaskCard({ ticket: { ...ticket, repoRoot }, settings });
  ticket.taskCard = taskCard;
  if (taskCard.blockedReason) {
    ticket.state = 'blocked';
    ticket.humanQuestion = taskCard.blockedReason;
    ticket.updatedAt = nowIso(now);
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { blocked: true, taskCard };
  }
  const worktree = ensureWorktree({ repoRoot, settings, ticket });
  ticket.attempts = (ticket.attempts || 0) + 1;
  ticket.state = 'working';
  ticket.lease = {
    id: `${ticket.number}-${ticket.attempts}`,
    startedAt: nowIso(now),
    expiresAt: new Date(now + settings.router.leaseMinutes * 60 * 1000).toISOString(),
    pid: null,
  };
  const artifact = artifactDir(settings, ticket);
  mkdirSync(artifact, { recursive: true });
  ticket.resultPath = join(artifact, 'result.json');
  const paths = writeTicketContext({ repoRoot, settings, ticket, taskCard });
  ticket.updatedAt = nowIso(now);
  saveTicket(settings, ticket);
  saveState(settings, state);
  return { blocked: false, taskCard, worktree, paths };
}

export function executeDispatch({
  repoRoot,
  settings,
  state,
  ticket,
  prepared,
  dryRun = false,
} = {}) {
  if (prepared.blocked) return { dispatched: false, status: 'blocked', reason: prepared.taskCard.blockedReason };
  const invocation = executorInvocation(settings, join(skillRoot, 'references', 'WORK.md'));
  if (dryRun) return { dispatched: false, status: 'dry-run', worktree: prepared.worktree, invocation };
  if (!invocation) {
    ticket.attempts = Math.max(0, (ticket.attempts || 0) - 1);
    ticket.state = 'queued';
    ticket.lease = null;
    ticket.updatedAt = nowIso();
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { dispatched: false, status: 'executor-not-configured', taskCard: prepared.taskCard };
  }

  const env = {
    ...process.env,
    SELF_LOOP_REPO: repoRoot,
    SELF_LOOP_TICKET: String(ticket.number),
    ISSUE_NUMBER: String(ticket.number),
    SELF_LOOP_TASK_CARD: join(artifactRoot(settings, ticket), 'task-card.json'),
    SELF_LOOP_CONTEXT: prepared.paths.workerPath,
    SELF_LOOP_RESULT: ticket.resultPath,
  };
  const result = spawnSync(invocation.file, invocation.args, {
    cwd: prepared.worktree,
    env,
    stdio: 'inherit',
    shell: invocation.shell,
  });

  if (existsSync(ticket.resultPath)) {
    const envelope = validateResultEnvelope(readJson(ticket.resultPath, null));
    applyResultToTicket(ticket, envelope);
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { dispatched: true, status: ticket.state, result: envelope };
  }

  if (result.error || result.status !== 0) {
    applyResultToTicket(ticket, {
      ticket: ticket.number,
      attempt: ticket.attempts,
      state: 'failed',
      humanText: result.error?.message || `executor exited with ${result.status}`,
      artifactRefs: [],
      error: { code: 'EXECUTOR_FAILED', userCause: 'Worker execution failed', userAction: 'Review the log and retry', system: false },
      clarify: null,
      notify: true,
      asOf: nowIso(),
    });
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { dispatched: true, status: ticket.state, error: result.error?.message || `exit ${result.status}` };
  }

  return { dispatched: true, status: 'working', note: 'executor exited without a result envelope' };
}

export function verifyTicket({ repoRoot, settings, state, ticket, keep = false } = {}) {
  const verification = runVerifier({ repoRoot, settings, ticket, keep });
  ticket.verification = verification;
  addArtifacts(ticket, [{
    id: `verify-${ticket.attempts}`,
    path: repoRelativePath(repoRoot, verification.evidencePath),
    summary: verification.status,
  }]);
  if (verification.status === 'pass') {
    ticket.state = 'awaiting_review';
    ticket.humanQuestion = null;
  } else if (verification.status === 'human_review') {
    ticket.state = 'blocked';
    ticket.humanQuestion = 'Independent verification could not decide; please review the evidence.';
  } else {
    ticket.state = (ticket.attempts || 0) < (ticket.maxAttempts || 2) ? 'queued' : 'blocked';
    ticket.humanQuestion = ticket.state === 'blocked'
      ? 'Retry budget exhausted after verification failure; run router recover.'
      : null;
  }
  ticket.updatedAt = nowIso();
  saveTicket(settings, ticket);
  saveState(settings, state);
  return verification;
}

export function recoverTicket({ settings, state, ticket, now = Date.now() } = {}) {
  ticket.state = 'queued';
  ticket.lease = null;
  ticket.humanQuestion = null;
  ticket.attempts = Math.max(0, (ticket.maxAttempts || 2) - 1);
  ticket.manualRecoveries = (ticket.manualRecoveries || 0) + 1;
  ticket.updatedAt = nowIso(now);
  saveTicket(settings, ticket);
  saveState(settings, state);
  return ticket;
}

/**
 * Resolve an expired lease deterministically. An expired Attempt was already
 * counted at dispatch time, so requeue only when the budget and safety checks
 * allow another Attempt. Any evidence of usable work blocks for a person.
 */
export function expireTicketIfNeeded({
  repoRoot,
  settings,
  state,
  ticket,
  now = Date.now(),
} = {}) {
  if (!leaseExpired(ticket, now)) return { effect: 'none', ticket };
  if (!['claimed', 'working'].includes(ticket.state)) return { effect: 'none', ticket };

  const reasons = [];
  if (ticket.pr) reasons.push(`an open pull request #${ticket.pr} is recorded`);
  if (ticket.resultPath && existsSync(ticket.resultPath)) {
    reasons.push('a completed Result Envelope exists');
  }
  if (branchHasCommits(repoRoot, ticket.branch)) {
    reasons.push(`branch ${ticket.branch} already contains commits`);
  }
  const attempts = ticket.attempts || 0;
  if (attempts >= (ticket.maxAttempts || settings.router.maxAttempts)) {
    reasons.push(`attempt budget exhausted (${attempts}/${ticket.maxAttempts || settings.router.maxAttempts})`);
  }

  ticket.lease = null;
  ticket.updatedAt = nowIso(now);
  if (reasons.length > 0) {
    ticket.state = 'blocked';
    ticket.humanQuestion = `Lease expired: ${reasons.join('; ')}. Review the worktree, then run router recover.`;
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { effect: 'blocked', ticket, reasons };
  }

  ticket.state = 'queued';
  ticket.humanQuestion = null;
  saveTicket(settings, ticket);
  saveState(settings, state);
  return { effect: 'requeued', ticket, reasons };
}

export function cleanTicketWorktree({ repoRoot, settings, ticket, all = false } = {}) {
  if (!all && !TERMINAL_STATES.has(ticket.state)) {
    throw new Error(`refusing to clean a non-terminal Ticket #${ticket.number}`);
  }
  if (!ticket.worktree) return false;
  try {
    gitOrThrow(repoRoot, ['worktree', 'remove', '--force', ticket.worktree]);
  } catch {
    rmSync(ticket.worktree, { recursive: true, force: true });
  }
  ticket.worktree = null;
  ticket.updatedAt = nowIso();
  saveTicket(settings, ticket);
  return true;
}

export async function tickRouter({
  repoRoot,
  settings,
  candidate = null,
  dryRun = false,
  now = Date.now(),
} = {}) {
  return withStateLock(settings, async () => {
    const state = loadState(settings);
    let ticket = activeTicket(state);
    if (!ticket && candidate) {
      if (dryRun) {
        const preview = createTicket(candidate, settings, now);
        const taskCard = buildTaskCard({ ticket: { ...preview, repoRoot }, settings });
        return { status: taskCard.blockedReason ? 'blocked' : 'dry-run', ticket: preview, taskCard };
      }
      ticket = createTicket(candidate, settings, now);
      state.tickets[String(ticket.number)] = ticket;
      state.activeTicket = ticket.number;
      saveTicket(settings, ticket);
      saveState(settings, state);
    }
    if (!ticket) return { status: 'idle', state };

    if (dryRun) {
      const taskCard = buildTaskCard({ ticket: { ...ticket, repoRoot }, settings });
      return { status: taskCard.blockedReason ? 'blocked' : 'dry-run', ticket, taskCard };
    }
    const expiration = expireTicketIfNeeded({ repoRoot, settings, state, ticket, now });
    if (expiration.effect === 'blocked') {
      return { status: 'blocked', reason: ticket.humanQuestion, ticket, state };
    }
    if (ticket.state === 'verifying') {
      const verification = verifyTicket({ repoRoot, settings, state, ticket });
      return { status: verification.status, ticket, state };
    }
    if (ticket.state === 'queued' || ticket.state === 'claimed') {
      const prepared = prepareDispatch({ repoRoot, settings, state, ticket, now });
      const dispatched = executeDispatch({ repoRoot, settings, state, ticket, prepared, dryRun });
      return { ...dispatched, ticket, state };
    }
    return { status: ticket.state, ticket, state };
  });
}

function summary(state) {
  return Object.values(state.tickets).map((ticket) => ({
    number: ticket.number,
    title: ticket.title,
    state: ticket.state,
    attempts: ticket.attempts,
    maxAttempts: ticket.maxAttempts,
    lease: ticket.lease?.expiresAt || null,
    pr: ticket.pr,
    question: ticket.humanQuestion,
  }));
}

async function selectCandidateForTick({ repoRoot, settings, noClaim = false }) {
  const token = resolveToken();
  const policy = parsePolicy(settings.policy);
  const selfLogin = await resolveSelfLogin(settings.githubRepo, token);
  const { state, candidate } = await selectOne({
    policy,
    repoRoot,
    githubRepo: settings.githubRepo,
    token,
    selfLogin,
    ttlMinutes: settings.claimTtlMinutes,
    outDir: settings.outDir,
    refresh: true,
  });
  if (!candidate) return null;
  mkdirSync(settings.outDir, { recursive: true });
  writeJsonAtomic(join(settings.outDir, 'triage.json'), state);
  writeJsonAtomic(join(settings.outDir, 'work.json'), {
    ...candidate,
    claimedBy: noClaim ? '(dry-run)' : selfLogin,
    claimedAt: nowIso(),
  });
  if (!noClaim && selfLogin) {
    await ghJson(settings.githubRepo, `/issues/${candidate.number}/assignees`, token, {
      method: 'POST',
      body: { assignees: [selfLogin] },
    });
  }
  return {
    ...candidate,
    claimedBy: noClaim ? '(dry-run)' : selfLogin,
    claimedAt: nowIso(),
  };
}

async function main() {
  const { values, flags, rest } = parseArgs(process.argv.slice(2));
  const sub = rest[0] || 'status';
  const repoRoot = resolveRepo({ repo: values.repo });
  const settings = resolveSettings(repoRoot, {
    policy: values.policy,
    claimTtlMinutes: values.ttl,
    outDir: values.out,
    maxAttempts: values['max-attempts'],
    leaseMinutes: values['lease-minutes'],
    maxConcurrent: values.concurrent,
  });
  if (!settings.githubRepo) {
    throw new Error('cannot resolve GitHub repo: set githubRepo in .self-loop.json or GITHUB_REPOSITORY');
  }
  const ticketNumber = values.ticket ? Number(values.ticket) : null;
  const notify = async (ticket) => {
    if (flags['no-notify'] || !ticket) return;
    try {
      const result = await publishIssueStatus({ settings, ticket });
      if (result.status === 'created' || result.status === 'updated') {
        console.error(`[router] issue comment ${result.status} for #${ticket.number}`);
      }
    } catch (error) {
      console.error(`[router] issue comment skipped for #${ticket.number}: ${error.message}`);
    }
  };

  if (sub === 'status') {
    const state = loadState(settings);
    if (flags.json) return console.log(JSON.stringify(state, null, 2));
    console.log(JSON.stringify({ repo: state.repo, activeTicket: state.activeTicket, tickets: summary(state) }, null, 2));
    return 0;
  }

  if (sub === 'tick') {
    const state = loadState(settings);
    let candidate = null;
    if (!activeTicket(state)) {
      candidate = await selectCandidateForTick({
        repoRoot,
        settings,
        noClaim: Boolean(flags['no-claim']) || Boolean(flags['dry-run']),
      });
      if (!candidate) {
        console.log('[router] no eligible issue');
        return 3;
      }
    }
    const result = await tickRouter({
      repoRoot,
      settings,
      candidate,
      dryRun: Boolean(flags['dry-run']),
    });
    console.log(JSON.stringify(flags.json ? result : { status: result.status, ticket: result.ticket?.number || null }, null, 2));
    if (!flags['dry-run']) await notify(result.ticket);
    return 0;
  }

  if (sub === 'report') {
    if (!values.file) throw new Error('router report requires --file <result.json>');
    return withStateLock(settings, async () => {
      const state = loadState(settings);
      const envelope = validateResultEnvelope(readJson(resolve(values.file), null));
      const ticket = state.tickets[String(envelope.ticket)]
        || (ticketNumber ? state.tickets[String(ticketNumber)] : null);
      if (!ticket) throw new Error(`unknown Ticket #${envelope.ticket}`);
      applyResultToTicket(ticket, envelope);
      saveTicket(settings, ticket);
      saveState(settings, state);
      console.log(`[router] #${ticket.number} ${ticket.state}`);
      if (!flags['no-notify']) await notify(ticket);
      return 0;
    });
  }

  if (sub === 'verify') {
    return withStateLock(settings, async () => {
      const state = loadState(settings);
      const ticket = state.tickets[String(ticketNumber)];
      if (!ticket) throw new Error(`unknown Ticket #${ticketNumber}`);
      const result = verifyTicket({ repoRoot, settings, state, ticket, keep: Boolean(flags.keep) });
      console.log(`[router] verify #${ticket.number}: ${result.status}`);
      if (!flags['no-notify']) await notify(ticket);
      return result.status === 'pass' || result.status === 'human_review' ? 0 : 2;
    });
  }

  if (sub === 'recover') {
    return withStateLock(settings, async () => {
      const state = loadState(settings);
      const ticket = state.tickets[String(ticketNumber)];
      if (!ticket) throw new Error(`unknown Ticket #${ticketNumber}`);
      recoverTicket({ settings, state, ticket });
      console.log(`[router] recovered #${ticket.number}; state=${ticket.state}`);
      if (!flags['no-notify']) await notify(ticket);
      return 0;
    });
  }

  if (sub === 'clean') {
    return withStateLock(settings, async () => {
      const state = loadState(settings);
      const tickets = ticketNumber
        ? [state.tickets[String(ticketNumber)]].filter(Boolean)
        : Object.values(state.tickets).filter((ticket) => TERMINAL_STATES.has(ticket.state));
      for (const ticket of tickets) cleanTicketWorktree({ repoRoot, settings, ticket });
      saveState(settings, state);
      console.log(`[router] cleaned ${tickets.length} worktree(s)`);
      return 0;
    });
  }

  if (sub === 'watchdog') {
    return withStateLock(settings, async () => {
      const state = loadState(settings);
      const actions = [];
      for (const ticket of Object.values(state.tickets)) {
        if (!leaseExpired(ticket)) continue;
        if (flags['dry-run']) {
          actions.push({ number: ticket.number, state: ticket.state, effect: 'dry-run', expiresAt: ticket.lease.expiresAt });
          continue;
        }
        const result = expireTicketIfNeeded({ repoRoot, settings, state, ticket });
        actions.push({ number: ticket.number, state: ticket.state, effect: result.effect, reason: result.reasons?.join('; ') });
      }
      console.log(JSON.stringify(actions, null, 2));
      return 0;
    });
  }

  console.error(`[router] unknown command: ${sub} (tick|status|report|verify|recover|clean|watchdog)`);
  return 2;
}

if (isMain(import.meta.url)) {
  try {
    const code = await main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[router] ${error.message}`);
    process.exit(2);
  }
}
