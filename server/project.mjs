import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveRepo, resolveSettings } from '../scripts/lib.mjs';
import { resolveExecutorAdapter } from '../scripts/executors.mjs';
import { loadOutbox, outboxSummary } from '../scripts/outbox.mjs';
import { loadJiraCursor, syncJira } from './connectors/jira.mjs';
import * as automationStore from '../scripts/automations.mjs';
import { listWorkers } from '../scripts/workers.mjs';

const execFileAsync = promisify(execFile);
const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const routerScript = join(skillRoot, 'scripts', 'router.mjs');

export const PROJECT_CAPABILITIES = Object.freeze({
  mode: 'project',
  liveState: true,
  outbox: true,
  outboxFlush: true,
  simulate: false,
  pause: false,
  injectEvent: false,
  sourceWrite: false,
  workerWrite: false,
  configWrite: false,
  ticketAnswer: false,
  ticketRetry: true,
  ticketCancel: true,
  ticketApprove: false,
  tick: true,
  projectSelect: true,
  projectWrite: true,
  projectAdd: true,
  projectRemove: true,
  connectorSync: true,
  automationWrite: true,
  remoteWorkerWrite: true,
  authRotate: true,
});

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON at ${file}: ${error.message}`);
  }
}

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function hashId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 10);
}

function projectName(repoRoot, githubRepo) {
  if (githubRepo) return githubRepo.split('/').at(-1);
  return basename(repoRoot);
}

function labelPriority(labels = []) {
  const names = labels.map((label) => String(label).toLowerCase());
  if (names.some((name) => ['priority:urgent', 'p0', 'urgent'].includes(name))) return 'urgent';
  if (names.some((name) => ['priority:high', 'p1', 'high'].includes(name))) return 'high';
  if (names.some((name) => ['priority:low', 'p3', 'low'].includes(name))) return 'low';
  return 'normal';
}

function excerpt(value, length = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function extractAcceptance(body = '') {
  const values = [];
  let inSection = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    if (/^\s*#{1,6}\s+.*(acceptance|acceptance criteria|验收)/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s*#{1,6}\s+/.test(line)) inSection = false;
    const checkbox = line.match(/^\s*[-*]\s*\[[ xX]\]\s+(.+)$/);
    if (checkbox) {
      values.push(checkbox[1].trim());
      continue;
    }
    if (inSection) {
      const item = line.match(/^\s*[-*]\s+(.+)$/);
      if (item) values.push(item[1].trim());
    }
  }
  return [...new Set(values.filter(Boolean))];
}

function stateSignature(statePath, inboxPath, outboxPath) {
  const parts = [];
  for (const file of [statePath, inboxPath, outboxPath]) {
    try {
      const stat = statSync(file);
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join('|');
}

function emptyCoreState(entry) {
  return {
    version: 1,
    repo: entry.githubRepo || '',
    activeTicket: null,
    tickets: {},
    updatedAt: null,
  };
}

function emptyOutboxState() {
  return { version: 1, updatedAt: null, deliveries: [] };
}

function mapEvent(event, source) {
  const payload = event.payload || {};
  const issue = payload.issue || payload.pull_request || {};
  const title = issue.title
    || payload.title
    || (event.type === 'issue' ? `GitHub issue #${event.ticket ?? ''}` : `${event.type} event`);
  return {
    id: String(event.id),
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    kind: event.type === 'task'
      ? (payload.kind || 'task.created')
      : event.type === 'issue'
        ? `issue.${event.action || 'event'}`
        : `github.${event.type}`,
    title,
    body: issue.body || payload.body || event.error || '',
    actor: payload.actor || payload.sender?.login || source.kind,
    externalId: event.ticket
      ? `GH-${event.ticket}`
      : payload.externalId || String(event.id),
    dedupeKey: String(event.id),
    priority: payload.priority
      || labelPriority(issue.labels?.map((label) => label?.name || label) || []),
    labels: (issue.labels || payload.labels || [])
      .map((label) => label?.name || label)
      .filter(Boolean),
    acceptance: payload.acceptance || [],
    scope: payload.scope || [],
    risk: payload.risk || 'medium',
    status: event.handledAt ? (event.outcome === 'error' ? 'ignored' : 'consumed') : 'pending',
    receivedAt: event.createdAt,
    consumedAt: event.handledAt || null,
    ticketId: event.ticket ? ticketId(event.ticket) : null,
    ignoredReason: event.error || (event.type === 'schedule' ? '仅唤醒 Router' : null),
  };
}

function ticketId(number) {
  return `tkt_${number}`;
}

function mapDelivery(delivery) {
  return {
    id: String(delivery.id),
    ticketId: delivery.ticket ? ticketId(delivery.ticket) : null,
    ticketNumber: delivery.ticket || null,
    channel: delivery.channel,
    target: delivery.target,
    kind: delivery.kind || 'ticket.status',
    state: delivery.state,
    attempts: Number(delivery.attempts || 0),
    maxAttempts: Number(delivery.maxAttempts || 5),
    lastError: delivery.lastError || null,
    statusCode: delivery.statusCode ?? null,
    requestId: delivery.requestId || null,
    idempotencyKey: delivery.idempotencyKey || '',
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
    sentAt: delivery.sentAt || null,
  };
}

