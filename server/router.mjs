import { appendAudit, makeId, nowIso } from './store.mjs';

const OCCUPYING_STATES = new Set(['claimed', 'working', 'verifying']);
const OPEN_STATES = new Set([
  'queued',
  'claimed',
  'working',
  'verifying',
  'awaiting_review',
  'blocked',
  'failed',
]);

const TICKET_KINDS = new Set([
  'issue.opened',
  'issue.reopened',
  'issue.labeled',
  'jira.issue.created',
  'task.created',
  'manual.task',
]);

const IGNORED_KINDS = new Map([
  ['comment.created', '评论只作为上下文，不单独创建 Ticket'],
  ['issue.updated', '字段更新不改变授权，等待下一次明确事件'],
  ['push', '代码推送不创建任务'],
  ['schedule.tick', '定时 tick 只唤醒 Router，不创建任务'],
]);

const PRIORITY_WEIGHT = { urgent: 0, high: 1, normal: 2, low: 3 };

export const PIPELINE = [
  { key: 'queued', label: 'Queued', states: ['queued'] },
  { key: 'working', label: 'Working', states: ['claimed', 'working'] },
  { key: 'verifying', label: 'Verifying', states: ['verifying'] },
  { key: 'review', label: 'Review', states: ['awaiting_review'] },
  { key: 'blocked', label: 'Blocked', states: ['blocked', 'failed'] },
  { key: 'done', label: 'Done', states: ['done', 'dropped'] },
];

const DEMO_EVENTS = [
  {
    kind: 'issue.opened',
    title: 'Router: 为 inbox 增加事件优先级',
    body: '同一批 webhook 到达时，urgent 事件应先于普通 issue 被消费。',
    priority: 'high',
    labels: ['router', 'priority'],
    scope: ['scripts/inbox.mjs', 'scripts/router.mjs'],
    risk: 'medium',
  },
  {
    kind: 'jira.issue.created',
    title: 'Jira: 支持从 Sprint 自动拉取 ready 任务',
    body: '只拉取当前 Sprint 中带有 agent-ready 标签的 issue。',
    priority: 'normal',
    labels: ['connector', 'jira'],
    scope: ['server/connectors/jira.mjs'],
    risk: 'medium',
  },
  {
    kind: 'task.created',
    title: 'Console: 增加 Outbox 死信重投',
    body: '死信可以人工重投，重投不改变原 Ticket 状态。',
    priority: 'normal',
    labels: ['console', 'outbox'],
    scope: ['server/public/app.js'],
    risk: 'low',
  },
  {
    kind: 'issue.opened',
    title: 'Verifier: 记录门禁日志路径',
    body: '每个 Attempt 的证据要包含命令、退出码、耗时和日志路径。',
    priority: 'normal',
    labels: ['verifier', 'evidence'],
    scope: ['scripts/verifier.mjs'],
    risk: 'low',
  },
  {
    kind: 'issue.opened',
    title: 'Worker: 心跳超时后释放 Ticket',
    body: 'Worker 超过 90 秒没有心跳时，Router 应判定 lease 失效。',
    priority: 'high',
    labels: ['worker', 'lease'],
    scope: ['scripts/router.mjs'],
    risk: 'high',
  },
];

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function slugify(value) {
  return String(value || 'task')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'task';
}

