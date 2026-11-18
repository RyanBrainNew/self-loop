// Create the two Orca automations for the current repo.
// Portable: run this from any Git repo after copying loop/ into it.
import { execFileSync } from 'node:child_process';
import { basename, resolve } from 'node:path';
import { git, parseArgs, repoSlug } from './lib.mjs';

const ISSUE_NAME = 'issue-loop';
const RETRO_NAME = 'retro-loop';

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

function automationNames() {
  const listing = orca(['automations', 'list', '--json']);
  return new Map((listing?.result?.automations || []).map((automation) => [automation.name, automation]));
}

function issuePrompt(name) {
  return [
    `这是 ${name} 的 issue loop。在仓库根目录依次执行:`,
    '1. node loop/run.mjs triage',
    '2. node loop/run.mjs select --policy <POLICY>',
    '若 select 退出码为 3,直接结束,不要改代码。',
    '否则读 .loop/work.json,按 loop/LOOP.md 与 loop/WORK.md 实现这个 issue:',
    '分支 -> 门禁 -> PR(第一行 Closes #N)。绝不合并,绝不 push 默认分支。',
  ].join('\n');
}

function retroPrompt(name) {
  return [
    `这是 ${name} 的每日复盘 loop。在仓库根目录执行 node loop/run.mjs retro,`,
    '然后按 loop/RETRO.md 更新 memory/LESSONS.md(不存在则按项目约定创建),',
    '用分支 + PR 交付(chore(loop): retro YYYY-MM-DD)。',
    '没有值得记的教训就说明检查范围并结束,不要硬凑。绝不合并。',
  ].join('\n');
}

function createOrEdit({ existing, name, trigger, prompt, provider, repo, timezone, disabled, dryRun }) {
  const verb = existing ? 'edit' : 'create';
  const args = existing ? ['automations', 'edit', existing.id] : ['automations', 'create'];
  if (!existing) {
    args.push('--name', name);
    args.push('--repo', `path:${repo}`);
    args.push('--provider', provider);
  }
  args.push('--trigger', trigger);
  args.push('--prompt', prompt);
  args.push('--timezone', timezone);
  args.push('--precheck', 'node loop/precheck.mjs');
  args.push(disabled ? '--disabled' : '--enabled');
  args.push('--json');
  const result = orca(args, { dryRun });
  const id = result?.result?.automation?.id || result?.result?.id || existing?.id || '(dry-run)';
  console.log(`[orca-setup] ${verb} ${name}: ${id}`);
  return id;
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const repoPath = resolve(values.repo || git(cwd, ['rev-parse', '--show-toplevel']) || cwd);
  const policy = values.policy || 'ready-for-agent';
  const provider = values.provider || 'codex';
  const timezone = values.timezone || 'Asia/Shanghai';
  const issueTrigger = values['issue-trigger'] || '0 * * * *';
  const retroTrigger = values['retro-trigger'] || '30 6 * * *';
  const disabled = !flags.enabled;
  const dryRun = flags['dry-run'];

  const slug = repoSlug(repoPath) || repoPath;
  const name = values.name || basename(repoPath);
  const repo = dryRun ? { id: 'dry-run' } : findRepo(repoPath);
  if (!repo && !dryRun) {
    console.error(`[orca-setup] ${repoPath} 不在 Orca 的 repo 列表里。先在 Orca 里添加这个仓库。`);
    process.exit(2);
  }

  const existing = dryRun ? new Map() : automationNames();
  const replace = flags.replace;
  const issueExisting = existing.get(ISSUE_NAME);
  const retroExisting = existing.get(RETRO_NAME);

  if (issueExisting && !replace) {
    console.log(`[orca-setup] ${ISSUE_NAME} 已存在(${issueExisting.id});跳过。加 --replace 可更新。`);
  } else {
    createOrEdit({
      existing: issueExisting,
      name: ISSUE_NAME,
      trigger: issueTrigger,
      prompt: issuePrompt(name).replace('<POLICY>', policy),
      provider,
      repo: repoPath,
      timezone,
      disabled,
      dryRun,
    });
  }

  if (retroExisting && !replace) {
    console.log(`[orca-setup] ${RETRO_NAME} 已存在(${retroExisting.id});跳过。加 --replace 可更新。`);
  } else {
    createOrEdit({
      existing: retroExisting,
      name: RETRO_NAME,
      trigger: retroTrigger,
      prompt: retroPrompt(name),
      provider,
      repo: repoPath,
      timezone,
      disabled,
      dryRun,
    });
  }

  console.log('');
  console.log(`[orca-setup] repo: ${slug}`);
  console.log(`[orca-setup] issue-loop: ${issueTrigger} (policy: ${policy})`);
  console.log(`[orca-setup] retro-loop: ${retroTrigger}`);
  console.log(`[orca-setup] disabled: ${disabled}${disabled ? ' (先手动跑一轮再启用)' : ''}`);
  if (disabled) {
    console.log('[orca-setup] 启用: orca automations edit <id> --enabled --json');
  }
}

try {
  main();
} catch (error) {
  console.error(`[orca-setup] ${error.message}`);
  process.exit(2);
}
