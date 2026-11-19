// Shared helpers and path/config resolution for self-loop.
// The core has no scheduler dependency: every entry point takes an explicit repo
// and can be called from a terminal, cron, CI, or another adapter.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_FILE = '.self-loop.json';

export const DEFAULTS = Object.freeze({
  policy: 'ready-for-agent',
  claimTtlMinutes: 180,
  retroDays: 2,
  outDir: '.loop',
  lessonsPath: 'memory/LESSONS.md',
  codeStandardsPath: 'memory/code-standards.md',
  decisionsPath: 'memory/DECISIONS.md',
});

export const ROUTER_DEFAULTS = Object.freeze({
  maxAttempts: 2,
  leaseMinutes: 45,
  maxConcurrent: 1,
  lockMinutes: 30,
  llmAdvisory: false,
  comments: true,
  worktreeMode: 'local',
  worktreeDir: '.loop/worktrees',
  routerChars: 2000,
  workerChars: 8000,
  verifierTimeoutMinutes: 30,
});

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

export function git(cwd, args) {
  return run('git', ['-C', cwd, ...args]);
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
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const key = equals >= 0 ? body.slice(0, equals) : body;
    if (equals >= 0) values[key] = body.slice(equals + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) values[key] = argv[++i];
    else flags[key] = true;
  }
  return { values, flags, rest };
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function choose(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? values.at(-1);
}

/**
 * Resolve the target repository. Precedence:
 * --repo, SELF_LOOP_REPO, LOOP_REPO, the current git root, then cwd.
 * A subdirectory passed as --repo is normalized to the repository root.
 */
export function resolveRepo({ repo } = {}, env = process.env) {
  const raw = repo || firstEnv(env, ['SELF_LOOP_REPO', 'LOOP_REPO']) || '';
  const candidate = raw ? resolve(process.cwd(), raw) : process.cwd();
  const topLevel = git(candidate, ['rev-parse', '--show-toplevel']);
  const selected = topLevel ? resolve(topLevel) : candidate;
  try {
    return resolve(realpathSync.native(selected));
  } catch {
    return selected;
  }
}

export function loadConfig(repoRoot) {
  const file = join(repoRoot, CONFIG_FILE);
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid ${CONFIG_FILE}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  }
  return parsed;
}

/**
 * Resolve a configured path against the target repo and reject anything that
 * escapes it. This keeps git operations, .loop output, and memory reads/writes
 * scoped to the repository no matter where the command was started.
 */
