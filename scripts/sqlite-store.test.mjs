import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { resolveSettings } from './lib.mjs';
import {
  loadSqliteInbox,
  loadSqliteOutbox,
  loadSqliteState,
  migrateJsonToSqlite,
  saveSqliteOutbox,
  sqliteAvailable,
} from './sqlite-store.mjs';

const sqliteTest = sqliteAvailable() ? test : test.skip;
const repo = fileURLToPath(new URL('..', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'self-loop-sqlite-'));
  const outDir = join(dir, '.loop');
  mkdirSync(join(outDir, 'tickets'), { recursive: true });
  const settings = resolveSettings(dir, {
    outDir,
    storageBackend: 'sqlite',
    sqlitePath: join(outDir, 'self-loop.db'),
  }, { GITHUB_REPOSITORY: '' });
  const at = new Date().toISOString();
  writeFileSync(join(outDir, 'state.json'), `${JSON.stringify({
    version: 1,
    repo: '',
    activeTicket: 7,
    updatedAt: at,
    tickets: {
      7: {
        number: 7,
        title: 'Legacy JSON ticket',
        state: 'blocked',
        attempts: 1,
        createdAt: at,
        updatedAt: at,
      },
    },
  }, null, 2)}\n`);
  writeFileSync(join(outDir, 'tickets', '7.json'), `${JSON.stringify({
    number: 7,
    title: 'Legacy JSON ticket',
    state: 'blocked',
    attempts: 1,
    createdAt: at,
    updatedAt: at,
  }, null, 2)}\n`);
  writeFileSync(join(outDir, 'inbox.json'), `${JSON.stringify({
    version: 1,
    events: [{
      id: 'evt-legacy',
      type: 'issue',
      action: 'opened',
      ticket: 7,
      payload: {},
      createdAt: at,
      handledAt: null,
      outcome: null,
      error: null,
    }],
  }, null, 2)}\n`);
  writeFileSync(join(outDir, 'outbox.json'), `${JSON.stringify({
    version: 1,
    updatedAt: at,
    deliveries: [{
      id: 'out_legacy',
      ticket: 7,
      idempotencyKey: 'legacy:7:blocked',
      state: 'dead',
      channel: 'slack',
      target: '#loop',
      createdAt: at,
      updatedAt: at,
    }],
  }, null, 2)}\n`);
  return { dir, outDir, settings };
}

sqliteTest('SQLite migration is dry-runnable, lossless, and leaves JSON in place', () => {
  const { dir, outDir, settings } = fixture();
  try {
    const dry = migrateJsonToSqlite({ settings, dryRun: true });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.tickets, 1);
    assert.equal(existsSync(settings.storage.sqlitePath), false);

    const migrated = migrateJsonToSqlite({ settings });
    assert.equal(migrated.ok, true);
    assert.equal(migrated.tickets, 1);
    assert.equal(existsSync(join(outDir, 'state.json')), true);
    assert.equal(loadSqliteState(settings).tickets['7'].state, 'blocked');
    assert.equal(loadSqliteInbox(settings).events[0].id, 'evt-legacy');
    assert.equal(loadSqliteOutbox(settings).deliveries[0].idempotencyKey, 'legacy:7:blocked');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

sqliteTest('SQLite enforces a unique outbox idempotency key', () => {
  const { dir, settings } = fixture();
  try {
    migrateJsonToSqlite({ settings });
    const at = new Date().toISOString();
    const delivery = (id) => ({
      id,
      ticket: 7,
      idempotencyKey: 'same-key',
      state: 'pending',
      channel: 'slack',
      target: '#loop',
      createdAt: at,
      updatedAt: at,
    });
    assert.throws(
      () => saveSqliteOutbox(settings, {
        version: 1,
        updatedAt: at,
        deliveries: [delivery('out_a'), delivery('out_b')],
      }),
      /UNIQUE constraint failed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

sqliteTest('two processes can write different Tickets without losing either', () => {
  const { dir, settings } = fixture();
  try {
    migrateJsonToSqlite({ settings });
    const moduleUrl = new URL('./sqlite-store.mjs', import.meta.url).href;
    const libUrl = new URL('./lib.mjs', import.meta.url).href;
    const script = `
      import { resolveSettings } from ${JSON.stringify(libUrl)};
      import { saveSqliteTicket } from ${JSON.stringify(moduleUrl)};
      const repo = ${JSON.stringify(dir)};
      const base = Number(process.argv[1]);
      const settings = resolveSettings(repo, {
        outDir: ${JSON.stringify(join(dir, '.loop'))},
        storageBackend: 'sqlite',
        sqlitePath: ${JSON.stringify(settings.storage.sqlitePath)},
      }, { GITHUB_REPOSITORY: '' });
      const at = new Date().toISOString();
      for (let index = 0; index < 20; index += 1) {
        const number = base + index;
        saveSqliteTicket(settings, {
          number,
          title: 'concurrent ' + number,
          state: 'queued',
          attempts: 0,
          createdAt: at,
          updatedAt: at,
        });
      }
    `;
    const run = (base) => spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      script,
      String(base),
    ], {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
    });
    const first = run(2000);
    const second = run(3000);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const state = loadSqliteState(settings);
    assert.equal(Object.keys(state.tickets).length, 41);
    assert.equal(state.tickets['2000'].title, 'concurrent 2000');
    assert.equal(state.tickets['3019'].title, 'concurrent 3019');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});

sqliteTest('a failed migration leaves the JSON source untouched', () => {
  const { dir, outDir, settings } = fixture();
  try {
    const before = readFileSync(join(outDir, 'state.json'), 'utf8');
    writeFileSync(join(outDir, 'inbox.json'), '{ broken json');
    assert.throws(() => migrateJsonToSqlite({ settings }), /JSON/);
    assert.equal(readFileSync(join(outDir, 'state.json'), 'utf8'), before);
    assert.equal(existsSync(join(outDir, 'tickets', '7.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
});
