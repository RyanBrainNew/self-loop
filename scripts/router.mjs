// Deterministic control plane for self-loop.
// It owns Ticket state, claims, leases, context packets, gates, and dispatch.
// It also owns the durable inbox that wakes it. It never writes business code
// and never merges.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
  pathInRepo,
  repoRelativePath,
  resolveRepo,
  resolveSelfLogin,
  resolveSettings,
  resolveToken,
} from './lib.mjs';
import { pick } from './copy.mjs';
import {
  appendEvent,
  inboxSummary,
  loadInbox,
  pendingEventTickets,
  pendingEvents,
  saveInbox,
} from './inbox.mjs';
import { selectCandidates } from './select.mjs';
import { discoverVerifierCommands, runVerifier } from './verifier.mjs';
import {
  buildExecutorInvocation,
  executorRegistration,
  processAlive,
  stopExecutorProcess,
} from './executors.mjs';
import {
  applyOutboxResults,
  claimOutboxBatch,
  deliverOutbox,
  enqueueTicketOutbox,
  loadOutbox,
  outboxSummary,
  retryOutboxDelivery,
} from './outbox.mjs';

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
const OCCUPYING_STATES = new Set(['queued', 'claimed', 'working', 'verifying']);
const RUNNING_STATES = new Set(['claimed', 'working', 'verifying']);
const TERMINAL_STATES = new Set(['done', 'dropped']);
const skillRoot = fileURLToPath(new URL('..', import.meta.url));

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
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
  return activeTickets(state)[0] || null;
}

export function activeTickets(state) {
  return Object.values(state.tickets)
    .filter((ticket) => ACTIVE_STATES.has(ticket.state))
    .sort((a, b) => a.number - b.number);
}

export function pendingTickets(state) {
  return Object.values(state.tickets)
    .filter((ticket) => OCCUPYING_STATES.has(ticket.state))
    .sort((a, b) => a.number - b.number);
}

export function runningTickets(state) {
  return Object.values(state.tickets)
    .filter((ticket) => RUNNING_STATES.has(ticket.state))
    .sort((a, b) => a.number - b.number);
}