function mapTicket(ticket, entry, source) {
  const number = Number(ticket.number);
  const labels = ticket.labels || [];
  const taskCard = ticket.taskCard || {};
  const verification = ticket.verification || null;
  const prNumber = Number(ticket.pr) || null;
  const workerName = ticket.worker?.pid
    ? `${ticket.worker.adapter || 'worker'} · pid ${ticket.worker.pid}`
    : ['working', 'verifying', 'claimed'].includes(ticket.state)
      ? 'Router worker'
      : null;
  const lastResultState = ticket.lastResult?.state;
  const lastError = ticket.lastResult?.error?.message
    || (['failed', 'blocked', 'timeout', 'undeliverable'].includes(lastResultState)
      ? ticket.lastResult?.humanText
      : null)
    || (verification?.status === 'fail' ? '独立验证失败' : null);
  const acceptance = taskCard.acceptance?.length
    ? taskCard.acceptance
    : extractAcceptance(ticket.body);

  return {
    id: ticketId(number),
    number,
    projectId: entry.id,
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    externalId: ticket.url || `GH-${number}`,
    title: ticket.title || `Issue #${number}`,
    summary: excerpt(ticket.body || taskCard.goal || ''),
    state: ticket.state,
    priority: labelPriority(labels),
    labels,
    acceptance,
    scope: taskCard.inScope?.length ? taskCard.inScope : ticket.inScope || ['**'],
    risk: taskCard.risk || ticket.risk || 'medium',
    sourceEventId: null,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    attempts: Number(ticket.attempts || 0),
    maxAttempts: Number(ticket.maxAttempts || 2),
    workerId: workerName ? `worker_${hashId(workerName)}` : null,
    workerName,
    lease: ticket.lease
      ? { expiresAt: ticket.lease.expiresAt, startedAt: ticket.lease.startedAt }
      : null,
    currentAttemptId: null,
    pr: prNumber
      ? {
          number: prNumber,
          url: ticket.url ? `${ticket.url.replace(/\/issues\/\d+$/, '')}/pull/${prNumber}` : '',
          branch: ticket.branch || '',
        }
      : null,
    humanQuestion: ticket.humanQuestion || null,
    humanAnswer: null,
    lastError,
    approvedAt: ticket.state === 'done' ? ticket.updatedAt : null,
    approvedBy: null,
    core: {
      url: ticket.url || '',
      branch: ticket.branch || null,
      worktree: ticket.worktree || null,
      taskCard,
      verification,
      lastResult: ticket.lastResult || null,
      manualRecoveries: ticket.manualRecoveries || 0,
      artifacts: ticket.artifacts || [],
    },
  };
}

function mapAttempt(ticket, mapped) {
  const verification = ticket.verification || null;
  if (!mapped.attempts && !verification && !ticket.lastResult) return null;
  const number = Math.max(1, Number(ticket.attempts || 1));
  const evidence = (verification?.checks || []).map((check) => ({
    gate: check.command,
    command: check.command,
    exitCode: check.exitCode,
    durationMs: check.durationMs,
    outputPath: check.stdoutPath || verification.evidencePath,
    stderrPath: check.stderrPath || null,
    evidencePath: verification.evidencePath,
    summary: check.status,
  }));
  const lastResultState = ticket.lastResult?.state;
  const runState = ['working', 'verifying'].includes(ticket.state);
  const attemptState = verification?.status === 'pass'
    ? 'passed'
    : verification?.status === 'fail'
      ? 'failed'
      : ['failed', 'blocked', 'timeout', 'undeliverable'].includes(lastResultState)
        ? 'failed'
        : runState
          ? 'running'
          : ['awaiting_review', 'done', 'dropped'].includes(ticket.state)
            ? 'passed'
            : ['blocked', 'failed'].includes(ticket.state)
              ? 'failed'
              : ['ready', 'dropped'].includes(lastResultState)
                ? 'passed'
                : 'failed';
  const phase = runState
    ? ticket.state
    : verification
      ? 'verifying'
      : lastResultState === 'ready'
        ? 'verifying'
        : 'working';
  return {
    id: `att_${ticket.number}_${number}`,
    ticketId: mapped.id,
    ticketNumber: ticket.number,
    number,
    workerId: mapped.workerId,
    workerName: mapped.workerName || 'self-loop worker',
    state: attemptState,
    phase,
    startedAt: ticket.lease?.startedAt || ticket.createdAt,
    phaseAt: ticket.updatedAt,
    finishedAt: attemptState === 'running' ? null : ticket.updatedAt,
    evidence,
    error: mapped.lastError,
  };
}

