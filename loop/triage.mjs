// Project-agnostic issue triage for the Orca-driven loop.
// Matt's five triage labels are the authoritative taxonomy. The cheap-model
// verdict is advisory only and never overrides those labels.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MATT_ROLES,
  ineligibleReason,
  labelNames,
  linkedPrNumbers,
  listOpenIssues,
  listOpenPrs,
  parseArgs,
  parsePolicy,
  repoSlug,
  resolveSelfLogin,
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
    'The repository already uses Matt Pocock triage labels. Those labels are authoritative;',
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

export async function collect({ policy = parsePolicy(), repo, token, selfLogin = '', ttlMinutes, useLlm = true } = {}) {
  const slug = repo || process.env.GITHUB_REPOSITORY || repoSlug();
  if (!slug) throw new Error('无法解析仓库: 设置 GITHUB_REPOSITORY 或在 git 仓库内运行');
  if (!token) throw new Error('没有 GitHub token: 设置 GITHUB_TOKEN / GH_TOKEN,或先 gh auth login');

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
  lines.push('', `Matt 角色集合: ${MATT_ROLES.join(' / ')}`);
  lines.push('', '> triage 只读: 不评论、不打标签、不关 issue。动作由 Orca 策略与 agent 按 loop/LOOP.md 决定。');
  return lines.join('\n');
}

async function main() {
  const { values } = parseArgs(process.argv.slice(2));
  const policy = parsePolicy(values.policy || process.env.LOOP_POLICY || 'ready-for-agent');
  const token = resolveToken();
  const repo = values.repo || process.env.GITHUB_REPOSITORY || repoSlug();
  const outDir = values.out || '.loop';
  mkdirSync(outDir, { recursive: true });

  const selfLogin = values['no-self'] ? '' : await resolveSelfLogin(repo, token);
  const state = await collect({
    policy,
    repo,
    token,
    selfLogin,
    ttlMinutes: values.ttl ? Number(values.ttl) : undefined,
    useLlm: !values['no-llm'],
  });
  state.selfLogin = selfLogin;

  writeFileSync(join(outDir, 'triage.json'), `${JSON.stringify(state, null, 2)}\n`);
  writeFileSync(join(outDir, 'triage.md'), `${renderMarkdown(state)}\n`);
  console.log(`[triage] ${state.openIssues} open issues, ${state.openPrs} open PRs, candidate: ${state.candidate || 'none'}`);
  console.log(`[triage] wrote ${join(outDir, 'triage.json')} and ${join(outDir, 'triage.md')}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[triage] ${error.message}`);
    process.exit(2);
  });
}
