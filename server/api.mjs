import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { normalizeGitHubEvent } from './connectors/github.mjs';
import {
  normalizeSlackCommand,
  normalizeSlackEvent,
  parseSlackBody,
  verifySlackSignature,
} from './connectors/slack.mjs';
import { metricsText, observabilitySummary } from './observability.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const UNSAFE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const OPEN_STATES = new Set([
  'queued',
  'claimed',
  'working',
  'verifying',
  'awaiting_review',
  'blocked',
  'failed',
]);

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...securityHeaders(),
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    ...securityHeaders(),
    ...headers,
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

function findSlackSource(sources) {
  return sources.find((source) => ['slack', 'im'].includes(source.kind)
    && source.status !== 'paused') || null;
}

function redactSource(source) {
  const copy = structuredClone(source);
  if (!copy.config || typeof copy.config !== 'object') return copy;
  for (const key of [
    'secret',
    'webhookSecret',
    'signingSecret',
    'token',
    'apiToken',
    'password',
  ]) {
    if (copy.config[key]) copy.config[key] = '••••••';
  }
  return copy;
}

function parseLimit(value, fallback = 200) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, 1000);
}

function auditFilterFrom(url) {
  const ok = url.searchParams.get('ok');
  return {
    action: (url.searchParams.get('action') || '').toLowerCase(),
    actor: (url.searchParams.get('actor') || '').toLowerCase(),
    source: (url.searchParams.get('source') || '').toLowerCase(),
    query: (url.searchParams.get('q') || '').toLowerCase(),
    ok: ok === 'true' ? true : ok === 'false' ? false : null,
    before: url.searchParams.get('before') || '',
    limit: parseLimit(url.searchParams.get('limit'), 100),
  };
}

function filterAuditEntries(entries, filter, sourceFallback = 'router') {
  const before = filter.before ? Date.parse(filter.before) : NaN;
  return [...(entries || [])]
    .map((entry) => ({
      ...entry,
      source: entry.source || sourceFallback,
      ok: entry.ok !== false,
    }))
    .filter((entry) => {
      if (filter.action && !String(entry.action || '').toLowerCase().includes(filter.action)) {
        return false;
      }
      if (filter.actor && !String(entry.actor || '').toLowerCase().includes(filter.actor)) {
        return false;
      }
      if (filter.source && !String(entry.source || '').toLowerCase().includes(filter.source)) {
        return false;
      }
      if (filter.ok !== null && Boolean(entry.ok) !== filter.ok) return false;
      if (Number.isFinite(before) && Date.parse(entry.at || 0) >= before) return false;
      if (filter.query) {
        const haystack = [
          entry.actor,
          entry.action,
          entry.detail,
          entry.project,
          entry.ip,
          entry.source,
        ].join(' ').toLowerCase();
        if (!haystack.includes(filter.query)) return false;
      }
      return true;
    })
    .sort((left, right) => Date.parse(right.at || 0) - Date.parse(left.at || 0))
    .slice(0, filter.limit);
}