function mapWorkers(tickets, entry, mappedTickets) {
  const active = tickets.filter((ticket) => ['claimed', 'working', 'verifying'].includes(ticket.state));
  if (!active.length) {
    return [
      {
        id: 'worker_project',
        name: entry.executorCommand ? basename(entry.executorCommand) : 'project executor',
        kind: entry.executorAdapter || (entry.executorCommand ? 'command' : 'shell'),
        status: 'online',
        paused: false,
        currentTicketId: null,
        lastHeartbeat: entry.updatedAt,
        capabilities: entry.executorCommand ? ['issue-to-pr'] : [],
        concurrency: entry.maxConcurrent,
        note: entry.executorCommand ? '' : '未配置 executor.command',
      },
    ];
  }
  return active.map((ticket) => {
    const mapped = mappedTickets.find((item) => item.number === Number(ticket.number));
    return {
      id: mapped?.workerId || `worker_${ticket.number}`,
      name: mapped?.workerName || 'Router worker',
      kind: ticket.worker?.adapter || entry.executorAdapter || (ticket.worker?.pid ? 'command' : 'shell'),
      status: 'busy',
      paused: false,
      currentTicketId: mapped?.id || ticketId(ticket.number),
      lastHeartbeat: ticket.worker?.heartbeatAt || ticket.updatedAt,
      capabilities: ['issue-to-pr'],
      concurrency: 1,
      note: '项目模式只读；Worker 由 Router 调度',
    };
  });
}

function derivedAudit(tickets, project) {
  const entries = [];
  for (const ticket of tickets) {
    entries.push({
      id: `aud_${ticket.number}_${ticket.updatedAt}`,
      at: ticket.updatedAt,
      actor: 'router',
      action: `ticket.${ticket.state}`,
      entity: 'ticket',
      entityId: ticketId(ticket.number),
      ticketId: ticketId(ticket.number),
      ticketNumber: ticket.number,
      detail: `#${ticket.number} ${ticket.title} · ${ticket.state}`,
      tone: ['blocked', 'failed'].includes(ticket.state)
        ? 'error'
        : ticket.state === 'done'
          ? 'success'
          : 'info',
      source: `${project}.loop/state.json`,
      derived: true,
    });
  }
  return entries.sort((a, b) => parseTime(b.at) - parseTime(a.at));
}

function buildOverview(snapshot) {
  const tickets = snapshot.tickets;
  const deliveries = snapshot.deliveries || [];
  const done = tickets.filter((ticket) => ticket.state === 'done');
  const finished = tickets.filter((ticket) => ['done', 'dropped', 'failed'].includes(ticket.state));
  const active = tickets.filter((ticket) =>
    ['queued', 'claimed', 'working', 'verifying', 'awaiting_review', 'blocked'].includes(
      ticket.state,
    ),
  );
  return {
    meta: snapshot.meta,
    config: snapshot.config,
    project: snapshot.config.project,
    capabilities: snapshot.capabilities,
    health: snapshot.health,
    counts: {
      sources: snapshot.sources.length,
      sourcesHealthy: snapshot.sources.filter((source) => source.status === 'healthy').length,
      sourcesPaused: snapshot.sources.filter((source) => source.status === 'paused').length,
      events: snapshot.events.length,
      pendingEvents: snapshot.events.filter((event) => event.status === 'pending').length,
      tickets: tickets.length,
      activeTickets: active.length,
      awaitingReview: tickets.filter((ticket) => ticket.state === 'awaiting_review').length,
      blocked: tickets.filter((ticket) => ['blocked', 'failed'].includes(ticket.state)).length,
      done: done.length,
      deliveries: deliveries.length,
      deliveriesPending: deliveries.filter((delivery) =>
        ['pending', 'sending', 'failed'].includes(delivery.state)
      ).length,
      deliveriesFailed: deliveries.filter((delivery) =>
        ['failed', 'dead'].includes(delivery.state)
      ).length,
      workersOnline: snapshot.workers.filter((worker) =>
        ['online', 'busy'].includes(worker.status),
      ).length,
      workersBusy: snapshot.workers.filter((worker) => worker.status === 'busy').length,
    },
    pipeline: [
      ['queued', ['queued']],
      ['working', ['claimed', 'working']],
      ['verifying', ['verifying']],
      ['review', ['awaiting_review']],
      ['blocked', ['blocked', 'failed']],
      ['done', ['done', 'dropped']],
    ].map(([key, states]) => ({
      key,
      label: key[0].toUpperCase() + key.slice(1),
      count: tickets.filter((ticket) => states.includes(ticket.state)).length,
    })),
    activeTickets: active.slice(0, 6),
    recentAudit: snapshot.audit.slice(0, 10),
    recentDeliveries: deliveries.slice(0, 8),
    sources: snapshot.sources,
    workers: snapshot.workers,
    avgCycleMinutes: done.length
      ? Math.round(
          done.reduce(
            (sum, ticket) => sum + parseTime(ticket.updatedAt) - parseTime(ticket.createdAt),
            0,
          ) /
            done.length /
            60_000,
        )
      : null,
    successRate: finished.length ? Math.round((done.length / finished.length) * 100) : null,
  };
}

