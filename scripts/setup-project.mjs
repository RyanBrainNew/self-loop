// One-time project setup for self-loop.
// It detects what it can, writes a minimal config, and never overwrites memory.
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FILE,
  isMain,
  loadConfig,
  parseArgs,
  repoRelativePath,
  repoSlug,
  resolveRepo,
  resolveSettings,
} from './lib.mjs';
import { normalizeLanguage } from './copy.mjs';
import { initMemory } from './init-memory.mjs';
import { discoverVerifierCommands } from './verifier.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));

export const LABELS = Object.freeze([
  { name: 'needs-triage', color: 'fbca04', description: 'Maintainer needs to evaluate this issue' },
  { name: 'needs-info', color: 'd876e3', description: 'Waiting on the reporter for more information' },
  { name: 'ready-for-agent', color: '0e8a16', description: 'Fully specified and ready for an agent' },
  { name: 'ready-for-human', color: '1d76db', description: 'Requires a human implementation decision' },
  { name: 'wontfix', color: 'b60205', description: 'Will not be actioned' },
]);

function runCommand(file, args, options = {}) {
  return execFileSync(file, args, options);
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function memoryPaths(memoryDir) {
  const base = String(memoryDir).replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    lessons: `${base}/LESSONS.md`,
    codeStandards: `${base}/code-standards.md`,
    decisions: `${base}/DECISIONS.md`,
  };
}

export function detectGithubRepo({ repoRoot, explicit, env = process.env } = {}) {
  return String(explicit || env.GITHUB_REPOSITORY || repoSlug(repoRoot) || '').trim();
}

/**
 * Choose the language for person-facing artifacts. Explicit config and
 * environment win; otherwise inspect the project's own docs. Chinese is the
 * default because the loop's primary authoring language is Chinese.
 */
export function detectLanguage({
  repoRoot,
  explicit,
  config = loadConfig(repoRoot),
  env = process.env,
} = {}) {
  if (explicit) return normalizeLanguage(explicit);
  const fromEnv = env.SELF_LOOP_LANGUAGE || env.LOOP_LANGUAGE;
  if (fromEnv) return normalizeLanguage(fromEnv);
  if (config.language) return normalizeLanguage(config.language);
  const files = ['README.md', 'AGENTS.md', 'GLOSSARY.md', 'docs/DESIGN.md'];
  const text = files
    .map((file) => (existsSync(join(repoRoot, file)) ? readFileSync(join(repoRoot, file), 'utf8') : ''))
    .join('\n');
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk > 40 && cjk >= latin * 0.2) return 'zh-CN';
  if (latin > 0 && cjk === 0) return 'en';
  return 'zh-CN';
}

