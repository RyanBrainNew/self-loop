import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ineligibleReason,
  labelNames,
  linkedPrNumbers,
  parseArgs,
  parsePolicy,
  pathInRepo,
  resolveRepo,
  resolveSettings,
  roleOf,
  selectCandidate,
} from './lib.mjs';
import { resolveWindow } from './retro.mjs';
import { initMemory } from './init-memory.mjs';
import { githubStatusReachable } from './precheck.mjs';
import { automationNamesForRepo, buildIssuePrompt } from '../adapters/orca/setup.mjs';
import {
  detectExecutor,
  detectGithubRepo,
  ensureGitignore,
  ensureLabels,
  mergeProjectConfig,
  setupProject,
} from './setup-project.mjs';
import {
  applyResultToTicket,
  buildContextPacket,
  buildIssueStatusComment,
  buildTaskCard,
  cleanTicketWorktree,
  createTicket,
  emptyState,
  executeDispatch,
  expireTicketIfNeeded,
  extractAcceptance,
  loadState,
  prepareDispatch,
  recoverTicket,
  tickRouter,
  validateResultEnvelope,
  verifyTicket,
  withStateLock,
  STATUS_MARKER,
} from './router.mjs';
import { discoverVerifierCommands, runVerifier } from './verifier.mjs';

const now = Date.parse('2026-11-13T08:00:00Z');
const scriptsDir = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function issue(overrides = {}) {
  return {
    number: 1,
    title: 'fixture',
    labels: [],
    assignees: [],
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    hasOpenPR: false,
    linkedPR: null,
    verdict: '',
    ...overrides,
  };
}

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'self-loop-test-'));
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'self-loop@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'self-loop test']);
  return dir;
}

function canonical(path) {
  return resolve(realpathSync.native(path));
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('SELF_LOOP_') || key.startsWith('LOOP_')) delete env[key];
  }
  return env;
}

test('Matt labels are the only taxonomy', () => {
  assert.deepEqual(labelNames([{ name: 'bug' }, 'ready-for-agent']), ['bug', 'ready-for-agent']);
  assert.equal(roleOf([{ name: 'bug' }, { name: 'ready-for-agent' }]), 'ready-for-agent');
  assert.equal(roleOf([{ name: 'bug' }]), 'unlabeled');
});

test('policy parsing stays explicit', () => {
  assert.deepEqual(parsePolicy(''), { raw: 'ready-for-agent', kind: 'label', label: 'ready-for-agent' });
  assert.deepEqual(parsePolicy('do'), { raw: 'do', kind: 'verdict' });
  assert.deepEqual(parsePolicy('label:good-first-issue'), {
    raw: 'label:good-first-issue',
    kind: 'label',
    label: 'good-first-issue',
  });
  assert.equal(parsePolicy('off').kind, 'off');
  assert.deepEqual(parsePolicy('needs-triage'), { raw: 'needs-triage', kind: 'label', label: 'needs-triage' });
});

test('flags are boolean properties, not a Set', () => {
  const parsed = parseArgs(['issue', '--dry-run', '--policy', 'do', '--no-claim']);
  assert.deepEqual(parsed.rest, ['issue']);
  assert.deepEqual(parsed.values, { policy: 'do' });
  assert.equal(parsed.flags['dry-run'], true);
  assert.equal(parsed.flags['no-claim'], true);
  assert.equal(parseArgs(['--prompt=a=b']).values.prompt, 'a=b');
});

test('default policy only takes ready-for-agent', () => {
  const policy = parsePolicy();
  assert.match(ineligibleReason(issue(), { policy, now }), /missing label ready-for-agent/);
  assert.equal(ineligibleReason(issue({ labels: ['ready-for-agent'] }), { policy, now }), '');
});

test('Matt blocking roles always win', () => {
  const policy = parsePolicy('do');
  for (const label of ['needs-info', 'ready-for-human', 'wontfix']) {
    assert.match(ineligibleReason(issue({ labels: [label], verdict: 'do' }), { policy, now }), /blocked by label/);
  }
  assert.match(ineligibleReason(issue({ labels: ['needs-triage'], verdict: 'do' }), { policy, now }), /needs triage/);
});

test('open PR and other assignees block; own stale claim can retry', () => {
  const policy = parsePolicy('ready-for-agent');
  const labels = ['ready-for-agent'];
  assert.match(
    ineligibleReason(issue({ labels, hasOpenPR: true, linkedPR: 12 }), { policy, now }),
    /open PR #12/,
  );
  assert.match(
    ineligibleReason(issue({ labels, assignees: ['someone-else'] }), { policy, selfLogin: 'bot', now }),
    /assigned to someone-else/,
  );
  assert.match(
    ineligibleReason(issue({ labels, assignees: ['bot'], updatedAt: '2026-11-13T07:00:00Z' }), {
      policy,
      selfLogin: 'bot',
      now,
      claimTtlMinutes: 180,
    }),
    /claimed recently/,
  );
  assert.equal(
    ineligibleReason(issue({ labels, assignees: ['bot'], updatedAt: '2026-11-12T00:00:00Z' }), {
      policy,
      selfLogin: 'bot',
      now,
      claimTtlMinutes: 180,
    }),
    '',
  );
});

test('do policy follows the advisory verdict but keeps labels authoritative', () => {
  const policy = parsePolicy('do');
  assert.equal(ineligibleReason(issue({ verdict: 'do' }), { policy, now }), '');
  assert.match(ineligibleReason(issue({ verdict: 'ignore' }), { policy, now }), /not do/);
  assert.match(
    ineligibleReason(issue({ verdict: 'do', labels: ['needs-info'] }), { policy, now }),
    /blocked by label needs-info/,
  );
});