export function pathInRepo(repoRoot, value, label = 'path') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const absolute = resolve(repoRoot, value);
  const rel = relative(repoRoot, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the target repository: ${value}`);
  }
  return absolute;
}

export function repoRelativePath(repoRoot, absolutePath) {
  return relative(repoRoot, absolutePath).split(sep).join('/');
}

function configMemoryPath(config, memoryConfig, key) {
  const names = {
    lessonsPath: ['lessonsPath', 'lessons'],
    codeStandardsPath: ['codeStandardsPath', 'codeStandards'],
    decisionsPath: ['decisionsPath', 'decisions'],
  };
  const [topLevel, nested] = names[key];
  return config[topLevel] ?? memoryConfig[nested];
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function booleanValue(value, label) {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0' || value === '') return false;
  throw new Error(`${label} must be true or false`);
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

/**
 * Resolve project settings with this precedence: CLI > environment > config >
 * defaults. Both SELF_LOOP_* and the legacy LOOP_* names are accepted.
 */
export function resolveSettings(repoRoot, overrides = {}, env = process.env) {
  const config = loadConfig(repoRoot);
  const memoryConfig = config.memory && typeof config.memory === 'object' && !Array.isArray(config.memory)
    ? config.memory
    : {};
  const routerConfig = config.router && typeof config.router === 'object' && !Array.isArray(config.router)
    ? config.router
    : {};
  const contextConfig = routerConfig.context && typeof routerConfig.context === 'object' && !Array.isArray(routerConfig.context)
    ? routerConfig.context
    : {};
  const executorConfig = config.executor && typeof config.executor === 'object' && !Array.isArray(config.executor)
    ? config.executor
    : {};
  const verifierConfig = config.verifier && typeof config.verifier === 'object' && !Array.isArray(config.verifier)
    ? config.verifier
    : {};

  const outDir = pathInRepo(
    repoRoot,
    choose(
      overrides.outDir,
      firstEnv(env, ['SELF_LOOP_OUT_DIR', 'LOOP_OUT_DIR']),
      config.outDir,
      DEFAULTS.outDir,
    ),
    'outDir',
  );

  return {
    repoRoot,
    policy: String(
      choose(
        overrides.policy,
        firstEnv(env, ['SELF_LOOP_POLICY', 'LOOP_POLICY']),
        config.policy,
        DEFAULTS.policy,
      ),
    ),
    claimTtlMinutes: positiveInteger(
      choose(
        overrides.claimTtlMinutes,
        firstEnv(env, ['SELF_LOOP_CLAIM_TTL_MINUTES', 'LOOP_CLAIM_TTL_MINUTES']),
        config.claimTtlMinutes,
        DEFAULTS.claimTtlMinutes,
      ),
      'claimTtlMinutes',
    ),
    retroDays: positiveInteger(
      choose(
        overrides.retroDays,
        firstEnv(env, ['SELF_LOOP_RETRO_DAYS', 'LOOP_RETRO_DAYS']),
        config.retroDays,
        DEFAULTS.retroDays,
      ),
      'retroDays',
    ),
    outDir,
    lessonsPath: pathInRepo(
      repoRoot,
      choose(
        overrides.lessonsPath,
        firstEnv(env, ['SELF_LOOP_LESSONS_PATH', 'LOOP_LESSONS_PATH']),
        configMemoryPath(config, memoryConfig, 'lessonsPath'),
        DEFAULTS.lessonsPath,
      ),
      'lessonsPath',
    ),
    codeStandardsPath: pathInRepo(
      repoRoot,
      choose(
        overrides.codeStandardsPath,
        firstEnv(env, ['SELF_LOOP_CODE_STANDARDS_PATH', 'LOOP_CODE_STANDARDS_PATH']),
        configMemoryPath(config, memoryConfig, 'codeStandardsPath'),
        DEFAULTS.codeStandardsPath,
      ),
      'codeStandardsPath',
    ),
    decisionsPath: pathInRepo(
      repoRoot,
      choose(
        overrides.decisionsPath,
        firstEnv(env, ['SELF_LOOP_DECISIONS_PATH', 'LOOP_DECISIONS_PATH']),
        configMemoryPath(config, memoryConfig, 'decisionsPath'),
        DEFAULTS.decisionsPath,
      ),
      'decisionsPath',
    ),
    githubRepo: String(
      choose(
        overrides.githubRepo,
        firstEnv(env, ['GITHUB_REPOSITORY']),
        config.githubRepo,
        repoSlug(repoRoot),
        '',
      ),
    ),
    router: {
      maxAttempts: positiveInteger(
        choose(
          overrides.maxAttempts,
          firstEnv(env, ['SELF_LOOP_MAX_ATTEMPTS', 'LOOP_MAX_ATTEMPTS']),
          routerConfig.maxAttempts,
          ROUTER_DEFAULTS.maxAttempts,
        ),
        'maxAttempts',
      ),
      leaseMinutes: positiveInteger(
        choose(
          overrides.leaseMinutes,
          firstEnv(env, ['SELF_LOOP_LEASE_MINUTES', 'LOOP_LEASE_MINUTES']),
          routerConfig.leaseMinutes,
          ROUTER_DEFAULTS.leaseMinutes,
        ),
        'leaseMinutes',
      ),
      maxConcurrent: positiveInteger(
        choose(
          overrides.maxConcurrent,
          firstEnv(env, ['SELF_LOOP_MAX_CONCURRENT', 'LOOP_MAX_CONCURRENT']),
          routerConfig.maxConcurrent,
          ROUTER_DEFAULTS.maxConcurrent,
        ),
        'maxConcurrent',
      ),
      lockMinutes: positiveInteger(
        choose(
          overrides.lockMinutes,
          firstEnv(env, ['SELF_LOOP_LOCK_MINUTES', 'LOOP_LOCK_MINUTES']),
          routerConfig.lockMinutes,
          ROUTER_DEFAULTS.lockMinutes,
        ),
        'lockMinutes',
      ),
      llmAdvisory: booleanValue(
        choose(
          overrides.llmAdvisory,
          firstEnv(env, ['SELF_LOOP_LLM_ADVISORY', 'LOOP_LLM_ADVISORY']),
          routerConfig.llmAdvisory,
          ROUTER_DEFAULTS.llmAdvisory,
        ),
        'llmAdvisory',
      ),
      comments: booleanValue(
        choose(
          overrides.comments,
          firstEnv(env, ['SELF_LOOP_COMMENTS', 'LOOP_COMMENTS']),
          routerConfig.comments,
          ROUTER_DEFAULTS.comments,
        ),
        'comments',
      ),
      worktreeMode: String(
        choose(
          overrides.worktreeMode,
          firstEnv(env, ['SELF_LOOP_WORKTREE_MODE', 'LOOP_WORKTREE_MODE']),
          routerConfig.worktreeMode,
          executorConfig.worktreeMode,
          ROUTER_DEFAULTS.worktreeMode,
        ),
      ),
      worktreeDir: pathInRepo(
        repoRoot,
        choose(
          overrides.worktreeDir,
          firstEnv(env, ['SELF_LOOP_WORKTREE_DIR', 'LOOP_WORKTREE_DIR']),
          routerConfig.worktreeDir,
          ROUTER_DEFAULTS.worktreeDir,
        ),
        'worktreeDir',
      ),
      context: {
        routerChars: positiveInteger(
          choose(
            overrides.routerChars,
            firstEnv(env, ['SELF_LOOP_CONTEXT_ROUTER_CHARS', 'LOOP_CONTEXT_ROUTER_CHARS']),
            contextConfig.routerChars,
            ROUTER_DEFAULTS.routerChars,
          ),
          'routerChars',
        ),
        workerChars: positiveInteger(
          choose(
            overrides.workerChars,
            firstEnv(env, ['SELF_LOOP_CONTEXT_WORKER_CHARS', 'LOOP_CONTEXT_WORKER_CHARS']),
            contextConfig.workerChars,
            ROUTER_DEFAULTS.workerChars,
          ),
          'workerChars',
        ),
      },
    },
    executor: {
      command: overrides.executorCommand ?? executorConfig.command ?? env.SELF_LOOP_AGENT ?? env.LOOP_AGENT ?? '',
      args: stringArray(overrides.executorArgs ?? executorConfig.args),
    },
    verifier: {
      commands: stringArray(
        overrides.verifierCommands
          ?? verifierConfig.commands
          ?? env.SELF_LOOP_VERIFY_COMMANDS
          ?? [],
      ),
      timeoutMinutes: positiveInteger(
        choose(
          overrides.verifierTimeoutMinutes,
          firstEnv(env, ['SELF_LOOP_VERIFY_TIMEOUT_MINUTES', 'LOOP_VERIFY_TIMEOUT_MINUTES']),
          verifierConfig.timeoutMinutes,
          ROUTER_DEFAULTS.verifierTimeoutMinutes,
        ),
        'verifierTimeoutMinutes',
      ),
    },
  };
}

export function repoSlug(cwd = process.cwd()) {
  const url = run('git', ['-C', cwd, 'remote', 'get-url', 'origin']);
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  return match ? `${match[1]}/${match[2]}` : '';
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
      'User-Agent': 'self-loop',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status} ${method} ${path}`);
  return res.json();
}

export async function resolveSelfLogin(repo, token, env = process.env) {
  const configured = firstEnv(env, ['SELF_LOOP_SELF_LOGIN', 'LOOP_SELF_LOGIN']);
  if (configured) return configured;
  if (!token) return '';
  try {
    const user = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'self-loop',
      },
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
    const byBranch = branch.match(/(?:^|\/)(?:loop|self-loop)\/(\d+)-/i);
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
 * Policy is supplied by the caller, never hard-coded here.
 */
export function ineligibleReason(issue, options = {}) {
  const {
    policy = parsePolicy(),
    selfLogin = '',
    now = Date.now(),
    claimTtlMinutes = DEFAULTS.claimTtlMinutes,
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

export function isMain(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  return Boolean(argv1) && metaUrl === pathToFileURL(argv1).href;
}
