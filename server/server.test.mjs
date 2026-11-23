import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
      config: {
        repo: 'acme/self-loop',
        webhookSecret: 'test-secret',
      },
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

async function httpFixture(initialState = null) {
  const context = fixture(initialState);
  const api = createApi({ store: context.store, engine: context.engine, publicDir, version: 'test' });
  const server = createServer(api.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    ...context,
    api,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      context.cleanup();
    },
  };
}

function githubRequest(base, {
  event = 'issues',
  delivery = 'delivery-1',
  payload,
  secret = 'test-secret',
  signature,
} = {}) {
  const raw = JSON.stringify(payload);
  const headers = {
    'Content-Type': 'application/json',
    'X-GitHub-Event': event,
    'X-GitHub-Delivery': delivery,
  };
  if (signature !== null) {
    headers['X-Hub-Signature-256'] =
      signature ?? `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  }
  return fetch(`${base}/hooks/github`, {
    method: 'POST',
    headers,
    body: raw,
  });
}

function issuePayload(action = 'opened', number = 42) {
  return {
    action,
    repository: { full_name: 'acme/self-loop' },
    sender: { login: 'octocat' },
    issue: {
      number,
      title: `Webhook issue #${number}`,
      body: 'Create a Ticket from a signed GitHub webhook.',
      labels: [{ name: 'ready-for-agent' }, { name: 'high' }],
    },
  };
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

test('GitHub webhook verifies signatures, dedupes deliveries, and normalizes issues', async () => {
  const context = await httpFixture();
  try {
    const payload = issuePayload();
    const first = await githubRequest(context.base, { payload });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.equal(firstBody.duplicate, false);
    assert.equal(firstBody.event.kind, 'issue.opened');
    assert.equal(firstBody.event.status, 'pending');

    assert.equal(context.store.state.events.length, 1);
    const event = context.store.state.events[0];
    assert.equal(event.externalId, 'GH-42');
    assert.equal(event.actor, 'octocat');
    assert.equal(event.priority, 'high');
    assert.deepEqual(event.labels, ['ready-for-agent', 'high']);
    assert.equal(event.dedupeKey, 'src_test:github:delivery-1');
    assert.equal(context.store.state.sources[0].eventCount, 1);

    const replay = await githubRequest(context.base, { payload });
    assert.equal(replay.status, 202);
    const replayBody = await replay.json();
    assert.equal(replayBody.duplicate, true);
    assert.equal(context.store.state.events.length, 1);
  } finally {
    await context.close();
  }
});

test('GitHub webhook records unsupported and metadata-only events as ignored', async () => {
  const context = await httpFixture();
  try {
    const edited = await githubRequest(context.base, {
      delivery: 'delivery-edit',
      payload: issuePayload('edited', 43),
    });
    assert.equal(edited.status, 202);
    const editedBody = await edited.json();
    assert.equal(editedBody.event.kind, 'issue.updated');
    assert.equal(editedBody.event.status, 'ignored');
    assert.match(editedBody.event.ignoredReason, /字段更新/);

    const unsupported = await githubRequest(context.base, {
      event: 'pull_request',
      delivery: 'delivery-pr',
      payload: {
        action: 'opened',
        repository: { full_name: 'acme/self-loop' },
        pull_request: { number: 7 },
      },
    });
    assert.equal(unsupported.status, 202);
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.event.kind, 'github.pull_request');
    assert.equal(unsupportedBody.event.status, 'ignored');
    assert.match(unsupportedBody.event.ignoredReason, /不支持的 GitHub 事件/);
  } finally {
    await context.close();
  }
});

test('GitHub webhook rejects invalid signatures without writing events', async () => {
  const context = await httpFixture();
  try {
    const payload = issuePayload();
    const invalid = await githubRequest(context.base, {
      delivery: 'delivery-invalid',
      payload,
      signature: 'sha256=deadbeef',
    });
    assert.equal(invalid.status, 401);

    const missing = await githubRequest(context.base, {
      delivery: 'delivery-missing',
      payload,
      signature: null,
    });
    assert.equal(missing.status, 401);

    const wrongRepository = await githubRequest(context.base, {
      delivery: 'delivery-wrong-repo',
      payload: {
        ...payload,
        repository: { full_name: 'other/self-loop' },
      },
    });
    assert.equal(wrongRepository.status, 503);
    assert.equal(context.store.state.events.length, 0);
  } finally {
    await context.close();
  }
});

test('source APIs redact webhook secrets', async () => {
  const context = await httpFixture();
  try {
    const response = await fetch(`${context.base}/api/sources`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.doesNotMatch(body, /test-secret/);
    assert.match(body, /••••••/);

    const overview = await fetch(`${context.base}/api/overview`).then((item) => item.text());
    assert.doesNotMatch(overview, /test-secret/);
    assert.match(overview, /••••••/);

    const patch = await fetch(`${context.base}/api/sources/src_test`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { webhookSecret: 'rotated-secret' } }),
    });
    assert.equal(patch.status, 200);
    const patchBody = await patch.json();
    assert.equal(patchBody.source.config.webhookSecret, '••••••');
    assert.equal(context.store.state.sources[0].config.webhookSecret, 'rotated-secret');
  } finally {
    await context.close();
  }
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