test('selection is oldest-first and skips ineligible issues', () => {
  const policy = parsePolicy('ready-for-agent');
  const issues = [
    issue({ number: 3, labels: ['ready-for-agent'], createdAt: '2026-11-01T00:00:00Z' }),
    issue({ number: 2, labels: ['ready-for-agent'], createdAt: '2026-10-01T00:00:00Z', hasOpenPR: true, linkedPR: 9 }),
    issue({ number: 1, labels: ['ready-for-agent'], createdAt: '2026-10-20T00:00:00Z' }),
  ];
  assert.equal(selectCandidate(issues, { policy, now }).number, 1);
  assert.equal(selectCandidate([issues[1]], { policy, now }), null);
});

test('PR bodies map closing references to issue numbers', () => {
  const links = linkedPrNumbers([
    { number: 40, title: 'fix', body: 'Closes #12\nAlso fixes #13', head: { ref: 'loop/14-title' } },
    { number: 41, title: 'chore', body: 'no close keyword', head: { ref: 'self-loop/15-title' } },
  ]);
  assert.equal(links.get(12), 40);
  assert.equal(links.get(13), 40);
  assert.equal(links.get(14), 40);
  assert.equal(links.get(15), 41);
  assert.equal(links.size, 4);
});

test('--repo normalizes a subdirectory and wins over environment variables', () => {
  const repo = tempRepo();
  const nested = join(repo, 'packages', 'app');
  mkdirSync(nested, { recursive: true });
  assert.equal(resolveRepo({ repo: nested }, {}), canonical(repo));
  assert.equal(resolveRepo({}, { SELF_LOOP_REPO: nested }), canonical(repo));
  assert.equal(resolveRepo({}, { LOOP_REPO: repo }), canonical(repo));
  assert.equal(resolveRepo({ repo }, { SELF_LOOP_REPO: join(tmpdir(), 'somewhere-else') }), canonical(repo));
});

test('config, environment, and CLI resolve memory and output paths in order', () => {
  const repo = tempRepo();
  writeFileSync(
    join(repo, '.self-loop.json'),
    JSON.stringify({
      policy: 'do',
      claimTtlMinutes: 60,
      retroDays: 4,
      outDir: 'artifacts/loop',
      memory: {
        lessons: 'docs/memory/lessons.md',
        codeStandards: 'docs/memory/standards.md',
        decisions: 'docs/memory/decisions.md',
      },
      githubRepo: 'acme/project',
    }),
  );

  const configOnly = resolveSettings(repo, {}, {});
  assert.equal(configOnly.policy, 'do');
  assert.equal(configOnly.claimTtlMinutes, 60);
  assert.equal(configOnly.retroDays, 4);
  assert.equal(configOnly.githubRepo, 'acme/project');
  assert.equal(configOnly.outDir, join(repo, 'artifacts', 'loop'));
  assert.equal(configOnly.lessonsPath, join(repo, 'docs', 'memory', 'lessons.md'));
  assert.equal(configOnly.codeStandardsPath, join(repo, 'docs', 'memory', 'standards.md'));
  assert.equal(configOnly.decisionsPath, join(repo, 'docs', 'memory', 'decisions.md'));

  const envSettings = resolveSettings(
    repo,
    {},
    {
      SELF_LOOP_POLICY: 'label:queue',
      LOOP_CLAIM_TTL_MINUTES: '90',
      SELF_LOOP_OUT_DIR: 'env-out',
      LOOP_LESSONS_PATH: 'env/lessons.md',
    },
  );
  assert.equal(envSettings.policy, 'label:queue');
  assert.equal(envSettings.claimTtlMinutes, 90);
  assert.equal(envSettings.outDir, join(repo, 'env-out'));
  assert.equal(envSettings.lessonsPath, join(repo, 'env', 'lessons.md'));

  const cliSettings = resolveSettings(
    repo,
    { policy: 'off', claimTtlMinutes: 5, lessonsPath: 'cli/lessons.md' },
    { SELF_LOOP_POLICY: 'label:queue', LOOP_CLAIM_TTL_MINUTES: '90' },
  );
  assert.equal(cliSettings.policy, 'off');
  assert.equal(cliSettings.claimTtlMinutes, 5);
  assert.equal(cliSettings.lessonsPath, join(repo, 'cli', 'lessons.md'));
});

test('configured paths cannot escape the target repo', () => {
  const repo = tempRepo();
  assert.throws(() => pathInRepo(repo, '../outside.md', 'lessonsPath'), /must stay inside/);
  writeFileSync(join(repo, '.self-loop.json'), JSON.stringify({ outDir: '../outside' }));
  assert.throws(() => resolveSettings(repo, {}, {}), /outDir must stay inside/);
});

