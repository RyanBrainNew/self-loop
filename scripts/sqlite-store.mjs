import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

let sqliteModule;

function sqlite() {
  if (sqliteModule !== undefined) return sqliteModule;
  try {
    const require = createRequire(import.meta.url);
    sqliteModule = require('node:sqlite');
  } catch {
    sqliteModule = null;
  }
  return sqliteModule;
}

export function sqliteAvailable() {
  return Boolean(sqlite()?.DatabaseSync);
}

function requireSqlite() {
  const module = sqlite();
  if (!module?.DatabaseSync) {
    throw new Error(
      'node:sqlite is unavailable; use Node 24 (or a Node build with node:sqlite enabled), '
      + 'or keep storage.backend=json',
    );
  }
  return module;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, file);
}

function ensurePrivate(file) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function schema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tickets (
      number INTEGER PRIMARY KEY,
      updated_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      handled_at TEXT,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY,
      ticket_number INTEGER,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_pending_idx
      ON events(handled_at, created_at);
    CREATE INDEX IF NOT EXISTS deliveries_due_idx
      ON deliveries(state, created_at);
    CREATE INDEX IF NOT EXISTS attempts_ticket_idx
      ON attempts(ticket_number);
    CREATE INDEX IF NOT EXISTS audit_at_idx
      ON audit(at DESC);
  `);
}

export function openSqliteStore(file) {
  const { DatabaseSync } = requireSqlite();
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  ensurePrivate(file);
  schema(db);
  return db;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = fn();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

function stateMeta(state) {
  const { tickets, ...meta } = state;
  return meta;
}

function loadJsonMirror(settings) {
  const stateFile = join(settings.outDir, 'state.json');
  const state = readJson(stateFile, {
    version: 1,
    repo: settings.githubRepo || '',
    activeTicket: null,
    tickets: {},
    updatedAt: null,
  });
  if (!state.tickets || typeof state.tickets !== 'object' || Array.isArray(state.tickets)) {
    state.tickets = {};
  }
  const inbox = readJson(join(settings.outDir, 'inbox.json'), { version: 1, events: [] });
  const outbox = readJson(join(settings.outDir, 'outbox.json'), {
    version: 1,
    updatedAt: null,
    deliveries: [],
  });
  return { state, inbox, outbox };
}

function migrate({ db, settings, source }) {
  const upsertMeta = db.prepare(
    'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  );
  const upsertTicket = db.prepare(
    'INSERT INTO tickets(number, updated_at, data) VALUES(?, ?, ?) '
      + 'ON CONFLICT(number) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data',
  );
  const insertEvent = db.prepare(
    'INSERT INTO events(id, created_at, handled_at, data) VALUES(?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET data=excluded.data, handled_at=excluded.handled_at',
  );
  const insertDelivery = db.prepare(
    'INSERT INTO deliveries(id, idempotency_key, state, created_at, data) VALUES(?, ?, ?, ?, ?) '
      + 'ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data',
  );
  const counts = { tickets: 0, events: 0, deliveries: 0 };
  upsertMeta.run('state', JSON.stringify(stateMeta(source.state)));
  upsertMeta.run('storageVersion', '1');
  const ticketFiles = existsSync(join(settings.outDir, 'tickets'))
    ? readdirSync(join(settings.outDir, 'tickets')).filter((name) => name.endsWith('.json'))
    : [];
  const tickets = new Map(
    Object.entries(source.state.tickets || {})
      .map(([number, ticket]) => [Number(number), ticket]),
  );
  for (const name of ticketFiles) {
    const ticket = readJson(join(settings.outDir, 'tickets', name), null);
    if (ticket?.number) tickets.set(Number(ticket.number), ticket);
  }
  for (const ticket of tickets.values()) {
    if (!Number.isInteger(Number(ticket.number))) continue;
    upsertTicket.run(
      Number(ticket.number),
      String(ticket.updatedAt || ''),
      JSON.stringify(ticket),
    );
    counts.tickets += 1;
  }
  for (const event of source.inbox.events || []) {
    insertEvent.run(
      String(event.id),
      String(event.createdAt || ''),
      event.handledAt || null,
      JSON.stringify(event),
    );
    counts.events += 1;
  }
  const seen = new Set();
  for (const delivery of source.outbox.deliveries || []) {
    const key = String(delivery.idempotencyKey || delivery.id);
    if (seen.has(key)) continue;
    seen.add(key);
    insertDelivery.run(
      String(delivery.id),
      key,
      String(delivery.state || 'pending'),
      String(delivery.createdAt || ''),
      JSON.stringify(delivery),
    );
    counts.deliveries += 1;
  }
  return counts;
}

export function databaseHasData(file) {
  if (!existsSync(file)) return false;
  const { DatabaseSync } = requireSqlite();
  const db = new DatabaseSync(file);
  try {
    schema(db);
    return Boolean(db.prepare('SELECT value FROM meta WHERE key = ?').get('storageVersion'));
  } finally {
    db.close();
  }
}

export function migrateJsonToSqlite({
  settings,
  sqlitePath = settings.storage?.sqlitePath || join(settings.outDir, 'self-loop.db'),
  dryRun = false,
} = {}) {
  const source = loadJsonMirror(settings);
  const preview = {
    tickets: Object.keys(source.state.tickets || {}).length,
    events: source.inbox.events?.length || 0,
    deliveries: source.outbox.deliveries?.length || 0,
  };
  if (dryRun) return { ok: true, dryRun: true, sqlitePath, ...preview };
  const db = openSqliteStore(sqlitePath);
  try {
    const migrated = transaction(db, () => migrate({ db, settings, source }));
    return { ok: true, dryRun: false, sqlitePath, ...migrated };
  } finally {
    db.close();
  }
}

function ensureMigrated(db, settings) {
  const marker = db.prepare('SELECT value FROM meta WHERE key = ?').get('storageVersion');
  if (marker) return;
  const source = loadJsonMirror(settings);
  transaction(db, () => migrate({ db, settings, source }));
}

export function loadSqliteState(settings) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('state');
    const state = meta ? JSON.parse(meta.value) : {
      version: 1,
      repo: settings.githubRepo || '',
      activeTicket: null,
      tickets: {},
      updatedAt: null,
    };
    state.tickets = {};
    for (const row of db.prepare('SELECT data FROM tickets ORDER BY number').all()) {
      const ticket = JSON.parse(row.data);
      state.tickets[String(ticket.number)] = ticket;
    }
    return state;
  } finally {
    db.close();
  }
}

export function saveSqliteState(settings, state) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    transaction(db, () => {
      const upsertMeta = db.prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      );
      const upsertTicket = db.prepare(
        'INSERT INTO tickets(number, updated_at, data) VALUES(?, ?, ?) '
          + 'ON CONFLICT(number) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data',
      );
      upsertMeta.run('state', JSON.stringify(stateMeta(state)));
      for (const ticket of Object.values(state.tickets || {})) {
        if (!Number.isInteger(Number(ticket.number))) continue;
        upsertTicket.run(
          Number(ticket.number),
          String(ticket.updatedAt || ''),
          JSON.stringify(ticket),
        );
      }
    });
    writeJsonAtomic(join(settings.outDir, 'state.json'), state);
    for (const ticket of Object.values(state.tickets || {})) {
      writeJsonAtomic(join(settings.outDir, 'tickets', `${ticket.number}.json`), ticket);
    }
  } finally {
    db.close();
  }
}

export function saveSqliteTicket(settings, ticket) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    transaction(db, () => {
      db.prepare(
        'INSERT INTO tickets(number, updated_at, data) VALUES(?, ?, ?) '
          + 'ON CONFLICT(number) DO UPDATE SET updated_at=excluded.updated_at, data=excluded.data',
      ).run(
        Number(ticket.number),
        String(ticket.updatedAt || ''),
        JSON.stringify(ticket),
      );
    });
    writeJsonAtomic(join(settings.outDir, 'tickets', `${ticket.number}.json`), ticket);
  } finally {
    db.close();
  }
}

export function loadSqliteInbox(settings) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    return {
      version: 1,
      events: db.prepare('SELECT data FROM events ORDER BY created_at, id')
        .all()
        .map((row) => JSON.parse(row.data)),
    };
  } finally {
    db.close();
  }
}

export function saveSqliteInbox(settings, inbox) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    transaction(db, () => {
      db.exec('DELETE FROM events');
      const insert = db.prepare(
        'INSERT INTO events(id, created_at, handled_at, data) VALUES(?, ?, ?, ?)',
      );
      for (const event of inbox.events || []) {
        insert.run(
          String(event.id),
          String(event.createdAt || ''),
          event.handledAt || null,
          JSON.stringify(event),
        );
      }
    });
    writeJsonAtomic(join(settings.outDir, 'inbox.json'), inbox);
  } finally {
    db.close();
  }
}

export function loadSqliteOutbox(settings) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    const meta = db.prepare('SELECT value FROM meta WHERE key = ?').get('outbox');
    const outbox = meta ? JSON.parse(meta.value) : {
      version: 1,
      updatedAt: null,
      deliveries: [],
    };
    outbox.deliveries = db.prepare('SELECT data FROM deliveries ORDER BY created_at DESC')
      .all()
      .map((row) => JSON.parse(row.data));
    return outbox;
  } finally {
    db.close();
  }
}

export function saveSqliteOutbox(settings, outbox) {
  const db = openSqliteStore(settings.storage.sqlitePath);
  try {
    ensureMigrated(db, settings);
    transaction(db, () => {
      db.prepare(
        'INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      ).run('outbox', JSON.stringify({ version: outbox.version, updatedAt: outbox.updatedAt }));
      const upsert = db.prepare(
        'INSERT INTO deliveries(id, idempotency_key, state, created_at, data) VALUES(?, ?, ?, ?, ?) '
          + 'ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data',
      );
      for (const delivery of outbox.deliveries || []) {
        upsert.run(
          String(delivery.id),
          String(delivery.idempotencyKey || delivery.id),
          String(delivery.state || 'pending'),
          String(delivery.createdAt || ''),
          JSON.stringify(delivery),
        );
      }
    });
    writeJsonAtomic(join(settings.outDir, 'outbox.json'), outbox);
  } finally {
    db.close();
  }
}

export function exportSqliteToJson(settings) {
  const state = loadSqliteState(settings);
  const inbox = loadSqliteInbox(settings);
  const outbox = loadSqliteOutbox(settings);
  writeJsonAtomic(join(settings.outDir, 'state.json'), state);
  writeJsonAtomic(join(settings.outDir, 'inbox.json'), inbox);
  writeJsonAtomic(join(settings.outDir, 'outbox.json'), outbox);
  mkdirSync(join(settings.outDir, 'tickets'), { recursive: true });
  for (const ticket of Object.values(state.tickets || {})) {
    writeJsonAtomic(join(settings.outDir, 'tickets', `${ticket.number}.json`), ticket);
  }
  return { state, inbox, outbox };
}
