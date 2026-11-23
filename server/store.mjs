import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const STATE_VERSION = 1;

export function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

export function emptyState(now = Date.now()) {
  const at = nowIso(now);
  return {
    version: STATE_VERSION,
    meta: {
      createdAt: at,
      updatedAt: at,
      startedAt: at,
      serverStartedAt: at,
      lastTickAt: null,
      tickCount: 0,
      paused: false,
      demo: true,
      lastDemoEventAt: null,
    },
    config: {
      project: { id: 'prj_local', name: 'self-loop', repo: 'local/self-loop' },
      maxConcurrent: 2,
      maxAttempts: 2,
      leaseMinutes: 45,
      tickMs: 2000,
      autoTick: true,
      workMs: 7000,
      verifyMs: 3500,
      language: 'zh-CN',
    },
    sources: [],
    events: [],
    tickets: [],
    attempts: [],
    deliveries: [],
    workers: [],
    automations: [],
    audit: [],
  };
}

export function appendAudit(state, entry, now = Date.now()) {
  const record = {
    id: makeId('aud'),
    at: nowIso(now),
    actor: entry.actor || 'router',
    action: entry.action,
    entity: entry.entity || 'ticket',
    entityId: entry.entityId || null,
    ticketId: entry.ticketId || null,
    ticketNumber: entry.ticketNumber || null,
    detail: entry.detail || '',
    tone: entry.tone || 'neutral',
  };
  state.audit.unshift(record);
  if (state.audit.length > 400) state.audit.length = 400;
  return record;
}

export class Store {
  constructor(file, { now = Date.now, initialState = null } = {}) {
    this.file = file;
    this.now = now;
    this.state = initialState ?? emptyState(now());

    if (existsSync(file)) {
      this.state = JSON.parse(readFileSync(file, 'utf8'));
    }

    this.state.version ??= STATE_VERSION;
    this.state.meta ??= emptyState(now()).meta;
    this.state.config ??= emptyState(now()).config;
    for (const key of ['sources', 'events', 'tickets', 'attempts', 'deliveries', 'workers', 'audit']) {
      if (!Array.isArray(this.state[key])) this.state[key] = [];
    }
    this.save();
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    this.state.meta.updatedAt = nowIso(this.now());
    const body = `${JSON.stringify(this.state, null, 2)}\n`;
    const temporary = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temporary, body);
    try {
      renameSync(temporary, this.file);
    } catch {
      writeFileSync(this.file, body);
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }

  snapshot() {
    return structuredClone(this.state);
  }
}
