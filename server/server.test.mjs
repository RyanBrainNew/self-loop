import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { RouterEngine } from './router.mjs';
import { createDemoState } from './seed.mjs';
import { Store, nowIso } from './store.mjs';

const publicDir = fileURLToPath(new URL('./public', import.meta.url));

function minimalState(now = Date.now()) {
  const state = createDemoState(now);
  state.meta.demo = false;
  state.config.workMs = 0;
  state.config.verifyMs = 0;
  state.config.maxConcurrent = 1;
  state.config.maxAttempts = 2;
  state.events = [];
  state.tickets = [];
  state.attempts = [];
  state.deliveries = [];
  state.audit = [];
  state.sources = [
    {
      id: 'src_test',
      name: 'Test Source',
      kind: 'github',
      status: 'healthy',
      createdAt: nowIso(now),
      lastEventAt: null,
      eventCount: 0,
      health: 'test',
      config: {},
    },
  ];
  state.workers = [
    {
      id: 'wrk_test',
      name: 'test-worker',
      kind: 'codex',
      status: 'online',
      paused: false,
      currentTicketId: null,
      lastHeartbeat: nowIso(now),
      capabilities: ['test'],
      concurrency: 1,
    },
  ];
  return state;
}

function fixture(initialState = null) {
  const dir = mkdtempSync(join(tmpdir(), 'self-loop-console-'));
  const store = new Store(join(dir, 'state.json'), {
    initialState: initialState || minimalState(),
  });
  const engine = new RouterEngine(store);
  return {
    dir,
    store,
    engine,
    cleanup() {
      store.save();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function ingest(engine, overrides = {}) {
  return engine.ingestEvent({
    sourceId: 'src_test',
    kind: 'issue.opened',
    title: 'Test task',
    externalId: 'T-1',
    labels: ['test'],
    ...overrides,
  });
}

test('tick consumes an event, creates a ticket, and claims it', () => {
  const { store, engine, cleanup } = fixture();
  const now = Date.now();
  ingest(engine);
  assert.equal(store.state.events.length, 1);
  assert.equal(store.state.events[0].status, 'pending');

  const result = engine.tick(now);
  assert.equal(result.changed, true);
  assert.equal(store.state.events[0].status, 'consumed');
  assert.ok(store.state.events[0].ticketId);
  assert.equal(store.state.tickets.length, 1);
  assert.equal(store.state.tickets[0].state, 'working');
  assert.equal(store.state.attempts.length, 1);
  assert.equal(store.state.workers[0].status, 'busy');
  cleanup();
});

test('duplicate events use the dedupe key and do not create a second ticket', () => {
  const { store, engine, cleanup } = fixture();
  const now = Date.now();
  const first = ingest(engine);
  const second = ingest(engine);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(store.state.events.length, 1);

  engine.tick(now);
  engine.tick(now + 1);
  assert.equal(store.state.tickets.length, 1);
  cleanup();
});

test('events without an external id still get distinct dedupe keys', () => {
  const { store, engine, cleanup } = fixture();
  ingest(engine, { externalId: undefined, title: 'First manual event' });
  ingest(engine, { externalId: undefined, title: 'Second manual event' });
  assert.equal(store.state.events.length, 2);
  const keys = new Set(store.state.events.map((event) => event.dedupeKey));
  assert.equal(keys.size, 2);
  assert.equal(store.state.events.every((event) => !event.dedupeKey.includes('undefined')), true);
  cleanup();
});

test('a passing attempt reaches review and queues outbox deliveries', () => {
  const { store, engine, cleanup } = fixture();
  const now = Date.now();
  ingest(engine);
  engine.tick(now);
  engine.tick(now + 1);
  engine.tick(now + 2);

  const ticket = store.state.tickets[0];
  assert.equal(ticket.state, 'awaiting_review');
  assert.ok(ticket.pr);
  assert.equal(store.state.deliveries.length, 2);
  assert.equal(store.state.workers[0].status, 'online');

  engine.tick(now + 5000);
  assert.equal(store.state.deliveries.every((delivery) => delivery.state === 'sent'), true);
  cleanup();
});

test('a flaky attempt is retried and the second attempt can pass', () => {
  const { store, engine, cleanup } = fixture();
  const now = Date.now();
  ingest(engine);
  engine.tick(now);
  store.state.tickets[0].flaky = true;

  engine.tick(now + 1);
  assert.equal(store.state.tickets[0].state, 'queued');
  assert.equal(store.state.tickets[0].attempts, 1);

  engine.tick(now + 2);
  assert.equal(store.state.tickets[0].state, 'working');
  assert.equal(store.state.attempts.filter((attempt) => attempt.state === 'running').length, 1);

  engine.tick(now + 3);
  engine.tick(now + 4);
  assert.equal(store.state.tickets[0].state, 'awaiting_review');
  assert.equal(store.state.attempts.length, 2);
  cleanup();
});

test('an exhausted attempt blocks for a human and an answer requeues it', () => {
  const { store, engine, cleanup } = fixture();
  const now = Date.now();
  store.state.config.maxAttempts = 1;
  ingest(engine);
  engine.tick(now);
  store.state.tickets[0].failAlways = true;

  engine.tick(now + 1);
  const ticket = store.state.tickets[0];
  assert.equal(ticket.state, 'blocked');
  assert.equal(ticket.attempts, 1);
  assert.ok(ticket.humanQuestion);

  engine.answerTicket(ticket.id, '只支持 Node 20+');
  assert.equal(ticket.state, 'queued');
  assert.equal(ticket.attempts, 0);
  assert.equal(ticket.humanAnswer, '只支持 Node 20+');
  cleanup();
});

test('failed deliveries can be replayed and sources/workers can be toggled', () => {
  const { store, engine, cleanup } = fixture(createDemoState());
  const dead = store.state.deliveries.find((delivery) => delivery.state === 'dead');
  assert.ok(dead);
  engine.replayDelivery(dead.id);
  assert.equal(dead.state, 'pending');
  assert.equal(dead.attempts, 0);

  const source = store.state.sources.find((item) => item.id === 'src_github');
  engine.toggleSource(source.id);
  assert.equal(source.status, 'paused');
  engine.toggleSource(source.id);
  assert.equal(source.status, 'healthy');

  const worker = store.state.workers.find((item) => item.id === 'wrk_codex');
  engine.toggleWorker(worker.id);
  assert.equal(worker.paused, true);
  engine.toggleWorker(worker.id);
  assert.equal(worker.paused, false);
  cleanup();
});

test('the HTTP API serves the console and accepts events', async () => {
  const { store, engine, cleanup } = fixture(createDemoState());
  const api = createApi({ store, engine, publicDir, version: 'test' });
  const server = createServer(api.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${base}/api/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.version, 'test');

    const html = await fetch(`${base}/`).then((response) => response.text());
    assert.match(html, /self-loop console/);

    const snapshot = await fetch(`${base}/api/state`).then((response) => response.json());
    assert.ok(snapshot.tickets.length > 0);
    assert.ok(snapshot.sources.length > 0);

    const created = await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceId: 'src_github',
        kind: 'issue.opened',
        title: 'API smoke event',
        externalId: 'API-1',
      }),
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.ok(createdBody.event.id);

    const tick = await fetch(`${base}/api/tick`, { method: 'POST' });
    assert.equal(tick.status, 200);

    const ticket = await fetch(`${base}/api/tickets?state=all&limit=5`).then((response) =>
      response.json(),
    );
    assert.ok(ticket.tickets.length > 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cleanup();
  }
});
