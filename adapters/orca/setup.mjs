// Optional Orca adapter: create issue-loop and retro-loop automations for a repo.
// The generated prompts call the installed skill's scripts, not a project-local
// loop/ directory.
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain, parseArgs, repoSlug, resolveRepo, resolveSettings } from '../../scripts/lib.mjs';

const LEGACY_ISSUE_NAME = 'issue-loop';
const LEGACY_RETRO_NAME = 'retro-loop';
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function displayPath(path) {
  return path.replace(/\\/g, '/');
}

function quote(value) {
  return `"${displayPath(value).replace(/"/g, '\\"')}"`;
}

/**
 * Build repository-specific automation names. Using owner and repository keeps
 * two projects with the same leaf name from colliding in one Orca instance.
 */
export function automationNamesForRepo(repoPath, slug = repoSlug(repoPath)) {
  const identity = String(slug || basename(repoPath) || 'repo');
  const parts = identity.split('/').filter(Boolean);
  const leaf = parts.length > 1 ? parts.slice(-2).join('-') : parts[0];
  const base = leaf
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '') || 'repo';
  return {
    issue: `${base}-issue-loop`,
    retro: `${base}-retro-loop`,
  };
}

export function buildIssuePrompt({
  name,
  policy,
  repoPath,
  outDir = join(repoPath, '.loop'),
  language = 'zh-CN',
}) {
  const runScript = join(skillRoot, 'scripts', 'run.mjs');
  const loopReference = join(skillRoot, 'references', 'LOOP.md');
  const workReference = join(skillRoot, 'references', 'WORK.md');
  const outRelative = relative(repoPath, outDir).split(sep).join('/') || '.';
  const languageLine = language === 'zh-CN'
    ? 'PR 标题和正文必须使用简体中文；代码、命令、路径、标识符和日志原文保持原样。'
    : 'Write the PR title and body in English; keep code, commands, paths, identifiers, and verbatim logs unchanged.';
  return [
    `这是 ${name} 的 issue loop。以下命令在 Orca 启动的当前仓库 worktree 中执行:`,
    `1. node ${quote(runScript)} triage --repo .`,
    `2. node ${quote(runScript)} select --repo . --policy ${policy}`,
    '若 select 退出码为 3,直接结束,不要改代码。',
    `否则读 ${quote(`${outRelative}/work.json`)},按 ${quote(loopReference)} 与 ${quote(workReference)} 实现这个 issue:`,
    '分支 -> 门禁 -> PR(第一行 Closes #N)。绝不合并,绝不 push 默认分支。',
    languageLine,
  ].join('\n');
}

export function buildRetroPrompt({ name, repoPath, language = 'zh-CN' }) {
  const runScript = join(skillRoot, 'scripts', 'run.mjs');
  const retroReference = join(skillRoot, 'references', 'RETRO.md');
  const languageLine = language === 'zh-CN'
    ? 'PR 标题和正文必须使用简体中文；代码、命令、路径和日志原文保持原样。'
    : 'Write the PR title and body in English; keep code, commands, paths, and verbatim logs unchanged.';
  return [
    `这是 ${name} 的每日复盘 loop。以下命令在 Orca 启动的当前仓库 worktree 中执行:`,
    `node ${quote(runScript)} retro --repo .`,
    `然后按 ${quote(retroReference)} 更新项目记忆文件(默认 memory/LESSONS.md)。`,
    '用分支 + PR 交付(chore(self-loop): retro YYYY-MM-DD)。',
    '没有值得记的教训就说明检查范围并结束,不要硬凑。绝不合并。',
    languageLine,
  ].join('\n');
}

function orca(args, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`[dry-run] orca ${args.map((arg) => JSON.stringify(arg)).join(' ')}`);
    return null;
  }
  const text = execFileSync('orca', args, { encoding: 'utf8' });
  return text ? JSON.parse(text) : null;
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function findRepo(repoPath) {
  const listing = orca(['repo', 'list', '--json']);
  const repos = listing?.result?.repos || [];
  const target = normalizePath(repoPath);
  return repos.find((repo) => normalizePath(repo.path) === target) || null;
}

