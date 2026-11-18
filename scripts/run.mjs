// Cross-platform entry point for manual, cron, CI, and adapter usage.
// This file intentionally knows nothing about any scheduler.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs,
  resolveRepo,
  resolveSettings,
} from './lib.mjs';
import { githubReachable } from './precheck.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const node = process.execPath;

const { values, flags, rest } = parseArgs(process.argv.slice(2));
const mode = rest[0] || 'issue';
const repoRoot = resolveRepo({ repo: values.repo });
const settings = resolveSettings(repoRoot, {
  policy: values.policy,
  claimTtlMinutes: values.ttl,
  retroDays: values.days,
  outDir: values.out,
});

const shared = ['--repo', repoRoot, '--policy', settings.policy, '--out', settings.outDir, '--ttl', String(settings.claimTtlMinutes)];
if (flags['no-llm']) shared.push('--no-llm');
if (flags['no-self']) shared.push('--no-self');
if (flags['no-claim']) shared.push('--no-claim');

function runScript(script, args = shared) {
  const result = spawnSync(node, [join(scriptDir, script), ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  return result.status ?? 2;
}

async function main() {
  const precheck = !flags['no-precheck'];
  if (mode === 'triage') {
    if (precheck && !(await githubReachable())) return console.log('[self-loop] GitHub unreachable, skip triage'), 0;
    return runScript('triage.mjs');
  }
  if (mode === 'select' || mode === 'work') {
    if (precheck && !(await githubReachable())) return console.log('[self-loop] GitHub unreachable, skip select'), 0;
    return runScript('select.mjs');
  }
  if (mode === 'issue') {
    if (precheck && !(await githubReachable())) return console.log('[self-loop] GitHub unreachable, skip issue loop'), 0;
    const triage = runScript('triage.mjs');
    if (triage !== 0) return triage;
    return runScript('select.mjs');
  }
  if (mode === 'retro') {
    const args = ['--repo', repoRoot, '--out', settings.outDir, '--days', String(settings.retroDays)];
    if (values.since) args.push('--since', values.since);
    return runScript('retro.mjs', args);
  }
  if (mode === 'router') {
    return runScript('router.mjs', ['--repo', repoRoot, ...process.argv.slice(3)]);
  }
  if (mode === 'agent') {
    if (precheck && !(await githubReachable())) return console.log('[self-loop] GitHub unreachable, skip agent dispatch'), 0;
    const selected = runScript('select.mjs', [...shared, '--json']);
    if (selected !== 0) return selected;
    const workFile = join(settings.outDir, 'work.json');
    if (!existsSync(workFile)) return console.log('[self-loop] no issue selected'), 3;
    const agentCommand = process.env.SELF_LOOP_AGENT || process.env.LOOP_AGENT || '';
    if (!agentCommand) {
      return console.log(`[self-loop] SELF_LOOP_AGENT not set; work item is in ${workFile}`), 0;
    }
    const issueNumber = JSON.parse(readFileSync(workFile, 'utf8')).number;
    const workReference = join(skillRoot, 'references', 'WORK.md');
    const agent = spawnSync(agentCommand, [workReference], {
      cwd: repoRoot,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ISSUE_NUMBER: String(issueNumber) },
    });
    return agent.status ?? 2;
  }
  console.error(`[self-loop] unknown mode: ${mode} (triage|select|issue|retro|router|agent)`);
  return 2;
}

const code = await main();
if (code) process.exit(code);
