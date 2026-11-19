// Durable event inbox for the Router.
//
// The inbox is a wake-up log and priority hint, not a second source of issue
// truth. The Router still reads GitHub for eligibility, so a stale event can
// never invent a candidate or bypass a gate.
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export const INBOX_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  'issue',
  'pull_request',
  'result',
  'worker',
  'verify',
  'recover',
  'clean',
  'schedule',
  'control',
  'manual',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

export function inboxPath(settings) {
  return join(settings.outDir, 'inbox.json');
}

export function emptyInbox() {
  return { version: INBOX_VERSION, events: [] };
}

export function loadInbox(settings) {
  const file = inboxPath(settings);
  if (!existsSync(file)) return emptyInbox();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid inbox at ${file}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('inbox must be a JSON object');
  }
  if (!Array.isArray(parsed.events)) parsed.events = [];
  parsed.version = INBOX_VERSION;
  return parsed;
}

export function saveInbox(settings, inbox) {
  mkdirSync(settings.outDir, { recursive: true });
  const file = inboxPath(settings);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ version: INBOX_VERSION, events: inbox.events }, null, 2)}\n`);
  renameSync(temporary, file);
}

function eventId(now) {
  return `evt-${new Date(now).getTime()}-${randomUUID().slice(0, 8)}`;
}

/**
 * Append one event. Passing the same `id` twice is a no-op, which makes
 * webhook delivery retries and repeated scheduler ticks safe.
 */
export function appendEvent(settings, {
  type,
  action = '',
  ticket = null,
  payload = {},
  id = null,
  now = Date.now(),
} = {}) {
  if (!EVENT_TYPE_SET.has(type)) {
    throw new Error(`unknown event type ${type}; expected ${EVENT_TYPES.join(', ')}`);
  }
  const inbox = loadInbox(settings);
  const resolvedId = String(id || eventId(now));
  const existing = inbox.events.find((event) => event.id === resolvedId);
  if (existing) return { inbox, event: existing, duplicate: true };

  const number = ticket === null || ticket === undefined || ticket === '' ? null : Number(ticket);
  if (number !== null && (!Number.isInteger(number) || number <= 0)) {
    throw new Error('event.ticket must be a positive integer');
  }
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
    throw new Error('event.payload must be a JSON object');
  }
  const event = {
    id: resolvedId,
    type,
    action: String(action || ''),
    ticket: number,
    payload: payload || {},
    createdAt: new Date(now).toISOString(),
    handledAt: null,
    outcome: null,
    error: null,
  };
  inbox.events.push(event);
  pruneInbox(inbox, settings.router.inboxLimit);
  saveInbox(settings, inbox);
  return { inbox, event, duplicate: false };
}

export function pendingEvents(inbox) {
  return inbox.events.filter((event) => !event.handledAt);
}

export function pendingEventTickets(settings) {
  try {
    return pendingEvents(loadInbox(settings))
      .map((event) => event.ticket)
      .filter((number) => Number.isInteger(number) && number > 0);
  } catch {
    return [];
  }
}

/**
 * Keep the newest `limit` events, dropping the oldest already-handled ones
 * first. Pending events are never pruned.
 */
export function pruneInbox(inbox, limit) {
  const max = Number(limit);
  if (!Number.isInteger(max) || max <= 0 || inbox.events.length <= max) return inbox;
  let excess = inbox.events.length - max;
  const kept = [];
  for (let index = 0; index < inbox.events.length; index++) {
    const event = inbox.events[index];
    if (excess > 0 && event.handledAt) {
      excess--;
      continue;
    }
    kept.push(event);
  }
  inbox.events = kept;
  return inbox;
}

export function inboxSummary(inbox) {
  const pending = pendingEvents(inbox);
  return {
    total: inbox.events.length,
    pending: pending.length,
    oldestPending: pending[0]?.createdAt || null,
    newestEvent: inbox.events.at(-1)?.createdAt || null,
  };
}
