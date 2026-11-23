#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { isMain, parseArgs, resolveSettings } from './lib.mjs';
import { tickRouter } from './router.mjs';

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...options,
  }).trim();
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'self-loop-executor-e2e-'));
  run('git', ['init', '-q', dir]);
  run('git', ['-C', dir, 'config', 'user.email', 'self-loop@example.com']);
  run('git', ['-C', dir, 'config', 'user.name', 'self-loop e2e']);
  writeFileSync(join(dir, 'README.md'), '# self-loop executor e2e\n');
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name: 'self-loop-executor-e2e',
    private: true,
    version: '0.0.0',
  }, null, 2)}\n`);
  run('git', ['-C', dir, 'add', '.']);
  run('git', ['-C', dir, 'commit', '-q', '-m', 'initial']);
  return dir;
}

function adapterAvailable(adapter, command) {
  if (adapter === 'codex') {
    const status = spawnSync(command || 'codex', ['login', 'status'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      ok: status.status === 0,
      detail: String(status.stdout || status.stderr || '').trim() || 'codex is not logged in',
    };
  }
  if (adapter === 'claude') {
    const status = spawnSync(command || 'claude', ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    return {
      ok: status.status === 0,
      detail: String(status.stdout || status.stderr || '').trim() || 'claude is not installed',
    };
  }
  const status = spawnSync(command || '', ['--version'], {
    encoding: 'utf8',
    shell: true,
    windowsHide: true,
  });
  return { ok: status.status === 0, detail: String(status.stdout || status.stderr || '').trim() };
}

async function main(argv = process.argv.slice(2)) {
  const { values, flags } = parseArgs(argv);
  const adapter = String(values.adapter || 'codex');
  const command = values.command ? String(values.command) : '';
  const availability = adapterAvailable(adapter, command);
  if (!availability.ok) {
    console.error(`[e2e] ${adapter} is unavailable: ${availability.detail}`);
    console.error('[e2e] authenticate the CLI first, then rerun this harness.');
    return 2;
  }

  const repo = values.repo ? resolve(values.repo) : makeFixture();
  const keep = Boolean(flags.keep) || Boolean(values.repo);
  const timeoutMinutes = Math.max(1, Number(values.timeout || 10));
  try {
    mkdirSync(join(repo, '.loop'), { recursive: true });
    writeFileSync(join(repo, '.self-loop.json'), `${JSON.stringify({
      language: 'en',
      router: {
        maxAttempts: 1,
        leaseMinutes: timeoutMinutes + 5,
        dispatchMode: 'wait',
      },
      executor: {
        adapter,
        ...(command ? { command } : {}),
        timeoutMinutes,
      },
      verifier: {
        commands: [
          'node -e "const fs=require(\'fs\'); const t=fs.readFileSync(\'result.txt\',\'utf8\').trim(); if(t!==\'done\') process.exit(1);"',
        ],
      },
    }, null, 2)}\n`);
    const settings = resolveSettings(repo, {}, {
      ...process.env,
      GITHUB_REPOSITORY: '',
    });
    const result = await tickRouter({
      repoRoot: repo,
      settings,
      candidate: {
        number: 1,
        title: 'Prove the real executor protocol',
        body: [
          'Create `result.txt` with exactly `done`.',
          'Commit the change on the Ticket branch.',
          'Do not merge or push a default branch.',
          '',
          '## Acceptance',
          '- [ ] result.txt contains exactly done on the ticket branch',
          '- [ ] Result Envelope points at Ticket 1 with state ready',
        ].join('\n'),
        labels: ['ready-for-agent'],
      },
    });
    const ticket = Object.values(result.state.tickets)[0];
    const evidence = ticket?.verification?.checks?.[0] || null;
    const report = {
      ok: ticket?.state === 'awaiting_review',
      adapter,
      repo,
      state: ticket?.state || null,
      attempts: ticket?.attempts || 0,
      branch: ticket?.branch || null,
      worker: ticket?.worker || null,
      resultPath: ticket?.resultPath || null,
      result: ticket?.lastResult || null,
      verification: ticket?.verification || null,
      evidence,
      kept: keep,
    };
    console.log(JSON.stringify(report, null, 2));
    if (flags['log'] && ticket?.resultPath) {
      const artifact = join(repo, '.loop', 'artifacts', String(ticket.number), `attempt-${ticket.attempts}`);
      for (const name of ['worker.stdout.txt', 'worker.stderr.txt']) {
        const file = join(artifact, name);
        if (existsSync(file)) console.error(`[${name}]\n${readFileSync(file, 'utf8').slice(-4000)}`);
      }
    }
    return report.ok ? 0 : 3;
  } finally {
    if (!keep) rmSync(repo, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}

if (isMain(import.meta.url)) {
  try {
    const code = await main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[e2e] ${error.message}`);
    process.exit(2);
  }
}

export { main, makeFixture };
