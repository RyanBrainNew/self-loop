import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveSettings } from './lib.mjs';
import {
  addAutomation,
  loadAutomations,
  runDueAutomations,
} from './automations.mjs';
import {
  claimTicketForWorker,
  completeTicketForWorker,
  createTicket,
  loadState,
  saveState,
} from './router.mjs';
import {
  authenticateWorker,
  heartbeatWorker,
  listWorkers,
  registerWorker,
  revokeWorker,
  rotateWorkerToken,
} from './workers.mjs';
import {
  deliverOutbox,
  enqueueTicketOutbox,
  loadOutbox,
} from './outbox.mjs';
import { createBackup, restoreBackup } from './backup.mjs';
import { metricsText, observabilitySummary } from '../server/observability.mjs';

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'self-loop-ops-'));
  const outDir = join(repo, '.loop');
  mkdirSync(join(outDir, 'tickets'), { recursive: true });
  writeFileSync(join(repo, '.self-loop.json'), `${JSON.stringify({
    githubRepo: 'acme/ops',
    router: { maxConcurrent: 2, maxAttempts: 2 },
  }, null, 2)}\n`);
  const settings = resolveSettings(repo, { worktreeMode: 'external' }, {
    GITHUB_REPOSITORY: '',
  });
  return { repo, outDir, settings };
}

test('automations create one task event per due window', () => {
  const { settings } = fixture();
  const now = Date.parse('2026-11-23T00:00:00.000Z');
  const automation = addAutomation(settings, {
    name: 'daily',
    title: 'check deps',
    body: '## Acceptance\n- [ ] checked',
    everyMinutes: 60,
  }, now);
  const due = runDueAutomations(settings, now);
  assert.equal(due.length, 0);
  assert.equal(automation.nextRunAt, new Date(now + 60 * 60_000).toISOString());
  const firstRun = runDueAutomations(settings, now + 61 * 60_000);
  assert.equal(firstRun.length, 1);
  assert.equal(firstRun[0].event.type, 'task');
  assert.equal(firstRun[0].event.payload.source.kind, 'automation');
  assert.equal(
    loadAutomations(settings).automations[0].lastRunAt,
    new Date(now + 61 * 60_000).toISOString(),
  );
  assert.equal(runDueAutomations(settings, now + 62 * 60_000).length, 0);
  assert.equal(automation.everyMinutes, 60);
});

test('cron automations honor timezone and compute the next weekday run', () => {
  const { settings } = fixture();
  const now = Date.parse('2026-11-23T00:00:00.000Z');
  const automation = addAutomation(settings, {
    name: 'weekday morning',
    title: 'weekday task',
    cron: '0 9 * * 1-5',
    timezone: 'Asia/Shanghai',
  }, now);
  assert.equal(automation.scheduleType, 'cron');
  assert.equal(automation.nextRunAt, '2026-11-23T01:00:00.000Z');
  assert.equal(runDueAutomations(settings, Date.parse('2026-11-23T00:59:00.000Z')).length, 0);
  assert.equal(runDueAutomations(settings, Date.parse('2026-11-23T01:00:00.000Z')).length, 1);
});

test('remote workers register, heartbeat, claim, and complete through the Router', async () => {
  const { repo, settings } = fixture();
  const ticket = createTicket({
    number: 1,
    title: 'remote task',
    body: '## Acceptance\n- [ ] works',
    labels: ['ready-for-agent'],
  }, settings);
  const state = loadState(settings);
  state.tickets['1'] = ticket;
  saveState(settings, state);

  const registered = registerWorker(settings, {
    name: 'box-1',
    kind: 'codex',
    capabilities: ['node', 'git'],
  });
  assert.match(registered.token, /^sw_/);
  assert.equal(listWorkers(settings)[0].name, 'box-1');

  const heartbeat = heartbeatWorker(settings, registered.token, { status: 'online' });
  assert.equal(heartbeat.status, 'online');

  const claimed = await claimTicketForWorker({
    repoRoot: repo,
    settings,
    token: registered.token,
  });
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.ticket.number, 1);
  assert.equal(claimed.ticket.state, 'working');
  assert.equal(claimed.lease.id, '1-1');

  const completed = await completeTicketForWorker({
    settings,
    token: registered.token,
    ticket: 1,
    result: {
      ticket: 1,
      attempt: 1,
      state: 'ready',
      humanText: 'remote worker finished',
      artifactRefs: [],
    },
  });
  assert.equal(completed.ticket.state, 'verifying');
  assert.equal(listWorkers(settings)[0].currentTicketId, null);

  const rotated = rotateWorkerToken(settings, registered.worker.id);
  assert.notEqual(rotated.token, registered.token);
  assert.throws(() => authenticateWorker(settings, registered.token), /unknown or revoked/);
  assert.equal(authenticateWorker(settings, rotated.token).name, 'box-1');
  revokeWorker(settings, registered.worker.id);
  assert.equal(listWorkers(settings).length, 0);
});