export class ProjectRegistry {
  constructor(projects = [], {
    cwd = process.cwd(),
    outDir = null,
    env = process.env,
    store = null,
    currentId = null,
  } = {}) {
    const values = Array.isArray(projects) ? projects : [projects];
    const seen = new Set();
    this.entries = [];
    this.env = env;
    this.store = store;
    this.cwd = cwd;
    this.outDir = outDir;
    for (const value of values.filter(Boolean)) {
      const descriptor = typeof value === 'string' ? { path: value } : value;
      if (!descriptor?.path) continue;
      const repoRoot = resolveRepo({ repo: resolve(cwd, descriptor.path) });
      if (seen.has(repoRoot)) continue;
      seen.add(repoRoot);
      this.entries.push(this.buildEntry(descriptor, repoRoot));
    }
    if (!this.entries.length) throw new Error('project mode requires at least one registered project');
    this.currentId = currentId && this.entries.some((entry) => entry.id === currentId)
      ? currentId
      : store?.current()?.id && this.entries.some((entry) => entry.id === store.current().id)
        ? store.current().id
        : this.entries[0].id;
  }

  buildEntry(descriptor, repoRoot) {
    const settings = resolveSettings(repoRoot, this.outDir ? { outDir: this.outDir } : {}, {
      ...this.env,
      GITHUB_REPOSITORY: '',
    });
    const githubRepo = settings.githubRepo || '';
    return {
      id: descriptor.id || `prj_${hashId(repoRoot)}`,
      name: descriptor.name || projectName(repoRoot, githubRepo),
      repoRoot,
      path: repoRoot,
      githubRepo,
      settings,
      statePath: join(settings.outDir, 'state.json'),
      inboxPath: join(settings.outDir, 'inbox.json'),
      outboxPath: join(settings.outDir, 'outbox.json'),
      outDir: settings.outDir,
      maxConcurrent: settings.router.maxConcurrent,
      maxAttempts: settings.router.maxAttempts,
      leaseMinutes: settings.router.leaseMinutes,
      language: settings.language,
      executorCommand: settings.executor.command || '',
      executorAdapter: resolveExecutorAdapter(settings),
      executorCapabilities: settings.executor.capabilities,
      addedAt: descriptor.addedAt || null,
      lastSelectedAt: descriptor.lastSelectedAt || null,
      updatedAt: null,
    };
  }

  current() {
    return this.entries.find((entry) => entry.id === this.currentId) || this.entries[0];
  }

  select(id) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`unknown project: ${id}`);
    this.store?.select(entry.id);
    this.currentId = entry.id;
    return entry;
  }

  addProject(value, { name = '' } = {}) {
    if (!this.store) throw new Error('project registry has no persistent store');
    const { project, added } = this.store.add(value, { name });
    let entry = this.entries.find((candidate) => candidate.id === project.id);
    if (!entry) {
      entry = this.buildEntry(project, project.path);
      this.entries.push(entry);
    } else {
      entry.name = project.name;
    }
    return { entry, added };
  }

  removeProject(id) {
    if (!this.store) throw new Error('project registry has no persistent store');
    if (this.entries.length <= 1) {
      const error = new Error('cannot remove the last registered project');
      error.statusCode = 409;
      throw error;
    }
    const removed = this.store.remove(id);
    this.entries = this.entries.filter((entry) => entry.id !== id);
    const current = this.store.current();
    this.currentId = current?.id && this.entries.some((entry) => entry.id === current.id)
      ? current.id
      : this.entries[0].id;
    return removed;
  }

  list() {
    return this.entries.map((entry) => {
      let state = null;
      let error = null;
      try {
        state = readJson(entry.statePath, null);
      } catch (readError) {
        error = readError.message;
      }
      const tickets = state?.tickets && typeof state.tickets === 'object'
        ? Object.values(state.tickets)
        : [];
      return {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        repo: entry.githubRepo,
        state: error ? 'error' : existsSync(entry.statePath) ? 'ready' : 'empty',
        health: error ? 'error' : existsSync(entry.statePath) ? 'live' : 'empty',
        error,
        current: entry.id === this.currentId,
        tickets: tickets.length,
        activeTickets: tickets.filter((ticket) =>
          ['queued', 'claimed', 'working', 'verifying', 'awaiting_review', 'blocked', 'failed']
            .includes(ticket.state)
        ).length,
        blocked: tickets.filter((ticket) => ['blocked', 'failed'].includes(ticket.state)).length,
        updatedAt: state?.updatedAt || null,
        addedAt: entry.addedAt,
        lastSelectedAt: entry.lastSelectedAt,
        executor: {
          adapter: entry.executorAdapter || 'command',
          command: entry.executorCommand,
          capabilities: entry.executorCapabilities,
        },
        maxConcurrent: entry.maxConcurrent,
      };
    });
  }
}

export class ProjectBackend {
  constructor(registry, { now = Date.now } = {}) {
    this.registry = registry;
    this.now = now;
    this.startedAt = new Date(now()).toISOString();
    this.signatures = new Map();
    this.connectorHealth = new Map();
  }

  get mode() {
    return 'project';
  }

