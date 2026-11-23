// Independent verification for one Ticket.
// The verifier never edits code and never trusts a Worker's self-report.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, pathInRepo } from './lib.mjs';

function gitOrThrow(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = error.stderr ? String(error.stderr).trim() : error.message;
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function packageScripts(repoRoot) {
  const file = join(repoRoot, 'package.json');
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
      ? parsed.scripts
      : {};
  } catch {
    return {};
  }
}

/**
 * Prefer explicit verifier commands, then common package scripts. The caller
 * can always configure `verifier.commands` in .self-loop.json.
 */
export function discoverVerifierCommands({ repoRoot, settings } = {}) {
  const configured = settings?.verifier?.commands;
  if (Array.isArray(configured) && configured.length > 0) return configured.map(String);

  const scripts = packageScripts(repoRoot);
  const commands = [];
  for (const name of ['test', 'lint', 'typecheck', 'build']) {
    if (!scripts[name]) continue;
    commands.push(name === 'test' ? 'npm test' : `npm run ${name}`);
  }
  return commands;
}

function runShell(command, cwd, timeoutMs, prefix = []) {
  const env = { ...process.env, CI: process.env.CI || '1' };
  if (Array.isArray(prefix) && prefix.length > 0) {
    const expanded = prefix.map((item) => String(item).replaceAll('${worktree}', cwd));
    return spawnSync(expanded[0], [...expanded.slice(1), command], {
      cwd,
      shell: false,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env,
    });
  }
  return spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    env,
  });
}

function writeEvidence(file, entry) {
  const line = `${JSON.stringify(entry)}\n`;
  try {
    writeFileSync(file, line, { flag: 'a' });
  } catch {
    writeFileSync(file, line);
  }
}

function removeWorktree(repoRoot, path) {
  if (!path) return;
  try {
    gitOrThrow(repoRoot, ['worktree', 'remove', '--force', path]);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Verify a Ticket at its PR head/branch in a detached, clean worktree.
 * Returns pass, fail, or human_review, plus an evidence path.
 */
export function runVerifier({
  repoRoot,
  settings,
  ticket,
  keep = false,
  now = Date.now(),
} = {}) {
  const commands = discoverVerifierCommands({ repoRoot, settings });
  const attempt = Number(ticket.attempts || 1);
  const artifactDir = join(settings.outDir, 'artifacts', String(ticket.number), `attempt-${attempt}`);
  const evidencePath = join(artifactDir, 'verify.jsonl');
  mkdirSync(artifactDir, { recursive: true });
  if (existsSync(evidencePath)) rmSync(evidencePath, { force: true });

  if (commands.length === 0) {
    writeEvidence(evidencePath, {
      at: new Date(now).toISOString(),
      command: null,
      status: 'human_review',
      reason: 'no verifier commands discovered',
    });
    return {
      status: 'human_review',
      evidencePath,
      checks: [],
      reason: 'no verifier commands discovered',
    };
  }

  const verifyRoot = pathInRepo(
    repoRoot,
    join(settings.router.worktreeDir, 'verify', String(ticket.number)),
    'verifyWorktree',
  );
  removeWorktree(repoRoot, verifyRoot);
  mkdirSync(join(verifyRoot, '..'), { recursive: true });

  const head = ticket.prHead || ticket.branch || 'HEAD';
  try {
    gitOrThrow(repoRoot, ['worktree', 'add', '--detach', verifyRoot, head]);
  } catch (error) {
    const reason = `could not create verification worktree at ${head}: ${error.message}`;
    writeEvidence(evidencePath, {
      at: new Date(now).toISOString(),
      command: null,
      status: 'human_review',
      reason,
    });
    return {
      status: 'human_review',
      evidencePath,
      checks: [],
      reason,
    };
  }

  const checks = [];
  let failed = false;
  const timeoutMs = settings.verifier.timeoutMinutes * 60 * 1000;

  try {
    for (const command of commands) {
      const started = Date.now();
      const result = runShell(
        command,
        verifyRoot,
        timeoutMs,
        settings.verifier.commandPrefix,
      );
      const durationMs = Date.now() - started;
      const status = result.error?.code === 'ETIMEDOUT'
        ? 'timeout'
        : result.status === 0
          ? 'pass'
          : 'fail';
      const safeName = checks.length + 1;
      const stdoutPath = join(artifactDir, `verify-${safeName}.stdout.txt`);
      const stderrPath = join(artifactDir, `verify-${safeName}.stderr.txt`);
      writeFileSync(stdoutPath, result.stdout || '');
      writeFileSync(stderrPath, result.stderr || result.error?.message || '');
      const entry = {
        at: new Date(now).toISOString(),
        command,
        commandPrefix: settings.verifier.commandPrefix?.length
          ? settings.verifier.commandPrefix
          : null,
        cwd: verifyRoot,
        status,
        exitCode: result.status,
        signal: result.signal || null,
        durationMs,
        stdoutPath,
        stderrPath,
      };
      checks.push(entry);
      writeEvidence(evidencePath, entry);
      if (status !== 'pass') failed = true;
    }
  } finally {
    if (!keep) {
      removeWorktree(repoRoot, verifyRoot);
    }
  }

  return {
    status: failed ? 'fail' : 'pass',
    evidencePath,
    checks,
    worktree: keep ? verifyRoot : null,
  };
}

export function verifierWorktreeExists({ repoRoot, settings, ticket } = {}) {
  const path = join(settings.router.worktreeDir, 'verify', String(ticket.number));
  return existsSync(path) && Boolean(git(repoRoot, ['rev-parse', '--is-inside-work-tree']));
}