test('init-memory creates templates once and never overwrites edits', () => {
  const repo = tempRepo();
  writeFileSync(
    join(repo, '.self-loop.json'),
    JSON.stringify({
      memory: {
        lessons: 'docs/memory/LESSONS.md',
        codeStandards: 'docs/memory/code-standards.md',
        decisions: 'docs/memory/DECISIONS.md',
      },
    }),
  );
  const settings = resolveSettings(repo, {}, {});
  const first = initMemory({ repoRoot: repo, settings });
  assert.equal(first.created.length, 3);
  assert.deepEqual(first.skipped, []);
  assert.match(readFileSync(settings.lessonsPath, 'utf8'), /# Lessons/);
  assert.match(readFileSync(settings.codeStandardsPath, 'utf8'), /Merge Gates/);
  assert.match(readFileSync(settings.decisionsPath, 'utf8'), /# Decisions/);

  writeFileSync(settings.lessonsPath, '# Custom lessons\n');
  const second = initMemory({ repoRoot: repo, settings });
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped.length, 3);
  assert.equal(readFileSync(settings.lessonsPath, 'utf8'), '# Custom lessons\n');
});

test('init-memory CLI honours --repo from outside the target repository', () => {
  const repo = tempRepo();
  const nested = join(repo, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  execFileSync(process.execPath, [join(scriptsDir, 'init-memory.mjs'), '--repo', nested], {
    cwd: tmpdir(),
    env: cleanEnv(),
  });
  assert.ok(existsSync(join(repo, 'memory', 'LESSONS.md')));
  assert.ok(existsSync(join(repo, 'memory', 'code-standards.md')));
  assert.ok(existsSync(join(repo, 'memory', 'DECISIONS.md')));
});

test('setup detects GitHub and executor without requiring another config file', () => {
  const repo = tempRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:acme/project.git']);
  assert.equal(
    detectGithubRepo({
      repoRoot: repo,
      explicit: 'explicit/repo',
      env: { GITHUB_REPOSITORY: 'env/repo' },
    }),
    'explicit/repo',
  );
  assert.equal(
    detectGithubRepo({ repoRoot: repo, env: { GITHUB_REPOSITORY: 'env/repo' } }),
    'env/repo',
  );
  assert.equal(detectGithubRepo({ repoRoot: repo, env: {} }), 'acme/project');

  assert.equal(detectExecutor({ explicit: 'custom-agent --flag', env: {} }), 'custom-agent --flag');
  assert.equal(
    detectExecutor({ env: { SELF_LOOP_AGENT: 'env-agent --flag' }, hasCommand: () => false }),
    'env-agent --flag',
  );
  assert.deepEqual(
    detectExecutor({
      env: {},
      hasCommand: (name) => name === 'codex',
    }),
    ['codex', 'exec', '--full-auto'],
  );
  assert.deepEqual(
    detectExecutor({
      env: {},
      hasCommand: (name) => name === 'claude',
    }),
    ['claude', '-p'],
  );
  assert.equal(detectExecutor({ env: {}, hasCommand: () => false }), '');
});

test('setup config merge preserves user edits and only fills missing gates', () => {
  const existing = {
    githubRepo: 'old/repo',
    executor: { command: ['custom-agent'], extra: true },
    verifier: { commands: ['npm run existing'], timeoutMinutes: 12 },
    memory: { lessons: 'docs/memory/lessons.md' },
    unknown: { keep: true },
  };
  const merged = mergeProjectConfig({
    existing,
    githubRepo: 'new/repo',
    executor: ['codex', 'exec'],
    verifierCommands: ['npm test'],
    memoryDir: 'docs/memory',
  });
  assert.equal(merged.githubRepo, 'new/repo');
  assert.deepEqual(merged.executor.command, ['codex', 'exec']);
  assert.equal(merged.executor.extra, true);
  assert.deepEqual(merged.verifier.commands, ['npm run existing']);
  assert.equal(merged.verifier.timeoutMinutes, 12);
  assert.deepEqual(merged.unknown, { keep: true });
  assert.equal(merged.memory.lessons, 'docs/memory/LESSONS.md');
  assert.equal(merged.memory.codeStandards, 'docs/memory/code-standards.md');
  assert.equal(merged.memory.decisions, 'docs/memory/DECISIONS.md');
  assert.equal(existing.githubRepo, 'old/repo');
});

test('setup labels are best-effort, limited to the five roles, and idempotent', () => {
  const calls = [];
  const runner = (file, args) => {
    calls.push({ file, args });
    if (args[0] === 'label' && args[1] === 'list') {
      return JSON.stringify([{ name: 'needs-triage' }]);
    }
    return '';
  };
  const result = ensureLabels({ githubRepo: 'acme/project', runner });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.created, [
    'needs-info',
    'ready-for-agent',
    'ready-for-human',
    'wontfix',
  ]);
  const created = calls
    .filter(({ args }) => args[0] === 'label' && args[1] === 'create')
    .map(({ args }) => args[2]);
  assert.deepEqual(created, result.created);
  assert.ok(created.every((name) => [
    'needs-triage',
    'needs-info',
    'ready-for-agent',
    'ready-for-human',
    'wontfix',
  ].includes(name)));
});

test('setup gitignore adds the loop output once and honours custom output', () => {
  const repo = tempRepo();
  const first = ensureGitignore({ repoRoot: repo });
  assert.deepEqual(first.added, ['.loop/']);
  assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /^\.loop\/$/m);

  const second = ensureGitignore({ repoRoot: repo });
  assert.deepEqual(second.added, []);
  assert.equal(
    readFileSync(join(repo, '.gitignore'), 'utf8').match(/^\.loop\/$/gm).length,
    1,
  );

  const custom = ensureGitignore({ repoRoot: repo, entries: ['artifacts/loop/'] });
  assert.deepEqual(custom.added, ['artifacts/loop/']);
});