  get capabilities() {
    return {
      ...PROJECT_CAPABILITIES,
      projectSelect: this.registry.entries.length > 0,
      projectRemove: this.registry.entries.length > 1,
    };
  }

  projects() {
    return { currentId: this.registry.currentId, items: this.registry.list() };
  }

  selectProject(id) {
    const entry = this.registry.select(id);
    return { project: this.projectPublic(entry), projects: this.projects() };
  }

  addProject(input = {}) {
    const { entry, added } = this.registry.addProject(input.path, { name: input.name });
    this.registry.select(entry.id);
    this.signatures.delete(entry.id);
    return {
      project: this.projectPublic(entry),
      projects: this.projects(),
      added,
    };
  }

  removeProject(id) {
    const current = this.registry.current();
    const removed = this.registry.removeProject(id);
    if (current.id !== this.registry.currentId) this.signatures.delete(current.id);
    return {
      removed: { id: removed.id, name: removed.name, path: removed.path },
      projects: this.projects(),
    };
  }

  projectPublic(entry) {
    return {
      id: entry.id,
      name: entry.name,
      repo: entry.githubRepo,
      path: entry.path,
      state: existsSync(entry.statePath) ? 'ready' : 'empty',
      current: entry.id === this.registry.currentId,
    };
  }

  read(entry = this.registry.current()) {
    let state;
    let inbox;
    let error = null;
    try {
      state = readJson(entry.statePath, null) || emptyCoreState(entry);
    } catch (readError) {
      state = emptyCoreState(entry);
      error = readError.message;
    }
    try {
      inbox = readJson(entry.inboxPath, { events: [] });
    } catch (readError) {
      inbox = { events: [] };
      error = error || readError.message;
    }
    if (!state.tickets || typeof state.tickets !== 'object' || Array.isArray(state.tickets)) {
      state.tickets = {};
    }
    if (!Array.isArray(inbox.events)) inbox.events = [];
    let outbox;
    try {
      outbox = loadOutbox({ outDir: entry.outDir });
    } catch (readError) {
      outbox = emptyOutboxState();
      error = error || readError.message;
    }
    entry.updatedAt = state.updatedAt || null;
    return { entry, state, inbox, outbox, error };
  }

  signature(entry = this.registry.current()) {
    return stateSignature(entry.statePath, entry.inboxPath, entry.outboxPath);
  }

  changed() {
    const entry = this.registry.current();
    const next = this.signature(entry);
    const previous = this.signatures.get(entry.id);
    this.signatures.set(entry.id, next);
    return previous !== undefined && previous !== next;
  }

