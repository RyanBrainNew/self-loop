import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { createAuth } from './auth.mjs';
import { ConsoleAudit } from './console-audit.mjs';
import { DemoBackend } from './demo-backend.mjs';
import { ProjectBackend, ProjectRegistry } from './project.mjs';
import { ProjectStore } from './project-store.mjs';
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
  const auth = createAuth({ tokenFile: join(context.dir, 'console-token') });
  const audit = new ConsoleAudit(join(context.dir, 'console-audit.json'));
  const backend = new DemoBackend({ store: context.store, engine: context.engine });
  const api = createApi({ backend, auth, audit, publicDir, version: 'test' });
  const server = createServer(api.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    ...context,
    api,
    auth,
    token: auth.token,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      context.cleanup();
    },
  };
}

function writeHeaders(context, extra = {}) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${context.token}`,
    ...extra,
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
      headers: writeHeaders(context),
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
  const context = await httpFixture(createDemoState());
  const base = context.base;
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
      headers: writeHeaders(context),
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

    const tick = await fetch(`${base}/api/tick`, {
      method: 'POST',
      headers: writeHeaders(context),
    });
    assert.equal(tick.status, 200);

    const ticket = await fetch(`${base}/api/tickets?state=all&limit=5`).then((response) =>
      response.json(),
    );
    assert.ok(ticket.tickets.length > 0);
  } finally {
    await context.close();
  }
});

test('write token and Origin protection reject unauthorized mutations', async () => {
  const context = await httpFixture();
  try {
    const payload = JSON.stringify({
      sourceId: 'src_test',
      kind: 'issue.opened',
      title: 'unauthorized',
      externalId: 'NO-AUTH',
    });
    const missing = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(missing.status, 401);

    const wrong = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer slc_bad' },
      body: payload,
    });
    assert.equal(wrong.status, 401);

    const crossSite = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: writeHeaders(context, { Origin: 'https://evil.example' }),
      body: payload,
    });
    assert.equal(crossSite.status, 403);

    const sameSite = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: writeHeaders(context, { Origin: context.base }),
      body: payload,
    });
    assert.equal(sameSite.status, 201);
  } finally {
    await context.close();
  }
});

test('the console session cookie authenticates writes and tokens never appear in reads', async () => {
  const context = await httpFixture();
  try {
    const page = await fetch(`${context.base}/`);
    const setCookie = page.headers.get('set-cookie') || '';
    assert.match(setCookie, /self_loop_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    const cookie = setCookie.split(';')[0];

    const created = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        sourceId: 'src_test',
        kind: 'issue.opened',
        title: 'cookie write',
        externalId: 'COOKIE-1',
      }),
    });
    assert.equal(created.status, 201);

    const stateText = await fetch(`${context.base}/api/state`).then((response) => response.text());
    assert.doesNotMatch(stateText, new RegExp(context.token));
    const healthText = await fetch(`${context.base}/api/health`).then((response) => response.text());
    assert.doesNotMatch(healthText, new RegExp(context.token));

    const crossSiteRead = await fetch(`${context.base}/api/state`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossSiteRead.status, 403);
  } finally {
    await context.close();
  }
});

test('token files are stable, rotation invalidates old credentials, and audits identify the actor', async () => {
  const context = await httpFixture();
  try {
    const page = await fetch(`${context.base}/`);
    const oldCookie = (page.headers.get('set-cookie') || '').split(';')[0];

    const rotated = await fetch(`${context.base}/api/auth/rotate`, {
      method: 'POST',
      headers: { Cookie: oldCookie },
    });
    assert.equal(rotated.status, 200);
    const body = await rotated.json();
    assert.notEqual(body.token, context.token);
    const newCookie = (rotated.headers.get('set-cookie') || '').split(';')[0];
    assert.match(newCookie, /self_loop_session=/);

    const oldBearer = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: writeHeaders(context),
      body: JSON.stringify({
        sourceId: 'src_test',
        kind: 'issue.opened',
        title: 'old token',
        externalId: 'OLD-TOKEN',
      }),
    });
    assert.equal(oldBearer.status, 401);

    const oldSession = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: oldCookie },
      body: JSON.stringify({
        sourceId: 'src_test',
        kind: 'issue.opened',
        title: 'old session',
        externalId: 'OLD-SESSION',
      }),
    });
    assert.equal(oldSession.status, 401);

    const newSession = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: newCookie },
      body: JSON.stringify({
        sourceId: 'src_test',
        kind: 'issue.opened',
        title: 'new session',
        externalId: 'NEW-SESSION',
      }),
    });
    assert.equal(newSession.status, 201);

    const audit = await fetch(`${context.base}/api/audit`).then((response) => response.json());
    assert.ok(audit.consoleAudit.some((entry) => entry.action === 'auth.rotated'));
    assert.ok(audit.consoleAudit.some((entry) => entry.action === 'event.injected'));
  } finally {
    await context.close();
  }
});

function coreState(number, title, state = 'blocked') {
  const at = nowIso();
  return {
    version: 1,
    repo: 'acme/real',
    activeTicket: number,
    updatedAt: at,
    tickets: {
      [number]: {
        number,
        title,
        body: [
          `## ${title}`,
          '',
          '## Acceptance',
          '- [ ] Router reads the real .loop state',
        ].join('\n'),
        url: `https://github.com/acme/real/issues/${number}`,
        labels: ['ready-for-agent'],
        state,
        attempts: 2,
        maxAttempts: 2,
        manualRecoveries: 0,
        claim: { by: 'self-loop', at },
        lease: null,
        branch: `loop/${number}-real-ticket`,
        worktree: null,
        pr: null,
        lastResult: null,
        verification: null,
        artifacts: [],
        humanQuestion: 'Need a human decision',
        createdAt: at,
        updatedAt: at,
      },
    },
  };
}

