// Cross-platform loop entry (Windows / macOS / Linux).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from './lib.mjs';

const dir = fileURLToPath(new URL('.', import.meta.url));
const node = process.execPath;

const { values, flags, rest } = parseArgs(process.argv.slice(2));
const mode = rest[0] || 'issue';
if (values.repo) process.chdir(values.repo);

const policy = values.policy || process.env.LOOP_POLICY || 'ready-for-agent';
const shared = ['--policy', policy];
if (values.repo) shared.push('--repo', process.cwd());
if (flags['no-llm']) shared.push('--no-llm');
if (values.ttl) shared.push('--ttl', values.ttl);

function run(script, args = shared) {
  const result = spawnSync(node, [join(dir, script), ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 2;
}

async function githubUp() {
  try {
    const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (mode === 'triage') {
    if (!(await githubUp())) return console.log('[loop] GitHub unreachable, skip triage'), 0;
    return run('triage.mjs');
  }
  if (mode === 'select' || mode === 'work') {
    if (!(await githubUp())) return console.log('[loop] GitHub unreachable, skip select'), 0;
    return run('select.mjs');
  }
  if (mode === 'issue') {
    if (!(await githubUp())) return console.log('[loop] GitHub unreachable, skip issue loop'), 0;
    const triage = run('triage.mjs');
    if (triage !== 0) return triage;
    return run('select.mjs');
  }
  if (mode === 'retro') {
    return run('retro.mjs', values.days ? ['--days', String(values.days)] : []);
  }
  if (mode === 'agent') {
    if (!(await githubUp())) return console.log('[loop] GitHub unreachable, skip agent dispatch'), 0;
    const selected = run('select.mjs', [...shared, '--json']);
    if (selected !== 0) return selected;
    const workFile = join(process.cwd(), '.loop', 'work.json');
    if (!existsSync(workFile)) return console.log('[loop] no issue selected'), 3;
    if (!process.env.LOOP_AGENT) {
      return console.log('[loop] LOOP_AGENT not set; work item is in .loop/work.json'), 0;
    }
    const issueNumber = JSON.parse(readFileSync(workFile, 'utf8')).number;
    const agent = spawnSync(process.env.LOOP_AGENT, [join(dir, 'WORK.md')], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ISSUE_NUMBER: String(issueNumber) },
    });
    return agent.status ?? 2;
  }
  console.error(`[loop] unknown mode: ${mode} (triage|select|issue|retro|agent)`);
  return 2;
}

const code = await main();
if (code) process.exit(code);
