#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { isMain, parseArgs, resolveRepo, resolveSettings } from './lib.mjs';

export const WORKERS_VERSION = 1;
export const OFFLINE_AFTER_MS = 120_000;

export function workersPath(settings) {
  return join(settings.outDir, 'workers.json');
}

export function emptyWorkers() {
  return { version: WORKERS_VERSION, updatedAt: null, workers: [] };
}

export function loadWorkers(settings) {
  const file = workersPath(settings);
  if (!existsSync(file)) return emptyWorkers();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return {
    version: WORKERS_VERSION,
    updatedAt: parsed.updatedAt || null,
    workers: Array.isArray(parsed.workers) ? parsed.workers : [],
  };
}

export function saveWorkers(settings, data) {
  mkdirSync(settings.outDir, { recursive: true });
  const file = workersPath(settings);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    version: WORKERS_VERSION,
    updatedAt: new Date().toISOString(),
    workers: data.workers || [],
  }, null, 2)}\n`);
  renameSync(temporary, file);
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function cleanWorker(worker, now = Date.now()) {
  const offline = now - Date.parse(worker.lastHeartbeatAt || 0) > OFFLINE_AFTER_MS;
  return {
    ...worker,
    tokenHash: undefined,
    status: offline && worker.status !== 'paused' ? 'offline' : worker.status || 'online',
    online: !offline,
  };
}

export function listWorkers(settings, now = Date.now()) {
  return loadWorkers(settings).workers.map((worker) => cleanWorker(worker, now));
}

export function registerWorker(settings, input = {}, now = Date.now()) {
  const token = `sw_${randomBytes(24).toString('hex')}`;
  const worker = {
    id: String(input.id || `rwk_${randomUUID().slice(0, 10)}`),
    name: String(input.name || 'remote-worker').slice(0, 120),
    kind: String(input.kind || 'remote').slice(0, 40),
    version: String(input.version || '').slice(0, 40),
    capabilities: Array.isArray(input.capabilities)
      ? input.capabilities.map(String)
      : String(input.capabilities || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    concurrency: Math.max(1, Number(input.concurrency) || 1),
    status: 'online',
    currentTicketId: null,
    createdAt: new Date(now).toISOString(),
    lastHeartbeatAt: new Date(now).toISOString(),
    tokenHash: hashToken(token),
  };
  const data = loadWorkers(settings);
  data.workers.push(worker);
  saveWorkers(settings, data);
  return { worker: cleanWorker(worker, now), token };
}

export function authenticateWorker(settings, token, now = Date.now()) {
  const hash = hashToken(token || '');
  const worker = loadWorkers(settings).workers.find((item) => item.tokenHash === hash);
  if (!worker) {
    const error = new Error('unknown or revoked worker token');
    error.statusCode = 401;
    throw error;
  }
  if (now - Date.parse(worker.lastHeartbeatAt || 0) > OFFLINE_AFTER_MS * 3) {
    const error = new Error('worker has been offline for too long; register it again');
    error.statusCode = 410;
    throw error;
  }
  return worker;
}

export function heartbeatWorker(settings, token, patch = {}, now = Date.now()) {
  const data = loadWorkers(settings);
  const worker = data.workers.find((item) => item.tokenHash === hashToken(token || ''));
  if (!worker) {
    const error = new Error('unknown or revoked worker token');
    error.statusCode = 401;
    throw error;
  }
  worker.lastHeartbeatAt = new Date(now).toISOString();
  if (patch.status) worker.status = String(patch.status);
  if (patch.currentTicketId !== undefined) {
    worker.currentTicketId = patch.currentTicketId ? String(patch.currentTicketId) : null;
  }
  worker.capabilities = Array.isArray(patch.capabilities)
    ? patch.capabilities.map(String)
    : worker.capabilities;
  if (patch.version !== undefined) worker.version = String(patch.version).slice(0, 40);
  saveWorkers(settings, data);
  return cleanWorker(worker, now);
}

export function rotateWorkerToken(settings, id, now = Date.now()) {
  const data = loadWorkers(settings);
  const worker = data.workers.find((item) => item.id === id);
  if (!worker) throw new Error(`unknown worker: ${id}`);
  const token = `sw_${randomBytes(24).toString('hex')}`;
  worker.tokenHash = hashToken(token);
  worker.lastHeartbeatAt = new Date(now).toISOString();
  saveWorkers(settings, data);
  return { worker: cleanWorker(worker, now), token };
}

export function revokeWorker(settings, id) {
  const data = loadWorkers(settings);
  const index = data.workers.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`unknown worker: ${id}`);
  const [removed] = data.workers.splice(index, 1);
  saveWorkers(settings, data);
  return cleanWorker(removed);
}

export function markWorker(settings, id, patch = {}, now = Date.now()) {
  const data = loadWorkers(settings);
  const worker = data.workers.find((item) => item.id === id);
  if (!worker) return null;
  Object.assign(worker, patch, { lastHeartbeatAt: new Date(now).toISOString() });
  saveWorkers(settings, data);
  return cleanWorker(worker, now);
}

function main(argv = process.argv.slice(2)) {
  const { values, flags } = parseArgs(argv);
  const settings = resolveSettings(resolveRepo({ repo: values.repo }), {}, process.env);
  const action = values.action || (flags.list ? 'list' : '');
  if (action === 'list') {
    console.log(JSON.stringify({ workers: listWorkers(settings) }, null, 2));
    return 0;
  }
  if (action === 'register') {
    const input = values.data ? JSON.parse(values.data) : {
      name: values.name,
      kind: values.kind,
      capabilities: values.capabilities,
    };
    console.log(JSON.stringify(registerWorker(settings, input), null, 2));
    return 0;
  }
  if (action === 'heartbeat') {
    const token = values.token || process.env.SELF_LOOP_WORKER_TOKEN;
    const patch = values.data ? JSON.parse(values.data) : {
      status: values.status,
      currentTicketId: values.ticket,
    };
    console.log(JSON.stringify(heartbeatWorker(settings, token, patch), null, 2));
    return 0;
  }
  if (action === 'rotate') {
    console.log(JSON.stringify(rotateWorkerToken(settings, values.id), null, 2));
    return 0;
  }
  if (action === 'revoke') {
    console.log(JSON.stringify(revokeWorker(settings, values.id), null, 2));
    return 0;
  }
  throw new Error('usage: workers --repo <repo> list|register|heartbeat|rotate|revoke');
}

if (isMain(import.meta.url)) {
  try {
    const code = main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[workers] ${error.message}`);
    process.exit(2);
  }
}

export { main };
