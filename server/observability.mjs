function countBy(items, key) {
  const counts = {};
  for (const item of items || []) {
    const value = typeof key === 'function' ? key(item) : item[key];
    counts[value || 'unknown'] = (counts[value || 'unknown'] || 0) + 1;
  }
  return counts;
}

function metric(name, help, type, samples) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`];
  for (const [labels, value] of samples) {
    lines.push(`${name}${labels} ${value}`);
  }
  return lines.join('\n');
}

function label(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

export function metricsText(snapshot) {
  const tickets = snapshot.tickets || [];
  const deliveries = snapshot.deliveries || [];
  const events = snapshot.events || [];
  const sources = snapshot.sources || [];
  const workers = snapshot.workers || [];
  const automations = snapshot.automations || [];
  const generated = new Date().toISOString();
  const ticketCounts = countBy(tickets, 'state');
  const deliveryCounts = countBy(deliveries, 'state');
  const eventCounts = countBy(events, (event) => event.status || 'pending');
  const sourceCounts = countBy(sources, 'status');
  const workerCounts = countBy(workers, (worker) => worker.paused ? 'paused' : worker.status);
  const automationCounts = countBy(automations, (item) => item.enabled ? 'enabled' : 'paused');
  const withZero = (counts, states) => Object.fromEntries(
    [...new Set([...states, ...Object.keys(counts)])].map((state) => [state, counts[state] || 0]),
  );
  const blocks = [
    `# self-loop metrics generated ${generated}`,
    metric(
      'self_loop_sources',
      'Connector sources by health status',
      'gauge',
      Object.entries(withZero(sourceCounts, ['healthy', 'degraded', 'paused'])).map(
        ([status, value]) => [`{status="${label(status)}"}`, value],
      ),
    ),
    metric(
      'self_loop_inbox_events',
      'Inbox events by status',
      'gauge',
      Object.entries(withZero(eventCounts, ['pending', 'consumed', 'ignored'])).map(
        ([status, value]) => [`{status="${label(status)}"}`, value],
      ),
    ),
    metric(
      'self_loop_tickets',
      'Tickets by Router state',
      'gauge',
      Object.entries(withZero(ticketCounts, [
        'queued',
        'claimed',
        'working',
        'verifying',
        'awaiting_review',
        'blocked',
        'failed',
        'done',
        'dropped',
      ])).map(
        ([state, value]) => [`{state="${label(state)}"}`, value],
      ),
    ),
    metric(
      'self_loop_outbox_deliveries',
      'Outbox deliveries by state',
      'gauge',
      Object.entries(withZero(deliveryCounts, ['pending', 'sending', 'sent', 'failed', 'dead'])).map(
        ([state, value]) => [`{state="${label(state)}"}`, value],
      ),
    ),
    metric(
      'self_loop_workers',
      'Executor workers by status',
      'gauge',
      Object.entries(withZero(workerCounts, ['online', 'busy', 'paused', 'offline'])).map(
        ([status, value]) => [`{status="${label(status)}"}`, value],
      ),
    ),
    metric(
      'self_loop_automations',
      'Scheduled automations by enabled flag',
      'gauge',
      Object.entries(withZero(automationCounts, ['enabled', 'paused'])).map(
        ([state, value]) => [`{state="${label(state)}"}`, value],
      ),
    ),
    [
      '# HELP self_loop_router_up Whether the Router is not paused',
      '# TYPE self_loop_router_up gauge',
      `self_loop_router_up ${snapshot.meta?.paused ? 0 : 1}`,
    ].join('\n'),
    [
      '# HELP self_loop_uptime_seconds Console process uptime',
      '# TYPE self_loop_uptime_seconds gauge',
      `self_loop_uptime_seconds ${Number(snapshot.health?.uptimeSeconds || 0)}`,
    ].join('\n'),
  ];
  return `${blocks.join('\n\n')}\n`;
}

export function observabilitySummary(snapshot) {
  const tickets = snapshot.tickets || [];
  const deliveries = snapshot.deliveries || [];
  const events = snapshot.events || [];
  const workers = snapshot.workers || [];
  return {
    generatedAt: new Date().toISOString(),
    router: {
      paused: Boolean(snapshot.meta?.paused),
      uptimeSeconds: Number(snapshot.health?.uptimeSeconds || 0),
      lastTickAt: snapshot.meta?.lastTickAt || null,
      slots: snapshot.config?.maxConcurrent || 0,
    },
    queues: {
      inboxPending: events.filter((event) => event.status === 'pending').length,
      ticketsActive: tickets.filter((ticket) =>
        ['queued', 'claimed', 'working', 'verifying', 'awaiting_review'].includes(ticket.state)).length,
      outboxPending: deliveries.filter((delivery) => delivery.state === 'pending').length,
      outboxDead: deliveries.filter((delivery) => delivery.state === 'dead').length,
    },
    workers: {
      online: workers.filter((worker) => ['online', 'busy'].includes(worker.status)).length,
      busy: workers.filter((worker) => worker.status === 'busy').length,
      paused: workers.filter((worker) => worker.paused).length,
    },
    states: countBy(tickets, 'state'),
    deliveryStates: countBy(deliveries, 'state'),
  };
}
