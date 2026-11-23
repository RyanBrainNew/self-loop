#!/usr/bin/env node
// Opt-in, read-only GitHub integration check. It never creates or edits issues.
import { isMain, parseArgs } from './lib.mjs';

function apiBase() {
  return String(process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
}

function token() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
}

async function request(path) {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'self-loop-live-check',
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status}: ${body.message || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs(argv);
  const repo = String(values.repo || process.env.SELF_LOOP_LIVE_REPO || process.env.GITHUB_REPOSITORY || '');
  if (!token()) {
    console.error('[github-live] set GITHUB_TOKEN or GH_TOKEN');
    return 2;
  }
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
    console.error('[github-live] pass --repo owner/name or set SELF_LOOP_LIVE_REPO');
    return 2;
  }
  const repository = await request(`/repos/${repo}`);
  const issues = await request(`/repos/${repo}/issues?state=all&per_page=5`);
  console.log(JSON.stringify({
    ok: true,
    repo: repository.full_name,
    defaultBranch: repository.default_branch,
    private: Boolean(repository.private),
    permissions: repository.permissions || null,
    sampleIssues: issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      pullRequest: Boolean(issue.pull_request),
    })),
    note: 'read-only check; no issue, comment, label, or pull request was written',
  }, null, 2));
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    const code = await main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[github-live] ${error.message}`);
    process.exit(error.status === 404 ? 3 : 2);
  }
}