  snapshot() {
    const { entry, state, inbox, outbox, error } = this.read();
    const githubSource = {
      id: 'src_github',
      name: 'GitHub Issues',
      kind: 'github',
      status: entry.githubRepo ? 'healthy' : 'degraded',
      createdAt: state.updatedAt || this.startedAt,
      lastEventAt: inbox.events.at(-1)?.createdAt || null,
      eventCount: inbox.events.length,
      health: entry.githubRepo
        ? `Router 从 ${entry.githubRepo} 读取候选 Issue`
        : '未解析到 GitHub 仓库',
      config: { repo: entry.githubRepo || null },
    };
    const sources = [githubSource];
    const jiraConfig = entry.settings.connectors?.jira || {};
    if (jiraConfig.enabled) {
      const cursor = (() => {
        try {
          return loadJiraCursor(entry.outDir);
        } catch {
          return null;
        }
      })();
      const runtime = this.connectorHealth.get(`${entry.id}:jira`);
      sources.push({
        id: 'src_jira',
        name: `Jira${jiraConfig.project ? ` · ${jiraConfig.project}` : ''}`,
        kind: 'jira',
        status: runtime?.status === 'degraded' || runtime?.status === 'auth_error'
          ? 'degraded'
          : jiraConfig.baseUrl && this.registry.env[jiraConfig.tokenEnv] ? 'healthy' : 'degraded',
        createdAt: state.updatedAt || this.startedAt,
        lastEventAt: inbox.events
          .filter((event) => event.payload?.source?.kind === 'jira')
          .at(-1)?.createdAt || null,
        eventCount: inbox.events
          .filter((event) => event.payload?.source?.kind === 'jira').length,
        health: runtime?.error
          ? `${runtime.status} · ${runtime.error}`
          : jiraConfig.baseUrl && this.registry.env[jiraConfig.tokenEnv]
            ? `增量同步 · ${cursor?.lastSyncAt || '尚未同步'}`
            : !jiraConfig.baseUrl
              ? '缺少 connectors.jira.baseUrl'
              : `缺少 ${jiraConfig.tokenEnv || 'JIRA_API_TOKEN'}`,
        config: {
          baseUrl: jiraConfig.baseUrl,
          project: jiraConfig.project,
          jql: jiraConfig.jql,
          pollMinutes: jiraConfig.pollMinutes,
          fieldMap: jiraConfig.fieldMap,
          cursor: cursor?.updatedAt || null,
          lastSyncAt: cursor?.lastSyncAt || null,
        },
      });
    }
    const slackConfig = entry.settings.connectors?.slack || {};
    if (slackConfig.enabled) {
      const runtime = this.connectorHealth.get(`${entry.id}:slack`);
      sources.push({
        id: 'src_slack',
        name: 'Slack',
        kind: 'slack',
        status: runtime?.status === 'degraded'
          ? 'degraded'
          : process.env[slackConfig.signingSecretEnv] ? 'healthy' : 'degraded',
        createdAt: state.updatedAt || this.startedAt,
        lastEventAt: inbox.events
          .filter((event) => event.payload?.source?.kind === 'slack')
          .at(-1)?.createdAt || null,
        eventCount: inbox.events
          .filter((event) => event.payload?.source?.kind === 'slack').length,
        health: runtime?.error
          ? `${runtime.status} · ${runtime.error}`
          : process.env[slackConfig.signingSecretEnv]
            ? 'Events API · /loop · thread replies'
            : `缺少 ${slackConfig.signingSecretEnv || 'SLACK_SIGNING_SECRET'}`,
        config: {
          signingSecretEnv: slackConfig.signingSecretEnv,
          allowedChannels: slackConfig.allowedChannels,
          respondToMessages: slackConfig.respondToMessages,
          webhookPath: '/hooks/slack',
          signingSecret: process.env[slackConfig.signingSecretEnv] ? 'configured' : '',
        },
      });
    }
    const tickets = Object.values(state.tickets)
      .filter((ticket) => ticket && Number.isInteger(Number(ticket.number)))
      .map((ticket) => {
        const source = sources.find((candidate) => candidate.kind === ticket.source?.kind)
          || githubSource;
        return mapTicket(ticket, entry, source);
      });
    const events = inbox.events.map((event) => {
      const source = sources.find(
        (candidate) => candidate.kind === event.payload?.source?.kind,
      ) || githubSource;
      return mapEvent(event, source);
    });
    for (const ticket of tickets) {
      const event = [...events]
        .reverse()
        .find((candidate) => candidate.ticketId === ticket.id);
      ticket.sourceEventId = event?.id || null;
    }
    const attempts = Object.values(state.tickets)
      .map((ticket) => {
        const mapped = tickets.find((item) => item.number === Number(ticket.number));
        return mapped ? mapAttempt(ticket, mapped) : null;
      })
      .filter(Boolean)
      .sort((a, b) => parseTime(b.startedAt) - parseTime(a.startedAt));
    const deliveries = outbox.deliveries
      .map(mapDelivery)
      .sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));
    const workers = mapWorkers(Object.values(state.tickets), entry, tickets);
    const audit = derivedAudit(tickets, entry.name);
    const updatedAt = state.updatedAt || this.startedAt;
    const meta = {
      createdAt: this.startedAt,
      updatedAt,
      startedAt: this.startedAt,
      serverStartedAt: this.startedAt,
      lastTickAt: state.updatedAt || null,
      tickCount: Number(
        Object.values(state.tickets).reduce(
          (sum, ticket) => sum + (Number(ticket.attempts) || 0),
          0,
        ),
      ),
      paused: false,
      demo: false,
      mode: 'project',
      lastDemoEventAt: null,
    };
    const config = {
      project: {
        id: entry.id,
        name: entry.name,
        repo: entry.githubRepo || entry.name,
      },
      maxConcurrent: entry.maxConcurrent,
      maxAttempts: entry.maxAttempts,
      leaseMinutes: entry.leaseMinutes,
      tickMs: 0,
      autoTick: false,
      workMs: 0,
      verifyMs: 0,
      language: entry.language,
      connectors: {
        jira: {
          enabled: Boolean(jiraConfig.enabled),
          project: jiraConfig.project || '',
          pollMinutes: jiraConfig.pollMinutes || 0,
        },
        slack: {
          enabled: Boolean(slackConfig.enabled),
          signingSecretEnv: slackConfig.signingSecretEnv || 'SLACK_SIGNING_SECRET',
          allowedChannels: slackConfig.allowedChannels || [],
          respondToMessages: Boolean(slackConfig.respondToMessages),
        },
      },
    };
    const automations = automationStore.loadAutomations(entry).automations;
    const remoteWorkers = listWorkers(entry.settings, this.now());
    const snapshot = {
      version: 1,
      meta,
      config,
      sources,
      events,
      tickets,
      attempts,
      deliveries,
      workers,
      automations,
      remoteWorkers,
      audit,
      capabilities: this.capabilities,
      projects: this.projects(),
      health: {
        status: error ? 'error' : existsSync(entry.statePath) ? 'live' : 'empty',
        lastTickAt: state.updatedAt || null,
        tickCount: meta.tickCount,
        uptimeSeconds: Math.max(0, Math.round((this.now() - parseTime(this.startedAt)) / 1000)),
        stateFile: existsSync(entry.statePath) ? '.loop/state.json' : null,
        outbox: outboxSummary(outbox),
        error,
      },
    };
    return snapshot;
  }

  overview() {
    return buildOverview(this.snapshot());
  }

  ticketDetail(id) {
    const snapshot = this.snapshot();
    const ticket = snapshot.tickets.find(
      (candidate) => candidate.id === id || String(candidate.number) === String(id),
    );
    if (!ticket) return null;
    const event = snapshot.events.find((candidate) => candidate.id === ticket.sourceEventId) || null;
    const source = snapshot.sources.find((candidate) => candidate.id === ticket.sourceId) || null;
    const attempts = snapshot.attempts.filter((attempt) => attempt.ticketId === ticket.id);
    const audit = snapshot.audit.filter((entry) => entry.ticketId === ticket.id);
    const timeline = [];
    if (event) {
      timeline.push({
        at: event.receivedAt,
        kind: 'event',
        title: '来源事件进入 Inbox',
        detail: `${event.sourceName} · ${event.kind}`,
      });
    }
    timeline.push({
      at: ticket.createdAt,
      kind: 'ticket',
      title: `创建 Ticket #${ticket.number}`,
      detail: `${ticket.sourceName} · ${ticket.externalId}`,
    });
    for (const entry of audit) {
      timeline.push({
        at: entry.at,
        kind: entry.tone === 'error' ? 'error' : 'audit',
        title: entry.action,
        detail: entry.detail,
      });
    }
    timeline.sort((a, b) => parseTime(a.at) - parseTime(b.at));
    const running = snapshot.tickets.filter((candidate) =>
      ['claimed', 'working', 'verifying'].includes(candidate.state),
    ).length;
    return {
      ticket,
      source,
      event,
      attempts,
      deliveries: snapshot.deliveries.filter(
        (delivery) => Number(delivery.ticketNumber) === Number(ticket.number),
      ),
      audit,
      timeline,
      routeReason: [
        {
          label: '来源连接器',
          ok: Boolean(source),
          detail: source ? `${source.name} · ${source.kind}` : '未知来源',
        },
        {
          label: 'GitHub 授权',
          ok: ticket.labels?.includes('ready-for-agent'),
          detail: ticket.labels?.length ? ticket.labels.join(', ') : '无标签',
        },
        {
          label: '并发预算',
          ok: running <= snapshot.config.maxConcurrent,
          detail: `${running}/${snapshot.config.maxConcurrent} 个槽位被占用`,
        },
        {
          label: '独立验证',
          ok: Boolean(ticket.core?.verification),
          detail: ticket.core?.verification?.status || '尚未运行',
        },
      ],
    };
  }

  async runRouter(args, { timeout = 180_000, env = {} } = {}) {
    return this.runRouterFor(this.registry.current(), args, { timeout, env });
  }

  async runRouterFor(entry, args, { timeout = 180_000, env = {} } = {}) {
    try {
      const result = await execFileAsync(
        process.execPath,
        [routerScript, ...args, '--repo', entry.repoRoot],
        {
          cwd: entry.repoRoot,
          timeout,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...this.registry.env,
            ...env,
            SELF_LOOP_REPO: entry.repoRoot,
            GITHUB_REPOSITORY: entry.githubRepo || '',
          },
        },
      );
      return { status: 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    } catch (error) {
      if (error.code === 3) {
        return { status: 3, stdout: String(error.stdout || '').trim(), stderr: '' };
      }
      const detail = String(error.stderr || error.stdout || error.message || '').trim();
      const failure = new Error(detail || 'router command failed');
      failure.statusCode = 502;
      throw failure;
    }
  }

  async tick() {
    const result = await this.runRouter(['tick', '--json']);
    return {
      ok: true,
      status: result.status === 3 ? 'idle' : 'tick',
      detail: result.status === 3 ? '没有可领取的 Issue' : 'Router tick 完成',
      output: result.stdout.slice(-4000),
    };
  }

  async addAutomation(input) {
    const result = await this.runRouter([
      'automations',
      'add',
      '--data',
      JSON.stringify(input),
    ]);
    let automation = null;
    try {
      automation = JSON.parse(result.stdout);
    } catch {}
    return { automation, automations: this.snapshot().automations };
  }

  async toggleAutomation(id) {
    const result = await this.runRouter(['automations', 'toggle', '--id', String(id)]);
    let automation = null;
    try {
      automation = JSON.parse(result.stdout);
    } catch {}
    return { automation, automations: this.snapshot().automations };
  }

  async runAutomation(id) {
    const result = await this.runRouter(['automations', 'run', '--id', String(id)]);
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {}
    return {
      automation: payload?.automation || null,
      event: payload?.event || null,
      automations: this.snapshot().automations,
    };
  }

  async runDueAutomations(entry = this.registry.current()) {
    const result = await this.runRouterFor(entry, ['automations', 'due']);
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {}
    return payload || { ran: 0, events: [] };
  }

  async registerRemoteWorker(input) {
    const result = await this.runRouter([
      'workers',
      'register',
      '--data',
      JSON.stringify(input),
    ]);
    let payload = null;
    try {
      payload = JSON.parse(result.stdout);
    } catch {}
    return {
      ...payload,
      remoteWorkers: this.snapshot().remoteWorkers || [],
    };
  }

  async heartbeatRemoteWorker(token, patch = {}) {
    const result = await this.runRouter(
      ['workers', 'heartbeat', '--data', JSON.stringify(patch)],
      { env: { SELF_LOOP_WORKER_TOKEN: token } },
    );
    let worker = null;
    try {
      worker = JSON.parse(result.stdout);
    } catch {}
    return { worker };
  }

  async claimRemoteWorker(token) {
    const result = await this.runRouter(
      ['claim'],
      { env: { SELF_LOOP_WORKER_TOKEN: token } },
    );
    return JSON.parse(result.stdout);
  }

  async completeRemoteWorker(token, ticketNumber, result) {
    const output = await this.runRouter(
      [
        'complete',
        '--ticket',
        String(ticketNumber),
        '--data',
        JSON.stringify(result),
      ],
      { env: { SELF_LOOP_WORKER_TOKEN: token } },
    );
    return JSON.parse(output.stdout);
  }

  async ingestConnectorEvent(input, source, entry = this.registry.current()) {
    const payload = {
      ...input,
      source: {
        id: source.id,
        kind: source.kind,
        name: source.name,
      },
    };
    const result = await this.runRouterFor(entry, [
      'post',
      '--type',
      'task',
      '--action',
      'created',
      '--id',
      String(input.dedupeKey || input.externalId),
      '--data',
      JSON.stringify(payload),
    ]);
    let posted = {};
    try {
      posted = JSON.parse(result.stdout);
    } catch {}
    return {
      duplicate: Boolean(posted.duplicate),
      event: {
        id: posted.id || input.dedupeKey || input.externalId,
        kind: input.kind || 'task.created',
      },
    };
  }

  setConnectorHealth(kind, value, entry = this.registry.current()) {
    if (value) this.connectorHealth.set(`${entry.id}:${kind}`, {
      ...value,
      at: new Date(this.now()).toISOString(),
    });
    else this.connectorHealth.delete(`${entry.id}:${kind}`);
  }

  async syncJira(entry = this.registry.current(), options = {}) {
    const config = entry.settings.connectors?.jira;
    if (!config?.enabled) {
      const error = new Error('Jira connector is not enabled');
      error.statusCode = 409;
      throw error;
    }
    try {
      const result = await syncJira({
        outDir: entry.outDir,
        config,
        env: this.registry.env,
        ...options,
        applyEvent: async (event) => {
          const payload = {
            ...event,
            source: {
              id: 'src_jira',
              kind: 'jira',
              name: `Jira${config.project ? ` · ${config.project}` : ''}`,
            },
          };
          await this.runRouterFor(entry, [
            'post',
            '--type',
            'task',
            '--action',
            'created',
            '--id',
            String(event.dedupeKey || event.externalId),
            '--data',
            JSON.stringify(payload),
          ]);
        },
      });
      this.setConnectorHealth('jira', {
        status: result.status,
        error: result.error || null,
      }, entry);
      return result;
    } catch (error) {
      this.setConnectorHealth('jira', {
        status: 'error',
        error: error.message,
      }, entry);
      throw error;
    }
  }

  async flushOutbox() {
    const result = await this.runRouter(['outbox', 'flush', '--limit', '20']);
    return {
      ok: true,
      detail: 'Outbox flush 完成',
      output: result.stdout.slice(-4000),
    };
  }

  async replayDelivery(id) {
    const result = await this.runRouter(['outbox', 'retry', '--id', String(id)]);
    let delivery = null;
    try {
      delivery = JSON.parse(result.stdout);
    } catch {}
    return {
      ok: true,
      detail: '投递已重新排队',
      output: result.stdout.slice(-4000),
      ...(delivery || {}),
    };
  }

  ticketNumber(id) {
    const snapshot = this.snapshot();
    const ticket = snapshot.tickets.find(
      (candidate) => candidate.id === id || String(candidate.number) === String(id),
    );
    return ticket?.number || Number(id);
  }

  async retryTicket(id) {
    const number = this.ticketNumber(id);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`unknown ticket: ${id}`);
    const result = await this.runRouter(['recover', '--ticket', String(number), '--no-notify']);
    return { ok: true, detail: result.stdout, ticketNumber: number };
  }

  async cancelTicket(id) {
    const number = this.ticketNumber(id);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`unknown ticket: ${id}`);
    const result = await this.runRouter(['cancel', '--ticket', String(number), '--no-notify']);
    return { ok: true, detail: result.stdout, ticketNumber: number };
  }

  async verifyTicket(id) {
    const number = this.ticketNumber(id);
    if (!Number.isInteger(number) || number <= 0) throw new Error(`unknown ticket: ${id}`);
    const result = await this.runRouter(['verify', '--ticket', String(number), '--no-notify']);
    return { ok: true, detail: result.stdout, ticketNumber: number };
  }

  unsupported(action) {
    const error = new Error(
      `${action} 在项目模式下不可用：Router 仍然是 Ticket 状态的唯一写入者。请使用 router CLI。`,
    );
    error.statusCode = 409;
    throw error;
  }
}