function projectDirectory(number, title, state) {
  const dir = mkdtempSync(join(tmpdir(), 'self-loop-project-'));
  mkdirSync(join(dir, '.loop'), { recursive: true });
  writeFileSync(join(dir, '.self-loop.json'), `${JSON.stringify({ githubRepo: 'acme/real' }, null, 2)}\n`);
  const at = nowIso();
  writeFileSync(join(dir, '.loop', 'state.json'), `${JSON.stringify(coreState(number, title, state), null, 2)}\n`);
  writeFileSync(
    join(dir, '.loop', 'inbox.json'),
    `${JSON.stringify({
      version: 1,
      events: [
        {
          id: `evt-${number}`,
          type: 'issue',
          action: 'opened',
          ticket: number,
          payload: { issue: { title, body: 'real issue' } },
          createdAt: at,
          handledAt: at,
          outcome: 'ok',
          error: null,
        },
      ],
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, '.loop', 'outbox.json'),
    `${JSON.stringify({
      version: 1,
      updatedAt: at,
      deliveries: [
        {
          id: `out_${number}`,
          ticket: number,
          ticketTitle: title,
          attempt: 2,
          ticketState: 'blocked',
          channel: 'github',
          target: `acme/real#${number}`,
          kind: 'ticket.status',
          body: 'status',
          idempotencyKey: `self-loop:ticket:${number}:blocked`,
          state: 'dead',
          attempts: 5,
          maxAttempts: 5,
          nextAttemptAt: null,
          lastError: 'HTTP 401',
          statusCode: 401,
          requestId: 'req-real',
          createdAt: at,
          updatedAt: at,
          sentAt: null,
        },
      ],
    }, null, 2)}\n`,
  );
  return dir;
}

async function projectFixture(count = 1) {
  const dirs = [];
  for (let index = 0; index < count; index += 1) {
    dirs.push(projectDirectory(70 + index, `Real ticket ${index + 1}`, 'blocked'));
  }
  const storeFile = join(dirs[0], 'projects.json');
  const store = new ProjectStore(storeFile);
  for (const dir of dirs) store.add(dir);
  const registry = new ProjectRegistry(store.list(), {
    store,
    currentId: store.current()?.id,
    env: { ...process.env, GITHUB_REPOSITORY: 'noise/console-repo' },
  });
  const backend = new ProjectBackend(registry);
  const auth = createAuth({ tokenFile: join(dirs[0], 'console-token') });
  const audit = new ConsoleAudit(join(dirs[0], 'console-audit.json'));
  const api = createApi({ backend, auth, audit, publicDir, version: 'test' });
  const server = createServer(api.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    dirs,
    store,
    storeFile,
    registry,
    backend,
    token: auth.token,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
      }
    },
  };
}

test('project mode reads the real .loop state and delegates recover to the router lock boundary', async () => {
  const context = await projectFixture();
  try {
    const snapshot = await fetch(`${context.base}/api/state`).then((response) => response.json());
    assert.equal(snapshot.capabilities.mode, 'project');
    assert.equal(snapshot.capabilities.liveState, true);
    assert.equal(snapshot.capabilities.outbox, true);
    assert.equal(snapshot.capabilities.projectAdd, true);
    assert.equal(snapshot.deliveries.length, 1);
    assert.equal(snapshot.deliveries[0].state, 'dead');
    assert.equal(snapshot.tickets.length, 1);
    assert.equal(snapshot.tickets[0].number, 70);
    assert.equal(snapshot.tickets[0].title, 'Real ticket 1');
    assert.equal(snapshot.tickets[0].state, 'blocked');
    assert.equal(snapshot.tickets[0].attempts, 2);
    assert.equal(snapshot.tickets[0].currentAttemptId, null);
    assert.equal(snapshot.sources[0].config.repo, 'acme/real');

    const unauthorized = await fetch(`${context.base}/api/tickets/tkt_70/retry`, {
      method: 'POST',
    });
    assert.equal(unauthorized.status, 401);

    const retried = await fetch(`${context.base}/api/tickets/tkt_70/retry`, {
      method: 'POST',
      headers: writeHeaders({ token: context.token }),
    });
    assert.equal(retried.status, 200);
    const state = JSON.parse(readFileSync(join(context.dirs[0], '.loop', 'state.json'), 'utf8'));
    assert.equal(state.tickets['70'].state, 'queued');
    assert.equal(state.tickets['70'].manualRecoveries, 1);

    const replay = await fetch(`${context.base}/api/outbox/out_70/replay`, {
      method: 'POST',
      headers: writeHeaders({ token: context.token }),
    });
    assert.equal(replay.status, 200);
    const outbox = JSON.parse(readFileSync(join(context.dirs[0], '.loop', 'outbox.json'), 'utf8'));
    assert.equal(outbox.deliveries[0].state, 'pending');

    const cancelled = await fetch(`${context.base}/api/tickets/tkt_70/cancel`, {
      method: 'POST',
      headers: writeHeaders({ token: context.token }),
    });
    assert.equal(cancelled.status, 200);
    const afterCancel = JSON.parse(readFileSync(join(context.dirs[0], '.loop', 'state.json'), 'utf8'));
    assert.equal(afterCancel.tickets['70'].state, 'dropped');

    const inject = await fetch(`${context.base}/api/events`, {
      method: 'POST',
      headers: writeHeaders({ token: context.token }),
      body: JSON.stringify({ sourceId: 'src_github', title: 'nope' }),
    });
    assert.equal(inject.status, 409);
  } finally {
    await context.close();
  }
});

test('project mode can switch between allowlisted repositories from the UI API', async () => {
  const context = await projectFixture(2);
  const extra = projectDirectory(72, 'Real ticket 3', 'queued');
  context.dirs.push(extra);
  try {
    const projects = await fetch(`${context.base}/api/projects`).then((response) => response.json());
    assert.equal(projects.items.length, 2);
    assert.equal(projects.items[0].current, true);

    const selected = await fetch(`${context.base}/api/projects/select`, {
      method: 'POST',
      headers: writeHeaders({ token: context.token }),
      body: JSON.stringify({ id: projects.items[1].id }),
    });
    assert.equal(selected.status, 200);

    const snapshot = await fetch(`${context.base}/api/state`).then((response) => response.json());
    assert.equal(snapshot.config.project.id, projects.items[1].id);
    assert.equal(snapshot.tickets[0].number, 71);
    assert.equal(snapshot.projects.currentId, projects.items[1].id);

    const unauthorized = await fetch(`${context.base}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: extra }),
    });
    assert.equal(unauthorized.status, 401);

    const added = await fetch(`${context.base}/api/projects`, {
      method: 'POST',
      headers: writeHeaders({ token: context.token }),
      body: JSON.stringify({ path: extra, name: 'Third repo' }),
    });
    assert.equal(added.status, 201);
    const addedBody = await added.json();
    assert.equal(addedBody.added, true);
    assert.equal(addedBody.projects.items.length, 3);

    const reopened = new ProjectStore(context.storeFile);
    assert.equal(reopened.list().length, 3);
    assert.equal(reopened.current().id, addedBody.project.id);
    assert.equal(reopened.list().find((item) => item.id === addedBody.project.id).name, 'Third repo');

    const current = await fetch(`${context.base}/api/projects/${addedBody.project.id}`, {
      method: 'DELETE',
      headers: writeHeaders({ token: context.token }),
    });
    assert.equal(current.status, 200);
    const afterRemove = await current.json();
    assert.equal(afterRemove.projects.items.length, 2);
    assert.equal(afterRemove.projects.currentId, projects.items[1].id);

    const removed = await fetch(`${context.base}/api/projects/${projects.items[1].id}`, {
      method: 'DELETE',
      headers: writeHeaders({ token: context.token }),
    });
    assert.equal(removed.status, 200);
    const last = await fetch(`${context.base}/api/projects/${projects.items[0].id}`, {
      method: 'DELETE',
      headers: writeHeaders({ token: context.token }),
    });
    assert.equal(last.status, 409);
  } finally {
    await context.close();
  }
});

test('project registry persists the selected project and protects the last entry', () => {
  const dirs = [projectDirectory(80, 'Registry A', 'queued'), projectDirectory(81, 'Registry B', 'queued')];
  try {
    const file = join(dirs[0], 'projects.json');
    const store = new ProjectStore(file);
    const first = store.add(dirs[0]).project;
    const second = store.add(dirs[1]).project;
    assert.equal(store.current().id, first.id);

    store.select(second.id);
    const reopened = new ProjectStore(file);
    assert.equal(reopened.list().length, 2);
    assert.equal(reopened.current().id, second.id);

    reopened.remove(first.id);
    assert.equal(reopened.current().id, second.id);
    assert.throws(
      () => reopened.remove(second.id),
      /cannot remove the last registered project/,
    );
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