test('setupProject configures a project once without overwriting later edits', () => {
  const repo = tempRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/project.git']);
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }),
  );

  const first = setupProject({
    repoRoot: repo,
    executor: ['node', 'agent.mjs'],
    labels: false,
    env: {},
  });
  assert.equal(first.githubRepo, 'acme/project');
  assert.deepEqual(first.verifierCommands, ['npm test', 'npm run lint']);
  const config = JSON.parse(readFileSync(join(repo, '.self-loop.json'), 'utf8'));
  assert.deepEqual(config.executor.command, ['node', 'agent.mjs']);
  assert.deepEqual(config.verifier.commands, ['npm test', 'npm run lint']);
  assert.ok(existsSync(join(repo, 'memory', 'LESSONS.md')));
  assert.ok(existsSync(join(repo, 'memory', 'code-standards.md')));
  assert.ok(existsSync(join(repo, 'memory', 'DECISIONS.md')));
  assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /^\.loop\/$/m);

  writeFileSync(join(repo, 'memory', 'LESSONS.md'), '# Project lessons\n');
  const second = setupProject({
    repoRoot: repo,
    labels: false,
    env: { GITHUB_REPOSITORY: 'wrong/repo' },
    executorDetector: () => {
      throw new Error('existing executor must win');
    },
  });
  assert.equal(second.config.changed, false);
  assert.equal(second.githubRepo, 'acme/project');
  assert.deepEqual(second.executor, ['node', 'agent.mjs']);
  assert.equal(readFileSync(join(repo, 'memory', 'LESSONS.md'), 'utf8'), '# Project lessons\n');
});

test('setupProject dry-run reports work without writing project files', () => {
  const repo = tempRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/dry.git']);
  const result = setupProject({
    repoRoot: repo,
    executor: 'node agent.mjs',
    labels: false,
    dryRun: true,
    env: {},
  });
  assert.equal(result.config.changed, true);
  assert.equal(result.memory.created.length, 3);
  assert.equal(existsSync(join(repo, '.self-loop.json')), false);
  assert.equal(existsSync(join(repo, 'memory')), false);
  assert.equal(existsSync(join(repo, '.gitignore')), false);
});

test('setupProject warns instead of inventing an executor or verifier', () => {
  const repo = tempRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/bare.git']);
  const result = setupProject({
    repoRoot: repo,
    labels: false,
    env: {},
    executorDetector: () => '',
  });
  assert.match(result.warnings.join('\n'), /No executor detected/);
  assert.match(result.warnings.join('\n'), /No verifier commands discovered/);
  assert.equal(result.config.changed, true);
});

