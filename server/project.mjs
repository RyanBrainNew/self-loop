import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveRepo, resolveSettings } from '../scripts/lib.mjs';

const execFileAsync = promisify(execFile);
const skillRoot = fileURLToPath(new URL('..', import.meta.url));
const routerScript = join(skillRoot, 'scripts', 'router.mjs');

export const PROJECT_CAPABILITIES = Object.freeze({
  mode: 'project',
  liveState: true,
  outbox: false,
  simulate: false,
  pause: false,
  injectEvent: false,
  sourceWrite: false,
  workerWrite: false,
  configWrite: false,
  ticketAnswer: false,
  ticketRetry: true,
  ticketCancel: false,
  ticketApprove: false,
  tick: true,
  projectSelect: true,
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

function stateSignature(statePath, inboxPath) {
  const parts = [];
  for (const file of [statePath, inboxPath]) {
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

function mapEvent(event, source) {
  const payload = event.payload || {};
  const issue = payload.issue || payload.pull_request || {};
  const title = issue.title
    || (event.type === 'issue' ? `GitHub issue #${event.ticket ?? ''}` : `${event.type} event`);
  return {
    id: String(event.id),
    sourceId: source.id,
    sourceName: source.name,
    sourceKind: source.kind,
    kind: event.type === 'issue' ? `issue.${event.action || 'event'}` : `github.${event.type}`,
    title,
    body: issue.body || event.error || '',
    actor: payload.sender?.login || payload.actor || 'github',
    externalId: event.ticket ? `GH-${event.ticket}` : String(event.id),
    dedupeKey: String(event.id),
    priority: labelPriority(issue.labels?.map((label) => label?.name || label) || []),
    labels: (issue.labels || []).map((label) => label?.name || label).filter(Boolean),
    acceptance: [],
    scope: [],
    risk: 'medium',
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

function mapTicket(ticket, entry, source) {
  const number = Number(ticket.number);
  const labels = ticket.labels || [];
  const taskCard = ticket.taskCard || {};
  const verification = ticket.verification || null;
  const prNumber = Number(ticket.pr) || null;
  const workerName = ticket.worker?.pid
    ? `Worker · pid ${ticket.worker.pid}`
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
        kind: entry.executorCommand ? 'codex' : 'shell',
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
      kind: ticket.worker?.pid ? 'codex' : 'shell',
      status: 'busy',
      paused: false,
      currentTicketId: mapped?.id || ticketId(ticket.number),
      lastHeartbeat: ticket.updatedAt,
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
      deliveries: 0,
      deliveriesPending: 0,
      deliveriesFailed: 0,
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
    recentDeliveries: [],
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
  constructor(repoArgs = [], { cwd = process.cwd(), outDir = null } = {}) {
    const values = Array.isArray(repoArgs) ? repoArgs : [repoArgs];
    const seen = new Set();
    this.entries = [];
    for (const value of values.filter(Boolean)) {
      const repoRoot = resolveRepo({ repo: resolve(cwd, value) });
      if (seen.has(repoRoot)) continue;
      seen.add(repoRoot);
      const settings = resolveSettings(repoRoot, outDir ? { outDir } : {});
      const githubRepo = settings.githubRepo || '';
      this.entries.push({
        id: `prj_${hashId(repoRoot)}`,
        name: projectName(repoRoot, githubRepo),
        repoRoot,
        githubRepo,
        settings,
        statePath: join(settings.outDir, 'state.json'),
        inboxPath: join(settings.outDir, 'inbox.json'),
        maxConcurrent: settings.router.maxConcurrent,
        maxAttempts: settings.router.maxAttempts,
        leaseMinutes: settings.router.leaseMinutes,
        language: settings.language,
        executorCommand: settings.executor.command || '',
        updatedAt: null,
      });
    }
    if (!this.entries.length) throw new Error('project mode requires at least one --repo');
    this.currentId = this.entries[0].id;
  }

  current() {
    return this.entries.find((entry) => entry.id === this.currentId) || this.entries[0];
  }

  select(id) {
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`unknown project: ${id}`);
    this.currentId = entry.id;
    return entry;
  }

  list() {
    return this.entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      repo: entry.githubRepo,
      state: existsSync(entry.statePath) ? 'ready' : 'empty',
      current: entry.id === this.currentId,
    }));
  }
}

export class ProjectBackend {
  constructor(registry, { now = Date.now } = {}) {
    this.registry = registry;
    this.now = now;
    this.startedAt = new Date(now()).toISOString();
    this.signatures = new Map();
  }

  get mode() {
    return 'project';
  }

  get capabilities() {
    return {
      ...PROJECT_CAPABILITIES,
      projectSelect: this.registry.entries.length > 1,
    };
  }

  projects() {
    return { currentId: this.registry.currentId, items: this.registry.list() };
  }

  selectProject(id) {
    const entry = this.registry.select(id);
    return { project: this.projectPublic(entry), projects: this.projects() };
  }

  projectPublic(entry) {
    return {
      id: entry.id,
      name: entry.name,
      repo: entry.githubRepo,
      state: existsSync(entry.statePath) ? 'ready' : 'empty',
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
    entry.updatedAt = state.updatedAt || null;
    return { entry, state, inbox, error };
  }

  signature(entry = this.registry.current()) {
    return stateSignature(entry.statePath, entry.inboxPath);
  }

  changed() {
    const entry = this.registry.current();
    const next = this.signature(entry);
    const previous = this.signatures.get(entry.id);
    this.signatures.set(entry.id, next);
    return previous !== undefined && previous !== next;
  }

  snapshot() {
    const { entry, state, inbox, error } = this.read();
    const source = {
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
    const tickets = Object.values(state.tickets)
      .filter((ticket) => ticket && Number.isInteger(Number(ticket.number)))
      .map((ticket) => mapTicket(ticket, entry, source));
    const events = inbox.events.map((event) => mapEvent(event, source));
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
    };
    const snapshot = {
      version: 1,
      meta,
      config,
      sources: [source],
      events,
      tickets,
      attempts,
      deliveries: [],
      workers,
      audit,
      capabilities: this.capabilities,
      projects: this.projects(),
      health: {
        status: error ? 'error' : existsSync(entry.statePath) ? 'live' : 'empty',
        lastTickAt: state.updatedAt || null,
        tickCount: meta.tickCount,
        uptimeSeconds: Math.max(0, Math.round((this.now() - parseTime(this.startedAt)) / 1000)),
        stateFile: existsSync(entry.statePath) ? '.loop/state.json' : null,
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
      deliveries: [],
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

  async runRouter(args, { timeout = 180_000 } = {}) {
    const entry = this.registry.current();
    try {
      const result = await execFileAsync(
        process.execPath,
        [routerScript, ...args, '--repo', entry.repoRoot],
        {
          cwd: entry.repoRoot,
          timeout,
          windowsHide: true,
          maxBuffer: 4 * 1024 * 1024,
          env: { ...process.env, SELF_LOOP_REPO: entry.repoRoot },
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