function listAutomations() {
  const listing = orca(['automations', 'list', '--json']);
  return new Map((listing?.result?.automations || []).map((automation) => [automation.name, automation]));
}

function createOrEdit({ existing, name, trigger, prompt, provider, repo, timezone, disabled, dryRun }) {
  const verb = existing ? 'edit' : 'create';
  const args = existing ? ['automations', 'edit', existing.id] : ['automations', 'create'];
  args.push('--name', name);
  if (!existing) {
    args.push('--repo', `path:${repo}`);
    args.push('--provider', provider);
  }
  args.push('--trigger', trigger);
  args.push('--prompt', prompt);
  args.push('--timezone', timezone);
  args.push('--precheck', `node ${quote(join(skillRoot, 'adapters', 'orca', 'precheck.mjs'))}`);
  args.push(disabled ? '--disabled' : '--enabled');
  args.push('--json');
  const result = orca(args, { dryRun });
  const id = result?.result?.automation?.id || result?.result?.id || existing?.id || '(dry-run)';
  console.log(`[orca-setup] ${verb} ${name}: ${id}`);
  return id;
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const repoPath = resolveRepo({ repo: values.repo });
  const settings = resolveSettings(repoPath);
  const policy = values.policy || settings.policy;
  const provider = values.provider || 'codex';
  const timezone = values.timezone || 'Asia/Shanghai';
  const issueTrigger = values['issue-trigger'] || '0 * * * *';
  const retroTrigger = values['retro-trigger'] || '30 6 * * *';
  const disabled = !flags.enabled;
  const dryRun = flags['dry-run'];

  const slug = repoSlug(repoPath) || repoPath;
  const name = values.name || basename(repoPath);
  const names = automationNamesForRepo(repoPath);
  const repo = dryRun ? { id: 'dry-run' } : findRepo(repoPath);
  if (!repo && !dryRun) {
    console.error(`[orca-setup] ${repoPath} is not in Orca's repo list. Add it in Orca first.`);
    process.exit(2);
  }

  const existing = dryRun ? new Map() : listAutomations();
  const replace = flags.replace;
  const issueExisting = existing.get(names.issue) || existing.get(LEGACY_ISSUE_NAME);
  const retroExisting = existing.get(names.retro) || existing.get(LEGACY_RETRO_NAME);

  if (issueExisting && !replace) {
    console.log(
      `[orca-setup] ${issueExisting.name} exists (${issueExisting.id}); skipped. Use --replace to rename/update to ${names.issue}.`,
    );
  } else {
    createOrEdit({
      existing: issueExisting,
      name: names.issue,
      trigger: issueTrigger,
      prompt: buildIssuePrompt({
        name,
        policy,
        repoPath,
        outDir: settings.outDir,
        language: settings.language,
      }),
      provider,
      repo: repoPath,
      timezone,
      disabled,
      dryRun,
    });
  }

  if (retroExisting && !replace) {
    console.log(
      `[orca-setup] ${retroExisting.name} exists (${retroExisting.id}); skipped. Use --replace to rename/update to ${names.retro}.`,
    );
  } else {
    createOrEdit({
      existing: retroExisting,
      name: names.retro,
      trigger: retroTrigger,
      prompt: buildRetroPrompt({ name, repoPath, language: settings.language }),
      provider,
      repo: repoPath,
      timezone,
      disabled,
      dryRun,
    });
  }

  console.log('');
  console.log(`[orca-setup] skill: ${skillRoot}`);
  console.log(`[orca-setup] repo: ${slug}`);
  console.log(`[orca-setup] ${names.issue}: ${issueTrigger} (policy: ${policy})`);
  console.log(`[orca-setup] ${names.retro}: ${retroTrigger}`);
  console.log(`[orca-setup] disabled: ${disabled}${disabled ? ' (run once manually before enabling)' : ''}`);
  if (disabled) {
    console.log('[orca-setup] enable: orca automations edit <id> --enabled --json');
  }
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[orca-setup] ${error.message}`);
    process.exit(2);
  }
}
