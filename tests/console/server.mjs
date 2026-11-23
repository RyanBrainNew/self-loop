#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createTicket,
  emptyState,
  saveState,
} from '../../scripts/router.mjs';
import { appendEvent, saveInbox } from '../../scripts/inbox.mjs';
import { emptyOutbox, saveOutbox } from '../../scripts/outbox.mjs';
import { resolveSettings } from '../../scripts/lib.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const work = mkdtempSync(join(tmpdir(), 'self-loop-console-e2e-'));
const port = Number(process.env.SELF_LOOP_E2E_PORT || 4319);
const projectsFile = join(work, 'projects.json');
const authFile = join(work, 'console-token');
const auditFile = join(work, 'console-audit.json');

function createProject(name, ticketStates) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.self-loop.json'), `${JSON.stringify({
    language: 'zh-CN',
    githubRepo: `acme/${name}`,
    router: {
      maxConcurrent: 2,
      maxAttempts: 2,
    },
  }, null, 2)}\n`);
  const settings = resolveSettings(dir, {}, { GITHUB_REPOSITORY: '' });
  const state = emptyState(settings);
  let number = 100;
  for (const [ticketState, title] of ticketStates) {
    number += 1;
    const ticket = createTicket({
      number,
      title,
      body: '## Acceptance\n- [ ] browser route renders',
      labels: ['ready-for-agent'],
      source: { id: 'src_github', kind: 'github', name: 'GitHub Issues' },
    }, settings);
    ticket.state = ticketState;
    ticket.summary = `${title} · Playwright fixture`;
    ticket.updatedAt = new Date().toISOString();
    state.tickets[String(number)] = ticket;
  }
  state.activeTicket = number;
  state.updatedAt = new Date().toISOString();
  saveState(settings, state);
  const inbox = { version: 1, events: [] };
  saveInbox(settings, inbox);
  const first = appendEvent(settings, {
    type: 'manual',
    action: 'browser-fixture',
    payload: {
      source: { id: 'src_github', kind: 'github', name: 'GitHub Issues' },
      externalId: `fixture-${name}`,
      title: `${name} fixture event`,
    },
  });
  saveInbox(settings, first.inbox);
  saveOutbox(settings, emptyOutbox());
  return dir;
}

const repoA = createProject('fixture-a', [
  ['queued', 'Queued fixture'],
  ['blocked', 'Blocked fixture'],
  ['awaiting_review', 'Review fixture'],
]);
const repoB = createProject('fixture-b', [
  ['working', 'Working fixture'],
  ['done', 'Done fixture'],
]);

const server = spawn(process.execPath, [
  join(root, 'server', 'index.mjs'),
  '--port', String(port),
  '--repo', repoA,
  '--repo', repoB,
  '--projects-file', projectsFile,
  '--auth-file', authFile,
  '--audit-file', auditFile,
], {
  cwd: root,
  stdio: 'inherit',
});

let closing = false;
function cleanup(signal = 'SIGTERM') {
  if (closing) return;
  closing = true;
  try {
    server.kill(signal);
  } catch {}
  setTimeout(() => {
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch {}
    process.exit(0);
  }, 250);
}

server.on('exit', (code) => {
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  } catch {}
  process.exit(code ?? 0);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => cleanup(signal));
}
