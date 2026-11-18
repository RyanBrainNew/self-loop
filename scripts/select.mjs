// Pick (and optionally claim) the single issue this run should implement.
// Policy comes from CLI, environment, or .self-loop.json, never from code.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ghJson,
  ineligibleReason,
  isMain,
  parseArgs,
  parsePolicy,
  resolveRepo,
  resolveSelfLogin,
  resolveSettings,
  resolveToken,
  selectCandidate,
} from './lib.mjs';
import { collect } from './triage.mjs';

const MAX_AGE_MS = 10 * 60 * 1000;

export function loadCached(outDir) {
  const file = join(outDir, 'triage.json');
  if (!existsSync(file)) return null;
  if (Date.now() - statSync(file).mtimeMs > MAX_AGE_MS) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function selectOne({
  policy,
  repoRoot,
  githubRepo,
  token,
  selfLogin,
  ttlMinutes,
  outDir,
  refresh = false,
}) {
  let state = refresh ? null : loadCached(outDir);
  if (state && githubRepo && state.repo !== githubRepo) state = null;
  if (!state) {
    state = await collect({ policy, repoRoot, githubRepo, token, selfLogin, ttlMinutes });
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

  const selfLogin = flags['no-self'] ? '' : await resolveSelfLogin(settings.githubRepo, token);
  const claim = !flags['no-claim'];
  const { state, candidate } = await selectOne({
    policy,
    repoRoot,
    githubRepo: settings.githubRepo,
    token,
    selfLogin,
    ttlMinutes: settings.claimTtlMinutes,
    outDir: settings.outDir,
    refresh: flags.refresh || flags['no-json'],
  });

  mkdirSync(settings.outDir, { recursive: true });
  writeFileSync(join(settings.outDir, 'triage.json'), `${JSON.stringify(state, null, 2)}\n`);

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
    console.error('[select] cannot claim: unknown GitHub login (set SELF_LOOP_SELF_LOGIN)');
    process.exit(2);
  }

  writeFileSync(join(settings.outDir, 'work.json'), `${JSON.stringify(claimState, null, 2)}\n`);

  if (flags.json) {
    console.log(JSON.stringify(claimState, null, 2));
  } else {
    console.log(`[select] #${candidate.number} ${candidate.title}`);
    console.log(`[select] policy=${policy.raw} labels=${candidate.labels.join(',') || '-'} claimedBy=${claimState.claimedBy}`);
    console.log(`[select] wrote ${join(settings.outDir, 'work.json')}`);
  }
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`[select] ${error.message}`);
    process.exit(2);
  });
}