export function detectExecutor({
  explicit,
  env = process.env,
  hasCommand = (name) => {
    const probe = process.platform === 'win32' ? 'where' : 'which';
    try {
      runCommand(probe, [name], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
} = {}) {
  if (explicit) return explicit;
  const fromEnv = env.SELF_LOOP_AGENT || env.LOOP_AGENT;
  if (fromEnv) return fromEnv;
  if (hasCommand('codex')) return ['codex', 'exec', '-s', 'workspace-write'];
  if (hasCommand('claude')) return ['claude', '-p'];
  return '';
}

/**
 * Merge into an existing config. Unknown keys and user edits stay intact.
 */
export function mergeProjectConfig({
  existing = {},
  githubRepo,
  executor,
  verifierCommands = [],
  memoryDir,
  language,
} = {}) {
  const config = JSON.parse(JSON.stringify(existing));
  if (githubRepo) config.githubRepo = githubRepo;
  if (executor) {
    const currentExecutor = config.executor && typeof config.executor === 'object' && !Array.isArray(config.executor)
      ? config.executor
      : {};
    config.executor = { ...currentExecutor, command: executor };
  }
  if (verifierCommands.length > 0 && !(config.verifier?.commands?.length)) {
    config.verifier = { ...(config.verifier || {}), commands: verifierCommands };
  }
  if (memoryDir) {
    config.memory = { ...(config.memory || {}), ...memoryPaths(memoryDir) };
  }
  if (language) config.language = language;
  return config;
}

export function ensureGitignore({
  repoRoot,
  entries = ['.loop/'],
  dryRun = false,
} = {}) {
  const file = join(repoRoot, '.gitignore');
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const missing = entries.filter((entry) => {
    const normalized = entry.replace(/\/+$/, '');
    return !lines.some((line) => line.replace(/\/+$/, '') === normalized);
  });
  if (missing.length > 0 && !dryRun) {
    const prefix = text ? (text.endsWith('\n') ? '' : '\n') : '';
    appendFileSync(file, `${prefix}# self-loop\n${missing.join('\n')}\n`);
  }
  return { file, added: missing };
}

/**
 * Create only the five role labels, never a sixth progress label.
 * Label setup is best-effort: local config remains useful without `gh`.
 */
export function ensureLabels({
  githubRepo,
  dryRun = false,
  runner = runCommand,
} = {}) {
  if (!githubRepo) return { status: 'skipped', created: [], missing: [] };
  if (dryRun) return { status: 'dry-run', created: [], missing: LABELS.map((label) => label.name) };
  try {
    const raw = runner('gh', [
      'label', 'list',
      '--repo', githubRepo,
      '--json', 'name',
      '--limit', '200',
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const existing = new Set(JSON.parse(raw || '[]').map((label) => label.name));
    const missing = LABELS.filter((label) => !existing.has(label.name));
    for (const label of missing) {
      runner('gh', [
        'label', 'create', label.name,
        '--repo', githubRepo,
        '--color', label.color,
        '--description', label.description,
      ], { stdio: ['ignore', 'ignore', 'pipe'] });
    }
    return {
      status: 'ok',
      created: missing.map((label) => label.name),
      missing: [],
    };
  } catch (error) {
    return {
      status: 'unavailable',
      created: [],
      missing: LABELS.map((label) => label.name),
      error: error.message,
    };
  }
}

export function setupProject({
  repoRoot,
  githubRepo,
  executor,
  memoryDir,
  verifierCommands,
  language,
  labels = true,
  dryRun = false,
  env = process.env,
  executorDetector = detectExecutor,
  labelRunner = runCommand,
} = {}) {
  const existing = loadConfig(repoRoot);
  const resolvedGithub = String(
    githubRepo
      || existing.githubRepo
      || detectGithubRepo({ repoRoot, env })
      || '',
  ).trim();
  if (!resolvedGithub) {
    throw new Error('cannot detect GitHub repo: pass --github owner/name or add a GitHub origin remote');
  }
  const resolvedExecutor = executor ?? existing.executor?.command ?? executorDetector({ env });
  const resolvedLanguage = detectLanguage({
    repoRoot,
    explicit: language,
    config: existing,
    env,
  });
  const existingVerifier = Array.isArray(existing.verifier?.commands)
    ? existing.verifier.commands
    : typeof existing.verifier?.commands === 'string' && existing.verifier.commands.trim()
      ? [existing.verifier.commands.trim()]
      : [];
  const discovered = verifierCommands?.length
    ? verifierCommands
    : existingVerifier.length
      ? existingVerifier
      : discoverVerifierCommands({
          repoRoot,
          settings: { verifier: { commands: [] } },
        });
  const memoryOverrides = memoryDir ? memoryPaths(memoryDir) : {};
  const settings = resolveSettings(repoRoot, {
    lessonsPath: memoryOverrides.lessons,
    codeStandardsPath: memoryOverrides.codeStandards,
    decisionsPath: memoryOverrides.decisions,
  });
  const config = mergeProjectConfig({
    existing,
    githubRepo: resolvedGithub,
    executor: resolvedExecutor,
    verifierCommands: discovered,
    memoryDir,
    language: resolvedLanguage,
  });
  const configPath = join(repoRoot, CONFIG_FILE);
  const configChanged = JSON.stringify(existing) !== JSON.stringify(config);
  if (configChanged && !dryRun) writeJsonAtomic(configPath, config);

  const memory = initMemory({ repoRoot, settings, dryRun });
  const outEntry = `${repoRelativePath(repoRoot, settings.outDir).replace(/\/+$/, '')}/`;
  const gitignore = ensureGitignore({
    repoRoot,
    entries: [outEntry === '/' ? '.loop/' : outEntry],
    dryRun,
  });
  const labelResult = labels
    ? ensureLabels({ githubRepo: resolvedGithub, dryRun, runner: labelRunner })
    : { status: 'disabled', created: [], missing: [] };
  const warnings = [];
  if (!resolvedExecutor) {
    warnings.push('No executor detected. Pass --executor "<command>" or set SELF_LOOP_AGENT.');
  }
  if (discovered.length === 0) {
    warnings.push('No verifier commands discovered. Add verifier.commands in .self-loop.json.');
  }
  if (labelResult.status === 'unavailable') {
    warnings.push(`Labels not created: ${labelResult.error}`);
  }

  return {
    repoRoot,
    githubRepo: resolvedGithub,
    executor: resolvedExecutor,
    language: resolvedLanguage,
    verifierCommands: discovered,
    config: {
      path: configPath,
      relativePath: repoRelativePath(repoRoot, configPath),
      changed: configChanged,
      value: config,
    },
    memory,
    gitignore: {
      relativePath: repoRelativePath(repoRoot, gitignore.file),
      added: gitignore.added,
    },
    labels: labelResult,
    warnings,
    dryRun,
    next: [
      `node "${join(scriptDir, 'run.mjs')}" router tick --repo "${repoRoot}" --dry-run`,
      `node "${join(scriptDir, 'run.mjs')}" router tick --repo "${repoRoot}"`,
    ],
  };
}

function printHuman(result) {
  console.log(`[setup] repo: ${result.repoRoot}`);
  console.log(`[setup] github: ${result.githubRepo}`);
  console.log(`[setup] config: ${result.config.changed ? (result.dryRun ? 'would update' : 'updated') : 'unchanged'} ${result.config.relativePath}`);
  console.log(`[setup] language: ${result.language}`);
  console.log(`[setup] executor: ${result.executor ? JSON.stringify(result.executor) : '(not detected)'}`);
  console.log(`[setup] verifier: ${result.verifierCommands.join(' ; ') || '(not discovered)'}`);
  for (const file of result.memory.created) {
    console.log(`[setup] ${result.dryRun ? 'would create' : 'created'} ${repoRelativePath(result.repoRoot, file)}`);
  }
  for (const file of result.memory.skipped) {
    console.log(`[setup] kept existing ${repoRelativePath(result.repoRoot, file)}`);
  }
  if (result.gitignore.added.length > 0) {
    console.log(`[setup] ${result.dryRun ? 'would add' : 'added'} to .gitignore: ${result.gitignore.added.join(', ')}`);
  }
  console.log(`[setup] labels: ${result.labels.status}${result.labels.created.length ? ` (${result.labels.created.join(', ')})` : ''}`);
  for (const warning of result.warnings) console.log(`[setup] warning: ${warning}`);
  console.log('[setup] next:');
  for (const command of result.next) console.log(`  ${command}`);
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepo({ repo: values.repo });
  const result = setupProject({
    repoRoot,
    githubRepo: values.github,
    executor: values.executor,
    memoryDir: values['memory-dir'] || values.dir,
    verifierCommands: values.verify ? [values.verify] : undefined,
    language: values.language,
    labels: !flags['no-labels'],
    dryRun: Boolean(flags['dry-run']),
  });
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[setup] ${error.message}`);
    process.exit(2);
  }
}