test('setup CLI works from outside the target and prints the next command', () => {
  const repo = tempRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/cli.git']);
  const nested = join(repo, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  const output = execFileSync(process.execPath, [
    join(scriptsDir, 'setup-project.mjs'),
    '--repo',
    nested,
    '--github',
    'acme/cli',
    '--executor',
    'node',
    '--no-labels',
  ], {
    cwd: tmpdir(),
    env: cleanEnv(),
    encoding: 'utf8',
  });
  assert.match(output, /next:/);
  assert.match(output, /router tick/);
  const config = JSON.parse(readFileSync(join(repo, '.self-loop.json'), 'utf8'));
  assert.equal(config.githubRepo, 'acme/cli');
  assert.equal(config.executor.command, 'node');
});

test('retro explicit window overrides lessons history and environment', () => {
  const repo = tempRepo();
  const window = resolveWindow({ since: 'abc123', repoRoot: repo, lessonsPath: join(repo, 'memory', 'LESSONS.md') });
  assert.equal(window.source, 'explicit');
  assert.equal(window.since, 'abc123');

  const previous = process.env.SELF_LOOP_RETRO_SINCE;
  process.env.SELF_LOOP_RETRO_SINCE = 'env456';
  try {
    const fromEnv = resolveWindow({ repoRoot: repo, lessonsPath: join(repo, 'memory', 'LESSONS.md') });
    assert.equal(fromEnv.source, 'explicit');
    assert.equal(fromEnv.since, 'env456');
    assert.equal(resolveWindow({ since: 'cli789', repoRoot: repo }).since, 'cli789');
  } finally {
    if (previous === undefined) delete process.env.SELF_LOOP_RETRO_SINCE;
    else process.env.SELF_LOOP_RETRO_SINCE = previous;
  }
});

test('retro defaults to the last commit that changed the lessons file', () => {
  const repo = tempRepo();
  const lessons = join(repo, 'memory', 'LESSONS.md');
  mkdirSync(join(repo, 'memory'), { recursive: true });
  writeFileSync(lessons, '# Lessons\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'add lessons']);
  const lessonsSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  writeFileSync(join(repo, 'work.txt'), 'change\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'later work']);

  const window = resolveWindow({ repoRoot: repo, lessonsPath: lessons, days: 2 });
  assert.equal(window.source, 'lessons');
  assert.equal(window.since, lessonsSha);
});

test('run.mjs retro resolves --repo and writes output inside the target', () => {
  const repo = tempRepo();
  const nested = join(repo, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);

  execFileSync(process.execPath, [join(scriptsDir, 'run.mjs'), 'retro', '--repo', nested, '--since', 'HEAD'], {
    cwd: tmpdir(),
    env: cleanEnv(),
  });
  const retro = readFileSync(join(repo, '.loop', 'retro.md'), 'utf8');
  assert.match(retro, /window: HEAD/);
});

test('core scripts contain no scheduler-specific references', () => {
  const files = readdirSync(scriptsDir).filter((name) => name.endsWith('.mjs') && name !== 'self-loop.test.mjs');
  for (const file of files) {
    const text = readFileSync(join(scriptsDir, file), 'utf8');
    assert.doesNotMatch(text, /\borca\b/i, `${file} must stay scheduler-agnostic`);
    assert.doesNotMatch(
      text,
      /(?<!\.)\bloop\/(?:run|triage|select|retro|lib|precheck|init-memory|scripts|references|templates)(?:\/|\b)/,
      `${file} must not assume a project-local loop/ directory`,
    );
  }
  assert.ok(existsSync(join(repoRoot, 'templates', 'memory', 'LESSONS.md')));
});

test('project setup is routed as an agent conversation', () => {
  const skill = readFileSync(join(repoRoot, 'SKILL.md'), 'utf8');
  const setup = readFileSync(join(repoRoot, 'references', 'SETUP.md'), 'utf8');
  assert.match(skill, /Configure a project through conversation/);
  assert.match(skill, /references\/SETUP\.md/);
  assert.match(setup, /prompt-driven setup method/i);
  assert.match(setup, /Do not make the user hand-write/i);
  assert.match(setup, /Ask only about real branches/);
  assert.match(setup, /Only the user's confirmation is required/);
});

test('setup-self-loop is an explicit, direct-invocation companion skill', () => {
  const skill = readFileSync(join(repoRoot, 'setup-self-loop', 'SKILL.md'), 'utf8');
  assert.match(skill, /^name:\s*setup-self-loop$/m);
  assert.match(skill, /^disable-model-invocation:\s*true$/m);
  assert.match(skill, /scripts\/setup-project\.mjs/);
  assert.match(skill, /invoked it, so consent/i);
  assert.match(skill, /Do not ask for confirmation/);
  assert.doesNotMatch(skill, /Proceed\?/);
  assert.match(skill, /--repo \. --json/);
});

test('Orca adapter prompts call the installed skill scripts, not loop/run.mjs', () => {
  const prompt = buildIssuePrompt({
    name: 'fixture',
    policy: 'ready-for-agent',
    repoPath: '/work/project',
    outDir: '/work/project/.loop',
  });
  assert.match(prompt, /scripts[\\/]run\.mjs/);
  assert.match(prompt, /\.loop[\\/]work\.json/);
  assert.match(prompt, /--repo \./);
  assert.doesNotMatch(prompt, /--repo "\/work\/project"/);
  assert.doesNotMatch(prompt, /node loop\/run\.mjs/);
});

test('Orca automation names are sanitized and repository-specific', () => {
  assert.deepEqual(automationNamesForRepo('/work/self-loop', 'RyanBrainNew/self-loop'), {
    issue: 'ryanbrainnew-self-loop-issue-loop',
    retro: 'ryanbrainnew-self-loop-retro-loop',
  });
  assert.deepEqual(automationNamesForRepo('/work/My Project', 'Acme/My Project'), {
    issue: 'acme-my-project-issue-loop',
    retro: 'acme-my-project-retro-loop',
  });
  const first = automationNamesForRepo('/work/a/app', 'acme/app');
  const second = automationNamesForRepo('/work/b/app', 'other/app');
  assert.notEqual(first.issue, second.issue);
  assert.match(first.issue, /^[a-z0-9._-]+$/);
});

test('GitHub precheck treats auth and rate-limit responses as reachable', () => {
  assert.equal(githubStatusReachable(200), true);
  assert.equal(githubStatusReachable(401), true);
  assert.equal(githubStatusReachable(403), true);
  assert.equal(githubStatusReachable(404), true);
  assert.equal(githubStatusReachable(500), false);
  assert.equal(githubStatusReachable(503), false);
  assert.equal(githubStatusReachable(0), false);
});

test('Task Card parses explicit acceptance and blocks on ambiguity', () => {
  const repo = tempRepo();
  const settings = resolveSettings(repo, {}, {});
  assert.deepEqual(
    extractAcceptance('## Acceptance criteria\n- [ ] redirect works\n- [x] regression test\n## Notes\n- not acceptance'),
    ['redirect works', 'regression test'],
  );
  const clear = buildTaskCard({
    ticket: { number: 1, title: 'fix', body: '## Acceptance\n- [ ] redirect works' },
    settings,
  });
  assert.equal(clear.blockedReason, null);
  assert.deepEqual(clear.acceptance, ['redirect works']);
  const ambiguous = buildTaskCard({
    ticket: { number: 2, title: 'unclear' },
    settings,
  });
  assert.match(ambiguous.blockedReason, /No concrete/);
  assert.equal(ambiguous.assumptions.length, 1);
});

test('Router settings resolve CLI, environment, config, and defaults in order', () => {
  const repo = tempRepo();
  writeFileSync(
    join(repo, '.self-loop.json'),
    JSON.stringify({
      router: {
        maxAttempts: 3,
        leaseMinutes: 20,
        context: { routerChars: 100, workerChars: 200 },
      },
      executor: { command: ['node', 'agent.mjs'] },
      verifier: { commands: ['node -e "process.exit(0)"'] },
    }),
  );
  const fromConfig = resolveSettings(repo, {}, {});
  assert.equal(fromConfig.router.maxAttempts, 3);
  assert.equal(fromConfig.router.leaseMinutes, 20);
  assert.equal(fromConfig.router.context.routerChars, 100);
  assert.deepEqual(fromConfig.executor.command, ['node', 'agent.mjs']);
  assert.deepEqual(fromConfig.verifier.commands, ['node -e "process.exit(0)"']);

  const fromEnv = resolveSettings(repo, {}, {
    SELF_LOOP_MAX_ATTEMPTS: '4',
    LOOP_LEASE_MINUTES: '15',
  });
  assert.equal(fromEnv.router.maxAttempts, 4);
  assert.equal(fromEnv.router.leaseMinutes, 15);
  const fromCli = resolveSettings(repo, { maxAttempts: 5 }, { SELF_LOOP_MAX_ATTEMPTS: '4' });
  assert.equal(fromCli.router.maxAttempts, 5);
});

test('configured executors receive the installed WORK.md reference', () => {
  const repo = tempRepo();
  const prepared = {
    blocked: false,
    worktree: repo,
    taskCard: {},
    paths: {},
  };
  const arraySettings = resolveSettings(repo, {
    worktreeMode: 'external',
    executorCommand: ['codex', 'exec', '--full-auto'],
  }, {});
  const fromArray = executeDispatch({
    repoRoot: repo,
    settings: arraySettings,
    state: {},
    ticket: { number: 1 },
    prepared,
    dryRun: true,
  });
  assert.equal(fromArray.invocation.shell, false);
  assert.deepEqual(fromArray.invocation.args, [
    'exec',
    '--full-auto',
    join(repoRoot, 'references', 'WORK.md'),
  ]);

  const stringSettings = resolveSettings(repo, {
    worktreeMode: 'external',
    executorCommand: 'codex exec --full-auto',
  }, {});
  const fromString = executeDispatch({
    repoRoot: repo,
    settings: stringSettings,
    state: {},
    ticket: { number: 1 },
    prepared,
    dryRun: true,
  });
  assert.equal(fromString.invocation.shell, true);
  assert.equal(fromString.invocation.args.at(-1), join(repoRoot, 'references', 'WORK.md'));
});

test('Context Packet projects roles and truncates memory', () => {
  const repo = tempRepo();
  mkdirSync(join(repo, 'memory'), { recursive: true });
  writeFileSync(join(repo, 'memory', 'LESSONS.md'), 'x'.repeat(500));
  const settings = resolveSettings(repo, { routerChars: 80, workerChars: 200 }, {});
  const ticket = createTicket({ number: 5, title: 'context' }, settings);
  const card = { ticket: 5, goal: 'context', acceptance: ['works'] };
  const routerPacket = buildContextPacket({ repoRoot: repo, settings, ticket, taskCard: card, role: 'router' });
  const workerPacket = buildContextPacket({ repoRoot: repo, settings, ticket, taskCard: card, role: 'worker' });
  assert.equal(routerPacket.taskCard, undefined);
  assert.deepEqual(workerPacket.taskCard, card);
  assert.equal(routerPacket.memory.lessons.truncated, true);
  assert.match(routerPacket.memory.lessons.excerpt, /context truncated/);
});

test('Result Envelope validates states and lease retry transitions', () => {
  const repo = tempRepo();
  const settings = resolveSettings(repo, { worktreeMode: 'external' }, {});
  const ticket = createTicket({ number: 6, title: 'retry', body: '## Acceptance\n- [ ] works' }, settings);
  ticket.worktree = repo;
  const state = emptyState(settings);
  state.tickets['6'] = ticket;
  state.activeTicket = 6;
  const prepared = prepareDispatch({ repoRoot: repo, settings, state, ticket });
  assert.equal(prepared.blocked, false);
  assert.equal(ticket.state, 'working');
  assert.equal(ticket.attempts, 1);
  assert.ok(ticket.lease.expiresAt);

  const failed = {
    ticket: 6,
    attempt: 1,
    state: 'failed',
    humanText: 'failed',
    artifactRefs: [],
  };
  assert.equal(validateResultEnvelope(failed).state, 'failed');
  applyResultToTicket(ticket, validateResultEnvelope(failed));
  assert.equal(ticket.state, 'queued');
  const second = prepareDispatch({ repoRoot: repo, settings, state, ticket });
  assert.equal(second.blocked, false);
  assert.equal(ticket.attempts, 2);
  applyResultToTicket(ticket, validateResultEnvelope({ ...failed, attempt: 2 }));
  assert.equal(ticket.state, 'blocked');
  recoverTicket({ settings, state, ticket });
  assert.equal(ticket.state, 'queued');
  assert.equal(ticket.manualRecoveries, 1);
  assert.throws(() => validateResultEnvelope({ ...failed, state: 'unknown' }), /invalid result.state/);
});

test('Router status comments are stable, idempotent, and human-readable', () => {
  const body = buildIssueStatusComment({
    number: 42,
    title: 'fix redirect',
    state: 'blocked',
    attempts: 2,
    maxAttempts: 2,
    branch: 'loop/42-fix-redirect',
    pr: 123,
    humanQuestion: 'Which redirect should expired sessions use?',
  });
  assert.match(body, new RegExp(STATUS_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(body, /status: `blocked`/);
  assert.match(body, /Attempt: 2\/2/);
  assert.match(body, /Pull request: #123/);
  assert.match(body, /Which redirect/);
  assert.match(body, /a person still decides whether to merge/);
});

test('Router tick creates a Ticket but does not consume an Attempt without an executor', async () => {
  const repo = tempRepo();
  const settings = resolveSettings(repo, { worktreeMode: 'external' }, {});
  const result = await tickRouter({
    repoRoot: repo,
    settings,
    candidate: {
      number: 7,
      title: 'tick',
      body: '## Acceptance\n- [ ] works',
      labels: ['ready-for-agent'],
    },
  });
  assert.equal(result.status, 'executor-not-configured');
  const state = loadState(settings);
  assert.equal(state.tickets['7'].state, 'queued');
  assert.equal(state.tickets['7'].attempts, 0);
});

test('Router tick dry-run previews without creating a Ticket or Attempt', async () => {
  const repo = tempRepo();
  const settings = resolveSettings(repo, { worktreeMode: 'external' }, {});
  const result = await tickRouter({
    repoRoot: repo,
    settings,
    dryRun: true,
    candidate: {
      number: 71,
      title: 'preview',
      body: '## Acceptance\n- [ ] works',
      labels: ['ready-for-agent'],
    },
  });
  assert.equal(result.status, 'dry-run');
  assert.equal(result.taskCard.acceptance.length, 1);
  const state = loadState(settings);
  assert.deepEqual(state.tickets, {});
  assert.equal(state.activeTicket, null);
});

test('Verifier runs in a clean worktree and returns objective evidence', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  const settings = resolveSettings(repo, {
    verifierCommands: ['node -e "process.exit(0)"'],
  }, {});
  const ticket = { number: 8, attempts: 1, branch: 'HEAD' };
  const passed = runVerifier({ repoRoot: repo, settings, ticket });
  assert.equal(passed.status, 'pass');
  assert.ok(existsSync(passed.evidencePath));
  assert.equal(discoverVerifierCommands({ repoRoot: repo, settings }).length, 1);
  const kept = runVerifier({ repoRoot: repo, settings, ticket, keep: true });
  assert.ok(existsSync(kept.worktree));
  const keptAgain = runVerifier({ repoRoot: repo, settings, ticket, keep: true });
  assert.equal(keptAgain.status, 'pass');
  assert.ok(existsSync(keptAgain.worktree));
  execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', keptAgain.worktree]);

  const failedSettings = resolveSettings(repo, {
    verifierCommands: ['node -e "process.exit(3)"'],
  }, {});
  const failed = runVerifier({
    repoRoot: repo,
    settings: failedSettings,
    ticket: { ...ticket, number: 9 },
  });
  assert.equal(failed.status, 'fail');
});

test('Task Card without concrete acceptance blocks before dispatch', async () => {
  const repo = tempRepo();
  const settings = resolveSettings(repo, { worktreeMode: 'external' }, {});
  const result = await tickRouter({
    repoRoot: repo,
    settings,
    candidate: { number: 10, title: 'unclear', labels: ['ready-for-agent'] },
  });
  assert.equal(result.status, 'blocked');
  const state = loadState(settings);
  assert.equal(state.tickets['10'].state, 'blocked');
  assert.equal(state.tickets['10'].attempts, 0);
  assert.match(state.tickets['10'].humanQuestion, /acceptance criteria/i);
});

test('expired lease requeues below budget and blocks at the budget', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  const settings = resolveSettings(repo, { worktreeMode: 'external', maxAttempts: 2 }, {});
  const state = emptyState(settings);

  const retry = createTicket({ number: 11, title: 'retry', body: '## Acceptance\n- [ ] works' }, settings);
  retry.state = 'working';
  retry.attempts = 1;
  retry.lease = { expiresAt: new Date(Date.now() - 60_000).toISOString() };
  state.tickets['11'] = retry;
  state.activeTicket = 11;
  const requeued = expireTicketIfNeeded({ repoRoot: repo, settings, state, ticket: retry });
  assert.equal(requeued.effect, 'requeued');
  assert.equal(retry.state, 'queued');
  assert.equal(retry.attempts, 1);
  assert.equal(retry.lease, null);

  const maxed = createTicket({ number: 12, title: 'maxed', body: '## Acceptance\n- [ ] works' }, settings);
  maxed.state = 'working';
  maxed.attempts = 2;
  maxed.lease = { expiresAt: new Date(Date.now() - 60_000).toISOString() };
  state.tickets['12'] = maxed;
  const blocked = expireTicketIfNeeded({ repoRoot: repo, settings, state, ticket: maxed });
  assert.equal(blocked.effect, 'blocked');
  assert.equal(maxed.state, 'blocked');
  assert.match(maxed.humanQuestion, /attempt budget exhausted/);
  assert.match(maxed.humanQuestion, /router recover/);
});

test('expired lease blocks when the branch already contains work', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  const base = execFileSync('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'checkout', '-q', '-b', 'loop/13-work']);
  writeFileSync(join(repo, 'work.txt'), 'partial work\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'partial']);
  execFileSync('git', ['-C', repo, 'checkout', '-q', base]);

  const settings = resolveSettings(repo, { worktreeMode: 'external', maxAttempts: 3 }, {});
  const state = emptyState(settings);
  const ticket = createTicket({ number: 13, title: 'partial', body: '## Acceptance\n- [ ] works' }, settings);
  ticket.state = 'working';
  ticket.attempts = 1;
  ticket.branch = 'loop/13-work';
  ticket.lease = { expiresAt: new Date(Date.now() - 60_000).toISOString() };
  state.tickets['13'] = ticket;
  const result = expireTicketIfNeeded({ repoRoot: repo, settings, state, ticket });
  assert.equal(result.effect, 'blocked');
  assert.match(ticket.humanQuestion, /already contains commits/);
});

test('verifyTicket promotes a pass and retries or blocks a failure', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);

  const passing = resolveSettings(repo, {
    verifierCommands: ['node -e "process.exit(0)"'],
  }, {});
  const passState = emptyState(passing);
  const passTicket = createTicket({ number: 14, title: 'pass' }, passing);
  passTicket.state = 'verifying';
  passTicket.attempts = 1;
  passTicket.branch = 'HEAD';
  passState.tickets['14'] = passTicket;
  const passed = verifyTicket({ repoRoot: repo, settings: passing, state: passState, ticket: passTicket });
  assert.equal(passed.status, 'pass');
  assert.equal(passTicket.state, 'awaiting_review');

  const failing = resolveSettings(repo, {
    verifierCommands: ['node -e "process.exit(3)"'],
  }, {});
  const failState = emptyState(failing);
  const retryTicket = createTicket({ number: 15, title: 'retry' }, failing);
  retryTicket.state = 'verifying';
  retryTicket.attempts = 1;
  retryTicket.branch = 'HEAD';
  failState.tickets['15'] = retryTicket;
  const failed = verifyTicket({ repoRoot: repo, settings: failing, state: failState, ticket: retryTicket });
  assert.equal(failed.status, 'fail');
  assert.equal(retryTicket.state, 'queued');

  retryTicket.state = 'verifying';
  retryTicket.attempts = 2;
  const blocked = verifyTicket({ repoRoot: repo, settings: failing, state: failState, ticket: retryTicket });
  assert.equal(blocked.status, 'fail');
  assert.equal(retryTicket.state, 'blocked');
  assert.match(retryTicket.humanQuestion, /Retry budget exhausted/);
});

test('router clean removes a terminal Ticket worktree', () => {
  const repo = tempRepo();
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'initial']);
  const settings = resolveSettings(repo, {}, {});
  const state = emptyState(settings);
  const worktree = join(settings.router.worktreeDir, '16');
  mkdirSync(join(worktree, '..'), { recursive: true });
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'loop/16-clean', worktree, 'HEAD']);

  const ticket = createTicket({ number: 16, title: 'clean' }, settings);
  ticket.state = 'done';
  ticket.worktree = worktree;
  state.tickets['16'] = ticket;
  assert.equal(cleanTicketWorktree({ repoRoot: repo, settings, ticket }), true);
  assert.equal(existsSync(worktree), false);
  assert.equal(ticket.worktree, null);
  assert.doesNotMatch(
    execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }),
    /loop[/\\]16-clean/,
  );
  rmSync(settings.outDir, { recursive: true, force: true });
});

