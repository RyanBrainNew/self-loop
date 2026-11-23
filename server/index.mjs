#!/usr/bin/env node
import { existsSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { createAuth, defaultTokenFile, isLoopbackHost } from './auth.mjs';
import { ConsoleAudit } from './console-audit.mjs';
import { DemoBackend } from './demo-backend.mjs';
import { ProjectBackend, ProjectRegistry } from './project.mjs';
import { RouterEngine } from './router.mjs';
import { createDemoState } from './seed.mjs';
import { Store } from './store.mjs';

const VERSION = '0.2.0';
const here = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(here, 'public');

function parseArgs(argv) {
  const options = {
    host: '127.0.0.1',
    port: 4317,
    data: '.self-loop/state.json',
    repos: [],
    out: null,
    authFile: defaultTokenFile(),
    auditFile: join(homedir(), '.self-loop', 'console-audit.json'),
    reset: false,
    demo: true,
    tick: true,
    rotateToken: false,
    allowRemote: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--data') options.data = argv[++index];
    else if (arg === '--repo') options.repos.push(argv[++index]);
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--auth-file') options.authFile = resolve(process.cwd(), argv[++index]);
    else if (arg === '--audit-file') options.auditFile = resolve(process.cwd(), argv[++index]);
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--no-demo') options.demo = false;
    else if (arg === '--no-tick') options.tick = false;
    else if (arg === '--rotate-token') options.rotateToken = true;
    else if (arg === '--allow-remote') options.allowRemote = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (!arg.startsWith('-')) options.repos.push(arg);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  if (options.repos.some((repo) => !repo)) throw new Error('--repo requires a path');
  return options;
}

function usage() {
  return [
    'self-loop console',
    '',
    'Usage: node server/index.mjs [options]',
    '',
    'Modes:',
    '  (default)        demo Router with a local synthetic state file',
    '  --repo <path>    read/drive a real project .loop/state.json (repeatable)',
    '',
    'Options:',
    '  --port <n>           listen port (default 4317)',
    '  --host <addr>        listen address (default 127.0.0.1)',
    '  --repo <path>        project repo; repeat to allow UI switching',
    '  --out <dir>          project .loop output directory override',
    '  --data <path>        demo state file (default .self-loop/state.json)',
    '  --auth-file <path>   local write-token file',
    '  --audit-file <path>  console write-audit file',
    '  --reset              replace demo state with seed data',
    '  --no-demo            do not inject demo events',
    '  --no-tick            start demo Router paused',
    '  --rotate-token       rotate the local write token and exit',
    '  --allow-remote       allow a non-loopback bind (token still required)',
    '  --help               show this help',
    '',
    'Writes require the local token via HttpOnly session cookie or Bearer token.',
    'Reads are local-only and reject cross-site Origins. Never expose this',
    'console to a public network without an authenticated reverse proxy.',
  ].join('\n');
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  console.log(usage());
  process.exit(0);
}
if (!options.allowRemote && !isLoopbackHost(options.host)) {
  throw new Error(
    `refusing to bind ${options.host}: use --allow-remote and put an authenticated proxy in front`,
  );
}

const auth = createAuth({ tokenFile: options.authFile });
if (options.rotateToken) {
  const result = auth.rotate();
  console.log(`token file  ${result.file}`);
  console.log(`new token   ${result.token}`);
  process.exit(0);
}

let backend;
let timer;
let dataFile = null;

if (options.repos.length) {
  if (options.reset) throw new Error('--reset only applies to demo mode');
  if (options.out && options.repos.length !== 1) {
    throw new Error('--out can only be used with a single --repo');
  }
  const registry = new ProjectRegistry(options.repos, {
    cwd: process.cwd(),
    outDir: options.out,
  });
  backend = new ProjectBackend(registry);

  let lastCheck = 0;
  timer = setInterval(() => {
    const now = Date.now();
    if (now - lastCheck < 800) return;
    lastCheck = now;
    try {
      if (backend.changed()) api.broadcast();
    } catch (error) {
      console.error('[watch]', error.message);
    }
  }, 250);
} else {
  dataFile = resolve(process.cwd(), options.data);
  if (options.reset && existsSync(dataFile)) unlinkSync(dataFile);
  const store = new Store(dataFile, { initialState: createDemoState() });
  store.state.meta.serverStartedAt = new Date().toISOString();
  store.state.meta.mode = 'demo';
  if (!options.demo) store.state.meta.demo = false;
  if (!options.tick) store.state.config.autoTick = false;
  const engine = new RouterEngine(store);
  backend = new DemoBackend({ store, engine });

  let lastTick = 0;
  timer = setInterval(() => {
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
}

const audit = new ConsoleAudit(options.auditFile);
const api = createApi({
  backend,
  auth,
  audit,
  publicDir,
  version: VERSION,
});
const server = createServer(api.handler);

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
  if (backend.mode === 'project') {
    for (const project of backend.registry.entries) {
      console.log(`  project ${project.name} · ${project.statePath}`);
    }
    console.log('  mode    project · read .loop state · writes go through router CLI');
  } else {
    console.log(`  data    ${dataFile}`);
    console.log(`  mode    demo · ${backend.store.state.config.autoTick ? 'auto tick' : 'paused'}`);
    console.log(`  router  ${backend.store.state.config.maxConcurrent} slots · ${backend.store.state.config.tickMs}ms tick`);
  }
  console.log(`  token   ${auth.file}`);
  console.log(`  audit   ${options.auditFile}`);
  console.log('');
  console.log('Writes require the local token. Cross-site Origins are rejected.');
  console.log('Do not expose this console to a public network without auth.');
  console.log('');
  if (auth.created) {
    console.log(`First run created ${auth.file}. Keep it private; rotate with --rotate-token.`);
    console.log('');
  }
});

function shutdown() {
  clearInterval(timer);
  try {
    if (backend.mode === 'demo') backend.store.save();
  } catch (error) {
    console.error('[store]', error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
