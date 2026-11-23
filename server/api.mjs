import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { normalizeGitHubEvent } from './connectors/github.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const OPEN_STATES = new Set([
  'queued',
  'claimed',
  'working',
  'verifying',
  'awaiting_review',
  'blocked',
  'failed',
]);

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > limit) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(body));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limit = 1_000_000) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function verifyGitHubSignature(secret, rawBody, signature) {
  if (!secret || typeof signature !== 'string' || !signature.startsWith('sha256=')) {
    return false;
  }
  const expected = Buffer.from(
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`,
  );
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function findGitHubSource(sources, repository) {
  const githubSources = sources.filter((source) => source.kind === 'github');
  if (repository) {
    const matched = githubSources.find(
      (source) =>
        String(source.config?.repo || '').toLowerCase() === repository.toLowerCase(),
    );
    if (matched) return matched;
    return githubSources.find((source) => !source.config?.repo) || null;
  }
  return githubSources.find((source) => source.status === 'healthy') || githubSources[0] || null;
}

function redactSource(source) {
  const copy = structuredClone(source);
  if (!copy.config || typeof copy.config !== 'object') return copy;
  for (const key of ['secret', 'webhookSecret', 'token', 'apiToken', 'password']) {
    if (copy.config[key]) copy.config[key] = '••••••';
  }
  return copy;
}

function parseLimit(value, fallback = 200) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
}

export function createApi({ store, engine, publicDir, version = '0.1.0' }) {
  const clients = new Set();
  const publicRoot = resolve(publicDir);

  function publicSnapshot() {
    const snapshot = store.snapshot();
    snapshot.sources = snapshot.sources.map(redactSource);
    return snapshot;
  }

  function broadcast() {
    if (!clients.size) return;
    const payload = JSON.stringify(publicSnapshot());
    for (const response of [...clients]) {
      try {
        response.write(`event: state\ndata: ${payload}\n\n`);
      } catch {
        clients.delete(response);
      }
    }
  }

  function serveStatic(req, res, pathname) {
    const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = resolve(publicRoot, relative);
    if (file !== publicRoot && !file.startsWith(`${publicRoot}${sep}`)) {
      return sendText(res, 403, 'forbidden');
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return sendText(res, 404, 'not found');
    }
    const type = MIME[extname(file)] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
    });
    res.end(readFileSync(file));
  }

  function streamState(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    res.write(`event: state\ndata: ${JSON.stringify(publicSnapshot())}\n\n`);
    clients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        clients.delete(res);
      }
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  }

  async function handleGitHubWebhook(req, res) {
    const eventName = req.headers['x-github-event'];
    const delivery = req.headers['x-github-delivery'];
    const signature = req.headers['x-hub-signature-256'];

    if (typeof delivery !== 'string' || !delivery || delivery.length > 200) {
      return sendJson(res, 400, { error: 'missing or invalid X-GitHub-Delivery' });
    }
    if (typeof eventName !== 'string' || !eventName || eventName.length > 80) {
      return sendJson(res, 400, { error: 'missing or invalid X-GitHub-Event' });
    }

    const rawBody = await readRawBody(req);
    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }

    const repository = payload?.repository?.full_name || '';
    const source = findGitHubSource(store.state.sources, repository);
    if (!source) {
      return sendJson(res, 503, { error: 'no GitHub source configured' });
    }

    const secret = source.config?.webhookSecret || source.config?.secret;
    if (!secret) {
      return sendJson(res, 503, { error: 'GitHub webhook secret is not configured' });
    }
    if (!verifyGitHubSignature(secret, rawBody, signature)) {
      return sendJson(res, 401, { error: 'invalid GitHub webhook signature' });
    }

    const { eventInput, ignoredReason } = normalizeGitHubEvent(eventName, payload);
    let result;
    try {
      result = engine.ingestEvent({
        ...eventInput,
        sourceId: source.id,
        dedupeKey: `${source.id}:github:${delivery}`,
        ignoredReason,
      });
    } catch (error) {
      if (String(error?.message || '').startsWith('source is paused:')) {
        return sendJson(res, 409, { error: error.message });
      }
      throw error;
    }

    broadcast();
    return sendJson(res, 202, {
      ok: true,
      duplicate: result.duplicate,
      event: {
        id: result.event.id,
        kind: result.event.kind,
        status: result.event.status,
        ignoredReason: result.event.ignoredReason,
      },
    });
  }

  async function handleApi(req, res, url) {
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    if (path === '/api/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        version,
        mode: store.state.meta.demo ? 'demo' : 'live',
        running: true,
        uptimeSeconds: Math.max(
          0,
          Math.round(
            (Date.now() -
              Date.parse(store.state.meta.serverStartedAt || store.state.meta.startedAt)) /
              1000,
          ),
        ),
      });
    }

    if (path === '/api/stream' && method === 'GET') {
      return streamState(req, res);
    }

    if (path === '/api/state' && method === 'GET') {
      return sendJson(res, 200, publicSnapshot());
    }

    if (path === '/api/overview' && method === 'GET') {
      const overview = engine.overview();
      overview.sources = overview.sources.map(redactSource);
      return sendJson(res, 200, overview);
    }

    if (path === '/api/tick' && method === 'POST') {
      const result = engine.tick();
      broadcast();
      return sendJson(res, 200, result);
    }

    if (path === '/api/config' && method === 'GET') {
      return sendJson(res, 200, {
        config: store.state.config,
        meta: {
          paused: store.state.meta.paused,
          demo: store.state.meta.demo,
        },
      });
    }

    if (path === '/api/config' && method === 'PATCH') {
      const patch = await readBody(req);
      const config = engine.updateConfig(patch);
      broadcast();
      return sendJson(res, 200, {
        config,
        meta: {
          paused: store.state.meta.paused,
          demo: store.state.meta.demo,
        },
      });
    }

    if (path === '/api/sources' && method === 'GET') {
      return sendJson(res, 200, { sources: publicSnapshot().sources });
    }

    if (path === '/api/sources' && method === 'POST') {
      const body = await readBody(req);
      const source = engine.addSource(body);
      broadcast();
      return sendJson(res, 201, { source: redactSource(source) });
    }

    const sourceDetail = path.match(/^\/api\/sources\/([^/]+)$/);
    if (sourceDetail && method === 'PATCH') {
      const body = await readBody(req);
      const source = engine.updateSource(decodeURIComponent(sourceDetail[1]), body);
      broadcast();
      return sendJson(res, 200, { source: redactSource(source) });
    }

    const sourceToggle = path.match(/^\/api\/sources\/([^/]+)\/toggle$/);
    if (sourceToggle && method === 'POST') {
      const source = engine.toggleSource(decodeURIComponent(sourceToggle[1]));
      broadcast();
      return sendJson(res, 200, { source: redactSource(source) });
    }

    if (path === '/api/events' && method === 'GET') {
      const status = url.searchParams.get('status');
      const limit = parseLimit(url.searchParams.get('limit'));
      const events = store.state.events
        .filter((event) => !status || event.status === status)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
        .slice(0, limit);
      return sendJson(res, 200, { events });
    }

    if (path === '/api/events' && method === 'POST') {
      const body = await readBody(req);
      const result = engine.ingestEvent(body);
      broadcast();
      return sendJson(res, result.duplicate ? 200 : 201, result);
    }

    if (path === '/api/tickets' && method === 'GET') {
      const state = url.searchParams.get('state');
      const limit = parseLimit(url.searchParams.get('limit'));
      const tickets = store.state.tickets
        .filter((ticket) => {
          if (!state || state === 'all') return true;
          if (state === 'active') return OPEN_STATES.has(ticket.state);
          if (state === 'blocked') return ['blocked', 'failed'].includes(ticket.state);
          if (state === 'done') return ['done', 'dropped'].includes(ticket.state);
          return ticket.state === state;
        })
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .slice(0, limit);
      return sendJson(res, 200, { tickets });
    }

    const ticketAction = path.match(
      /^\/api\/tickets\/([^/]+)\/(answer|retry|cancel|approve)$/,
    );
    if (ticketAction && method === 'POST') {
      const id = decodeURIComponent(ticketAction[1]);
      const action = ticketAction[2];
      const body = await readBody(req);
      let ticket;
      if (action === 'answer') ticket = engine.answerTicket(id, body.answer);
      if (action === 'retry') ticket = engine.retryTicket(id);
      if (action === 'cancel') ticket = engine.cancelTicket(id);
      if (action === 'approve') ticket = engine.approveTicket(id);
      broadcast();
      return sendJson(res, 200, { ticket });
    }

    const ticketDetail = path.match(/^\/api\/tickets\/([^/]+)$/);
    if (ticketDetail && method === 'GET') {
      const detail = engine.ticketDetail(decodeURIComponent(ticketDetail[1]));
      if (!detail) return sendJson(res, 404, { error: 'ticket not found' });
      return sendJson(res, 200, detail);
    }

    if (path === '/api/outbox' && method === 'GET') {
      const state = url.searchParams.get('state');
      const limit = parseLimit(url.searchParams.get('limit'));
      const deliveries = store.state.deliveries
        .filter((delivery) => !state || state === 'all' || delivery.state === state)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
      return sendJson(res, 200, { deliveries });
    }

    const deliveryReplay = path.match(/^\/api\/outbox\/([^/]+)\/replay$/);
    if (deliveryReplay && method === 'POST') {
      const delivery = engine.replayDelivery(decodeURIComponent(deliveryReplay[1]));
      broadcast();
      return sendJson(res, 200, { delivery });
    }

    if (path === '/api/workers' && method === 'GET') {
      return sendJson(res, 200, { workers: store.state.workers });
    }

    const workerToggle = path.match(/^\/api\/workers\/([^/]+)\/toggle$/);
    if (workerToggle && method === 'POST') {
      const worker = engine.toggleWorker(decodeURIComponent(workerToggle[1]));
      broadcast();
      return sendJson(res, 200, { worker });
    }

    if (path === '/api/audit' && method === 'GET') {
      const limit = parseLimit(url.searchParams.get('limit'), 100);
      return sendJson(res, 200, { audit: store.state.audit.slice(0, limit) });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/hooks/github' && req.method === 'POST') {
        await handleGitHubWebhook(req, res);
      } else if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
      } else {
        serveStatic(req, res, url.pathname);
      }
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message = error?.message || 'internal error';
      const status = message === 'body too large' ? 413 : message === 'invalid JSON body' ? 400 : 400;
      sendJson(res, status, { error: message });
    }
  }

  return { handler, broadcast, clients };
}
