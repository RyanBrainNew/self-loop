import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
    assert.doesNotMatch(text, /\bloop\//, `${file} must not assume a project-local loop/ directory`);
  }
  assert.ok(existsSync(join(repoRoot, 'templates', 'memory', 'LESSONS.md')));
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