export class RouterEngine {
  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.now = now;
  }

  get state() {
    return this.store.state;
  }

  get config() {
    return this.state.config;
  }

  tick(now = this.now()) {
    const state = this.state;
    state.meta.lastTickAt = nowIso(now);
    if (state.meta.paused) {
      return { changed: false, paused: true, at: nowIso(now) };
    }

    state.meta.tickCount = Number(state.meta.tickCount || 0) + 1;
    this.consumeEvents(now);
    this.expireLeases(now);
    this.advanceAttempts(now);
    this.claimTickets(now);
    this.advanceDeliveries(now);
    this.heartbeat(now);
    if (state.meta.demo) this.maybeDemoEvent(now);
    this.store.save();
    return { changed: true, at: nowIso(now), counts: this.counts() };
  }

  counts() {
    const tickets = this.state.tickets;
    const events = this.state.events;
    const deliveries = this.state.deliveries;
    return {
      pendingEvents: events.filter((event) => event.status === 'pending').length,
      activeTickets: tickets.filter((ticket) => OPEN_STATES.has(ticket.state)).length,
      awaitingReview: tickets.filter((ticket) => ticket.state === 'awaiting_review').length,
      blocked: tickets.filter((ticket) => ['blocked', 'failed'].includes(ticket.state)).length,
      deliveriesPending: deliveries.filter((delivery) => delivery.state === 'pending').length,
      deliveriesFailed: deliveries.filter((delivery) => ['failed', 'dead'].includes(delivery.state)).length,
    };
  }

  consumeEvents(now) {
    const pending = this.state.events
      .filter((event) => event.status === 'pending')
      .sort((a, b) => parseTime(a.receivedAt) - parseTime(b.receivedAt));

    for (const event of pending) {
      const ignoredReason = IGNORED_KINDS.get(event.kind);
      if (ignoredReason) {
        event.status = 'ignored';
        event.ignoredReason = ignoredReason;
        event.consumedAt = nowIso(now);
        appendAudit(this.state, {
          action: 'event.ignored',
          entity: 'event',
          entityId: event.id,
          detail: `${event.sourceName} · ${ignoredReason}`,
          tone: 'muted',
        }, now);
        continue;
      }

      if (!TICKET_KINDS.has(event.kind)) {
        event.status = 'ignored';
        event.ignoredReason = `未知事件类型：${event.kind}`;
        event.consumedAt = nowIso(now);
        continue;
      }

      let ticket = this.state.tickets.find(
        (candidate) =>
          candidate.externalId === event.externalId &&
          candidate.sourceId === event.sourceId,
      );
      if (!ticket && event.ticketId) ticket = this.findTicket(event.ticketId);
      if (!ticket) ticket = this.createTicketFromEvent(event, now);

      event.status = 'consumed';
      event.consumedAt = nowIso(now);
      event.ticketId = ticket.id;
      if (!ticket.sourceEventId) ticket.sourceEventId = event.id;

      appendAudit(this.state, {
        action: 'event.consumed',
        entity: 'event',
        entityId: event.id,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        detail: `${event.sourceName} → Ticket #${ticket.number} · ${event.title}`,
      }, now);
    }
  }

  createTicketFromEvent(event, now) {
    const at = nowIso(now);
    const ticket = {
      id: makeId('tkt'),
      number: this.nextTicketNumber(),
      projectId: this.config.project.id,
      sourceId: event.sourceId,
      sourceName: event.sourceName,
      sourceKind: event.sourceKind,
      externalId: event.externalId,
      title: event.title,
      summary: event.body || '由连接器自动创建，等待 Task Card 补全。',
      state: 'queued',
      priority: event.priority || 'normal',
      labels: event.labels || [],
      acceptance: event.acceptance?.length
        ? event.acceptance
        : ['通过项目现有检查', 'PR 描述包含可复核的验证证据'],
      scope: event.scope?.length ? event.scope : ['待 Planner 补全'],
      risk: event.risk || 'medium',
      sourceEventId: event.id,
      createdAt: at,
      updatedAt: at,
      attempts: 0,
      maxAttempts: this.config.maxAttempts,
      workerId: null,
      workerName: null,
      lease: null,
      currentAttemptId: null,
      pr: null,
      humanQuestion: null,
      humanAnswer: null,
      lastError: null,
    };
    this.state.tickets.unshift(ticket);
    appendAudit(this.state, {
      action: 'ticket.created',
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: `从 ${event.sourceName} 创建 Ticket #${ticket.number}`,
    }, now);
    return ticket;
  }

  nextTicketNumber() {
    const highest = this.state.tickets.reduce(
      (max, ticket) => Math.max(max, Number(ticket.number) || 0),
      1000,
    );
    return highest + 1;
  }

  nextPrNumber() {
    const highest = this.state.tickets.reduce(
      (max, ticket) => Math.max(max, Number(ticket.pr?.number) || 0),
      120,
    );
    return highest + 1;
  }

  claimTickets(now) {
    const running = this.state.tickets.filter((ticket) => OCCUPYING_STATES.has(ticket.state)).length;
    let slots = Math.max(0, Number(this.config.maxConcurrent || 1) - running);
    if (!slots) return;

    const queue = this.state.tickets
      .filter(
        (ticket) =>
          ticket.state === 'queued' &&
          (!ticket.retryAfter || parseTime(ticket.retryAfter) <= now) &&
          Number(ticket.attempts || 0) < Number(ticket.maxAttempts || this.config.maxAttempts),
      )
      .sort(
        (a, b) =>
          (PRIORITY_WEIGHT[a.priority] ?? 2) - (PRIORITY_WEIGHT[b.priority] ?? 2) ||
          parseTime(a.createdAt) - parseTime(b.createdAt),
      );

    const workers = this.state.workers
      .filter((worker) => worker.status === 'online' && !worker.paused && !worker.currentTicketId)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    for (const ticket of queue) {
      if (slots <= 0) break;
      const worker = workers.shift();
      if (!worker) break;
      this.claim(ticket, worker, now);
      slots -= 1;
    }
  }

  claim(ticket, worker, now) {
    const at = nowIso(now);
    ticket.state = 'working';
    ticket.retryAfter = null;
    ticket.workerId = worker.id;
    ticket.workerName = worker.name;
    ticket.lease = {
      workerId: worker.id,
      expiresAt: nowIso(now + Number(this.config.leaseMinutes || 45) * 60_000),
    };
    ticket.updatedAt = at;

    worker.status = 'busy';
    worker.currentTicketId = ticket.id;
    worker.lastHeartbeat = at;

    const attempt = {
      id: makeId('att'),
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      number: Number(ticket.attempts || 0) + 1,
      workerId: worker.id,
      workerName: worker.name,
      state: 'running',
      phase: 'working',
      startedAt: at,
      phaseAt: at,
      finishedAt: null,
      evidence: [],
      error: null,
    };
    this.state.attempts.unshift(attempt);
    ticket.currentAttemptId = attempt.id;

    appendAudit(this.state, {
      action: 'ticket.claimed',
      actor: worker.name,
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: `${worker.name} 领取 Ticket #${ticket.number}，Attempt ${attempt.number}/${ticket.maxAttempts}`,
    }, now);
  }

  advanceAttempts(now) {
    const running = this.state.attempts.filter((attempt) => attempt.state === 'running');
    for (const attempt of running) {
      const ticket = this.findTicket(attempt.ticketId);
      if (!ticket) {
        attempt.state = 'cancelled';
        continue;
      }
      if (!['working', 'verifying'].includes(ticket.state)) {
        attempt.state = 'cancelled';
        attempt.finishedAt = nowIso(now);
        continue;
      }

      const elapsed = now - parseTime(attempt.phaseAt);
      if (attempt.phase === 'working' && elapsed >= Number(this.config.workMs || 0)) {
        if (this.shouldFail(ticket, attempt)) {
          this.failAttempt(ticket, attempt, now, '门禁失败：npm test 退出码 1');
          continue;
        }
        attempt.phase = 'verifying';
        attempt.phaseAt = nowIso(now);
        ticket.state = 'verifying';
        ticket.updatedAt = nowIso(now);
        appendAudit(this.state, {
          action: 'ticket.verifying',
          entityId: ticket.id,
          ticketId: ticket.id,
          ticketNumber: ticket.number,
          detail: `Verifier 启动：在干净工作树复跑门禁（Attempt ${attempt.number}）`,
        }, now);
        continue;
      }

      if (attempt.phase === 'verifying' && elapsed >= Number(this.config.verifyMs || 0)) {
        this.passAttempt(ticket, attempt, now);
      }
    }
  }

  shouldFail(ticket, attempt) {
    if (ticket.failAlways) return true;
    if (ticket.flaky && Number(attempt.number) === 1) return true;
    return false;
  }

  failAttempt(ticket, attempt, now, reason) {
    attempt.state = 'failed';
    attempt.finishedAt = nowIso(now);
    attempt.error = reason;
    attempt.evidence = [
      {
        gate: 'npm test',
        command: 'npm test',
        exitCode: 1,
        durationMs: 3200,
        outputPath: `.loop/attempts/${attempt.id}/npm-test.log`,
        summary: reason,
      },
    ];

    ticket.attempts = Number(ticket.attempts || 0) + 1;
    ticket.lastError = reason;
    ticket.updatedAt = nowIso(now);
    ticket.currentAttemptId = null;
    this.releaseWorker(ticket, now);

    if (ticket.attempts < ticket.maxAttempts) {
      ticket.state = 'queued';
      ticket.retryAfter = nowIso(now + 1);
      ticket.workerId = null;
      ticket.workerName = null;
      ticket.lease = null;
      appendAudit(this.state, {
        action: 'ticket.retry',
        entityId: ticket.id,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        detail: `Attempt ${ticket.attempts}/${ticket.maxAttempts} 失败，重新排队：${reason}`,
        tone: 'warn',
      }, now);
      return;
    }

    ticket.state = 'blocked';
    ticket.workerId = null;
    ticket.workerName = null;
    ticket.lease = null;
    ticket.humanQuestion = `Attempt ${ticket.attempts}/${ticket.maxAttempts} 失败：${reason}。请决定是否重试，或补充验收条件。`;
    appendAudit(this.state, {
      action: 'ticket.blocked',
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: `尝试耗尽，转人工：${reason}`,
      tone: 'error',
    }, now);
  }

  passAttempt(ticket, attempt, now) {
    attempt.state = 'passed';
    attempt.finishedAt = nowIso(now);
    attempt.error = null;
    attempt.evidence = [
      {
        gate: 'npm test',
        command: 'npm test',
        exitCode: 0,
        durationMs: 4200,
        outputPath: `.loop/attempts/${attempt.id}/npm-test.log`,
        summary: '42 passed',
      },
      {
        gate: 'node --test',
        command: 'node --test',
        exitCode: 0,
        durationMs: 6100,
        outputPath: `.loop/attempts/${attempt.id}/node-test.log`,
        summary: '118 passed',
      },
    ];

    ticket.attempts = Number(ticket.attempts || 0) + 1;
    ticket.state = 'awaiting_review';
    ticket.updatedAt = nowIso(now);
    ticket.lastError = null;
    ticket.currentAttemptId = null;
    ticket.lease = null;

    const prNumber = this.nextPrNumber();
    ticket.pr = {
      number: prNumber,
      url: `https://github.com/${this.config.project.repo}/pull/${prNumber}`,
      branch: `loop/${ticket.number}-${slugify(ticket.title)}`,
    };

    this.releaseWorker(ticket, now);
    ticket.workerId = null;
    ticket.workerName = null;

    this.enqueueDelivery(ticket, 'github', `PR #${prNumber}`, 'PR 评论', now);
    this.enqueueDelivery(ticket, 'slack', '#self-loop', 'IM 通知', now);

    appendAudit(this.state, {
      action: 'ticket.awaiting_review',
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: `Verifier 通过，PR #${prNumber} 等待人工 review`,
      tone: 'success',
    }, now);
  }

  releaseWorker(ticket, now) {
    const worker = this.state.workers.find((candidate) => candidate.id === ticket.workerId);
    if (!worker) return;
    worker.status = worker.paused ? 'paused' : 'online';
    worker.currentTicketId = null;
    worker.lastHeartbeat = nowIso(now);
  }

  enqueueDelivery(ticket, channel, target, kind, now) {
    const delivery = {
      id: makeId('dlv'),
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      channel,
      target,
      kind,
      state: 'pending',
      attempts: 0,
      maxAttempts: 3,
      createdAt: nowIso(now),
      nextAttemptAt: nowIso(now + 1200),
      sentAt: null,
      lastAttemptAt: null,
      lastError: null,
      idempotencyKey: `${ticket.id}:${kind}:${ticket.attempts}`,
    };
    this.state.deliveries.unshift(delivery);
    appendAudit(this.state, {
      action: 'delivery.queued',
      entity: 'delivery',
      entityId: delivery.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: `${kind} → ${target}`,
      tone: 'muted',
    }, now);
    return delivery;
  }

  advanceDeliveries(now) {
    for (const delivery of this.state.deliveries) {
      if (delivery.state === 'failed' && delivery.attempts >= delivery.maxAttempts) {
        delivery.state = 'dead';
      }
      if (
        delivery.state === 'failed' &&
        delivery.attempts < delivery.maxAttempts &&
        parseTime(delivery.nextAttemptAt) <= now
      ) {
        delivery.state = 'pending';
      }
      if (delivery.state !== 'pending' || parseTime(delivery.nextAttemptAt) > now) continue;

      delivery.attempts = Number(delivery.attempts || 0) + 1;
      delivery.lastAttemptAt = nowIso(now);

      if (delivery.failFirst && delivery.attempts === 1) {
        delivery.state = 'failed';
        delivery.lastError = delivery.failure || '429 rate_limited';
        delivery.nextAttemptAt = nowIso(now + 3000);
        appendAudit(this.state, {
          action: 'delivery.failed',
          entity: 'delivery',
          entityId: delivery.id,
          ticketId: delivery.ticketId,
          ticketNumber: delivery.ticketNumber,
          detail: `${delivery.kind} → ${delivery.target} 失败：${delivery.lastError}，将重试`,
          tone: 'warn',
        }, now);
        continue;
      }

      if (delivery.failAlways) {
        delivery.state = delivery.attempts < delivery.maxAttempts ? 'failed' : 'dead';
        delivery.lastError = delivery.failure || 'upstream_error';
        delivery.nextAttemptAt = delivery.state === 'failed' ? nowIso(now + 4000) : null;
        appendAudit(this.state, {
          action: 'delivery.failed',
          entity: 'delivery',
          entityId: delivery.id,
          ticketId: delivery.ticketId,
          ticketNumber: delivery.ticketNumber,
          detail: `${delivery.kind} → ${delivery.target} 失败：${delivery.lastError}`,
          tone: 'error',
        }, now);
        continue;
      }

      delivery.state = 'sent';
      delivery.sentAt = nowIso(now);
      delivery.lastError = null;
      delivery.nextAttemptAt = null;
      appendAudit(this.state, {
        action: 'delivery.sent',
        entity: 'delivery',
        entityId: delivery.id,
        ticketId: delivery.ticketId,
        ticketNumber: delivery.ticketNumber,
        detail: `${delivery.kind} → ${delivery.target} 已送达`,
        tone: 'success',
      }, now);
    }
  }

  expireLeases(now) {
    for (const ticket of this.state.tickets) {
      if (!ticket.lease || !OCCUPYING_STATES.has(ticket.state)) continue;
      if (parseTime(ticket.lease.expiresAt) > now) continue;
      const attempt = this.state.attempts.find(
        (candidate) => candidate.ticketId === ticket.id && candidate.state === 'running',
      );
      if (attempt) {
        this.failAttempt(ticket, attempt, now, 'Lease 过期，Worker 未按时回报');
        continue;
      }
      ticket.attempts = Number(ticket.attempts || 0) + 1;
      ticket.updatedAt = nowIso(now);
      ticket.state = ticket.attempts < ticket.maxAttempts ? 'queued' : 'blocked';
      ticket.retryAfter = ticket.state === 'queued' ? nowIso(now + 1) : null;
      ticket.lease = null;
      ticket.workerId = null;
      ticket.workerName = null;
      if (ticket.state === 'blocked') {
        ticket.humanQuestion = 'Lease 连续过期，请检查 Worker 健康状态后重试。';
      }
      appendAudit(this.state, {
        action: 'ticket.lease_expired',
        entityId: ticket.id,
        ticketId: ticket.id,
        ticketNumber: ticket.number,
        detail: 'Lease 过期，尝试次数已消耗',
        tone: 'warn',
      }, now);
    }
  }

  heartbeat(now) {
    for (const worker of this.state.workers) {
      if (worker.status === 'online' || worker.status === 'busy') {
        worker.lastHeartbeat = nowIso(now);
      }
      if (worker.status === 'busy' && !worker.currentTicketId) {
        worker.status = worker.paused ? 'paused' : 'online';
      }
    }
  }

  maybeDemoEvent(now) {
    const meta = this.state.meta;
    if (meta.lastDemoEventAt && now - parseTime(meta.lastDemoEventAt) < 22_000) return;
    const open = this.state.tickets.filter((ticket) => OPEN_STATES.has(ticket.state)).length;
    if (open >= 9) return;

    const template = DEMO_EVENTS[Number(meta.tickCount || 0) % DEMO_EVENTS.length];
    const preferredKind =
      template.kind === 'jira.issue.created'
        ? 'jira'
        : template.kind === 'task.created'
          ? 'webhook'
          : 'github';
    const source =
      this.state.sources.find((candidate) => candidate.kind === preferredKind && candidate.status === 'healthy') ||
      this.state.sources.find((candidate) => candidate.status === 'healthy' && candidate.kind !== 'cron');
    if (!source) return;

    this.ingestEvent(
      {
        ...template,
        sourceId: source.id,
        externalId: `demo-${now}-${meta.tickCount}`,
        actor: 'demo-feed',
      },
      now,
      { silent: true },
    );
    meta.lastDemoEventAt = nowIso(now);
  }

  ingestEvent(input, now = this.now(), { silent = false } = {}) {
    const source = this.state.sources.find((candidate) => candidate.id === input.sourceId);
    if (!source) throw new Error(`unknown source: ${input.sourceId}`);
    if (source.status === 'paused') throw new Error(`source is paused: ${source.name}`);

    const externalId = input.externalId || makeId('ext');
    const dedupeKey = input.dedupeKey || `${source.id}:${input.kind}:${externalId}`;
    const existing = this.state.events.find((event) => event.dedupeKey === dedupeKey);
    if (existing) return { event: existing, duplicate: true };

    const at = nowIso(now);
    const event = {
      id: makeId('evt'),
      sourceId: source.id,
      sourceName: source.name,
      sourceKind: source.kind,
      kind: input.kind || 'issue.opened',
      title: input.title || '未命名事件',
      body: input.body || '',
      actor: input.actor || 'connector',
      externalId,
      dedupeKey,
      priority: input.priority || 'normal',
      labels: input.labels || [],
      acceptance: input.acceptance || [],
      scope: input.scope || [],
      risk: input.risk || 'medium',
      status: 'pending',
      receivedAt: at,
      consumedAt: null,
      ticketId: null,
      ignoredReason: null,
    };
    this.state.events.unshift(event);
    source.lastEventAt = at;
    source.eventCount = Number(source.eventCount || 0) + 1;

    appendAudit(this.state, {
      action: 'event.received',
      entity: 'event',
      entityId: event.id,
      detail: `${source.name} · ${event.kind} · ${event.title}`,
      tone: 'info',
    }, now);

    if (!silent) this.store.save();
    return { event, duplicate: false };
  }

  addSource({ name, kind, config } = {}) {
    if (!name || !kind) throw new Error('source name and kind are required');
    const at = nowIso(this.now());
    const source = {
      id: makeId('src'),
      name,
      kind,
      status: 'healthy',
      createdAt: at,
      lastEventAt: null,
      eventCount: 0,
      health: '已配置，等待第一个事件',
      config: config || {},
    };
    this.state.sources.push(source);
    appendAudit(this.state, {
      action: 'source.created',
      entity: 'source',
      entityId: source.id,
      detail: `新增连接器：${name} (${kind})`,
      tone: 'success',
    }, this.now());
    this.store.save();
    return source;
  }

  toggleSource(id) {
    const source = this.state.sources.find((candidate) => candidate.id === id);
    if (!source) throw new Error(`unknown source: ${id}`);
    source.status = source.status === 'paused' ? 'healthy' : 'paused';
    source.health = source.status === 'paused' ? 'Paused by operator' : '已恢复，等待事件';
    appendAudit(this.state, {
      action: source.status === 'paused' ? 'source.paused' : 'source.resumed',
      entity: 'source',
      entityId: source.id,
      detail: `${source.name} ${source.status === 'paused' ? '已暂停' : '已恢复'}`,
      tone: source.status === 'paused' ? 'warn' : 'success',
    }, this.now());
    this.store.save();
    return source;
  }

  findTicket(id) {
    return this.state.tickets.find(
      (ticket) => ticket.id === id || String(ticket.number) === String(id),
    );
  }

  answerTicket(id, answer, actor = 'local-operator') {
    const ticket = this.findTicket(id);
    if (!ticket) throw new Error(`unknown ticket: ${id}`);
    if (ticket.state !== 'blocked') throw new Error('only blocked tickets can be answered');
    if (!String(answer || '').trim()) throw new Error('answer is required');

    const now = this.now();
    ticket.humanAnswer = String(answer).trim();
    ticket.humanQuestion = null;
    ticket.state = 'queued';
    ticket.retryAfter = null;
    ticket.attempts = 0;
    ticket.lastError = null;
    ticket.updatedAt = nowIso(now);
    appendAudit(this.state, {
      action: 'ticket.answered',
      actor,
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: `人工回答：${ticket.humanAnswer}`,
      tone: 'success',
    }, now);
    this.store.save();
    return ticket;
  }

  retryTicket(id, actor = 'local-operator') {
    const ticket = this.findTicket(id);
    if (!ticket) throw new Error(`unknown ticket: ${id}`);
    if (!['blocked', 'failed'].includes(ticket.state)) {
      throw new Error('only blocked or failed tickets can be retried');
    }
    const now = this.now();
    ticket.state = 'queued';
    ticket.retryAfter = null;
    ticket.attempts = 0;
    ticket.humanQuestion = null;
    ticket.lastError = null;
    ticket.lease = null;
    ticket.workerId = null;
    ticket.workerName = null;
    ticket.updatedAt = nowIso(now);
    appendAudit(this.state, {
      action: 'ticket.retry_requested',
      actor,
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: '人工重跑，尝试次数已重置',
      tone: 'warn',
    }, now);
    this.store.save();
    return ticket;
  }

  cancelTicket(id, actor = 'local-operator') {
    const ticket = this.findTicket(id);
    if (!ticket) throw new Error(`unknown ticket: ${id}`);
    if (['done', 'dropped'].includes(ticket.state)) return ticket;
    const now = this.now();
    this.releaseWorker(ticket, now);
    for (const attempt of this.state.attempts) {
      if (attempt.ticketId === ticket.id && attempt.state === 'running') {
        attempt.state = 'cancelled';
        attempt.finishedAt = nowIso(now);
      }
    }
    ticket.state = 'dropped';
    ticket.lease = null;
    ticket.workerId = null;
    ticket.workerName = null;
    ticket.currentAttemptId = null;
    ticket.updatedAt = nowIso(now);
    appendAudit(this.state, {
      action: 'ticket.cancelled',
      actor,
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: '人工取消，释放 Worker 占用',
      tone: 'warn',
    }, now);
    this.store.save();
    return ticket;
  }

  approveTicket(id, actor = 'local-operator') {
    const ticket = this.findTicket(id);
    if (!ticket) throw new Error(`unknown ticket: ${id}`);
    if (ticket.state !== 'awaiting_review') throw new Error('ticket is not awaiting review');
    const now = this.now();
    ticket.state = 'done';
    ticket.approvedAt = nowIso(now);
    ticket.approvedBy = actor;
    ticket.updatedAt = nowIso(now);
    this.enqueueDelivery(ticket, 'slack', '#self-loop', '验收通知', now);
    appendAudit(this.state, {
      action: 'ticket.approved',
      actor,
      entityId: ticket.id,
      ticketId: ticket.id,
      ticketNumber: ticket.number,
      detail: '人工验收通过；loop 未合并 PR',
      tone: 'success',
    }, now);
    this.store.save();
    return ticket;
  }

  replayDelivery(id, actor = 'local-operator') {
    const delivery = this.state.deliveries.find((candidate) => candidate.id === id);
    if (!delivery) throw new Error(`unknown delivery: ${id}`);
    if (!['failed', 'dead'].includes(delivery.state)) {
      throw new Error('only failed or dead deliveries can be replayed');
    }
    const now = this.now();
    delivery.state = 'pending';
    delivery.attempts = 0;
    delivery.lastError = null;
    delivery.nextAttemptAt = nowIso(now + 500);
    appendAudit(this.state, {
      action: 'delivery.replayed',
      actor,
      entity: 'delivery',
      entityId: delivery.id,
      ticketId: delivery.ticketId,
      ticketNumber: delivery.ticketNumber,
      detail: `人工重投 ${delivery.kind} → ${delivery.target}`,
      tone: 'warn',
    }, now);
    this.store.save();
    return delivery;
  }

  toggleWorker(id) {
    const worker = this.state.workers.find((candidate) => candidate.id === id);
    if (!worker) throw new Error(`unknown worker: ${id}`);
    worker.paused = !worker.paused;
    if (worker.paused) {
      worker.status = worker.currentTicketId ? 'busy' : 'paused';
    } else {
      worker.status = worker.currentTicketId ? 'busy' : 'online';
    }
    appendAudit(this.state, {
      action: worker.paused ? 'worker.paused' : 'worker.resumed',
      entity: 'worker',
      entityId: worker.id,
      detail: `${worker.name} ${worker.paused ? '暂停接单' : '恢复接单'}`,
      tone: worker.paused ? 'warn' : 'success',
    }, this.now());
    this.store.save();
    return worker;
  }

  updateConfig(patch = {}) {
    const limits = {
      maxConcurrent: [1, 8],
      maxAttempts: [1, 5],
      leaseMinutes: [1, 240],
      tickMs: [500, 60_000],
      workMs: [0, 120_000],
      verifyMs: [0, 120_000],
    };
    const now = this.now();

    for (const [key, [min, max]] of Object.entries(limits)) {
      if (patch[key] === undefined) continue;
      const value = Number(patch[key]);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer between ${min} and ${max}`);
      }
      this.config[key] = value;
    }

    for (const key of ['paused', 'autoTick', 'demo']) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
      if (key === 'paused') {
        this.state.meta.paused = patch[key];
      } else if (key === 'demo') {
        this.state.meta.demo = patch[key];
      } else {
        this.config[key] = patch[key];
      }
    }

    if (patch.language !== undefined) this.config.language = String(patch.language);
    appendAudit(this.state, {
      action: 'config.updated',
      entity: 'config',
      entityId: 'config',
      detail: `maxConcurrent=${this.config.maxConcurrent}, maxAttempts=${this.config.maxAttempts}, paused=${this.state.meta.paused}`,
      tone: 'info',
    }, now);
    this.store.save();
    return this.config;
  }

  overview() {
    const state = this.state;
    const tickets = state.tickets;
    const done = tickets.filter((ticket) => ticket.state === 'done');
    const finished = tickets.filter((ticket) => ['done', 'dropped', 'failed'].includes(ticket.state));
    const avgCycleMinutes = done.length
      ? Math.round(
          done.reduce(
            (sum, ticket) => sum + (parseTime(ticket.updatedAt) - parseTime(ticket.createdAt)),
            0,
          ) /
            done.length /
            60_000,
        )
      : null;

    return {
      meta: state.meta,
      config: state.config,
      project: this.config.project,
      health: {
        status: state.meta.paused ? 'paused' : 'live',
        lastTickAt: state.meta.lastTickAt,
        tickCount: state.meta.tickCount,
        uptimeSeconds: Math.max(
          0,
          Math.round(
            (Date.now() - parseTime(state.meta.serverStartedAt || state.meta.startedAt)) / 1000,
          ),
        ),
      },
      counts: {
        sources: state.sources.length,
        sourcesHealthy: state.sources.filter((source) => source.status === 'healthy').length,
        sourcesPaused: state.sources.filter((source) => source.status === 'paused').length,
        events: state.events.length,
        pendingEvents: state.events.filter((event) => event.status === 'pending').length,
        tickets: tickets.length,
        activeTickets: tickets.filter((ticket) => OPEN_STATES.has(ticket.state)).length,
        awaitingReview: tickets.filter((ticket) => ticket.state === 'awaiting_review').length,
        blocked: tickets.filter((ticket) => ['blocked', 'failed'].includes(ticket.state)).length,
        done: done.length,
        deliveries: state.deliveries.length,
        deliveriesPending: state.deliveries.filter((delivery) => delivery.state === 'pending').length,
        deliveriesFailed: state.deliveries.filter((delivery) =>
          ['failed', 'dead'].includes(delivery.state),
        ).length,
        workersOnline: state.workers.filter((worker) =>
          ['online', 'busy'].includes(worker.status),
        ).length,
        workersBusy: state.workers.filter((worker) => worker.status === 'busy').length,
      },
      pipeline: PIPELINE.map((stage) => ({
        key: stage.key,
        label: stage.label,
        count: tickets.filter((ticket) => stage.states.includes(ticket.state)).length,
      })),
      activeTickets: tickets
        .filter((ticket) => OPEN_STATES.has(ticket.state))
        .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt))
        .slice(0, 6),
      recentAudit: state.audit.slice(0, 10),
      recentDeliveries: state.deliveries.slice(0, 6),
      sources: state.sources,
      workers: state.workers,
      avgCycleMinutes,
      successRate: finished.length
        ? Math.round((done.length / finished.length) * 100)
        : null,
    };
  }

  ticketDetail(id) {
    const ticket = this.findTicket(id);
    if (!ticket) return null;
    const event = this.state.events.find((candidate) => candidate.id === ticket.sourceEventId) || null;
    const source = this.state.sources.find((candidate) => candidate.id === ticket.sourceId) || null;
    const attempts = this.state.attempts
      .filter((attempt) => attempt.ticketId === ticket.id)
      .sort((a, b) => Number(b.number) - Number(a.number));
    const deliveries = this.state.deliveries
      .filter((delivery) => delivery.ticketId === ticket.id)
      .sort((a, b) => parseTime(b.createdAt) - parseTime(a.createdAt));
    const audit = this.state.audit.filter(
      (entry) => entry.ticketId === ticket.id || entry.entityId === ticket.id,
    );
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
      detail: `来源 ${ticket.sourceName} · ${ticket.externalId}`,
    });
    for (const entry of audit) {
      timeline.push({
        at: entry.at,
        kind: entry.tone === 'error' ? 'error' : entry.tone === 'warn' ? 'warn' : 'audit',
        title: entry.action,
        detail: entry.detail,
      });
    }
    for (const attempt of attempts) {
      timeline.push({
        at: attempt.startedAt,
        kind: 'attempt',
        title: `Attempt ${attempt.number} 开始`,
        detail: `${attempt.workerName} · ${attempt.state}`,
      });
      if (attempt.finishedAt) {
        timeline.push({
          at: attempt.finishedAt,
          kind: attempt.state === 'passed' ? 'verify' : 'error',
          title: `Attempt ${attempt.number} ${attempt.state === 'passed' ? '通过' : '失败'}`,
          detail: attempt.error || `${attempt.evidence?.length || 0} 个门禁证据`,
        });
      }
    }
    timeline.sort((a, b) => parseTime(a.at) - parseTime(b.at));

    const running = this.state.tickets.filter((candidate) =>
      OCCUPYING_STATES.has(candidate.state),
    ).length;
    return {
      ticket,
      source,
      event,
      attempts,
      deliveries,
      audit,
      timeline,
      routeReason: [
        {
          label: '来源连接器',
          ok: source ? source.status !== 'paused' : false,
          detail: source ? `${source.name} · ${source.kind}` : '未知来源',
        },
        {
          label: '去重键',
          ok: true,
          detail: event?.dedupeKey || '未记录',
        },
        {
          label: '策略标签',
          ok: true,
          detail: ticket.labels?.length ? ticket.labels.join(', ') : 'ready-for-agent',
        },
        {
          label: '并发预算',
          ok: running <= this.config.maxConcurrent,
          detail: `${running}/${this.config.maxConcurrent} 个 Worker 槽位被占用`,
        },
        {
          label: '独立验证',
          ok: attempts.some((attempt) => attempt.evidence?.length),
          detail: 'Verifier 在干净工作树复跑门禁',
        },
      ],
    };
  }
}
