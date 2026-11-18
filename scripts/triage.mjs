// Read all open issues and open PRs, then write a deterministic triage report.
// This command is read-only: it does not label, comment, close, or assign.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MATT_ROLES,
  ineligibleReason,
  isMain,
  labelNames,
  linkedPrNumbers,
  listOpenIssues,
  listOpenPrs,
  parseArgs,
  parsePolicy,
  resolveRepo,
  resolveSelfLogin,
  resolveSettings,
  resolveToken,
  roleOf,
  selectCandidate,
} from './lib.mjs';

async function classify(base, key, model, issues) {
  if (!base || !key || !model || issues.length === 0) return {};
  const prompt = [
    'You triage GitHub issues for this software project.',
    'One line per issue, exactly: number|verdict|reason',
    'verdict is one of do|reply|review|ignore.',
    'do=worth implementing, reply=just answer, review=needs a human or PR review, ignore=skip.',
    'The repository already uses the five triage labels. Those labels are authoritative;',
    'use them as a strong signal, and never repeat the label text as the reason.',
  ].join('\n');
  const items = issues
    .map((issue) => {
      const labels = labelNames(issue.labels).join(', ') || '(none)';
      return `#${issue.number} [${labels}] ${issue.title}\n${(issue.body || '').slice(0, 800)}`;
    })
    .join('\n---\n');
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: `${prompt}\n\n${items}` }],
      temperature: 0,
      max_tokens: 800,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const payload = await res.json();
  const content = payload?.choices?.[0]?.message?.content || '';
  const verdicts = {};
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^#?(\d+)\s*\|\s*(do|reply|review|ignore)\s*\|\s*(.*)$/i);
    if (match) verdicts[Number(match[1])] = { verdict: match[2].toLowerCase(), reason: match[3].trim() };
  }
  return verdicts;
}

export async function collect({
  policy = parsePolicy(),
  repoRoot,
  githubRepo = '',
  token,
  selfLogin = '',
  ttlMinutes,
  useLlm = true,
} = {}) {
  const slug = githubRepo || process.env.GITHUB_REPOSITORY || '';
  if (!slug) throw new Error('cannot resolve GitHub repo: set githubRepo/.self-loop.json or GITHUB_REPOSITORY');
  if (!token) throw new Error('no GitHub token: set GITHUB_TOKEN / GH_TOKEN, or run gh auth login');

  const [rawIssues, prs] = await Promise.all([listOpenIssues(slug, token), listOpenPrs(slug, token)]);
  const prLinks = linkedPrNumbers(prs);

  let verdicts = {};
  if (useLlm) {
    try {
      verdicts = await classify(process.env.LLM_BASE, process.env.LLM_KEY, process.env.LLM_CHEAP_MODEL, rawIssues);
    } catch (error) {
      console.error(`[triage] cheap-model classification skipped: ${error.message}`);
    }
  }

  const options = { policy, selfLogin, claimTtlMinutes: ttlMinutes };
  const issues = rawIssues.map((issue) => {
    const labels = labelNames(issue.labels);
    const linkedPR = prLinks.get(issue.number);
    const verdict = verdicts[issue.number] || {};
    const item = {
      number: issue.number,
      title: issue.title,
      body: issue.body || '',
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      author: issue.user?.login || '',
      authorAssociation: issue.author_association || '',
      labels,
      role: roleOf(labels),
      assignees: (issue.assignees || []).map((user) => user.login),
      comments: issue.comments || 0,
      hasOpenPR: Boolean(linkedPR),
      linkedPR: linkedPR || null,
      verdict: verdict.verdict || '',
      verdictReason: verdict.reason || '',
    };
    item.ineligibleReason = ineligibleReason(item, options);
    return item;
  });

  issues.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  const candidate = selectCandidate(issues, options);
  return {
    generatedAt: new Date().toISOString(),
    repo: slug,
    policy,
    selfLogin,
    openIssues: issues.length,
    openPrs: prs.length,
    candidate: candidate?.number || null,
    issues,
  };
}

function renderMarkdown(state) {
  const lines = [
    `# Triage @ ${state.generatedAt}`,
    '',
    `repo: ${state.repo}`,
    `policy: \`${state.policy.raw}\` (${state.policy.kind}${state.policy.label ? `:${state.policy.label}` : ''})`,
    `self: ${state.selfLogin || '(unknown)'}`,
    `open issues: ${state.openIssues} / open PRs: ${state.openPrs}`,
    '',
    `candidate: ${state.candidate ? `#${state.candidate}` : '(none)'}`,
    '',
    '## Issues (oldest first)',
    '| issue | role | verdict | labels | open PR | eligible | reason |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const issue of state.issues) {
    lines.push(
      `| [#${issue.number}](${issue.url}) | ${issue.role} | ${issue.verdict || '-'} | ${
        issue.labels.join(', ') || '-'
      } | ${issue.hasOpenPR ? `#${issue.linkedPR}` : '-'} | ${issue.ineligibleReason ? 'no' : 'yes'} | ${
        issue.ineligibleReason || '-'
      } |`,
    );
  }
  lines.push('', `Triage roles: ${MATT_ROLES.join(' / ')}`);
  lines.push('', '> Triage is read-only. Selection and implementation follow the supplied policy and work reference.');
  return lines.join('\n');
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepo({ repo: values.repo });
  const settings = resolveSettings(repoRoot, {
    policy: values.policy,
    claimTtlMinutes: values.ttl,
    outDir: values.out,
  });
  const policy = parsePolicy(settings.policy);
  const token = resolveToken();
  if (!settings.githubRepo) {
    throw new Error('cannot resolve GitHub repo: set githubRepo in .self-loop.json or GITHUB_REPOSITORY');
  }

  mkdirSync(settings.outDir, { recursive: true });
  const selfLogin = flags['no-self'] ? '' : await resolveSelfLogin(settings.githubRepo, token);
  const state = await collect({
    policy,
    repoRoot,
    githubRepo: settings.githubRepo,
    token,
    selfLogin,
    ttlMinutes: settings.claimTtlMinutes,
    useLlm: !flags['no-llm'],
  });
  state.selfLogin = selfLogin;

  writeFileSync(join(settings.outDir, 'triage.json'), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(settings.outDir, 'triage.md'), `${renderMarkdown(state)}\n`);
  console.log(`[triage] ${state.openIssues} open issues, ${state.openPrs} open PRs, candidate: ${state.candidate || 'none'}`);
  console.log(`[triage] wrote ${join(settings.outDir, 'triage.json')} and ${join(settings.outDir, 'triage.md')}`);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`[triage] ${error.message}`);
    process.exit(2);
  });
}
