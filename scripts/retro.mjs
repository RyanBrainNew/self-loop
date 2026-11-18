// Build deterministic retrospective material from git history.
// The window starts at the last commit that changed the lessons file, unless an
// explicit --since / SELF_LOOP_RETRO_SINCE is supplied.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  git,
  isMain,
  parseArgs,
  repoRelativePath,
  resolveRepo,
  resolveSettings,
} from './lib.mjs';

function daysAgo(days) {
  const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

function lastLessonsCommit(repoRoot, lessonsPath, maxAgeDays = 14) {
  const rel = repoRelativePath(repoRoot, lessonsPath);
  const sha = git(repoRoot, ['log', '-1', '--format=%H', '--', rel]);
  if (!sha) return '';
  const date = git(repoRoot, ['show', '-s', '--format=%cs', sha]);
  const ageDays = (Date.now() - new Date(date).getTime()) / 86400000;
  return Number.isFinite(ageDays) && ageDays <= maxAgeDays ? sha : '';
}

export function resolveWindow({ since, days = 2, repoRoot = process.cwd(), lessonsPath } = {}) {
  const explicit = since || process.env.SELF_LOOP_RETRO_SINCE || process.env.LOOP_RETRO_SINCE || '';
  if (explicit) return { since: explicit, label: explicit, source: 'explicit' };

  const lessons = lessonsPath || join(repoRoot, 'memory', 'LESSONS.md');
  const lessonsSha = lastLessonsCommit(repoRoot, lessons, Math.max(days * 3, 7));
  if (lessonsSha) {
    const rel = repoRelativePath(repoRoot, lessons);
    return {
      since: lessonsSha,
      label: `since ${lessonsSha} (last ${rel} change)`,
      source: 'lessons',
    };
  }
  const label = `${daysAgo(days)} (last ${days} days)`;
  return { since: `--since=${daysAgo(days)}`, label, source: 'days' };
}

function range(since) {
  return since.startsWith('--since=') ? [since, 'HEAD'] : [`${since}..HEAD`];
}

function commitList(repoRoot, since) {
  const args = ['log', '--pretty=format:%h%x09%ad%x09%s', '--date=short', '--no-merges', ...range(since)];
  const text = git(repoRoot, args);
  return text ? text.split('\n').filter(Boolean) : [];
}

function mergeList(repoRoot, since) {
  const args = ['log', '--merges', '--pretty=format:%h%x09%ad%x09%s', '--date=short', ...range(since)];
  const text = git(repoRoot, args);
  return text ? text.split('\n').filter(Boolean) : [];
}

function areaSummary(repoRoot, since) {
  const args = ['log', '--name-only', '--pretty=format:', ...range(since)];
  const files = git(repoRoot, args).split('\n').filter(Boolean);
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

export function buildRetro({
  repoRoot = process.cwd(),
  since,
  days = 2,
  lessonsPath,
  codeStandardsPath,
  decisionsPath,
} = {}) {
  const lessons = lessonsPath || join(repoRoot, 'memory', 'LESSONS.md');
  const standards = codeStandardsPath || join(repoRoot, 'memory', 'code-standards.md');
  const decisions = decisionsPath || join(repoRoot, 'memory', 'DECISIONS.md');
  const window = resolveWindow({ since, days, repoRoot, lessonsPath: lessons });
  const commits = commitList(repoRoot, window.since);
  const merges = mergeList(repoRoot, window.since);
  const areas = areaSummary(repoRoot, window.since);
  const lessonsRel = repoRelativePath(repoRoot, lessons);
  const standardsRel = repoRelativePath(repoRoot, standards);
  const decisionsRel = repoRelativePath(repoRoot, decisions);
  const lines = [
    `# Retro material @ ${new Date().toISOString()}`,
    '',
    `window: ${window.label}`,
    `commits: ${commits.length}, merges: ${merges.length}`,
    '',
    '## Commits',
    ...(commits.length ? commits.slice(0, 200).map(formatCommit) : ['- (none)']),
    '',
    '## Merged PRs',
    ...(merges.length ? merges.slice(0, 50).map(formatCommit) : ['- (none)']),
    '',
    '## Changed areas',
    ...(areas.length ? areas.map(([area, count]) => `- ${area} ${count} files`) : ['- (no file changes)']),
    '',
    '## Retro instructions',
    `1. Read \`${lessonsRel}\` (if present), \`${standardsRel}\` (if present), and \`${decisionsRel}\` (if present); do not repeat an existing lesson.`,
    '2. Record only evidence-backed lessons: rework after a fix, a change that should not have merged, or weak verification. Rule + reason + commit/issue evidence.',
    '3. Record things done right too, marked as Done right, so later agents can repeat them.',
    `4. If the same lesson appears on about three different dates, propose promoting it to \`${standardsRel}\` as a hard gate.`,
    '5. Deliver with a branch + PR (chore(self-loop): retro YYYY-MM-DD). Never merge or push the default branch.',
    '6. If nothing is worth recording, explain what was checked and stop. Do not invent lessons.',
  ];
  return { window, commits, merges, areas, markdown: lines.join('\n') };
}

function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepo({ repo: values.repo });
  const settings = resolveSettings(repoRoot, {
    outDir: values.out,
    retroDays: values.days,
  });
  const result = buildRetro({
    repoRoot,
    since: values.since,
    days: settings.retroDays,
    lessonsPath: settings.lessonsPath,
    codeStandardsPath: settings.codeStandardsPath,
    decisionsPath: settings.decisionsPath,
  });
  mkdirSync(settings.outDir, { recursive: true });
  writeFileSync(join(settings.outDir, 'retro.md'), `${result.markdown}\n`);
  console.log(`[retro] window=${result.window.label} commits=${result.commits.length} merges=${result.merges.length}`);
  console.log(`[retro] wrote ${join(settings.outDir, 'retro.md')}`);
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[retro] ${error.message}`);
    process.exit(2);
  }
}
