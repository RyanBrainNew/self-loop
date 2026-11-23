#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { RouterEngine } from './router.mjs';
import { createDemoState } from './seed.mjs';
import { Store } from './store.mjs';

const VERSION = '0.1.0';
const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(here, 'public');

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 4317,
    data: '.self-loop/state.json',
    reset: false,
    demo: true,
    tick: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--data') options.data = argv[++index];
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--no-demo') options.demo = false;
    else if (arg === '--no-tick') options.tick = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-')) options.data = arg;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  return options;
}

function usage() {
  return [
    'self-loop console',
    '',
    'Usage: node server/index.mjs [options]',
    '',
    'Options:',
    '  --port <n>      listen port (default 4317)',
    '  --host <addr>   listen address (default 127.0.0.1)',
    '  --data <path>   state file (default .self-loop/state.json)',
    '  --reset         replace the state file with demo data',
    '  --no-demo       do not inject demo events',
    '  --no-tick       start paused; run ticks from the console',
    '  --help          show this help',
    '',
    'The MVP binds to localhost and has no authentication.',
    'Do not expose it to a public network.',
  ].join('\n');
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}

const dataFile = resolve(process.cwd(), options.data);
if (options.reset && existsSync(dataFile)) unlinkSync(dataFile);

const store = new Store(dataFile, { initialState: createDemoState() });
store.state.meta.serverStartedAt = new Date().toISOString();
if (!options.demo) store.state.meta.demo = false;
if (!options.tick) store.state.config.autoTick = false;

const engine = new RouterEngine(store);
const api = createApi({ store, engine, publicDir, version: VERSION });
const server = createServer(api.handler);

let lastTick = 0;
const timer = setInterval(() => {
  if (!store.state.config.autoTick) return;
  const now = Date.now();
  const interval = Number(store.state.config.tickMs || 2000);
  if (now - lastTick < interval) return;
  lastTick = now;
  try {
    engine.tick(now);
    api.broadcast();
  } catch (error) {
    console.error('[tick]', error);
  }
}, 250);

server.on('error', (error) => {
  console.error(`[server] ${error.message}`);
  process.exitCode = 1;
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;
  console.log('');
  console.log(`self-loop console ${VERSION}`);
  console.log(`  local   http://${options.host}:${port}`);
  console.log(`  data    ${dataFile}`);
  console.log(`  mode    ${store.state.meta.demo ? 'demo' : 'live'} · ${store.state.config.autoTick ? 'auto tick' : 'paused'}`);
  console.log(`  router  ${store.state.config.maxConcurrent} slots · ${store.state.config.tickMs}ms tick`);
  console.log('');
  console.log('Local MVP · no authentication · do not expose to a public network.');
  console.log('');
});

function shutdown() {
  clearInterval(timer);
  try {
    store.save();
  } catch (error) {
    console.error('[store]', error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