function syncActiveTicket(state) {
  state.activeTicket = activeTickets(state)[0]?.number ?? null;
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
    language: settings.language,
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
  const language = settings.language || ticket.language || 'zh-CN';
  return {
    ticket: ticket.number,
    goal: ticket.title,
    language,
    inScope: ticket.inScope || ['**'],
    outOfScope: ticket.outOfScope || [],
    acceptance,
    requiredChecks: settings.verifier.commands?.length ? settings.verifier.commands : commands,
    risk: ticket.risk || '',
    rollback: ticket.rollback || pick(
      language,
      'Close the branch and pull request.',
      '关闭分支和 PR。',
    ),
    assumptions: acceptance.length ? [] : [
      pick(
        language,
        'No explicit acceptance criteria were found in the Issue.',
        'Issue 中没有找到明确的验收标准。',
      ),
    ],
    blockedReason: acceptance.length ? null : pick(
      language,
      'No concrete, verifiable acceptance criteria were found.',
      '没有找到具体、可验证的验收标准。',
    ),
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
    language: settings.language,
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
      language: settings.language,
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

export function buildIssueStatusComment(ticket, language = 'zh-CN') {
  const lines = [
    STATUS_MARKER,
    pick(language, `## self-loop status: \`${ticket.state}\``, `## self-loop 状态：\`${ticket.state}\``),
    '',
    `- Ticket: #${ticket.number} ${ticket.title || ''}`.trimEnd(),
    `- ${pick(language, 'Attempt', '尝试')}: ${ticket.attempts || 0}/${ticket.maxAttempts || 2}`,
  ];
  if (ticket.branch) lines.push(`- ${pick(language, 'Branch', '分支')}: \`${ticket.branch}\``);
  if (ticket.pr) lines.push(`- ${pick(language, 'Pull request', 'PR')}: #${ticket.pr}`);
  if (ticket.verification?.status) {
    lines.push(`- ${pick(language, 'Independent verification', '独立验证')}: \`${ticket.verification.status}\``);
  }
  if (ticket.worker?.pid) lines.push(`- ${pick(language, 'Worker PID', 'Worker 进程')}: \`${ticket.worker.pid}\``);
  if (ticket.humanQuestion) lines.push('', `> ${ticket.humanQuestion}`);
  lines.push('', pick(
    language,
    '_This comment is maintained by self-loop; a person still decides whether to merge._',
    '_此评论由 self-loop 维护；是否合并仍由人决定。_',
  ));
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
  const body = buildIssueStatusComment(ticket, settings.language);
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

export function queueTicketOutbox({ settings, ticket, now = Date.now() } = {}) {
  if (!settings.outbox?.enabled || !ticket) return [];
  return enqueueTicketOutbox({
    settings,
    ticket,
    state: ticket.state,
    body: buildIssueStatusComment(ticket, settings.language),
    now,
  });
}

export function applyResultToTicket(ticket, result, language = 'zh-CN') {
  ticket.lastResult = result;
  ticket.attempts = Math.max(ticket.attempts || 0, result.attempt || 0);
  ticket.pr = result.pr || ticket.pr || null;
  ticket.prHead = result.prHead || ticket.prHead || null;
  addArtifacts(ticket, result.artifactRefs);
  ticket.updatedAt = nowIso();
  if (result.state === 'ready') {
    ticket.lease = null;
    ticket.state = 'verifying';
  } else if (result.state === 'blocked' || result.state === 'timeout' || result.state === 'undeliverable') {
    ticket.lease = null;
    ticket.state = 'blocked';
    ticket.humanQuestion = result.clarify?.question
      || result.humanText
      || pick(language, 'The Worker could not continue.', 'Worker 无法继续。');
  } else if (result.state === 'failed') {
    ticket.lease = null;
    if ((ticket.attempts || 0) < (ticket.maxAttempts || 2)) {
      ticket.state = 'queued';
      ticket.humanQuestion = null;
    } else {
      ticket.state = 'blocked';
      ticket.humanQuestion = result.clarify?.question || pick(
        language,
        'Retry budget exhausted; review and run router recover.',
        '重试次数已耗尽；请检查后运行 router recover。',
      );
    }
  } else if (result.state === 'dropped') {
    ticket.lease = null;
    ticket.state = 'done';
    ticket.humanQuestion = null;
  } else {
    // progress/waiting: the Attempt is still alive and keeps its lease.
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
  return buildExecutorInvocation({ settings, workReference });
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
  rmSync(ticket.resultPath, { force: true });
  ticket.executor = executorRegistration(settings);
  ticket.worker = null;
  const paths = writeTicketContext({ repoRoot, settings, ticket, taskCard });
  ticket.updatedAt = nowIso(now);
  saveTicket(settings, ticket);
  saveState(settings, state);
  return { blocked: false, taskCard, worktree, paths };
}

function dispatchEnv({ repoRoot, settings, ticket, prepared }) {
  return {
    ...process.env,
    SELF_LOOP_REPO: repoRoot,
    SELF_LOOP_TICKET: String(ticket.number),
    ISSUE_NUMBER: String(ticket.number),
    SELF_LOOP_LANGUAGE: settings.language,
    SELF_LOOP_TASK_CARD: join(artifactRoot(settings, ticket), 'task-card.json'),
    SELF_LOOP_CONTEXT: prepared.paths.workerPath,
    SELF_LOOP_RESULT: ticket.resultPath,
    SELF_LOOP_EXECUTOR_ADAPTER: String(settings.executor.adapter || 'command'),
  };
}

function applyDispatchExit({ settings, state, ticket, result }) {
  if (existsSync(ticket.resultPath)) {
    const envelope = validateResultEnvelope(readJson(ticket.resultPath, null));
    applyResultToTicket(ticket, envelope, settings.language);
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { dispatched: true, status: ticket.state, result: envelope };
  }

  if (result.error || result.status !== 0) {
    const timedOut = result.error?.code === 'ETIMEDOUT';
    applyResultToTicket(ticket, {
      ticket: ticket.number,
      attempt: ticket.attempts,
      state: timedOut ? 'timeout' : 'failed',
      humanText: timedOut
        ? `executor timed out after ${settings.executor.timeoutMinutes} minutes`
        : result.error?.message || `executor exited with ${result.status}`,
      artifactRefs: [],
      error: {
        code: timedOut ? 'EXECUTOR_TIMEOUT' : 'EXECUTOR_FAILED',
        userCause: timedOut ? 'Worker execution timed out' : 'Worker execution failed',
        userAction: 'Review the log and retry',
        system: false,
      },
      clarify: null,
      notify: true,
      asOf: nowIso(),
    }, settings.language);
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { dispatched: true, status: ticket.state, error: result.error?.message || `exit ${result.status}` };
  }

  return { dispatched: true, status: 'working', note: 'executor exited without a result envelope' };
}

export async function executeDispatch({
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

  const env = dispatchEnv({ repoRoot, settings, ticket, prepared });
  if (settings.router.dispatchMode === 'background') {
    const stdoutPath = join(artifactDir(settings, ticket), 'worker.stdout.txt');
    const stderrPath = join(artifactDir(settings, ticket), 'worker.stderr.txt');
    const stdout = openSync(stdoutPath, 'a');
    const stderr = openSync(stderrPath, 'a');
    let child;
    try {
      child = spawn(invocation.file, invocation.args, {
        cwd: prepared.worktree,
        env,
        stdio: ['ignore', stdout, stderr],
        shell: invocation.shell,
        detached: true,
        windowsHide: true,
      });
    } catch (error) {
      closeSync(stdout);
      closeSync(stderr);
      ticket.attempts = Math.max(0, (ticket.attempts || 0) - 1);
      ticket.state = 'queued';
      ticket.lease = null;
      ticket.updatedAt = nowIso();
      saveTicket(settings, ticket);
      saveState(settings, state);
      return { dispatched: false, status: 'executor-failed', error: error.message };
    }
    const started = await new Promise((resolve) => {
      child.once('spawn', () => resolve(true));
      child.once('error', (error) => resolve(error));
    });
    closeSync(stdout);
    closeSync(stderr);
    if (started !== true) {
      ticket.attempts = Math.max(0, (ticket.attempts || 0) - 1);
      ticket.state = 'queued';
      ticket.lease = null;
      ticket.updatedAt = nowIso();
      saveTicket(settings, ticket);
      saveState(settings, state);
      return { dispatched: false, status: 'executor-failed', error: started?.message || 'spawn failed' };
    }
    child.unref();
    ticket.worker = {
      pid: child.pid,
      startedAt: nowIso(),
      heartbeatAt: nowIso(),
      adapter: invocation.adapter,
      timeoutMinutes: settings.executor.timeoutMinutes,
      stdout: repoRelativePath(repoRoot, stdoutPath),
      stderr: repoRelativePath(repoRoot, stderrPath),
    };
    ticket.updatedAt = nowIso();
    saveTicket(settings, ticket);
    saveState(settings, state);
    return { dispatched: true, status: 'working', background: true, pid: child.pid };
  }

  const result = spawnSync(invocation.file, invocation.args, {
    cwd: prepared.worktree,
    env,
    stdio: 'inherit',
    shell: invocation.shell,
    timeout: invocation.timeoutMs,
    killSignal: 'SIGTERM',
  });
  ticket.worker = {
    pid: result.pid || null,
    startedAt: ticket.lease?.startedAt || nowIso(),
    heartbeatAt: nowIso(),
    adapter: invocation.adapter,
    timeoutMinutes: settings.executor.timeoutMinutes,
    exitCode: result.status,
    signal: result.signal || null,
  };
  return applyDispatchExit({ settings, state, ticket, result });
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
    ticket.humanQuestion = pick(
      settings.language,
      'Independent verification could not decide; please review the evidence.',
      '独立验证无法给出结论；请检查验证证据。',
    );
  } else {
    ticket.state = (ticket.attempts || 0) < (ticket.maxAttempts || 2) ? 'queued' : 'blocked';
    ticket.humanQuestion = ticket.state === 'blocked'
      ? pick(
          settings.language,
          'Retry budget exhausted after verification failure; run router recover.',
          '验证失败且重试次数已耗尽；请运行 router recover。',
        )
      : null;
  }
  ticket.updatedAt = nowIso();
  saveTicket(settings, ticket);
  saveState(settings, state);
  queueTicketOutbox({ settings, ticket });
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

export function cancelTicketRun({
  settings,
  state,
  ticket,
  now = Date.now(),
} = {}) {
  if (TERMINAL_STATES.has(ticket.state)) return ticket;
  stopExecutorProcess(ticket.worker?.pid);
  if (ticket.worker) {
    ticket.worker.finishedAt = nowIso(now);
    ticket.worker.exitReason = 'cancelled';
  }
  ticket.state = 'dropped';
  ticket.lease = null;
  ticket.humanQuestion = null;
  ticket.updatedAt = nowIso(now);
  saveTicket(settings, ticket);
  saveState(settings, state);
  queueTicketOutbox({ settings, ticket, now });
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
    ticket.humanQuestion = pick(
      settings.language,
      `Lease expired: ${reasons.join('; ')}. Review the worktree, then run router recover.`,
      `租约已过期：${reasons.join('；')}。请检查 worktree 后运行 router recover。`,
    );
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

/**
 * A Worker may write its Result Envelope after the dispatching process has
 * returned. Every tick applies any completed envelope it finds, so an event or
 * the next scheduled tick can move the Ticket forward without polling GitHub.
 */
export function collectCompletedResults({ repoRoot, settings, state, now = Date.now() } = {}) {
  const applied = [];
  for (const ticket of Object.values(state.tickets)) {
    if (!['claimed', 'working'].includes(ticket.state)) continue;
    if (!ticket.resultPath || !existsSync(ticket.resultPath)) {
      const started = parseTime(ticket.worker?.startedAt || ticket.lease?.startedAt);
      const ageMs = started ? now - started : 0;
      const timeoutMs = Number(
        ticket.worker?.timeoutMinutes || settings.executor.timeoutMinutes,
      ) * 60 * 1000;
      if (started && ageMs > timeoutMs) {
        stopExecutorProcess(ticket.worker?.pid);
        if (ticket.worker) {
          ticket.worker.finishedAt = nowIso(now);
          ticket.worker.heartbeatAt = nowIso(now);
          ticket.worker.exitReason = 'timeout';
        }
        applyResultToTicket(ticket, {
          ticket: ticket.number,
          attempt: ticket.attempts,
          state: 'timeout',
          humanText: `executor timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
          artifactRefs: [],
          error: {
            code: 'EXECUTOR_TIMEOUT',
            userCause: 'Worker execution timed out',
            userAction: 'Review the log and retry',
            system: false,
          },
          clarify: null,
          notify: true,
          asOf: nowIso(now),
        }, settings.language);
        saveTicket(settings, ticket);
        applied.push({ number: ticket.number, status: 'applied', state: ticket.state, asOf: nowIso(now) });
        continue;
      }
      if (ticket.worker?.pid && ageMs > 2000 && !processAlive(ticket.worker.pid)) {
        if (ticket.worker) {
          ticket.worker.finishedAt = nowIso(now);
          ticket.worker.heartbeatAt = nowIso(now);
          ticket.worker.exitReason = 'process-exited-without-result';
        }
        applyResultToTicket(ticket, {
          ticket: ticket.number,
          attempt: ticket.attempts,
          state: 'failed',
          humanText: 'worker process exited without a Result Envelope',
          artifactRefs: [],
          error: {
            code: 'EXECUTOR_EXITED',
            userCause: 'Worker exited before reporting a result',
            userAction: 'Review the log and retry',
            system: false,
          },
          clarify: null,
          notify: true,
          asOf: nowIso(now),
        }, settings.language);
        saveTicket(settings, ticket);
        applied.push({ number: ticket.number, status: 'applied', state: ticket.state, asOf: nowIso(now) });
        continue;
      }
      if (ticket.worker?.pid && processAlive(ticket.worker.pid)) {
        ticket.worker.heartbeatAt = nowIso(now);
        if (ticket.lease) {
          const extended = new Date(now + settings.router.leaseMinutes * 60 * 1000).toISOString();
          if (!ticket.lease.expiresAt || parseTime(ticket.lease.expiresAt) < parseTime(extended)) {
            ticket.lease.expiresAt = extended;
          }
        }
      }
      continue;
    }
    let envelope;
    try {
      envelope = validateResultEnvelope(readJson(ticket.resultPath, null));
    } catch (error) {
      applied.push({ number: ticket.number, status: 'invalid', error: error.message });
      continue;
    }
    if (envelope.ticket !== ticket.number) {
      applied.push({ number: ticket.number, status: 'invalid', error: `result is for #${envelope.ticket}` });
      continue;
    }
    applyResultToTicket(ticket, envelope, settings.language);
    saveTicket(settings, ticket);
    applied.push({ number: ticket.number, status: 'applied', state: ticket.state, asOf: nowIso(now) });
  }
  if (applied.some((item) => item.status === 'applied')) {
    syncActiveTicket(state);
    saveState(settings, state);
  }
  return applied;
}

function ticketForEvent(state, event) {
  if (event.ticket) {
    const ticket = state.tickets[String(event.ticket)];
    if (ticket) return ticket;
  }
  const payload = event.payload || {};
  const prNumber = Number(payload.pull_request?.number || payload.pr || 0);
  if (prNumber) {
    return Object.values(state.tickets).find((ticket) => Number(ticket.pr) === prNumber) || null;
  }
  return null;
}

function resultEnvelopeForEvent({ repoRoot, ticket, event }) {
  const payload = event.payload || {};
  if (payload.ticket && payload.state) {
    return validateResultEnvelope(payload);
  }
  if (payload.result && typeof payload.result === 'object') {
    return validateResultEnvelope(payload.result);
  }
  if (payload.resultPath) {
    const file = pathInRepo(repoRoot, payload.resultPath, 'resultPath');
    return validateResultEnvelope(readJson(file, null));
  }
  if (ticket?.resultPath && existsSync(ticket.resultPath)) {
    return validateResultEnvelope(readJson(ticket.resultPath, null));
  }
  return null;
}

function applyInboxEvent({ repoRoot, settings, state, event }) {
  const ticket = ticketForEvent(state, event);
  const payload = event.payload || {};

  if (event.type === 'issue') {
    if (!ticket) return { outcome: 'no-ticket' };
    if (event.action === 'closed' && !TERMINAL_STATES.has(ticket.state)) {
      ticket.state = payload.issue?.state_reason === 'not_planned' ? 'dropped' : 'done';
      ticket.lease = null;
      ticket.humanQuestion = null;
      ticket.updatedAt = nowIso();
      saveTicket(settings, ticket);
      return { outcome: 'closed', ticket };
    }
    return { outcome: 'priority', ticket };
  }

  if (event.type === 'pull_request') {
    const pr = payload.pull_request || payload;
    if (!ticket) return { outcome: 'no-ticket' };
    ticket.pr = Number(pr.number || event.ticket || ticket.pr) || ticket.pr;
    ticket.prHead = pr.head?.sha || ticket.prHead;
    const sameBranch = ticket.branch && pr.head?.ref === ticket.branch;
    if (['queued', 'claimed'].includes(ticket.state) && !sameBranch) {
      ticket.state = 'blocked';
      ticket.humanQuestion = pick(
        settings.language,
        `PR #${ticket.pr} already exists for this Issue; confirm whether the loop should continue.`,
        `这个 Issue 已有 PR #${ticket.pr}；请确认 loop 是否还要继续。`,
      );
    }
    if (event.action === 'closed' && !TERMINAL_STATES.has(ticket.state)) {
      ticket.state = pr.merged ? 'done' : 'dropped';
      ticket.lease = null;
      ticket.humanQuestion = null;
    }
    ticket.updatedAt = nowIso();
    saveTicket(settings, ticket);
    return { outcome: 'pr-updated', ticket };
  }

  if (event.type === 'result' || event.type === 'worker') {
    const envelope = resultEnvelopeForEvent({ repoRoot, ticket, event });
    if (!envelope) return { outcome: 'no-result', ticket };
    const target = state.tickets[String(envelope.ticket)] || ticket;
    if (!target) throw new Error(`unknown Ticket #${envelope.ticket}`);
    applyResultToTicket(target, envelope, settings.language);
    saveTicket(settings, target);
    return { outcome: 'result-applied', ticket: target };
  }

  if (event.type === 'recover') {
    if (!ticket) return { outcome: 'no-ticket' };
    recoverTicket({ settings, state, ticket });
    return { outcome: 'recovered', ticket };
  }

  if (event.type === 'clean') {
    if (!ticket) return { outcome: 'no-ticket' };
    if (!TERMINAL_STATES.has(ticket.state)) {
      throw new Error(`refusing to clean a non-terminal Ticket #${ticket.number}`);
    }
    cleanTicketWorktree({ repoRoot, settings, ticket });
    return { outcome: 'cleaned', ticket };
  }

  if (event.type === 'control' || event.type === 'manual') {
    if (event.action === 'recover' && ticket) {
      recoverTicket({ settings, state, ticket });
      return { outcome: 'recovered', ticket };
    }
    if (event.action === 'clean' && ticket) {
      if (!TERMINAL_STATES.has(ticket.state)) {
        throw new Error(`refusing to clean a non-terminal Ticket #${ticket.number}`);
      }
      cleanTicketWorktree({ repoRoot, settings, ticket });
      return { outcome: 'cleaned', ticket };
    }
    return { outcome: 'ack', ticket };
  }

  // schedule and verify are wake-ups: the main tick loop re-evaluates state.
  return { outcome: 'ack', ticket };
}

/**
 * Mark every pending event handled. One bad event records its error and does
 * not stop later events; a person can repost it with a new id.
 */
export function drainInbox({ repoRoot, settings, state, now = Date.now() } = {}) {
  const inbox = loadInbox(settings);
  const pending = pendingEvents(inbox);
  const results = [];
  for (const event of pending) {
    try {
      const result = applyInboxEvent({ repoRoot, settings, state, event });
      event.handledAt = nowIso(now);
      event.outcome = result.outcome || 'ok';
      results.push({ id: event.id, type: event.type, ...result, ticket: result.ticket?.number ?? null });
    } catch (error) {
      event.handledAt = nowIso(now);
      event.outcome = 'error';
      event.error = error.message;
      results.push({ id: event.id, type: event.type, outcome: 'error', error: error.message });
    }
  }
  if (pending.length > 0) {
    syncActiveTicket(state);
    saveState(settings, state);
    saveInbox(settings, inbox);
  }
  return { pending: pending.length, results, inbox };
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
  candidates = null,
  dryRun = false,
  now = Date.now(),
} = {}) {
  return withStateLock(settings, async () => {
    const state = loadState(settings);
    const selected = [];
    for (const item of [...(candidates || []), ...(candidate ? [candidate] : [])]) {
      if (!item) continue;
      const number = Number(item.number);
      if (!selected.some((existing) => Number(existing.number) === number)) selected.push(item);
    }
    const current = activeTicket(state);

    if (dryRun) {
      const preview = current || (selected[0] ? createTicket(selected[0], settings, now) : null);
      if (!preview) return { status: 'idle', ticket: null, tickets: [], state };
      const taskCard = buildTaskCard({ ticket: { ...preview, repoRoot }, settings });
      return {
        status: taskCard.blockedReason ? 'blocked' : 'dry-run',
        ticket: preview,
        tickets: [preview],
        taskCard,
        state,
      };
    }

    const changed = new Map();
    const remember = (ticket) => {
      if (ticket) changed.set(ticket.number, ticket);
    };

    const finishedThisTick = new Set();
    const inbox = drainInbox({ repoRoot, settings, state, now });
    for (const result of inbox.results) {
      if (result.ticket) {
        remember(state.tickets[String(result.ticket)]);
        if (result.outcome === 'result-applied') finishedThisTick.add(result.ticket);
      }
    }

    const completed = collectCompletedResults({ repoRoot, settings, state, now });
    for (const item of completed) {
      remember(state.tickets[String(item.number)]);
      if (item.status === 'applied') finishedThisTick.add(item.number);
    }

    const expired = [];
    for (const ticket of activeTickets(state)) {
      if (!leaseExpired(ticket, now)) continue;
      const result = expireTicketIfNeeded({ repoRoot, settings, state, ticket, now });
      if (result.effect !== 'none') {
        expired.push({ number: ticket.number, effect: result.effect });
        remember(ticket);
      }
    }

    const verification = [];
    const verified = new Set();
    for (const ticket of Object.values(state.tickets)) {
      if (ticket.state !== 'verifying') continue;
      const result = verifyTicket({ repoRoot, settings, state, ticket });
      verification.push({ number: ticket.number, status: result.status });
      verified.add(ticket.number);
      remember(ticket);
    }

    const created = [];
    for (const item of selected) {
      if (state.tickets[String(item.number)]) continue;
      if (pendingTickets(state).length >= settings.router.maxConcurrent) break;
      const ticket = createTicket(item, settings, now);
      state.tickets[String(ticket.number)] = ticket;
      saveTicket(settings, ticket);
      created.push(ticket);
      remember(ticket);
    }

    const dispatch = [];
    const attempted = new Set([
      ...verification.map((item) => item.number),
      ...finishedThisTick,
    ]);
    while (runningTickets(state).length < settings.router.maxConcurrent) {
      const next = pendingTickets(state).find(
        (ticket) => ['queued', 'claimed'].includes(ticket.state) && !attempted.has(ticket.number),
      );
      if (!next) break;
      attempted.add(next.number);
      const prepared = prepareDispatch({ repoRoot, settings, state, ticket: next, now });
      const result = await executeDispatch({
        repoRoot,
        settings,
        state,
        ticket: next,
        prepared,
        dryRun: false,
      });
      dispatch.push({ number: next.number, ...result });
      remember(next);
    }

    // In wait mode a Worker may return `ready` during this tick. Verify it now
    // instead of making a person wait for the next scheduled tick.
    for (const ticket of Object.values(state.tickets)) {
      if (ticket.state !== 'verifying' || verified.has(ticket.number)) continue;
      const result = verifyTicket({ repoRoot, settings, state, ticket });
      verification.push({ number: ticket.number, status: result.status });
      verified.add(ticket.number);
      remember(ticket);
    }

    for (const ticket of changed.values()) {
      queueTicketOutbox({ settings, ticket, now });
    }

    syncActiveTicket(state);
    saveState(settings, state);

    const status = dispatch.find((item) => item.status === 'executor-not-configured')?.status
      || verification.at(-1)?.status
      || dispatch.at(-1)?.status
      || (created.length ? 'queued' : null)
      || (changed.size ? [...changed.values()].at(-1).state : null)
      || (activeTickets(state)[0]?.state ?? 'idle');

    return {
      status,
      ticket: changed.values().next().value || null,
      tickets: [...changed.values()],
      created: created.map((ticket) => ticket.number),
      dispatch,
      verification,
      completed,
      expired,
      inbox: inboxSummary(loadInbox(settings)),
      state,
    };
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
    workerPid: ticket.worker?.pid || null,
    pr: ticket.pr,
    question: ticket.humanQuestion,
  }));
}

async function selectCandidatesForTick({
  repoRoot,
  settings,
  noClaim = false,
  limit = 1,
  exclude = new Set(),
  prefer = [],
}) {
  const token = resolveToken();
  const policy = parsePolicy(settings.policy);
  const selfLogin = await resolveSelfLogin(settings.githubRepo, token);
  const { state, candidates } = await selectCandidates({
    policy,
    repoRoot,
    githubRepo: settings.githubRepo,
    token,
    selfLogin,
    ttlMinutes: settings.claimTtlMinutes,
    outDir: settings.outDir,
    refresh: true,
    limit,
    exclude,
    prefer,
  });
  if (candidates.length === 0) return [];
  mkdirSync(settings.outDir, { recursive: true });
  writeJsonAtomic(join(settings.outDir, 'triage.json'), state);

  const claimed = [];
  for (const candidate of candidates) {
    if (noClaim || !selfLogin) {
      claimed.push({
        ...candidate,
        claimedBy: noClaim ? '(dry-run)' : selfLogin,
        claimedAt: nowIso(),
      });
      continue;
    }
    try {
      await ghJson(settings.githubRepo, `/issues/${candidate.number}/assignees`, token, {
        method: 'POST',
        body: { assignees: [selfLogin] },
      });
    } catch (error) {
      console.error(`[router] claim failed for #${candidate.number}: ${error.message}`);
      continue;
    }
    claimed.push({
      ...candidate,
      claimedBy: selfLogin,
      claimedAt: nowIso(),
    });
  }
  if (!noClaim && selfLogin && claimed.length === 0) {
    throw new Error('all candidate claims failed');
  }
  if (claimed[0]) {
    writeJsonAtomic(join(settings.outDir, 'work.json'), {
      ...claimed[0],
      language: settings.language,
    });
  }
  return claimed;
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
    dispatchMode: values['dispatch-mode'],
    inboxLimit: values['inbox-limit'],
    language: values.language,
  });
  const ticketNumber = values.ticket ? Number(values.ticket) : null;
  const notify = async (ticket) => {
    if (flags['no-notify'] || !ticket) return;
    queueTicketOutbox({ settings, ticket });
    if (settings.outbox.enabled) return;
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
    const inbox = loadInbox(settings);
    if (flags.json) return console.log(JSON.stringify({ ...state, inbox: inboxSummary(inbox) }, null, 2));
    console.log(JSON.stringify({
      repo: state.repo,
      activeTicket: state.activeTicket,
      activeTickets: activeTickets(state).map((ticket) => ticket.number),
      inbox: inboxSummary(inbox),
      tickets: summary(state),
    }, null, 2));
    return 0;
  }

  if (sub === 'post') {
    if (!values.type) {
      throw new Error('router post requires --type <issue|pull_request|result|worker|verify|recover|clean|schedule|control>');
    }
    let payload = {};
    if (values.file) payload = readJson(resolve(repoRoot, values.file), {});
    else if (values.data) payload = JSON.parse(values.data);
    const ticket = values.ticket
      ? Number(values.ticket)
      : payload.issue?.number || payload.pull_request?.number || payload.number || payload.ticket || null;
    return withStateLock(settings, async () => {
      const result = appendEvent(settings, {
        type: values.type,
        action: values.action || '',
        ticket,
        payload,
        id: values.id,
      });
      console.log(JSON.stringify({
        id: result.event.id,
        duplicate: result.duplicate,
        type: result.event.type,
        ticket: result.event.ticket,
        pending: inboxSummary(loadInbox(settings)).pending,
      }, null, 2));
      return 0;
    });
  }

  if (sub === 'inbox') {
    const inbox = loadInbox(settings);
    const events = flags.pending ? pendingEvents(inbox) : inbox.events;
    const requested = values.limit === undefined ? events.length : Number(values.limit);
    const limit = Number.isInteger(requested) && requested >= 0 ? requested : events.length;
    const selected = limit === 0 ? [] : events.slice(-limit);
    console.log(JSON.stringify({
      summary: inboxSummary(inbox),
      events: selected,
    }, null, 2));
    return 0;
  }

  if (sub === 'outbox') {
    const action = rest[1] || 'status';
    if (action === 'status') {
      const outbox = loadOutbox(settings);
      console.log(JSON.stringify({
        summary: outboxSummary(outbox),
        deliveries: outbox.deliveries.slice(0, Number(values.limit || 50)),
      }, null, 2));
      return 0;
    }
    if (action === 'retry') {
      if (!values.id) throw new Error('router outbox retry requires --id <delivery>');
      return withStateLock(settings, async () => {
        const delivery = retryOutboxDelivery(settings, values.id);
        console.log(JSON.stringify({ id: delivery.id, state: delivery.state }, null, 2));
        return 0;
      });
    }
    if (action === 'flush') {
      const limit = Math.min(100, Math.max(1, Number(values.limit || 20)));
      const claimed = await withStateLock(settings, async () =>
        claimOutboxBatch(settings, { limit }));
      const results = [];
      for (const delivery of claimed) {
        const outcome = await deliverOutbox(delivery, settings);
        results.push({ id: delivery.id, ...outcome });
      }
      const applied = await withStateLock(settings, async () =>
        applyOutboxResults(settings, results));
      console.log(JSON.stringify({
        flushed: applied.length,
        summary: outboxSummary(loadOutbox(settings)),
        results: applied.map((delivery) => ({
          id: delivery.id,
          state: delivery.state,
          statusCode: delivery.statusCode,
          requestId: delivery.requestId,
          error: delivery.lastError,
        })),
      }, null, 2));
      return 0;
    }
    throw new Error(`unknown router outbox action: ${action} (status|flush|retry)`);
  }

  if (sub === 'tick') {
    const state = loadState(settings);
    const capacity = Math.max(0, settings.router.maxConcurrent - pendingTickets(state).length);
    let candidates = [];
    if (capacity > 0) {
      if (!settings.githubRepo) {
        throw new Error('cannot resolve GitHub repo: set githubRepo in .self-loop.json or GITHUB_REPOSITORY');
      }
      const exclude = new Set(
        Object.values(state.tickets)
          .filter((ticket) => !TERMINAL_STATES.has(ticket.state))
          .map((ticket) => ticket.number),
      );
      candidates = await selectCandidatesForTick({
        repoRoot,
        settings,
        noClaim: Boolean(flags['no-claim']) || Boolean(flags['dry-run']),
        limit: capacity,
        exclude,
        prefer: pendingEventTickets(settings),
      });
    }
    if (candidates.length === 0 && activeTickets(state).length === 0) {
      console.log('[router] no eligible issue');
      return 3;
    }
    const result = await tickRouter({
      repoRoot,
      settings,
      candidates,
      dryRun: Boolean(flags['dry-run']),
    });
    console.log(JSON.stringify(flags.json ? result : {
      status: result.status,
      tickets: (result.tickets || []).map((ticket) => ticket.number),
    }, null, 2));
    if (!flags['dry-run']) {
      for (const ticket of result.tickets || []) await notify(ticket);
    }
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
      applyResultToTicket(ticket, envelope, settings.language);
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

  if (sub === 'cancel') {
    return withStateLock(settings, async () => {
      const state = loadState(settings);
      const ticket = state.tickets[String(ticketNumber)];
      if (!ticket) throw new Error(`unknown Ticket #${ticketNumber}`);
      cancelTicketRun({ settings, state, ticket });
      console.log(`[router] cancelled #${ticket.number}; state=${ticket.state}`);
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

  console.error(`[router] unknown command: ${sub} (tick|status|post|inbox|outbox|report|verify|recover|cancel|clean|watchdog)`);
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