test('router state lock refuses an active lock and clears a stale one', async () => {
  const repo = tempRepo();
  const settings = resolveSettings(repo, { lockMinutes: 1 }, {});
  mkdirSync(settings.outDir, { recursive: true });
  writeFileSync(join(settings.outDir, 'lock'), '{"pid":1}\n');
  await assert.rejects(
    () => withStateLock(settings, async () => 'unreachable'),
    /router lock is held/,
  );

  const old = new Date(Date.now() - 2 * 60 * 1000);
  utimesSync(join(settings.outDir, 'lock'), old, old);
  const value = await withStateLock(settings, async () => 'acquired');
  assert.equal(value, 'acquired');
  assert.equal(existsSync(join(settings.outDir, 'lock')), false);
});

test('router status runs through run.mjs with --repo from outside the target', () => {
  const repo = tempRepo();
  const nested = join(repo, 'src', 'nested');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(repo, '.self-loop.json'), JSON.stringify({ githubRepo: 'acme/project' }));
  const env = cleanEnv();
  delete env.GITHUB_REPOSITORY;
  const output = execFileSync(process.execPath, [
    join(scriptsDir, 'run.mjs'),
    'router',
    'status',
    '--repo',
    nested,
    '--json',
  ], {
    cwd: tmpdir(),
    env,
    encoding: 'utf8',
  });
  const state = JSON.parse(output);
  assert.equal(state.repo, 'acme/project');
  assert.equal(state.activeTicket, null);
  assert.deepEqual(state.tickets, {});
});

