// Project-agnostic retro material. The loop never invents a local marker file:
// Orca runs in a fresh worktree, so state must survive through git.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git, parseArgs } from './lib.mjs';

const LESSONS = 'memory/LESSONS.md';
const STANDARDS = 'memory/code-standards.md';

function daysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function lastLessonsCommit(maxAgeDays = 14) {
  const sha = git(process.cwd(), ['log', '-1', '--format=%H', '--', LESSONS]);
  if (!sha) return '';
  const date = git(process.cwd(), ['show', '-s', '--format=%cs', sha]);
  const ageDays = (Date.now() - new Date(date).getTime()) / 86400000;
  return Number.isFinite(ageDays) && ageDays <= maxAgeDays ? sha : '';
}

export function resolveWindow({ since, days = 2 } = {}) {
  const explicit = since || process.env.LOOP_RETRO_SINCE || '';
  if (explicit) return { since: explicit, label: explicit, source: 'explicit' };
  const lessons = lastLessonsCommit(Math.max(days * 3, 7));
  if (lessons) return { since: lessons, label: `since ${lessons} (last ${LESSONS} change)`, source: 'lessons' };
  const label = `${daysAgo(days)} (last ${days} days)`;
  return { since: `--since=${daysAgo(days)}`, label, source: 'days' };
}

function commitList(since) {
  const range = since.startsWith('--since=') ? [since, 'HEAD'] : [`${since}..HEAD`];
  const args = ['log', '--pretty=format:%h%x09%ad%x09%s', '--date=short', '--no-merges', ...range];
  const text = git(process.cwd(), args);
  return text ? text.split('\n').filter(Boolean) : [];
}

function mergeList(since) {
  const range = since.startsWith('--since=') ? [since, 'HEAD'] : [`${since}..HEAD`];
  const args = ['log', '--merges', '--pretty=format:%h%x09%ad%x09%s', '--date=short', ...range];
  const text = git(process.cwd(), args);
  return text ? text.split('\n').filter(Boolean) : [];
}

function areaSummary(since) {
  const range = since.startsWith('--since=') ? [since, 'HEAD'] : [`${since}..HEAD`];
  const args = ['log', '--name-only', '--pretty=format:', ...range];
  const files = git(process.cwd(), args).split('\n').filter(Boolean);
  const counts = new Map();
  for (const file of files) {
    const parts = file.split('/');
    const key = parts.length > 1 ? `${parts[0]}/` : '(root)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function formatCommit(line) {
  const [sha, date, ...subject] = line.split('\t');
  return `- \`${sha}\` ${date || ''} ${subject.join(' ')}`.trim();
}

export function buildRetro({ since, days } = {}) {
  const window = resolveWindow({ since, days });
  const commits = commitList(window.since);
  const merges = mergeList(window.since);
  const areas = areaSummary(window.since);
  const lines = [
    `# Retro 素材 @ ${new Date().toISOString()}`,
    '',
    `window: ${window.label}`,
    `commits: ${commits.length}, merges: ${merges.length}`,
    '',
    '## 提交',
    ...(commits.length ? commits.slice(0, 200).map(formatCommit) : ['- (无提交)']),
    '',
    '## 合并的 PR',
    ...(merges.length ? merges.slice(0, 50).map(formatCommit) : ['- (无合并)']),
    '',
    '## 变动区域',
    ...(areas.length ? areas.map(([area, count]) => `- ${area} ${count} 个文件`) : ['- (无文件变更)']),
    '',
    '## 复盘要求',
    `1. 读 \`${LESSONS}\`(若存在)与 \`${STANDARDS}\`(若存在),避免重复记同一条。`,
    '2. 只记有证据的教训:修完返工 / 压根不该合 / 验证太糙。一句规则 + 原因 + commit/issue 证据。',
    '3. 做对的事也记,标 ✅ **Done right**,让后来的 agent 照着来。',
    `4. 同一条教训已在 ~3 个日期的复盘出现,提议转成 \`${STANDARDS}\` 的硬门禁。`,
    '5. 用分支 + PR 交付(`chore(loop): retro YYYY-MM-DD`),绝不直接 push main。',
    '6. 没有值得记的内容就说明原因直接结束,不要硬凑。',
  ];
  return { window, commits, merges, areas, markdown: lines.join('\n') };
}

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const result = buildRetro({
    since: values.since,
    days: values.days ? Number(values.days) : Number(process.env.LOOP_RETRO_DAYS || 2),
  });
  mkdirSync('.loop', { recursive: true });
  writeFileSync(join('.loop', 'retro.md'), `${result.markdown}\n`);
  console.log(`[retro] window=${result.window.label} commits=${result.commits.length} merges=${result.merges.length}`);
  console.log('[retro] wrote .loop/retro.md');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[retro] ${error.message}`);
    process.exit(2);
  }
}
