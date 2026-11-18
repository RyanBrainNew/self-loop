// Pick (and optionally claim) the single issue this run should implement.
// Policy comes from the Orca automation prompt / environment, never from code.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ghJson,
  ineligibleReason,
  parseArgs,
  parsePolicy,
  repoSlug,
  resolveSelfLogin,
  resolveToken,
  selectCandidate,
} from './lib.mjs';
import { collect } from './triage.mjs';

const MAX_AGE_MS = 10 * 60 * 1000;

function loadCached(outDir) {
  const file = join(outDir, 'triage.json');
  if (!existsSync(file)) return null;
  if (Date.now() - statSync(file).mtimeMs > MAX_AGE_MS) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function selectOne({ policy, repo, token, selfLogin, ttlMinutes, outDir = '.loop', refresh = false }) {
  let state = refresh ? null : loadCached(outDir);
  if (!state) {
    state = await collect({ policy, repo, token, selfLogin, ttlMinutes });
  }

  const options = { policy, selfLogin, claimTtlMinutes: ttlMinutes };
  const issues = (state.issues || []).map((issue) => ({
    ...issue,
    ineligibleReason: ineligibleReason(issue, options),
  }));
  const candidate = selectCandidate(issues, options);
  state.issues = issues;
  state.policy = policy;
  state.selfLogin = selfLogin;
  state.candidate = candidate?.number || null;
  return { state, candidate };
}

async function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const policy = parsePolicy(values.policy || process.env.LOOP_POLICY || 'ready-for-agent');
  const outDir = values.out || '.loop';
  const token = resolveToken();
  const repo = values.repo || process.env.GITHUB_REPOSITORY || repoSlug();
  const selfLogin = values['no-self'] ? '' : await resolveSelfLogin(repo, token);
  const ttlMinutes = values.ttl ? Number(values.ttl) : undefined;
  const claim = !flags['no-claim'];

  const { state, candidate } = await selectOne({
    policy,
    repo,
    token,
    selfLogin,
    ttlMinutes,
    outDir,
    refresh: flags.refresh || flags['no-json'],
  });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'triage.json'), `${JSON.stringify(state, null, 2)}\n`);

  if (!candidate) {
    console.log(`[select] no eligible issue for policy ${policy.raw}`);
    process.exit(3);
  }

  const claimState = {
    number: candidate.number,
    title: candidate.title,
    url: candidate.url,
    labels: candidate.labels,
    policy: policy.raw,
    repo: state.repo,
    claimedBy: claim ? selfLogin : '(dry-run)',
    claimedAt: new Date().toISOString(),
  };

  if (claim && selfLogin) {
    try {
      await ghJson(state.repo, `/issues/${candidate.number}/assignees`, token, {
        method: 'POST',
        body: { assignees: [selfLogin] },
      });
    } catch (error) {
      console.error(`[select] claim failed (${error.message}); refusing to run unclaimed`);
      process.exit(2);
    }
  } else if (claim && !selfLogin) {
    console.error('[select] cannot claim: unknown GitHub login (set LOOP_SELF_LOGIN)');
    process.exit(2);
  }

  writeFileSync(join(outDir, 'work.json'), `${JSON.stringify(claimState, null, 2)}\n`);

  if (flags.json) {
    console.log(JSON.stringify(claimState, null, 2));
  } else {
    console.log(`[select] #${candidate.number} ${candidate.title}`);
    console.log(`[select] policy=${policy.raw} labels=${candidate.labels.join(',') || '-'} claimedBy=${claimState.claimedBy}`);
    console.log(`[select] wrote ${join(outDir, 'work.json')}`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error(`[select] ${error.message}`);
    process.exit(2);
  });
}
