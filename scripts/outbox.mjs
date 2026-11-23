// Durable outbound delivery queue. The Router only enqueues here; network
// calls happen in an explicit `router outbox flush` step.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { loadSqliteOutbox, saveSqliteOutbox } from './sqlite-store.mjs';

export const OUTBOX_VERSION = 1;
export const OUTBOX_MARKER_PREFIX = '<!-- self-loop:outbox:';

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function makeId() {
  return `out_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

export function outboxPath(settings) {
  return join(settings.outDir, 'outbox.json');
}

export function emptyOutbox() {
  return {
    version: OUTBOX_VERSION,
    updatedAt: null,
    deliveries: [],
  };
}

export function loadOutbox(settings) {
  if (settings.storage?.backend === 'sqlite') return loadSqliteOutbox(settings);
  const file = outboxPath(settings);
  if (!existsSync(file)) return emptyOutbox();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('outbox must be a JSON object');
  }
  if (!Array.isArray(parsed.deliveries)) parsed.deliveries = [];
  parsed.version ??= OUTBOX_VERSION;
  return parsed;
}

export function saveOutbox(settings, outbox, now = Date.now()) {
  outbox.updatedAt = nowIso(now);
  if (settings.storage?.backend === 'sqlite') {
    saveSqliteOutbox(settings, outbox);
    return outbox;
  }
  writeJsonAtomic(outboxPath(settings), outbox);
  return outbox;
}

function issueKey(ticket) {
  if (ticket.externalKey && /^[A-Z][A-Z0-9]+-\d+$/.test(ticket.externalKey)) {
    return ticket.externalKey;
  }
  const source = `${ticket.url || ''} ${ticket.externalKey || ''}`;
  const match = source.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return match?.[1] || ticket.externalKey || String(ticket.number);
}

function messageBody(ticket, body, key) {
  const marker = `${OUTBOX_MARKER_PREFIX}${key} -->`;
  return `${String(body || '').trim()}\n\n${marker}`;
}

function targetsFor({ settings, ticket }) {
  const adapters = settings.outbox.adapters;
  const targets = [];
  const sourceKind = ticket.source?.kind || 'github';
  if (adapters.github.enabled && sourceKind === 'github') {
    const repo = adapters.github.repo || settings.githubRepo;
    if (repo && ticket.number) {
      targets.push({
        channel: 'github',
        target: `${repo}#${ticket.number}`,
        config: { repo, issue: Number(ticket.number) },
      });
    }
  }
  if (adapters.jira.enabled) {
    const key = issueKey(ticket);
    if (sourceKind === 'jira' || /^[A-Z][A-Z0-9]+-\d+$/.test(key)) {
      targets.push({
        channel: 'jira',
        target: key,
        config: { issueKey: key },
      });
    }
  }
  if (adapters.slack.enabled) {
    const channel = ticket.connector?.channel || adapters.slack.channel || 'webhook';
    const threadTs = ticket.connector?.threadTs || ticket.slackThreadTs || '';
    targets.push({
      channel: 'slack',
      target: threadTs ? `${channel}:${threadTs}` : channel,
      config: {
        channel: ticket.connector?.channel || adapters.slack.channel || '',
        threadTs,
      },
    });
  }
  return targets;
}

export function enqueueTicketOutbox({
  settings,
  ticket,
  state,
  body,
  now = Date.now(),
} = {}) {
  if (!settings.outbox.enabled || !ticket?.number) return [];
  if (!settings.outbox.notifyOn.includes(state)) return [];
  const outbox = loadOutbox(settings);
  const created = [];
  for (const destination of targetsFor({ settings, ticket })) {
    const key = [
      'self-loop',
      'ticket',
      ticket.number,
      'attempt',
      ticket.attempts || 0,
      'state',
      state,
      destination.channel,
      destination.target,
    ].join(':');
    if (outbox.deliveries.some((delivery) => delivery.idempotencyKey === key)) continue;
    const at = nowIso(now);
    const delivery = {
      id: makeId(),
      ticket: Number(ticket.number),
      ticketTitle: ticket.title || '',
      attempt: Number(ticket.attempts || 0),
      ticketState: state,
      channel: destination.channel,
      target: destination.target,
      kind: 'ticket.status',
      body: messageBody(ticket, body, key),
      idempotencyKey: key,
      config: destination.config,
      state: 'pending',
      attempts: 0,
      maxAttempts: settings.outbox.maxAttempts,
      nextAttemptAt: at,
      lastAttemptAt: null,
      sentAt: null,
      requestId: null,
      statusCode: null,
      lastError: null,
      createdAt: at,
      updatedAt: at,
    };
    outbox.deliveries.unshift(delivery);
    created.push(delivery);
  }
  if (created.length) {
    outbox.deliveries = outbox.deliveries.slice(0, 2000);
    saveOutbox(settings, outbox, now);
  }
  return created;
}