test('generic webhook outbox signs and posts the delivery body', async () => {
  const { settings } = fixture();
  const ticket = createTicket({
    number: 2,
    title: 'webhook task',
    body: '## Acceptance\n- [ ] works',
    labels: ['ready-for-agent'],
  }, settings);
  settings.outbox.enabled = true;
  settings.outbox.notifyOn = ['blocked'];
  settings.outbox.adapters.webhook = {
    enabled: true,
    url: 'https://hooks.example/self-loop',
    urlEnv: 'TEST_HOOK_URL',
    secretEnv: 'TEST_HOOK_SECRET',
  };
  const deliveries = enqueueTicketOutbox({
    settings,
    ticket,
    state: 'blocked',
    body: 'Ticket blocked',
  });
  assert.equal(deliveries.length, 1);
  const delivery = loadOutbox(settings).deliveries[0];
  let request = null;
  const result = await deliverOutbox(delivery, settings, {
    env: { TEST_HOOK_SECRET: 'secret' },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response('{}', { status: 202, headers: { 'x-request-id': 'req-1' } });
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-1');
  assert.equal(request.url, 'https://hooks.example/self-loop');
  assert.equal(request.options.headers['X-Self-Loop-Idempotency-Key'], delivery.idempotencyKey);
  assert.equal(
    request.options.headers['X-Self-Loop-Signature'],
    `sha256=${createHmac('sha256', 'secret').update(request.options.body).digest('hex')}`,
  );
  assert.equal(JSON.parse(request.options.body).ticketNumber, 2);
});

test('backup creates a manifest and restore is dry-runnable', () => {
  const { repo, outDir } = fixture();
  const backupDir = join(repo, 'backup');
  writeFileSync(join(outDir, 'state.json'), '{"version":1,"tickets":{}}\n');
  const created = createBackup({
    repoRoot: repo,
    outDir: backupDir,
    now: Date.parse('2026-11-23T00:00:00.000Z'),
  });
  assert.equal(created.ok, true);
  assert.equal(existsSync(join(backupDir, 'manifest.json')), true);
  assert.equal(existsSync(join(backupDir, '.loop', 'state.json')), true);
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.repo, repo);
  assert.ok(manifest.files >= 1);
  const restored = restoreBackup({
    repoRoot: repo,
    backupDir,
    dryRun: true,
  });
  assert.equal(restored.ok, true);
  assert.ok(restored.files >= 1);
});

test('observability exposes Prometheus metrics and a JSON summary', () => {
  const snapshot = {
    meta: { paused: false, lastTickAt: '2026-11-23T00:00:00.000Z' },
    config: { maxConcurrent: 2 },
    health: { uptimeSeconds: 12 },
    sources: [{ status: 'healthy' }, { status: 'degraded' }],
    events: [{ status: 'pending' }],
    tickets: [{ state: 'working' }, { state: 'done' }],
    deliveries: [{ state: 'dead' }],
    workers: [{ status: 'online' }, { status: 'busy' }],
    automations: [{ enabled: true }],
  };
  const text = metricsText(snapshot);
  assert.match(text, /self_loop_tickets\{state="working"\} 1/);
  assert.match(text, /self_loop_outbox_deliveries\{state="dead"\} 1/);
  const summary = observabilitySummary(snapshot);
  assert.equal(summary.queues.inboxPending, 1);
  assert.equal(summary.workers.online, 2);
  assert.equal(summary.router.paused, false);
});
