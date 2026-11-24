import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizeGitHubEvent } from './connectors/github.mjs';
import {
  normalizeSlackCommand,
  normalizeSlackEvent,
  parseSlackBody,
  verifySlackSignature,
} from './connectors/slack.mjs';
import { withTenant } from './hosted-pg.mjs';

const PROVIDERS = new Set(['github', 'slack', 'jira', 'generic']);

export function normalizeBindingExternalId(provider, externalId) {
  const value = String(externalId || '').trim();
  return provider === 'github' ? value.toLowerCase() : value;
}

export class IngressError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function safeEqual(left, right) {
  const actual = Buffer.from(String(left || ''));
  const expected = Buffer.from(String(right || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifyGitHubSignature(secret, rawBody, signature) {
  if (!secret || typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    return false;
  }
  const expected = `sha256=${createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex')}`;
  return safeEqual(signature, expected);
}

function bindingFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    sourceId: row.source_id,
    provider: row.provider,
    externalId: row.external_id,
    credentialId: row.credential_id,
    allowedChannels: Array.isArray(row.allowed_channels) ? row.allowed_channels : [],
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const BINDING_COLUMNS = `
  id, tenant_id, project_id, source_id, provider, external_id, credential_id,
  allowed_channels, enabled, created_at, updated_at
`;

export class PgIngressStore {
  constructor({ pool } = {}) {
    if (!pool?.connect) throw new Error('pool with connect() is required');
    this.pool = pool;
  }

  async resolveBinding({ provider, externalId }) {
    const normalizedId = normalizeBindingExternalId(provider, externalId);
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT id, tenant_id, project_id, source_id, credential_id,
                allowed_channels, enabled
         FROM resolve_connector_binding($1, $2)`,
        [provider, normalizedId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...bindingFromRow(row),
        provider,
        externalId: normalizedId,
      };
    } finally {
      client.release();
    }
  }

  async createBinding({
    tenantId,
    projectId,
    provider,
    externalId,
    credentialId = null,
    sourceId = null,
    allowedChannels = [],
    enabled = true,
  }) {
    if (!tenantId || !projectId) throw new Error('tenantId and projectId are required');
    if (!PROVIDERS.has(provider)) throw new Error(`unsupported connector provider: ${provider}`);
    const normalizedId = normalizeBindingExternalId(provider, externalId);
    if (!normalizedId) throw new Error('externalId is required');
    if (!Array.isArray(allowedChannels)) throw new Error('allowedChannels must be an array');
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO connector_bindings
           (id, tenant_id, project_id, source_id, provider, external_id,
            credential_id, allowed_channels, enabled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (provider, external_id) DO NOTHING
         RETURNING ${BINDING_COLUMNS}`,
        [
          randomUUID(),
          tenantId,
          projectId,
          sourceId,
          provider,
          normalizedId,
          credentialId,
          JSON.stringify(allowedChannels.map(String)),
          Boolean(enabled),
        ],
      );
      return bindingFromRow(result.rows[0]);
    });
  }

