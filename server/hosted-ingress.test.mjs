import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  HostedIngressService,
  IngressError,
  PgIngressStore,
  verifyGitHubSignature,
} from './hosted-ingress.mjs';

function fakePool(handler) {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(text, values = []) {
          queries.push({ text: text.replace(/\s+/g, ' ').trim(), values });
          return handler(text, values);
        },
        release() {},
      };
    },
  };
  return { pool, queries };
}

function githubSignature(secret, body) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function slackSignature(secret, timestamp, body) {
  return `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${body}`)
    .digest('hex')}`;
}

function serviceFixture({ allowed = true } = {}) {
  const events = [];
  const binding = {
    id: 'binding-1',
    tenantId: 'tenant-a',
    projectId: 'project-1',
    sourceId: 'source-1',
    provider: 'github',
    externalId: 'acme/repo',
    credentialId: 'credential-1',
    allowedChannels: [],
    enabled: true,
  };
  const store = {
    async resolveBinding({ provider, externalId }) {
      if (provider === 'slack' && externalId === 'T1') {
        return {
          ...binding,
          id: 'binding-slack',
          provider: 'slack',
          externalId: 'T1',
          allowedChannels: ['C1'],
        };
      }
      return externalId === 'acme/repo' ? binding : null;
    },
    async consumeRateLimit() {
      return { allowed, count: allowed ? 1 : 999, limit: 1 };
    },
    async recordEvent(input) {
      events.push(input);
      return {
        duplicate: false,
        id: 'event-1',
        status: input.status,
        kind: input.event.kind,
        ignoredReason: input.event.ignoredReason || null,
      };
    },
  };
  const credentialStore = {
    async runtimeSecret() {
      return {
        webhookSecret: 'github-secret',
        signingSecret: 'slack-secret',
      };
    },
  };
  return {
    service: new HostedIngressService({
      store,
      credentialStore,
      rateLimit: 1,
    }),
    events,
  };
}

test('hosted GitHub ingress verifies signatures, routes by repository, and dedupes', async () => {
  const { service, events } = serviceFixture();
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/repo' },
    issue: {
      number: 7,
      title: 'Fix login',
      body: 'The login form fails',
      labels: [{ name: 'high' }],
    },
    sender: { login: 'alice' },
  });
  const result = await service.ingestGitHub({
    headers: {
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'issues',
      'x-hub-signature-256': githubSignature('github-secret', body),
    },
    rawBody: body,
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'pending');
  assert.equal(result.kind, 'issue.opened');
  assert.match(result.dedupeKey, /binding-1:github:delivery-1/);
  assert.equal(events[0].eventType, 'issue');
  assert.equal(events[0].payload.ingress.repository, 'acme/repo');
  assert.equal(events[0].payload.connector, undefined);
});

test('hosted GitHub ingress rejects bad signatures and rate limits', async () => {
  const { service } = serviceFixture();
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/repo' },
    issue: { number: 7, title: 'Fix', body: '', labels: [] },
  });
  await assert.rejects(
    () => service.ingestGitHub({
      headers: {
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'issues',
        'x-hub-signature-256': 'sha256=bad',
      },
      rawBody: body,
    }),
    (error) => error instanceof IngressError && error.statusCode === 401,
  );

  const limited = serviceFixture({ allowed: false }).service;
  await assert.rejects(
    () => limited.ingestGitHub({
      headers: {
        'x-github-delivery': 'delivery-2',
        'x-github-event': 'issues',
        'x-hub-signature-256': githubSignature('github-secret', body),
      },
      rawBody: body,
    }),
    (error) => error instanceof IngressError && error.statusCode === 429,
  );
  assert.equal(verifyGitHubSignature('github-secret', body, githubSignature('github-secret', body)), true);
});

test('hosted Slack ingress verifies signatures, challenges, and slash commands', async () => {
  const { service, events } = serviceFixture();
  const timestamp = Math.floor(Date.now() / 1000);
  const challengeBody = JSON.stringify({
    type: 'url_verification',
    challenge: 'challenge-1',
    team_id: 'T1',
  });
  const challenge = await service.ingestSlack({
    headers: {
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': slackSignature('slack-secret', timestamp, challengeBody),
    },
    rawBody: challengeBody,
    contentType: 'application/json',
  });
  assert.equal(challenge.challenge, 'challenge-1');

  const form = new URLSearchParams({
    command: '/loop',
    team_id: 'T1',
    channel_id: 'C1',
    user_id: 'U1',
    trigger_id: 'trigger-1',
    text: 'Fix login | login works; tests pass',
  }).toString();
  const command = await service.ingestSlack({
    headers: {
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': slackSignature('slack-secret', timestamp, form),
    },
    rawBody: form,
    contentType: 'application/x-www-form-urlencoded',
  });
  assert.match(command.acknowledgement, /Fix login/);
  assert.equal(command.kind, 'task.created');
  assert.equal(events.at(-1).eventType, 'task');
  assert.equal(events.at(-1).payload.acceptance.length, 2);
});

test('hosted Slack ingress rejects stale signatures', async () => {
  const { service } = serviceFixture();
  const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;
  const body = JSON.stringify({ type: 'event_callback', team_id: 'T1', event: {} });
  await assert.rejects(
    () => service.ingestSlack({
      headers: {
        'x-slack-request-timestamp': String(oldTimestamp),
        'x-slack-signature': slackSignature('slack-secret', oldTimestamp, body),
      },
      rawBody: body,
      contentType: 'application/json',
    }),
    (error) => error instanceof IngressError && error.statusCode === 401,
  );
});

test('PostgreSQL ingress resolves bindings and enforces tenant-scoped limits', async () => {
  const context = fakePool((text, values) => {
    if (text.includes('FROM resolve_connector_binding')) {
      return {
        rows: [{
          id: 'binding-1',
          tenant_id: 'tenant-a',
          project_id: 'project-1',
          source_id: 'source-1',
          credential_id: 'credential-1',
          allowed_channels: [],
          enabled: true,
        }],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO connector_bindings')) {
      return {
        rows: [{
          id: values[0],
          tenant_id: values[1],
          project_id: values[2],
          source_id: values[3],
          provider: values[4],
          external_id: values[5],
          credential_id: values[6],
          allowed_channels: [],
          enabled: values[8],
          created_at: '2026-11-24T00:00:00Z',
          updated_at: '2026-11-24T00:00:00Z',
        }],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO ingress_rate_limits')) {
      return { rows: [{ count: 2, window_start: '2026-11-24T00:00:00Z' }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO events')) {
      return { rows: [{ id: 'event-1' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const store = new PgIngressStore({ pool: context.pool });
  const binding = await store.resolveBinding({
    provider: 'github',
    externalId: 'ACME/Repo',
  });
  assert.equal(binding.tenantId, 'tenant-a');
  const resolution = context.queries.find((item) => item.text.includes('resolve_connector_binding'));
  assert.deepEqual(resolution.values, ['github', 'acme/repo']);

  const created = await store.createBinding({
    tenantId: 'tenant-a',
    projectId: 'project-1',
    provider: 'github',
    externalId: 'ACME/Repo',
    credentialId: 'credential-1',
  });
  assert.equal(created.externalId, 'acme/repo');
  const insert = context.queries.find((item) => item.text.includes('INSERT INTO connector_bindings'));
  assert.match(insert.text, /tenant_id/);
  assert.match(insert.text, /ON CONFLICT \(provider, external_id\)/);

  const limit = await store.consumeRateLimit({
    binding,
    limit: 1,
    windowSeconds: 60,
  });
  assert.equal(limit.allowed, false);
  const rateQuery = context.queries.find((item) => item.text.includes('INSERT INTO ingress_rate_limits'));
  assert.deepEqual(rateQuery.values, ['binding-1', 'tenant-a', 'project-1', 60]);

  const recorded = await store.recordEvent({
    binding,
    event: { kind: 'issue.opened', externalId: 'GH-7' },
    eventType: 'issue',
    dedupeKey: 'dedupe-1',
    payload: { ok: true },
  });
  assert.equal(recorded.id, 'event-1');
  const eventQuery = context.queries.find((item) => item.text.includes('INSERT INTO events'));
  assert.match(eventQuery.text, /tenant_id/);
  assert.match(eventQuery.text, /ON CONFLICT \(tenant_id, project_id, idempotency_key\)/);
});