export function createApi({ backend, auth, audit, publicDir, version = '0.1.0' }) {
  const clients = new Set();
  const publicRoot = resolve(publicDir);

  function publicSnapshot() {
    const snapshot = backend.snapshot();
    snapshot.sources = (snapshot.sources || []).map(redactSource);
    snapshot.capabilities = backend.capabilities;
    snapshot.projects = snapshot.projects || backend.projects();
    snapshot.consoleAudit = audit.list(50);
    snapshot.observability = observabilitySummary(snapshot);
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

  function record(req, authorization, action, detail, ok = true) {
    audit.record({
      actor: authorization?.actor || 'anonymous',
      source: authorization?.source || 'direct',
      ip: authorization?.ip || req.socket?.remoteAddress || 'local',
      via: authorization?.via || 'none',
      action,
      project: backend.projects().currentId,
      detail,
      ok,
    });
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
    const headers = { 'Cache-Control': 'no-store' };
    if (type.startsWith('text/html')) {
      headers['Set-Cookie'] = auth.sessionCookie();
      headers['Content-Security-Policy'] =
        "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'";
    }
    res.writeHead(200, {
      'Content-Type': type,
      ...securityHeaders(),
      ...headers,
    });
    res.end(readFileSync(file));
  }

  function streamState(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
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

    if (req.headers.origin && !auth.sameOrigin(req)) {
      return sendJson(res, 403, { error: 'cross-site request rejected' });
    }
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
    let projectEntry = null;
    let source = null;
    if (backend.mode === 'project') {
      const env = backend.registry.env || process.env;
      const entries = backend.registry.entries;
      const matches = entries.filter(
        (entry) => entry.githubRepo
          && repository
          && String(entry.githubRepo).toLowerCase() === repository.toLowerCase(),
      );
      if (matches.length > 1) {
        return sendJson(res, 409, {
          error: 'GitHub repository is registered more than once',
          repository,
        });
      }
      projectEntry = matches[0] || null;
      if (!projectEntry && entries.length === 1) projectEntry = entries[0];
      if (!projectEntry) {
        return sendJson(res, 503, {
          error: 'no registered project matches the GitHub repository',
          repository,
        });
      }
      const secretEnv = projectEntry.settings.connectors?.github?.webhookSecretEnv
        || 'SELF_LOOP_GITHUB_WEBHOOK_SECRET';
      source = {
        id: 'src_github',
        name: `GitHub · ${projectEntry.name}`,
        kind: 'github',
        status: 'healthy',
        config: {
          repo: projectEntry.githubRepo,
          webhookSecret: env[secretEnv] || env.GITHUB_WEBHOOK_SECRET || '',
        },
      };
    } else {
      source = findGitHubSource(backend.snapshot().sources, repository);
    }
    if (!source) {
      return sendJson(res, 503, { error: 'no GitHub source configured' });
    }
    if (!source.config?.repo) {
      return sendJson(res, 503, { error: 'GitHub repository is not configured' });
    }
    if (
      repository
      && String(source.config.repo).toLowerCase() !== repository.toLowerCase()
    ) {
      return sendJson(res, 503, { error: 'GitHub repository does not match the configured source' });
    }

    const secret = source.config?.webhookSecret || source.config?.secret;
    if (!secret) {
      return sendJson(res, 503, { error: 'GitHub webhook secret is not configured' });
    }
    if (!verifyGitHubSignature(secret, rawBody, signature)) {
      return sendJson(res, 401, { error: 'invalid GitHub webhook signature' });
    }

    const { eventInput, ignoredReason } = normalizeGitHubEvent(eventName, payload);
    const dedupeKey = `${source.id}:github:${delivery}`;
    let result;
    try {
      if (backend.mode === 'project') {
        const taskEvent = eventInput.kind === 'task.created';
        const ticket = taskEvent
          ? null
          : Number(eventInput.externalId?.replace(/\D/g, '')) || null;
        const posted = await backend.runRouterFor(projectEntry, [
          'post',
          '--type',
          taskEvent ? 'task' : eventName === 'pull_request' ? 'pull_request' : 'issue',
          ...(ticket ? ['--ticket', String(ticket)] : []),
          '--action',
          String(payload.action || ''),
          '--id',
          dedupeKey,
          '--data',
          JSON.stringify(taskEvent
            ? {
                ...eventInput,
                source: { id: source.id, kind: source.kind, name: source.name },
              }
            : payload),
        ]);
        let duplicate = false;
        try {
          duplicate = Boolean(JSON.parse(posted.stdout).duplicate);
        } catch {}
        result = {
          duplicate,
          event: {
            id: dedupeKey,
            kind: eventInput.kind,
            status: ignoredReason ? 'ignored' : 'pending',
            ignoredReason,
          },
        };
      } else {
        result = backend.ingestEvent({
          ...eventInput,
          sourceId: source.id,
          dedupeKey,
          ignoredReason,
        });
      }
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

  async function handleSlackWebhook(req, res) {
    if (req.headers.origin && !auth.sameOrigin(req)) {
      return sendJson(res, 403, { error: 'cross-site request rejected' });
    }
    const rawBody = await readRawBody(req);
    const contentType = req.headers['content-type'] || '';
    const timestamp = req.headers['x-slack-request-timestamp'];
    const signature = req.headers['x-slack-signature'];
    let source = null;
    let projectEntry = null;
    if (backend.mode === 'project') {
      const env = backend.registry.env || process.env;
      const candidates = backend.registry.entries
        .map((entry) => ({ entry, config: entry.settings.connectors?.slack }))
        .filter((candidate) => candidate.config?.enabled);
      if (!candidates.length) {
        return sendJson(res, 503, { error: 'no Slack source configured' });
      }
      const withSecrets = candidates.map((candidate) => ({
        ...candidate,
        secret: env[candidate.config.signingSecretEnv || 'SLACK_SIGNING_SECRET'] || '',
      }));
      if (!withSecrets.some((candidate) => candidate.secret)) {
        return sendJson(res, 503, { error: 'Slack signing secret is not configured' });
      }
      const verified = withSecrets.filter((candidate) => verifySlackSignature(
        candidate.secret,
        rawBody,
        timestamp,
        signature,
      ));
      if (!verified.length) {
        return sendJson(res, 401, { error: 'invalid or expired Slack signature' });
      }
      let chosen = verified[0];
      if (verified.length > 1) {
        let channel = '';
        try {
          const probe = parseSlackBody(rawBody, contentType);
          channel = String(probe.form?.channel_id || probe.json?.event?.channel || '');
        } catch {}
        const narrowed = channel
          ? verified.filter((candidate) => {
              const allowed = (candidate.config.allowedChannels || []).map(String);
              return !allowed.length || allowed.includes(channel);
            })
          : verified;
        if (narrowed.length === 1) chosen = narrowed[0];
        else if (narrowed.length > 1) {
          return sendJson(res, 409, {
            error: 'Slack request matches multiple projects; configure distinct signing secrets',
          });
        } else {
          return sendJson(res, 403, { error: 'Slack channel is not allowed' });
        }
      }
      projectEntry = chosen.entry;
      source = {
        id: 'src_slack',
        name: `Slack · ${chosen.entry.name}`,
        kind: 'slack',
        status: 'healthy',
        config: chosen.config,
      };
    } else {
      source = findSlackSource(backend.snapshot().sources || []);
      if (!source) {
        return sendJson(res, 503, { error: 'no Slack source configured' });
      }
      const signingSecret = source.config?.signingSecret
        || (source.config?.signingSecretEnv
          ? process.env[source.config.signingSecretEnv]
          : '')
        || process.env.SLACK_SIGNING_SECRET
        || '';
      if (!signingSecret) {
        return sendJson(res, 503, { error: 'Slack signing secret is not configured' });
      }
      if (!verifySlackSignature(signingSecret, rawBody, timestamp, signature)) {
        return sendJson(res, 401, { error: 'invalid or expired Slack signature' });
      }
    }

    let parsed;
    try {
      parsed = parseSlackBody(rawBody, contentType);
    } catch (error) {
      return sendJson(res, 400, { error: error.message });
    }
    if (parsed.json?.type === 'url_verification') {
      return sendText(res, 200, String(parsed.json.challenge || ''));
    }

    const normalized = parsed.form
      ? normalizeSlackCommand(parsed.form, {
          allowedChannels: source.config?.allowedChannels || [],
        })
      : normalizeSlackEvent(parsed.json, {
          respondToMessages: Boolean(source.config?.respondToMessages),
          allowedChannels: source.config?.allowedChannels || [],
        });
    const acknowledgement = normalized.acknowledgement
      || (normalized.eventInput
        ? `已收到 #${normalized.eventInput.title}`
        : normalized.ignoredReason);

    if (!normalized.eventInput) {
      return sendJson(res, 200, {
        ok: true,
        ignoredReason: normalized.ignoredReason,
        response_type: 'ephemeral',
        text: acknowledgement,
      });
    }

    const eventInput = {
      ...normalized.eventInput,
      source: {
        id: source.id,
        kind: 'slack',
        name: source.name,
      },
      dedupeKey: `${source.id}:${normalized.eventInput.dedupeKey}`,
    };
    const result = await backend.ingestConnectorEvent(eventInput, source, projectEntry || undefined);
    broadcast();
    return sendJson(res, parsed.form ? 200 : 202, {
      ok: true,
      duplicate: result.duplicate,
      response_type: 'ephemeral',
      text: result.duplicate ? '这个请求已经在 Inbox 中。' : acknowledgement,
      event: {
        id: result.event.id,
        kind: result.event.kind,
      },
    });
  }

  function bearerToken(req) {
    const raw = String(req.headers.authorization || '');
    return raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : '';
  }

  async function handleRemoteApi(req, res, path) {
    if (backend.mode !== 'project') {
      return sendJson(res, 409, { error: 'remote workers are available in project mode only' });
    }
    const token = bearerToken(req);
    if (!token) return sendJson(res, 401, { error: 'worker token is required' });
    try {
      if (path === '/api/remote/heartbeat') {
        const body = await readBody(req);
        const result = await backend.heartbeatRemoteWorker(token, body);
        return sendJson(res, 200, result);
      }
      if (path === '/api/remote/claim') {
        const result = await backend.claimRemoteWorker(token);
        if (result.status === 'claimed') broadcast();
        return sendJson(res, 200, result);
      }
      if (path === '/api/remote/complete') {
        const body = await readBody(req);
        const result = await backend.completeRemoteWorker(token, body.ticket, body.result);
        broadcast();
        return sendJson(res, 200, result);
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message });
    }
  }

  function requireCapability(name, label) {
    if (backend.capabilities[name]) return;
    backend.unsupported(label);
  }

  async function handleApi(req, res, url) {
    const path = url.pathname;
    const method = req.method || 'GET';

    if (method === 'OPTIONS') {
      if (!auth.sameOrigin(req)) {
        return sendJson(res, 403, { error: 'cross-site request rejected' });
      }
      res.writeHead(204, {
        Allow: 'GET,POST,PATCH,OPTIONS',
        ...securityHeaders(),
      });
      return res.end();
    }

    if (!auth.sameOrigin(req)) {
      record(req, null, 'request.rejected', `cross-site ${method} ${path}`, false);
      return sendJson(res, 403, { error: 'cross-site request rejected' });
    }

    if (path.startsWith('/api/remote/') && method === 'POST') {
      return handleRemoteApi(req, res, path);
    }

    let authorization = null;
    if (UNSAFE_METHODS.has(method)) {
      authorization = auth.authorize(req);
      if (!authorization.ok) {
        record(req, null, 'auth.rejected', `${method} ${path}`, false);
        return sendJson(res, authorization.status || 401, { error: authorization.reason });
      }
    }

    if (path === '/api/health' && method === 'GET') {
      const projects = backend.projects();
      return sendJson(res, 200, {
        ok: true,
        version,
        mode: backend.mode,
        running: true,
        project: projects.currentId,
        auth: {
          writeProtected: true,
          tokenFile: auth.file,
        },
        uptimeSeconds: Math.max(
          0,
          Math.round((Date.now() - Date.parse(backend.snapshot().meta.serverStartedAt || Date.now())) / 1000),
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
      const overview = backend.overview();
      overview.sources = (overview.sources || []).map(redactSource);
      overview.capabilities = backend.capabilities;
      overview.projects = overview.projects || backend.projects();
      return sendJson(res, 200, overview);
    }

    if (path === '/api/projects' && method === 'GET') {
      return sendJson(res, 200, backend.projects());
    }

    if (path === '/api/projects' && method === 'POST') {
      requireCapability('projectAdd', '添加项目');
      const body = await readBody(req);
      const result = backend.addProject(body);
      record(req, authorization, 'project.added', result.project?.id || '');
      broadcast();
      return sendJson(res, result.added ? 201 : 200, result);
    }

    if (path === '/api/projects/select' && method === 'POST') {
      requireCapability('projectSelect', '选择项目');
      const body = await readBody(req);
      const result = backend.selectProject(body.id);
      record(req, authorization, 'project.selected', `project=${body.id}`);
      broadcast();
      return sendJson(res, 200, result);
    }

    const projectSelect = path.match(/^\/api\/projects\/([^/]+)\/select$/);
    if (projectSelect && method === 'POST') {
      requireCapability('projectSelect', '选择项目');
      const id = decodeURIComponent(projectSelect[1]);
      const result = backend.selectProject(id);
      record(req, authorization, 'project.selected', `project=${id}`);
      broadcast();
      return sendJson(res, 200, result);
    }

    const projectDetail = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectDetail && method === 'DELETE') {
      requireCapability('projectRemove', '移除项目');
      const id = decodeURIComponent(projectDetail[1]);
      const result = backend.removeProject(id);
      record(req, authorization, 'project.removed', `project=${id}`);
      broadcast();
      return sendJson(res, 200, result);
    }

    if (path === '/api/auth/rotate' && method === 'POST') {
      requireCapability('authRotate', '轮换 token');
      const result = auth.rotate();
      record(req, authorization, 'auth.rotated', 'write token rotated');
      res.setHeader('Set-Cookie', auth.sessionCookie());
      return sendJson(res, 200, {
        ok: true,
        tokenFile: result.file,
        token: result.token,
      });
    }

    if (path === '/api/tick' && method === 'POST') {
      requireCapability('tick', '运行 tick');
      const result = await backend.tick();
      record(req, authorization, 'router.tick', `mode=${backend.mode}`);
      broadcast();
      return sendJson(res, 200, result);
    }

    if (path === '/api/config' && method === 'GET') {
      const snapshot = backend.snapshot();
      return sendJson(res, 200, {
        config: snapshot.config,
        meta: {
          paused: snapshot.meta.paused,
          demo: snapshot.meta.demo,
          mode: backend.mode,
        },
        capabilities: backend.capabilities,
      });
    }

    if (path === '/api/config' && method === 'PATCH') {
      requireCapability('configWrite', '修改运行参数');
      const patch = await readBody(req);
      const config = backend.updateConfig(patch);
      record(req, authorization, 'config.updated', JSON.stringify(patch));
      broadcast();
      const snapshot = backend.snapshot();
      return sendJson(res, 200, {
        config,
        meta: {
          paused: snapshot.meta.paused,
          demo: snapshot.meta.demo,
          mode: backend.mode,
        },
      });
    }

    if (path === '/api/sources' && method === 'GET') {
      return sendJson(res, 200, { sources: publicSnapshot().sources });
    }

    if (path === '/api/sources' && method === 'POST') {
      requireCapability('sourceWrite', '新增连接器');
      const body = await readBody(req);
      const source = backend.addSource(body);
      record(req, authorization, 'source.created', source.name);
      broadcast();
      return sendJson(res, 201, { source: redactSource(source) });
    }

    const sourceDetail = path.match(/^\/api\/sources\/([^/]+)$/);
    if (sourceDetail && method === 'PATCH') {
      requireCapability('sourceWrite', '修改连接器');
      const body = await readBody(req);
      const source = backend.updateSource(decodeURIComponent(sourceDetail[1]), body);
      record(req, authorization, 'source.updated', source.name);
      broadcast();
      return sendJson(res, 200, { source: redactSource(source) });
    }

    const sourceToggle = path.match(/^\/api\/sources\/([^/]+)\/toggle$/);
    if (sourceToggle && method === 'POST') {
      requireCapability('sourceWrite', '暂停连接器');
      const source = backend.toggleSource(decodeURIComponent(sourceToggle[1]));
      record(req, authorization, 'source.toggled', source.name);
      broadcast();
      return sendJson(res, 200, { source: redactSource(source) });
    }

    if (path === '/api/automations' && method === 'GET') {
      return sendJson(res, 200, { automations: publicSnapshot().automations || [] });
    }

    if (path === '/api/observability' && method === 'GET') {
      return sendJson(res, 200, observabilitySummary(publicSnapshot()));
    }

    if (path === '/api/automations' && method === 'POST') {
      requireCapability('automationWrite', '新增定时自动化');
      const body = await readBody(req);
      const result = await backend.addAutomation(body);
      record(req, authorization, 'automation.created', result.automation?.id || '');
      broadcast();
      return sendJson(res, 201, result);
    }

    const automationAction = path.match(/^\/api\/automations\/([^/]+)\/(toggle|run)$/);
    if (automationAction && method === 'POST') {
      requireCapability('automationWrite', '操作定时自动化');
      const id = decodeURIComponent(automationAction[1]);
      const result = automationAction[2] === 'run'
        ? await backend.runAutomation(id)
        : await backend.toggleAutomation(id);
      record(req, authorization, `automation.${automationAction[2]}`, id);
      broadcast();
      return sendJson(res, 200, result);
    }

    const automationDetail = path.match(/^\/api\/automations\/([^/]+)$/);
    if (automationDetail && method === 'PATCH') {
      requireCapability('automationWrite', '编辑定时自动化');
      const id = decodeURIComponent(automationDetail[1]);
      const body = await readBody(req);
      const result = await backend.editAutomation(id, body);
      record(req, authorization, 'automation.updated', id);
      broadcast();
      return sendJson(res, 200, result);
    }
    if (automationDetail && method === 'DELETE') {
      requireCapability('automationWrite', '删除定时自动化');
      const id = decodeURIComponent(automationDetail[1]);
      const result = await backend.removeAutomation(id);
      record(req, authorization, 'automation.removed', id);
      broadcast();
      return sendJson(res, 200, result);
    }

    const automationHistory = path.match(/^\/api\/automations\/([^/]+)\/history$/);
    if (automationHistory && method === 'GET') {
      return sendJson(res, 200, await backend.automationHistory(
        decodeURIComponent(automationHistory[1]),
      ));
    }

    if (path === '/api/events' && method === 'GET') {
      const status = url.searchParams.get('status');
      const limit = parseLimit(url.searchParams.get('limit'));
      const events = [...(publicSnapshot().events || [])]
        .filter((event) => !status || event.status === status)
        .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt))
        .slice(0, limit);
      return sendJson(res, 200, { events });
    }

    if (path === '/api/events' && method === 'POST') {
      requireCapability('injectEvent', '注入事件');
      const body = await readBody(req);
      const result = backend.ingestEvent({ ...body, actor: authorization.actor });
      record(req, authorization, 'event.injected', result.event?.title || '');
      broadcast();
      return sendJson(res, result.duplicate ? 200 : 201, result);
    }

    if (path === '/api/tickets' && method === 'GET') {
      const stateFilter = url.searchParams.get('state');
      const limit = parseLimit(url.searchParams.get('limit'));
      const tickets = (publicSnapshot().tickets || [])
        .filter((ticket) => {
          if (!stateFilter || stateFilter === 'all') return true;
          if (stateFilter === 'active') return OPEN_STATES.has(ticket.state);
          if (stateFilter === 'blocked') return ['blocked', 'failed'].includes(ticket.state);
          if (stateFilter === 'done') return ['done', 'dropped'].includes(ticket.state);
          return ticket.state === stateFilter;
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
      let result;
      if (action === 'answer') {
        requireCapability('ticketAnswer', '回答 Ticket');
        result = backend.answerTicket(id, body.answer, authorization.actor);
      }
      if (action === 'retry') {
        requireCapability('ticketRetry', '重跑 Ticket');
        result = await backend.retryTicket(id, authorization.actor);
      }
      if (action === 'cancel') {
        requireCapability('ticketCancel', '取消 Ticket');
        result = await backend.cancelTicket(id, authorization.actor);
      }
      if (action === 'approve') {
        requireCapability('ticketApprove', '验收 Ticket');
        result = await backend.approveTicket(id, authorization.actor);
      }
      record(req, authorization, `ticket.${action}`, `ticket=${id}`);
      broadcast();
      return sendJson(res, 200, {
        ticket: result?.ticket || result,
        result,
      });
    }

    const ticketDetail = path.match(/^\/api\/tickets\/([^/]+)$/);
    if (ticketDetail && method === 'GET') {
      const detail = backend.ticketDetail(decodeURIComponent(ticketDetail[1]));
      if (!detail) return sendJson(res, 404, { error: 'ticket not found' });
      return sendJson(res, 200, detail);
    }

    if (path === '/api/outbox' && method === 'GET') {
      const stateFilter = url.searchParams.get('state');
      const limit = parseLimit(url.searchParams.get('limit'));
      const deliveries = (publicSnapshot().deliveries || [])
        .filter((delivery) => !stateFilter || stateFilter === 'all' || delivery.state === stateFilter)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit);
      return sendJson(res, 200, { deliveries, capabilities: backend.capabilities });
    }

    if (path === '/api/outbox/flush' && method === 'POST') {
      requireCapability('outboxFlush', '投递消息');
      const result = await backend.flushOutbox();
      record(req, authorization, 'outbox.flushed', `mode=${backend.mode}`);
      broadcast();
      return sendJson(res, 200, result);
    }

    if (path === '/api/connectors/jira/sync' && method === 'POST') {
      requireCapability('connectorSync', '同步 Jira');
      const result = await backend.syncJira();
      record(req, authorization, 'connector.jira.sync', `status=${result.status}`);
      broadcast();
      return sendJson(res, 200, {
        ok: result.status === 'healthy',
        status: result.status,
        fetched: result.fetched || 0,
        events: (result.events || []).length,
        error: result.error || null,
        nextSyncAt: result.nextSyncAt || null,
      });
    }

    const deliveryReplay = path.match(/^\/api\/outbox\/([^/]+)\/replay$/);
    if (deliveryReplay && method === 'POST') {
      requireCapability('outbox', '重投消息');
      const delivery = await backend.replayDelivery(
        decodeURIComponent(deliveryReplay[1]),
        authorization.actor,
      );
      record(req, authorization, 'delivery.replayed', `delivery=${deliveryReplay[1]}`);
      broadcast();
      return sendJson(res, 200, { delivery });
    }

    if (path === '/api/workers' && method === 'GET') {
      return sendJson(res, 200, {
        workers: publicSnapshot().workers || [],
        remoteWorkers: publicSnapshot().remoteWorkers || [],
      });
    }

    if (path === '/api/workers/register' && method === 'POST') {
      requireCapability('remoteWorkerWrite', '注册远程执行器');
      const body = await readBody(req);
      const result = await backend.registerRemoteWorker(body);
      record(req, authorization, 'worker.registered', result.worker?.id || '');
      broadcast();
      return sendJson(res, 201, result);
    }

    const workerRotate = path.match(/^\/api\/workers\/([^/]+)\/rotate$/);
    if (workerRotate && method === 'POST') {
      requireCapability('remoteWorkerWrite', '轮换远程执行器 token');
      const id = decodeURIComponent(workerRotate[1]);
      const result = await backend.rotateRemoteWorker(id);
      record(req, authorization, 'worker.token_rotated', id);
      broadcast();
      return sendJson(res, 200, result);
    }

    const remoteWorkerDetail = path.match(/^\/api\/workers\/([^/]+)$/);
    if (remoteWorkerDetail && method === 'DELETE') {
      requireCapability('remoteWorkerWrite', '吊销远程执行器');
      const id = decodeURIComponent(remoteWorkerDetail[1]);
      const result = await backend.revokeRemoteWorker(id);
      record(req, authorization, 'worker.revoked', id);
      broadcast();
      return sendJson(res, 200, result);
    }

    const workerToggle = path.match(/^\/api\/workers\/([^/]+)\/toggle$/);
    if (workerToggle && method === 'POST') {
      requireCapability('workerWrite', '暂停 Worker');
      const worker = backend.toggleWorker(decodeURIComponent(workerToggle[1]));
      record(req, authorization, 'worker.toggled', worker.name);
      broadcast();
      return sendJson(res, 200, { worker });
    }

    if (path === '/api/audit' && method === 'GET') {
      const filter = auditFilterFrom(url);
      const snapshot = publicSnapshot();
      const routerAudit = filterAuditEntries(snapshot.audit, filter, 'router');
      const consoleAudit = filterAuditEntries(
        audit.list(500),
        filter,
        'console',
      );
      const entries = [...routerAudit, ...consoleAudit]
        .sort((left, right) => Date.parse(right.at || 0) - Date.parse(left.at || 0))
        .slice(0, filter.limit);
      return sendJson(res, 200, {
        audit: routerAudit,
        consoleAudit,
        entries,
        limit: filter.limit,
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/hooks/github' && req.method === 'POST') {
        await handleGitHubWebhook(req, res);
      } else if (url.pathname === '/hooks/slack' && req.method === 'POST') {
        await handleSlackWebhook(req, res);
      } else if (url.pathname === '/metrics' && req.method === 'GET') {
        if (req.headers.origin && !auth.sameOrigin(req)) {
          return sendText(res, 403, 'forbidden');
        }
        return sendText(
          res,
          200,
          metricsText(backend.snapshot()),
          'text/plain; version=0.0.4; charset=utf-8',
        );
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
      const status = error?.statusCode
        || (message === 'body too large' ? 413 : message === 'invalid JSON body' ? 400 : 400);
      sendJson(res, status, { error: message });
    }
  }

  return { handler, broadcast, clients };
}
