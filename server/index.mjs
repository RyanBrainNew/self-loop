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
import { ProjectStore, defaultProjectsFile } from './project-store.mjs';
import { RouterEngine } from './router.mjs';
import { createDemoState } from './seed.mjs';
import { Store } from './store.mjs';

const VERSION = '0.6.0';
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
    projectsFile: defaultProjectsFile(),
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
    else if (arg === '--projects-file') options.projectsFile = resolve(process.cwd(), argv[++index]);
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
    '  (default)        registered projects, or demo when the registry is empty',
    '  --repo <path>    read/drive a real project .loop/state.json (repeatable)',
    '',
    'Options:',
    '  --port <n>           listen port (default 4317)',
    '  --host <addr>        listen address (default 127.0.0.1)',
    '  --repo <path>        register and open a project repo (repeatable)',
    '  --projects-file <p>  persistent project registry',
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
const backendRef = { current: null };
let timer;
let connectorTimer;
let automationTimer;
let dataFile = null;
let demoStore = null;
let projectStore = null;

function stopRuntimeTimers() {
  clearInterval(timer);
  clearInterval(connectorTimer);
  clearInterval(automationTimer);
  timer = null;
  connectorTimer = null;
  automationTimer = null;
}

function startProjectRuntime(registry) {
  let lastCheck = 0;
  timer = setInterval(() => {
    const now = Date.now();
    if (now - lastCheck < 800) return;
    lastCheck = now;
    try {
      if (backendRef.current.changed()) api.broadcast();
    } catch (error) {
      console.error('[watch]', error.message);
    }
  }, 250);

  const jiraDue = new Map();
  let jiraRunning = false;
  connectorTimer = setInterval(async () => {
    if (jiraRunning) return;
    jiraRunning = true;
    try {
      for (const entry of registry.entries) {
        const config = entry.settings.connectors?.jira;
        if (!config?.enabled) continue;
        const dueAt = jiraDue.get(entry.id) || 0;
        if (Date.now() < dueAt) continue;
        jiraDue.set(entry.id, Date.now() + Math.max(1, config.pollMinutes) * 60_000);
        try {
          const result = await backendRef.current.syncJira(entry);
          if (result.events?.length) api.broadcast();
          if (result.nextSyncAt) {
            const retryAt = Date.parse(result.nextSyncAt);
            if (Number.isFinite(retryAt)) {
              jiraDue.set(entry.id, Math.max(jiraDue.get(entry.id) || 0, retryAt));
            }
          }
          if (['degraded', 'auth_error', 'network_error'].includes(result.status)) {
            console.error(`[jira] ${entry.name}: ${result.error || result.status}`);
          }
        } catch (error) {
          console.error(`[jira] ${entry.name}: ${error.message}`);
        }
      }
    } finally {
      jiraRunning = false;
    }
  }, 15_000);

  automationTimer = setInterval(async () => {
    for (const entry of registry.entries) {
      try {
        const result = await backendRef.current.runDueAutomations(entry);
        if (result.ran) api.broadcast();
      } catch (error) {
        console.error(`[automation] ${entry.name}: ${error.message}`);
      }
    }
  }, 30_000);
}

function startDemoRuntime(store, engine) {
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

  automationTimer = setInterval(() => {
    const current = backendRef.current;
    if (current.mode !== 'demo') return;
    const now = Date.now();
    for (const automation of current.store.state.automations || []) {
      if (!automation.enabled) continue;
      if (Date.parse(automation.nextRunAt || 0) > now) continue;
      try {
        current.runAutomation(automation.id);
        api.broadcast();
      } catch (error) {
        console.error('[automation]', error.message);
      }
    }
  }, 30_000);
}

function addFirstProject(input = {}) {
  const { project, added } = projectStore.add(input.path, { name: input.name });
  projectStore.select(project.id);
  const registry = new ProjectRegistry(projectStore.list(), {
    cwd: process.cwd(),
    outDir: options.out,
    store: projectStore,
    currentId: project.id,
  });
  const next = new ProjectBackend(registry);
  try {
    demoStore?.save();
  } catch (error) {
    console.error('[store]', error);
  }
  stopRuntimeTimers();
  backendRef.current = next;
  startProjectRuntime(registry);
  console.log(`[project] ${added ? 'registered' : 'opened'} ${project.path}`);
  return {
    project: next.projectPublic(registry.current()),
    projects: next.projects(),
    added,
  };
}

function liveBackend() {
  return new Proxy({}, {
    get(_target, property) {
      const current = backendRef.current;
      const value = current[property];
      return typeof value === 'function' ? value.bind(current) : value;
    },
    has(_target, property) {
      return property in backendRef.current;
    },
  });
}

projectStore = new ProjectStore(options.projectsFile, { cwd: process.cwd() });
if (options.repos.length) {
  let opened = null;
  for (const repo of options.repos) opened = projectStore.add(repo).project;
  if (opened) projectStore.select(opened.id);
}
const registeredProjects = projectStore.list();

if (registeredProjects.length) {
  if (options.reset) throw new Error('--reset only applies to demo mode');
  if (options.out && registeredProjects.length !== 1) {
    throw new Error('--out can only be used with a single registered project');
  }
  const registry = new ProjectRegistry(registeredProjects, {
    cwd: process.cwd(),
    outDir: options.out,
    store: projectStore,
    currentId: projectStore.current()?.id,
  });
  backend = new ProjectBackend(registry);
  backendRef.current = backend;
  startProjectRuntime(registry);
} else {
  if (options.repos.length) throw new Error('no project was registered');
  dataFile = resolve(process.cwd(), options.data);
  if (options.reset && existsSync(dataFile)) unlinkSync(dataFile);
  const store = new Store(dataFile, { initialState: createDemoState() });
  store.state.meta.serverStartedAt = new Date().toISOString();
  store.state.meta.mode = 'demo';
  if (!options.demo) store.state.meta.demo = false;
  if (!options.tick) store.state.config.autoTick = false;
  const engine = new RouterEngine(store);
  demoStore = store;
  backend = new DemoBackend({ store, engine, onAddProject: addFirstProject });
  backendRef.current = backend;
  startDemoRuntime(store, engine);
}

const audit = new ConsoleAudit(options.auditFile);
const api = createApi({
  backend: liveBackend(),
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
  const current = backendRef.current;
  if (current.mode === 'project') {
    for (const project of current.registry.entries) {
      console.log(`  project ${project.name} · ${project.statePath}`);
    }
    console.log(`  projects ${options.projectsFile}`);
    console.log('  mode    project · multi-repo registry · writes go through router CLI');
  } else {
    console.log(`  data    ${dataFile}`);
    console.log(`  mode    demo · ${current.store.state.config.autoTick ? 'auto tick' : 'paused'}`);
    console.log(`  router  ${current.store.state.config.maxConcurrent} slots · ${current.store.state.config.tickMs}ms tick`);
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
  stopRuntimeTimers();
  try {
    const current = backendRef.current;
    if (current?.mode === 'demo') current.store.save();
  } catch (error) {
    console.error('[store]', error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