  async listBindings({ tenantId, projectId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT ${BINDING_COLUMNS}
         FROM connector_bindings
         WHERE tenant_id = $1 AND project_id = $2
         ORDER BY provider, external_id`,
        [tenantId, projectId],
      );
      return result.rows.map(bindingFromRow);
    });
  }

  async getBinding({ tenantId, projectId, bindingId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `SELECT ${BINDING_COLUMNS}
         FROM connector_bindings
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
        [tenantId, projectId, bindingId],
      );
      return bindingFromRow(result.rows[0]);
    });
  }

  async deleteBinding({ tenantId, projectId, bindingId }) {
    return withTenant(this.pool, tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM connector_bindings
         WHERE tenant_id = $1 AND project_id = $2 AND id = $3
         RETURNING id`,
        [tenantId, projectId, bindingId],
      );
      return Boolean(result.rows[0]);
    });
  }

  async consumeRateLimit({
    binding,
    limit,
    windowSeconds = 60,
  }) {
    const window = Math.max(1, Number(windowSeconds) || 60);
    const max = Math.max(1, Number(limit) || 1);
    return withTenant(this.pool, binding.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO ingress_rate_limits
           (binding_id, tenant_id, project_id, window_start, count)
         VALUES (
           $1, $2, $3,
           to_timestamp(floor(extract(epoch from now()) / $4) * $4),
           1
         )
         ON CONFLICT (binding_id, window_start)
         DO UPDATE SET count = ingress_rate_limits.count + 1
         RETURNING count, window_start`,
        [binding.id, binding.tenantId, binding.projectId, window],
      );
      const row = result.rows[0] || { count: 1 };
      const count = Number(row.count || 1);
      return {
        allowed: count <= max,
        count,
        limit: max,
        windowStart: row.window_start || null,
      };
    });
  }

  async recordEvent({
    binding,
    event,
    eventType,
    dedupeKey,
    status = 'pending',
    payload,
  }) {
    if (!dedupeKey) throw new Error('dedupeKey is required');
    return withTenant(this.pool, binding.tenantId, async (client) => {
      const result = await client.query(
        `INSERT INTO events
           (id, tenant_id, project_id, source_id, type, action, external_id,
            idempotency_key, payload, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
         ON CONFLICT (tenant_id, project_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [
          randomUUID(),
          binding.tenantId,
          binding.projectId,
          String(binding.sourceId || binding.provider),
          eventType,
          String(event.kind || ''),
          event.externalId || null,
          dedupeKey,
          JSON.stringify(payload || {}),
          status,
        ],
      );
      const row = result.rows[0];
      return {
        duplicate: !row,
        id: row?.id || null,
        status,
        kind: event.kind || '',
        ignoredReason: event.ignoredReason || null,
      };
    });
  }
}

function eventTypeFor(kind, provider) {
  const value = String(kind || '');
  if (value === 'task.created') return 'task';
  if (value.includes('.ignored')) return 'manual';
  if (value.startsWith('issue.') || value.startsWith('github.issues')) return 'issue';
  if (value.startsWith('github.pull_request')) return 'pull_request';
  if (value.startsWith('slack.')) return 'task';
  return provider === 'jira' ? 'issue' : 'manual';
}

function header(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

async function secretOrIngressError(credentialStore, binding, field) {
  if (!binding.credentialId) {
    throw new IngressError(503, 'connector credential is not configured');
  }
  let secret;
  try {
    secret = await credentialStore.runtimeSecret({
      tenantId: binding.tenantId,
      projectId: binding.projectId,
      credentialId: binding.credentialId,
    });
  } catch {
    throw new IngressError(503, 'connector credential is unavailable');
  }
  const value = secret?.[field];
  if (!value) throw new IngressError(503, `connector ${field} is not configured`);
  return value;
}

async function enforceRateLimit({ store, binding, limit, windowSeconds }) {
  const result = await store.consumeRateLimit({
    binding,
    limit,
    windowSeconds,
  });
  if (!result.allowed) {
    throw new IngressError(429, 'webhook rate limit exceeded');
  }
  return result;
}

export class HostedIngressService {
  constructor({
    store,
    credentialStore,
    rateLimit = 120,
    rateWindowSeconds = 60,
    now = Date.now,
  } = {}) {
    if (!store) throw new Error('ingress store is required');
    if (!credentialStore) throw new Error('credential store is required');
    this.store = store;
    this.credentialStore = credentialStore;
    this.rateLimit = rateLimit;
    this.rateWindowSeconds = rateWindowSeconds;
    this.now = now;
  }

  async ingestGitHub({ headers, rawBody }) {
    const delivery = header(headers, 'x-github-delivery');
    const eventName = header(headers, 'x-github-event');
    const signature = header(headers, 'x-hub-signature-256');
    if (typeof delivery !== 'string' || !delivery || delivery.length > 200) {
      throw new IngressError(400, 'missing or invalid X-GitHub-Delivery');
    }
    if (typeof eventName !== 'string' || !eventName || eventName.length > 80) {
      throw new IngressError(400, 'missing or invalid X-GitHub-Event');
    }
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new IngressError(400, 'invalid JSON body');
    }
    const repository = String(payload?.repository?.full_name || '');
    if (!repository) throw new IngressError(400, 'GitHub payload has no repository');
    const binding = await this.store.resolveBinding({
      provider: 'github',
      externalId: repository,
    });
    if (!binding) throw new IngressError(404, 'no GitHub connector binding');
    if (!binding.enabled) throw new IngressError(403, 'GitHub connector binding is disabled');
    const secret = await secretOrIngressError(this.credentialStore, binding, 'webhookSecret');
    if (!verifyGitHubSignature(secret, rawBody, signature)) {
      throw new IngressError(401, 'invalid GitHub webhook signature');
    }
    await enforceRateLimit({
      store: this.store,
      binding,
      limit: this.rateLimit,
      windowSeconds: this.rateWindowSeconds,
    });
    const normalized = normalizeGitHubEvent(eventName, payload);
    const event = normalized.eventInput;
    const eventType = eventTypeFor(event.kind, 'github');
    const dedupeKey = `${binding.id}:github:${delivery}`;
    const recorded = await this.store.recordEvent({
      binding,
      event: { ...event, ignoredReason: normalized.ignoredReason },
      eventType,
      dedupeKey,
      status: normalized.ignoredReason ? 'ignored' : 'pending',
      payload: {
        ...event,
        source: {
          id: binding.sourceId || 'github',
          kind: 'github',
          name: `GitHub · ${repository}`,
        },
        ingress: {
          provider: 'github',
          delivery,
          event: eventName,
          repository,
          receivedAt: new Date(this.now()).toISOString(),
        },
      },
    });
    return { ok: true, ...recorded, dedupeKey };
  }

  async ingestSlack({ headers, rawBody, contentType }) {
    const timestamp = header(headers, 'x-slack-request-timestamp');
    const signature = header(headers, 'x-slack-signature');
    let parsed;
    try {
      parsed = parseSlackBody(rawBody, contentType);
    } catch {
      throw new IngressError(400, 'invalid Slack payload');
    }
    const form = parsed.form || {};
    const payload = parsed.json || {};
    const team = String(form.team_id || payload.team_id || '');
    if (!team) throw new IngressError(400, 'Slack payload has no team_id');
    const binding = await this.store.resolveBinding({
      provider: 'slack',
      externalId: team,
    });
    if (!binding) throw new IngressError(404, 'no Slack connector binding');
    if (!binding.enabled) throw new IngressError(403, 'Slack connector binding is disabled');
    const signingSecret = await secretOrIngressError(
      this.credentialStore,
      binding,
      'signingSecret',
    );
    if (!verifySlackSignature(
      signingSecret,
      rawBody,
      timestamp,
      signature,
      this.now(),
    )) {
      throw new IngressError(401, 'invalid or expired Slack signature');
    }
    await enforceRateLimit({
      store: this.store,
      binding,
      limit: this.rateLimit,
      windowSeconds: this.rateWindowSeconds,
    });

    if (payload.type === 'url_verification') {
      return { challenge: String(payload.challenge || '') };
    }

    const allowedChannels = binding.allowedChannels || [];
    const isCommand = Boolean(form.command);
    const normalized = isCommand
      ? normalizeSlackCommand(form, { allowedChannels })
      : normalizeSlackEvent(payload, { allowedChannels });
    const event = normalized.eventInput;
    const eventId = payload.event_id
      || form.trigger_id
      || payload.event?.ts
      || payload.event_time;
    const dedupeKey = `${binding.id}:slack:${eventId || event?.dedupeKey || event?.externalId || 'unknown'}`;
    const fallbackEvent = event || {
      kind: 'slack.ignored',
      externalId: eventId ? `slack:${team}:${eventId}` : null,
      ignoredReason: normalized.ignoredReason || 'unsupported Slack payload',
    };
    const recorded = await this.store.recordEvent({
      binding,
      event: { ...fallbackEvent, ignoredReason: normalized.ignoredReason || null },
      eventType: eventTypeFor(fallbackEvent.kind, 'slack'),
      dedupeKey,
      status: normalized.ignoredReason || !event ? 'ignored' : 'pending',
      payload: {
        ...fallbackEvent,
        ingress: {
          provider: 'slack',
          team,
          channel: String(form.channel_id || payload.event?.channel || ''),
          receivedAt: new Date(this.now()).toISOString(),
        },
      },
    });
    return {
      ok: true,
      ...recorded,
      acknowledgement: normalized.acknowledgement || null,
      dedupeKey,
    };
  }
}