function retryDelayMs(delivery, settings) {
  const exponent = Math.max(0, delivery.attempts - 1);
  return Math.min(settings.outbox.maxDelayMs, settings.outbox.baseDelayMs * 2 ** exponent);
}

function retryAfterMs(value, now) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function claimOutboxBatch(settings, { limit = 20, now = Date.now() } = {}) {
  const outbox = loadOutbox(settings);
  const claimed = [];
  let changed = false;
  const staleMs = Math.max(settings.outbox.requestTimeoutMs * 2, 60_000);
  for (const delivery of outbox.deliveries) {
    if (delivery.state !== 'sending') continue;
    const started = Date.parse(delivery.lastAttemptAt || delivery.updatedAt || 0);
    if (started && now - started <= staleMs) continue;
    delivery.state = (delivery.attempts || 0) >= (delivery.maxAttempts || settings.outbox.maxAttempts)
      ? 'dead'
      : 'failed';
    delivery.lastError = 'delivery interrupted before completion';
    delivery.nextAttemptAt = nowIso(now);
    delivery.updatedAt = nowIso(now);
    changed = true;
  }
  for (const delivery of outbox.deliveries) {
    if (claimed.length >= limit) break;
    if (!['pending', 'failed'].includes(delivery.state)) continue;
    if (Date.parse(delivery.nextAttemptAt || 0) > now) continue;
    delivery.state = 'sending';
    delivery.attempts = Number(delivery.attempts || 0) + 1;
    delivery.lastAttemptAt = nowIso(now);
    delivery.updatedAt = nowIso(now);
    claimed.push(structuredClone(delivery));
    changed = true;
  }
  if (changed) saveOutbox(settings, outbox, now);
  return claimed;
}

function requestId(headers) {
  return headers?.get?.('x-github-request-id')
    || headers?.get?.('x-request-id')
    || headers?.get?.('x-slack-req-id')
    || null;
}

async function responseBody(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text.slice(0, 2000);
  }
}

async function githubDelivery(delivery, settings, { fetchImpl, env, signal }) {
  const config = settings.outbox.adapters.github;
  const token = env[config.tokenEnv];
  if (!token) throw Object.assign(new Error(`missing ${config.tokenEnv}`), { permanent: true });
  const base = `${config.apiBaseUrl.replace(/\/$/, '')}/repos/${delivery.config.repo}/issues/${delivery.config.issue}/comments`;
  const marker = `${OUTBOX_MARKER_PREFIX}${delivery.idempotencyKey} -->`;
  const existingResponse = await fetchImpl(`${base}?per_page=100`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'self-loop-outbox',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    signal,
  });
  if (existingResponse.ok) {
    const comments = await responseBody(existingResponse);
    if (Array.isArray(comments) && comments.some((comment) => String(comment.body || '').includes(marker))) {
      return {
        status: 200,
        headers: existingResponse.headers,
        body: { duplicate: true },
        id: existingResponse.headers?.get?.('x-github-request-id') || null,
      };
    }
  }
  const response = await fetchImpl(base, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'self-loop-outbox',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ body: delivery.body }),
    signal,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await responseBody(response),
    id: response.headers?.get?.('x-github-request-id') || null,
  };
}

async function jiraDelivery(delivery, settings, { fetchImpl, env, signal }) {
  const config = settings.outbox.adapters.jira;
  const token = env[config.tokenEnv];
  if (!token) throw Object.assign(new Error(`missing ${config.tokenEnv}`), { permanent: true });
  if (!config.baseUrl || !config.email) {
    throw Object.assign(new Error('jira baseUrl and email are required'), { permanent: true });
  }
  const auth = Buffer.from(`${config.email}:${token}`).toString('base64');
  const base = `${config.baseUrl.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(delivery.config.issueKey)}/comment`;
  const marker = `${OUTBOX_MARKER_PREFIX}${delivery.idempotencyKey} -->`;
  const existingResponse = await fetchImpl(`${base}?maxResults=100`, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (existingResponse.ok) {
    const comments = await responseBody(existingResponse);
    if (JSON.stringify(comments || {}).includes(marker)) {
      return {
        status: 200,
        headers: existingResponse.headers,
        body: { duplicate: true },
        id: existingResponse.headers?.get?.('x-arequestid') || null,
      };
    }
  }
  const response = await fetchImpl(base, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: delivery.body }],
          },
        ],
      },
    }),
    signal,
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await responseBody(response),
    id: response.headers?.get?.('x-arequestid') || null,
  };
}

