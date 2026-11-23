#!/usr/bin/env node
import { isMain, parseArgs, resolveRepo, resolveSettings } from './lib.mjs';
import {
  exportSqliteToJson,
  migrateJsonToSqlite,
  sqliteAvailable,
} from './sqlite-store.mjs';

function main(argv = process.argv.slice(2)) {
  const { values, flags } = parseArgs(argv);
  const repoRoot = resolveRepo({ repo: values.repo });
  const settings = resolveSettings(repoRoot, {
    outDir: values.out,
    sqlitePath: values.sqlite,
  });
  const dryRun = Boolean(flags['dry-run']);
  if ((!dryRun || flags.export) && !sqliteAvailable()) {
    throw new Error('node:sqlite is unavailable; use Node 24 for migration or export');
  }
  if (flags.export) {
    const result = exportSqliteToJson(settings);
    console.log(JSON.stringify({
      ok: true,
      action: 'export',
      sqlite: settings.storage.sqlitePath,
      tickets: Object.keys(result.state.tickets || {}).length,
      events: result.inbox.events.length,
      deliveries: result.outbox.deliveries.length,
    }, null, 2));
    return 0;
  }
  const result = migrateJsonToSqlite({
    settings,
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    const code = main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[store] ${error.message}`);
    process.exit(2);
  }
}

export { main };