test('a copied skill root runs against a separate target repo', () => {
  const skill = mkdtempSync(join(tmpdir(), 'self-loop-skill-'));
  for (const item of ['SKILL.md', 'package.json', 'scripts', 'references', 'templates']) {
    cpSync(join(repoRoot, item), join(skill, item), { recursive: true });
  }
  const target = tempRepo();
  writeFileSync(join(target, 'README.md'), '# fixture\n');
  execFileSync('git', ['-C', target, 'add', '.']);
  execFileSync('git', ['-C', target, 'commit', '-q', '-m', 'initial']);

  assert.ok(existsSync(join(skill, 'SKILL.md')));
  assert.match(readFileSync(join(skill, 'SKILL.md'), 'utf8'), /^name:\s*self-loop$/m);
  assert.ok(existsSync(join(skill, 'scripts', 'setup-project.mjs')));
  execFileSync(process.execPath, [
    join(skill, 'scripts', 'setup-project.mjs'),
    '--repo',
    target,
    '--github',
    'acme/target',
    '--executor',
    'node',
    '--no-labels',
  ], {
    cwd: tmpdir(),
    env: cleanEnv(),
  });
  assert.ok(existsSync(join(target, '.self-loop.json')));
  assert.ok(existsSync(join(target, 'memory', 'LESSONS.md')));
  assert.ok(existsSync(join(target, 'memory', 'code-standards.md')));
  assert.ok(existsSync(join(target, 'memory', 'DECISIONS.md')));

  execFileSync(process.execPath, [
    join(skill, 'scripts', 'run.mjs'),
    'retro',
    '--repo',
    target,
    '--since',
    'HEAD',
  ], {
    cwd: tmpdir(),
    env: cleanEnv(),
  });
  assert.ok(existsSync(join(target, '.loop', 'retro.md')));
  assert.equal(existsSync(join(skill, '.loop')), false);
});