async function slackDelivery(delivery, settings, { fetchImpl, env, signal }) {
  const config = settings.outbox.adapters.slack;
  const botToken = env[config.botTokenEnv];
  const webhookUrl = env[config.webhookUrlEnv];
  const payload = {
    text: delivery.body,
    ...(delivery.config.channel ? { channel: delivery.config.channel } : {}),
    ...(delivery.config.threadTs ? { thread_ts: delivery.config.threadTs } : {}),
    client_msg_id: delivery.idempotencyKey,
  };
  let url;
  let headers = { 'Content-Type': 'application/json' };
  let body;
  if (botToken && delivery.config.channel) {
    url = `${config.apiBaseUrl.replace(/\/$/, '')}/chat.postMessage`;
    headers = { ...headers, Authorization: `Bearer ${botToken}` };
    body = JSON.stringify(payload);
  } else if (webhookUrl) {
    url = webhookUrl;
    body = JSON.stringify({ text: delivery.body });
  } else {
    throw Object.assign(
      new Error(`missing ${config.botTokenEnv} with channel, or ${config.webhookUrlEnv}`),
      { permanent: true },
    );
  }
  const response = await fetchImpl(url, { method: 'POST', headers, body, signal });
  return {
    status: response.status,
    headers: response.headers,
    body: await responseBody(response),
    id: response.headers?.get?.('x-slack-req-id') || null,
  };
}

const DELIVERERS = {
  github: githubDelivery,
  jira: jiraDelivery,
  slack: slackDelivery,
};

export async function deliverOutbox(delivery, settings, {
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const deliverer = DELIVERERS[delivery.channel];
  if (!deliverer) {
    return { ok: false, permanent: true, error: `unknown outbox channel: ${delivery.channel}` };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings.outbox.requestTimeoutMs);
  try {
    const response = await deliverer(delivery, settings, {
      fetchImpl,
      env,
      signal: controller.signal,
    });
    const ok = response.status >= 200 && response.status < 300;
    const duplicate = response.status === 409;
    return {
      ok: ok || duplicate,
      duplicate,
      statusCode: response.status,
      requestId: response.id || requestId(response.headers),
      responseBody: response.body,
      retryAfter: retryAfterMs(response.headers?.get?.('retry-after'), Date.now()),
      permanent: [400, 401, 403, 404, 422].includes(response.status),
      error: ok || duplicate ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const permanent = Boolean(error.permanent);
    return {
      ok: false,
      permanent,
      error: error.name === 'AbortError' ? 'request timed out' : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function applyOutboxResults(settings, results, { now = Date.now() } = {}) {
  if (!results.length) return [];
  const outbox = loadOutbox(settings);
  const byId = new Map(outbox.deliveries.map((delivery) => [delivery.id, delivery]));
  const applied = [];
  for (const result of results) {
    const delivery = byId.get(result.id);
    if (!delivery || delivery.state !== 'sending') continue;
    delivery.statusCode = result.statusCode ?? null;
    delivery.requestId = result.requestId ?? null;
    delivery.lastError = result.error ?? null;
    if (result.ok) {
      delivery.state = 'sent';
      delivery.sentAt = nowIso(now);
      delivery.nextAttemptAt = null;
    } else if (result.permanent || delivery.attempts >= delivery.maxAttempts) {
      delivery.state = 'dead';
      delivery.nextAttemptAt = null;
    } else {
      delivery.state = 'failed';
      delivery.nextAttemptAt = new Date(
        now + (result.retryAfter ?? retryDelayMs(delivery, settings)),
      ).toISOString();
    }
    delivery.updatedAt = nowIso(now);
    applied.push(structuredClone(delivery));
  }
  saveOutbox(settings, outbox, now);
  return applied;
}

export async function flushOutbox(settings, {
  limit = 20,
  now = Date.now,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const claimed = claimOutboxBatch(settings, { limit, now: now() });
  const results = [];
  for (const delivery of claimed) {
    const outcome = await deliverOutbox(delivery, settings, { fetchImpl, env });
    results.push({ id: delivery.id, ...outcome });
  }
  return applyOutboxResults(settings, results, { now: now() });
}

export function retryOutboxDelivery(settings, id, { now = Date.now() } = {}) {
  const outbox = loadOutbox(settings);
  const delivery = outbox.deliveries.find((item) => item.id === id);
  if (!delivery) throw new Error(`unknown outbox delivery: ${id}`);
  if (!['failed', 'dead'].includes(delivery.state)) {
    throw new Error(`delivery ${id} is ${delivery.state}, not failed or dead`);
  }
  delivery.state = 'pending';
  delivery.attempts = 0;
  delivery.nextAttemptAt = nowIso(now);
  delivery.lastError = null;
  delivery.updatedAt = nowIso(now);
  saveOutbox(settings, outbox, now);
  return delivery;
}

export function outboxSummary(outbox) {
  return {
    total: outbox.deliveries.length,
    pending: outbox.deliveries.filter((delivery) => ['pending', 'sending'].includes(delivery.state)).length,
    sent: outbox.deliveries.filter((delivery) => delivery.state === 'sent').length,
    failed: outbox.deliveries.filter((delivery) => delivery.state === 'failed').length,
    dead: outbox.deliveries.filter((delivery) => delivery.state === 'dead').length,
  };
}
