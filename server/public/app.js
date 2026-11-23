const app = document.getElementById('app');
const modalRoot = document.getElementById('modal-root');
const toastRoot = document.getElementById('toast-root');

const ICONS = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
  inbox: '<path d="M4 5h16v14H4z"/><path d="M4 13h4l2 3h4l2-3h4"/>',
  tickets:
    '<path d="M4 6h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/><path d="M9 8v8"/>',
  outbox: '<path d="M4 5h16v14H4z"/><path d="M4 13h4l2-3h4l2 3h4"/><path d="M9 9l3-3 3 3"/>',
  sources:
    '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0z"/><path d="M12 17v4"/>',
  workers:
    '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M8 12h.01M16 12h.01M9 16h6"/>',
  policy:
    '<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z"/><path d="M9 12l2 2 4-4"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 9v5M12 17h.01"/>',
  check: '<path d="M5 12l4 4L19 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  git: '<circle cx="6" cy="6" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8a2 2 0 0 0 2 2h8"/>',
  message: '<path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/>',
  database:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  arrowLeft: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5H5V5h5"/>',
  zap: '<path d="M13 2L4 14h6l-1 8 9-12h-6z"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5h10"/>',
  logs: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  projects:
    '<rect x="4" y="5" width="16" height="5" rx="1.5"/><path d="M6 10v8h12v-8M9 14h6"/>',
};

const STATE_LABEL = {
  queued: 'Queued',
  claimed: 'Claimed',
  working: 'Working',
  verifying: 'Verifying',
  awaiting_review: 'Review',
  blocked: 'Blocked',
  failed: 'Failed',
  done: 'Done',
  dropped: 'Dropped',
};

const STATE_BADGE = {
  queued: 'badge-amber',
  claimed: 'badge-blue',
  working: 'badge-blue',
  verifying: 'badge-purple',
  awaiting_review: 'badge-cyan',
  blocked: 'badge-red',
  failed: 'badge-red',
  done: 'badge-green',
  dropped: 'badge-muted',
};

const PRIORITY_LABEL = {
  urgent: 'urgent',
  high: 'high',
  normal: 'normal',
  low: 'low',
};

const state = {
  data: null,
  route: parseRoute(),
  filters: {
    inbox: 'all',
    outbox: 'all',
    tickets: 'all',
  },
  modal: null,
  stream: null,
  lastRoute: null,
};

function icon(name, className = 'icon') {
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (!parts.length) return { name: 'overview', id: null };
  if (parts[0] === 'tickets' && parts[1]) return { name: 'ticket', id: parts[1] };
  return { name: parts[0], id: parts[1] || null };
}

function isOpen(value) {
  return [
    'queued',
    'claimed',
    'working',
    'verifying',
    'awaiting_review',
    'blocked',
    'failed',
  ].includes(value);
}

function fmtDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function fmtTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function timeAgo(value) {
  if (!value) return '—';
  const diff = Date.now() - Date.parse(value);
  if (!Number.isFinite(diff)) return '—';
  if (diff < 10_000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function timeUntil(value) {
  if (!value) return '—';
  const diff = Date.parse(value) - Date.now();
  if (!Number.isFinite(diff)) return '—';
  if (diff <= 0) return 'expired';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)} 秒后`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)} 分钟后`;
  return `${Math.ceil(diff / 3_600_000)} 小时后`;
}

function duration(start, end) {
  const ms = Date.parse(end || new Date().toISOString()) - Date.parse(start);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function stageClass(value) {
  return `stage-${value || 'queued'}`;
}

function stateBadge(value) {
  return `<span class="badge ${STATE_BADGE[value] || 'badge-muted'}">${esc(STATE_LABEL[value] || value)}</span>`;
}

function priorityClass(value) {
  return value === 'urgent' || value === 'high' ? value : '';
}

function sourceBadge(kind) {
  const map = {
    github: ['badge-blue', 'git'],
    jira: ['badge-purple', 'tickets'],
    webhook: ['badge-cyan', 'zap'],
    cron: ['badge-amber', 'clock'],
    im: ['badge-green', 'message'],
    slack: ['badge-green', 'message'],
  };
  const [badge, iconName] = map[kind] || ['badge-muted', 'database'];
  return `<span class="badge ${badge}">${icon(iconName, 'icon')} ${esc(kind)}</span>`;
}

function eventBadge(value) {
  const map = {
    pending: 'badge-amber',
    consumed: 'badge-green',
    ignored: 'badge-muted',
  };
  return `<span class="badge ${map[value] || 'badge-muted'}">${esc(value)}</span>`;
}

function deliveryBadge(value) {
  const map = {
    pending: 'badge-amber',
    sending: 'badge-blue',
    sent: 'badge-green',
    failed: 'badge-red',
    dead: 'badge-red',
  };
  return `<span class="badge ${map[value] || 'badge-muted'}">${esc(value)}</span>`;
}

function workerBadge(worker) {
  if (worker.paused) return '<span class="badge badge-amber">paused</span>';
  if (worker.status === 'offline') return '<span class="badge badge-muted">offline</span>';
  if (worker.status === 'busy') return '<span class="badge badge-blue">busy</span>';
  return '<span class="badge badge-green">online</span>';
}

function computeCounts(data) {
  return {
    sources: data.sources.length,
    sourcesHealthy: data.sources.filter((source) => source.status === 'healthy').length,
    pendingEvents: data.events.filter((event) => event.status === 'pending').length,
    activeTickets: data.tickets.filter((ticket) => isOpen(ticket.state)).length,
    awaitingReview: data.tickets.filter((ticket) => ticket.state === 'awaiting_review').length,
    blocked: data.tickets.filter((ticket) => ['blocked', 'failed'].includes(ticket.state)).length,
    verifying: data.tickets.filter((ticket) => ticket.state === 'verifying').length,
    done: data.tickets.filter((ticket) => ticket.state === 'done').length,
    deliveries: data.deliveries.length,
    deliveriesPending: data.deliveries.filter((delivery) => delivery.state === 'pending').length,
    deliveriesFailed: data.deliveries.filter((delivery) =>
      ['failed', 'dead'].includes(delivery.state),
    ).length,
    workersOnline: data.workers.filter((worker) =>
      ['online', 'busy'].includes(worker.status),
    ).length,
    workersBusy: data.workers.filter((worker) => worker.status === 'busy').length,
  };
}

function pageTitle(route) {
  if (route.name === 'ticket') return 'Ticket 详情';
  return {
    overview: 'Overview',
    inbox: 'Inbox',
    tickets: 'Tickets',
    outbox: 'Outbox',
    sources: 'Sources',
    workers: 'Workers',
    policy: 'Policy',
    projects: 'Projects',
  }[route.name] || 'Overview';
}

function navItem(name, label, iconName, count, route, tone = '') {
  const active =
    route.name === name || (name === 'tickets' && route.name === 'ticket');
  return `<a class="nav-item ${active ? 'active' : ''}" href="#/${name}" data-route="#/${name}">
    ${icon(iconName, 'nav-icon')}
    <span class="nav-label">${label}</span>
    ${count !== '' && count !== undefined ? `<span class="nav-count ${tone}">${count}</span>` : ''}
  </a>`;
}

function shell() {
  const data = state.data;
  const counts = computeCounts(data);
  const route = state.route;
  const caps = data.capabilities || {};
  const projects = data.projects || { currentId: null, items: [] };
  const canSwitch = Boolean(caps.projectSelect && projects.items.length > 0);
  const project = data.config.project || { name: 'self-loop', repo: '' };
  const currentProject = projects.items.find((item) => item.current);
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark">${icon('git')}</div>
          <div>
            <div class="brand-name">self-loop</div>
            <div class="brand-sub">router console</div>
          </div>
        </div>
        <div class="project">
          <div>
            <div class="project-label">Project</div>
            ${
              canSwitch
                ? `<select class="project-select" data-project-select aria-label="选择项目">
                    ${projects.items
                      .map(
                        (item) => `<option value="${esc(item.id)}" ${item.current ? 'selected' : ''}>${esc(item.name)}</option>`,
                      )
                      .join('')}
                  </select>`
                : `<div class="project-name">${esc(project.name)}</div>`
            }
            <div class="project-repo">${esc(project.repo || currentProject?.path || 'local project')}</div>
            ${caps.projectSelect ? `<a class="project-manage" href="#/projects" data-route="#/projects">Manage projects</a>` : ''}
          </div>
          <span class="badge ${caps.mode === 'project' ? 'badge-cyan' : 'badge-green'}">${caps.mode === 'project' ? 'project' : 'demo'}</span>
        </div>
        <nav class="nav" aria-label="主导航">
          <div class="nav-section">Workspace</div>
          ${navItem('projects', 'Projects', 'projects', projects.items.length || '', route)}
          <div class="nav-section">Control plane</div>
          ${navItem('overview', 'Overview', 'overview', counts.activeTickets, route)}
          ${navItem('inbox', 'Inbox', 'inbox', counts.pendingEvents, route, 'hot')}
          ${navItem('tickets', 'Tickets', 'tickets', counts.activeTickets, route)}
          ${navItem('outbox', 'Outbox', 'outbox', counts.deliveriesFailed, route, counts.deliveriesFailed ? 'danger' : '')}
          <div class="nav-section">Runtime</div>
          ${navItem('sources', 'Sources', 'sources', counts.sources, route)}
          ${navItem('workers', 'Workers', 'workers', counts.workersOnline, route)}
          ${navItem('policy', 'Policy', 'policy', '', route)}
        </nav>
        <div class="sidebar-foot">
          <div class="router-status">
            <div class="status-row">
              <span class="live-dot ${data.meta.paused ? 'paused' : ''}"></span>
              <span>${data.meta.paused ? 'Router paused' : 'Router live'}</span>
              <span class="nav-count" style="margin-left:auto">${data.meta.tickCount || 0}</span>
            </div>
            <div class="status-meta">
              ${caps.mode === 'project' ? 'reads .loop/state.json' : `tick ${data.config.tickMs}ms`} · ${data.config.maxConcurrent} slots<br>
              ${data.meta.lastTickAt ? `last ${timeAgo(data.meta.lastTickAt)}` : 'not started'}
            </div>
          </div>
          <div class="local-badge">
            ${icon('shield')}
            <span>LOCAL · TOKEN<br>写操作已保护 · 不要暴露到公网</span>
          </div>
        </div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div>
            <div class="topbar-title">${pageTitle(route)}</div>
            <div class="topbar-crumb">self-loop / ${route.name}${route.id ? ` / ${esc(route.id)}` : ''}</div>
          </div>
          <div class="topbar-spacer"></div>
          <div class="topbar-meta">
            <span class="badge ${data.meta.paused ? 'badge-amber' : 'badge-green'}">${data.meta.paused ? 'paused' : 'live'}</span>
            <span class="badge badge-muted">${data.config.maxConcurrent} slots</span>
            <span class="badge badge-muted">${fmtTime(data.meta.lastTickAt)}</span>
          </div>
          ${caps.pause ? `<button class="btn btn-ghost btn-sm" data-action="toggle-pause" type="button">${icon(data.meta.paused ? 'play' : 'pause')} ${data.meta.paused ? 'Resume' : 'Pause'}</button>` : ''}
          <button class="btn btn-sm" data-action="tick" type="button">${icon('refresh')} ${caps.mode === 'project' ? 'Run tick' : 'Tick'}</button>
          ${caps.injectEvent ? `<button class="btn btn-primary btn-sm" data-action="inject-event" type="button">${icon('plus')} Inject event</button>` : ''}
        </header>
        <main class="content">${view()}</main>
      </div>
    </div>
  `;
}

function view() {
  const route = state.route;
  if (route.name === 'inbox') return inboxView();
  if (route.name === 'tickets') return ticketsView();
  if (route.name === 'ticket') return ticketView(route.id);
  if (route.name === 'outbox') return outboxView();
  if (route.name === 'sources') return sourcesView();
  if (route.name === 'workers') return workersView();
  if (route.name === 'policy') return policyView();
  if (route.name === 'projects') return projectsView();
  return overviewView();
}

function flowStrip(data) {
  const counts = computeCounts(data);
  const steps = [
    ['Sources', counts.sources, `${counts.sourcesHealthy} healthy`],
    ['Inbox', counts.pendingEvents, 'pending events'],
    ['Router', counts.activeTickets, `${data.config.maxConcurrent} slots`],
    ['Workers', `${counts.workersBusy}/${counts.workersOnline}`, 'busy / online'],
    ['Verifier', counts.verifying, 'in verification'],
    ['Outbox', counts.deliveriesPending, `${counts.deliveriesFailed} failed`],
  ];
  return `<div class="flow-strip">${steps
    .map(
      ([label, value, note], index) => `
        ${index ? `<div class="flow-arrow">${icon('chevron')}</div>` : ''}
        <div class="flow-step">
          <div class="flow-step-label">${label}</div>
          <div class="flow-step-value">${value}</div>
          <div class="flow-step-note">${esc(note)}</div>
        </div>`,
    )
    .join('')}</div>`;
}

function kpi(label, value, foot, accent, iconName) {
  return `<div class="card kpi" style="--accent:${accent}">
    <div class="kpi-label">${icon(iconName)} ${label}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-foot">${esc(foot)}</div>
  </div>`;
}

function pipeline(data) {
  const stages = [
    ['Queued', ['queued'], 'var(--amber)', 'queued'],
    ['Working', ['claimed', 'working'], 'var(--blue)', 'working'],
    ['Verifying', ['verifying'], 'var(--purple)', 'verifying'],
    ['Review', ['awaiting_review'], 'var(--cyan)', 'review'],
    ['Blocked', ['blocked', 'failed'], 'var(--red)', 'blocked'],
    ['Done', ['done', 'dropped'], 'var(--green)', 'done'],
  ];
  return `<div class="pipeline">${stages
    .map(([label, states, accent, filter]) => {
      const count = data.tickets.filter((ticket) => states.includes(ticket.state)).length;
      return `<button class="pipeline-stage" style="--stage:${accent}" data-action="focus-tickets" data-filter="${filter}" type="button">
        <div class="stage-bar"></div>
        <div class="pipeline-count">${count}</div>
        <div class="pipeline-label">${label}</div>
      </button>`;
    })
    .join('')}</div>`;
}

function auditList(entries) {
  if (!entries.length) return '<div class="inline-empty">暂无活动</div>';
  return `<div class="list">${entries
    .map(
      (entry) => `<div class="list-row">
        <div class="list-main">
          <div class="list-title">${esc(entry.detail)}</div>
          <div class="list-sub">${esc(entry.actor)} · ${esc(entry.action)}${entry.ticketNumber ? ` · #${entry.ticketNumber}` : ''}</div>
        </div>
        <div class="timeline-time nowrap">${timeAgo(entry.at)}</div>
      </div>`,
    )
    .join('')}</div>`;
}

function workerList(workers) {
  return `<div class="list">${workers
    .map(
      (worker) => `<div class="list-row">
        <span class="live-dot ${worker.status === 'busy' ? '' : worker.status === 'offline' ? 'paused' : ''}" style="${worker.status === 'offline' ? 'background:var(--dim);box-shadow:none;animation:none' : ''}"></span>
        <div class="list-main">
          <div class="list-title">${esc(worker.name)} <span class="dim mono">${esc(worker.kind)}</span></div>
          <div class="list-sub">${worker.currentTicketId ? `正在处理 ${esc(worker.currentTicketId)}` : worker.paused ? '暂停接单' : 'idle'}</div>
        </div>
        ${workerBadge(worker)}
      </div>`,
    )
    .join('')}</div>`;
}

function outboxSummary(deliveries) {
  const sent = deliveries.filter((delivery) => delivery.state === 'sent').length;
  const pending = deliveries.filter((delivery) => delivery.state === 'pending').length;
  const failed = deliveries.filter((delivery) => ['failed', 'dead'].includes(delivery.state)).length;
  const total = deliveries.length || 1;
  return `<div class="list">
    <div class="list-row">
      <div class="list-main"><div class="list-title">Delivered</div><div class="progress" style="margin-top:6px"><span style="width:${(sent / total) * 100}%"></span></div></div>
      <span class="mono">${sent}</span>
    </div>
    <div class="list-row">
      <div class="list-main"><div class="list-title">Pending</div><div class="progress" style="margin-top:6px"><span style="width:${(pending / total) * 100}%;background:var(--amber)"></span></div></div>
      <span class="mono">${pending}</span>
    </div>
    <div class="list-row">
      <div class="list-main"><div class="list-title">Failed / dead</div><div class="progress" style="margin-top:6px"><span style="width:${(failed / total) * 100}%;background:var(--red)"></span></div></div>
      <span class="mono">${failed}</span>
    </div>
  </div>`;
}

function focusList(blocked, active) {
  const chosen = [...blocked, ...active]
    .filter((ticket, index, list) => list.findIndex((item) => item.id === ticket.id) === index)
    .slice(0, 4);
  if (!chosen.length) return '<div class="inline-empty">当前没有需要关注的 Ticket</div>';
  return `<div class="list">${chosen
    .map(
      (ticket) => `<button class="list-row" data-route="#/tickets/${ticket.id}" style="background:none;border:0;color:inherit;text-align:left;cursor:pointer;width:100%;font:inherit">
        <div class="list-main">
          <div class="list-title">#${ticket.number} ${esc(ticket.title)}</div>
          <div class="list-sub">${ticket.humanQuestion ? esc(ticket.humanQuestion) : esc(ticket.summary)}</div>
        </div>
        ${stateBadge(ticket.state)}
      </button>`,
    )
    .join('')}</div>`;
}

function overviewView() {
  const data = state.data;
  const caps = data.capabilities || {};
  const counts = computeCounts(data);
  const blocked = data.tickets.filter((ticket) => ['blocked', 'failed'].includes(ticket.state));
  const active = data.tickets.filter((ticket) => isOpen(ticket.state));
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">控制面总览</h1>
        <p class="page-sub">Source → Inbox → Router → Worker → Verifier → Outbox。所有状态从这里可追踪。</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="refresh" type="button">${icon('refresh')} 刷新</button>
        ${caps.injectEvent ? `<button class="btn btn-primary" data-action="inject-event" type="button">${icon('plus')} 注入事件</button>` : ''}
      </div>
    </div>
    ${
      caps.mode === 'project'
        ? `<div class="mode-banner">
            ${icon('database')}
            <div>
              <div class="mode-banner-title">正在读取项目真实 Router 状态</div>
              <div class="mode-banner-sub">
                ${esc(data.config.project.repo || data.config.project.name)} · ${esc(data.health?.stateFile || '.loop/state.json')}；
                Router 仍是 Ticket 状态唯一写入者，控制台写操作通过 router CLI 执行。
              </div>
            </div>
          </div>`
        : ''
    }
    ${flowStrip(data)}
    <div class="kpi-grid">
      ${kpi('Inbox pending', counts.pendingEvents, `${counts.sources} sources connected`, 'var(--amber)', 'inbox')}
      ${kpi('Active tickets', counts.activeTickets, `${data.config.maxConcurrent} worker slots`, 'var(--blue)', 'tickets')}
      ${kpi('Awaiting review', counts.awaitingReview, 'PR ready for a human', 'var(--cyan)', 'check')}
      ${kpi('Blocked', counts.blocked, 'needs a human decision', 'var(--red)', 'alert')}
      ${kpi('Outbox failed', counts.deliveriesFailed, `${counts.deliveriesPending} pending deliveries`, counts.deliveriesFailed ? 'var(--red)' : 'var(--green)', 'outbox')}
    </div>
    <div class="grid grid-2-1">
      <div class="stack">
        <section class="card">
          <div class="card-header">
            <div><div class="card-title">Router pipeline</div><div class="card-sub">Ticket 状态分布 · 点击筛选</div></div>
            <span class="badge badge-muted">${counts.activeTickets} active</span>
          </div>
          ${pipeline(data)}
        </section>
        <section class="card">
          <div class="card-header">
            <div><div class="card-title">最近活动</div><div class="card-sub">Router 审计流 · 最新在前</div></div>
            <span class="badge badge-muted">${data.audit.length} events</span>
          </div>
          ${auditList(data.audit.slice(0, 8))}
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-header">
            <div><div class="card-title">Worker pool</div><div class="card-sub">在线 / 忙碌 / 暂停</div></div>
            <span class="badge badge-green">${counts.workersOnline} online</span>
          </div>
          ${workerList(data.workers)}
        </section>
        <section class="card">
          <div class="card-header">
            <div><div class="card-title">Outbox health</div><div class="card-sub">投递状态分布</div></div>
            <span class="badge ${counts.deliveriesFailed ? 'badge-red' : 'badge-green'}">${counts.deliveriesFailed} failed</span>
          </div>
          ${outboxSummary(data.deliveries)}
        </section>
        <section class="card">
          <div class="card-header">
            <div><div class="card-title">Focus</div><div class="card-sub">最需要人看的 Ticket</div></div>
          </div>
          ${focusList(blocked, active)}
        </section>
      </div>
    </div>
  `;
}

function filterChips(group, options) {
  return `<div class="filters">${options
    .map(
      ([value, label]) =>
        `<button class="filter ${state.filters[group] === value ? 'active' : ''}" data-action="filter-${group}" data-filter="${value}" type="button">${label}</button>`,
    )
    .join('')}</div>`;
}

function inboxView() {
  const data = state.data;
  const caps = data.capabilities || {};
  const filter = state.filters.inbox;
  const events = data.events
    .filter((event) => filter === 'all' || event.status === filter)
    .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Inbox</h1>
        <p class="page-sub">事件流，不是任务列表。Router 消费事件后才会生成 Ticket。</p>
      </div>
      <div class="page-actions">
        ${caps.injectEvent ? `<button class="btn btn-primary" data-action="inject-event" type="button">${icon('plus')} 注入事件</button>` : ''}
      </div>
    </div>
    <section class="card">
      <div class="card-header">
        ${filterChips('inbox', [['all', 'All'], ['pending', 'Pending'], ['consumed', 'Consumed'], ['ignored', 'Ignored']])}
        <span class="badge badge-muted">${events.length} events</span>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Source</th><th>Event</th><th>Kind</th><th>Status</th><th>Ticket</th></tr></thead>
          <tbody>
            ${events
              .map(
                (event) => `<tr>
                  <td class="nowrap mono dim">${fmtDate(event.receivedAt)}</td>
                  <td>${sourceBadge(event.sourceKind)}</td>
                  <td><div class="list-title">${esc(event.title)}</div><div class="list-sub">${esc(event.externalId)}${event.ignoredReason ? ` · ${esc(event.ignoredReason)}` : ''}</div></td>
                  <td class="mono dim nowrap">${esc(event.kind)}</td>
                  <td>${eventBadge(event.status)}</td>
                  <td>${event.ticketId ? `<span class="link" data-route="#/tickets/${event.ticketId}">打开 Ticket</span>` : '<span class="dim">—</span>'}</td>
                </tr>`,
              )
              .join('') || '<tr><td colspan="6" class="dim">没有匹配的事件</td></tr>'}
          </tbody>
        </table>
      </div>
    </section>
    <div style="margin-top:12px" class="card">
      <div class="card-title">事件语义</div>
      <p class="card-sub" style="font-size:11.5px;line-height:1.65;margin:6px 0 0">
        <span class="badge badge-amber">pending</span> 等待 Router 消费；
        <span class="badge badge-green">consumed</span> 已关联到 Ticket；
        <span class="badge badge-muted">ignored</span> 只作为上下文或唤醒信号。
        Inbox 不保存历史执行，Attempt 在 Ticket 详情里。
        ${caps.mode === 'project' ? ' 当前是项目模式，事件直接来自 .loop/inbox.json。' : ''}
      </p>
    </div>
  `;
}

function ticketsView() {
  const data = state.data;
  const filter = state.filters.tickets;
  const columns = [
    { key: 'queued', label: 'Queued', states: ['queued'], accent: 'var(--amber)' },
    { key: 'working', label: 'Working', states: ['claimed', 'working'], accent: 'var(--blue)' },
    { key: 'verifying', label: 'Verifying', states: ['verifying'], accent: 'var(--purple)' },
    { key: 'review', label: 'Review', states: ['awaiting_review'], accent: 'var(--cyan)' },
    { key: 'blocked', label: 'Blocked', states: ['blocked', 'failed'], accent: 'var(--red)' },
    { key: 'done', label: 'Done', states: ['done', 'dropped'], accent: 'var(--green)' },
  ];
  const visible = data.tickets.filter((ticket) => {
    if (filter === 'all') return true;
    if (filter === 'active') return isOpen(ticket.state);
    if (filter === 'queued') return ticket.state === 'queued';
    if (filter === 'working') return ['claimed', 'working'].includes(ticket.state);
    if (filter === 'verifying') return ticket.state === 'verifying';
    if (filter === 'review') return ticket.state === 'awaiting_review';
    if (filter === 'blocked') return ['blocked', 'failed'].includes(ticket.state);
    if (filter === 'done') return ['done', 'dropped'].includes(ticket.state);
    return true;
  });
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Tickets</h1>
        <p class="page-sub">Router 是唯一写 Ticket 状态的角色。Worker 只写 Attempt 与 PR。</p>
      </div>
      <div class="page-actions">
        ${filterChips('tickets', [['all', 'All'], ['active', 'Active'], ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done']])}
      </div>
    </div>
    <div class="kanban">
      ${columns
        .map((column) => {
          const items = visible.filter((ticket) => column.states.includes(ticket.state));
          return `<section class="kanban-col">
            <div class="kanban-head">
              <span class="stage-bar" style="width:14px;height:4px;margin:0;--stage:${column.accent}"></span>
              <span class="kanban-title">${column.label}</span>
              <span class="kanban-count">${items.length}</span>
            </div>
            ${items.length ? items.map(ticketCard).join('') : '<div class="inline-empty">空</div>'}
          </section>`;
        })
        .join('')}
    </div>
  `;
}

function ticketCard(ticket) {
  const current = ticket.currentAttemptId ? 1 : 0;
  const attemptValue = Number(ticket.attempts || 0) + current;
  return `<button class="ticket-card ${stageClass(ticket.state)}" data-route="#/tickets/${ticket.id}" type="button" aria-label="打开 Ticket ${ticket.number}">
    <div class="ticket-top">
      <span class="ticket-id">#${ticket.number}</span>
      ${sourceBadge(ticket.sourceKind)}
      <span class="ticket-priority ${priorityClass(ticket.priority)}">${PRIORITY_LABEL[ticket.priority] || ticket.priority}</span>
    </div>
    <div class="ticket-title">${esc(ticket.title)}</div>
    <div class="ticket-foot">
      ${ticket.workerName ? `<span class="badge badge-muted">${esc(ticket.workerName)}</span>` : '<span class="badge badge-muted">unassigned</span>'}
      <span class="badge badge-muted">A${attemptValue}/${ticket.maxAttempts}</span>
      ${ticket.humanQuestion ? '<span class="badge badge-amber">needs answer</span>' : ''}
      ${['blocked', 'failed'].includes(ticket.state) && ticket.lastError ? '<span class="badge badge-red">gate failed</span>' : ''}
      <span class="dim" style="margin-left:auto;font-size:9.5px">${timeAgo(ticket.updatedAt)}</span>
    </div>
  </button>`;
}

function buildTimeline(ticket, event, attempts, audit) {
  const items = [];
  if (event) {
    items.push({
      at: event.receivedAt,
      kind: 'event',
      title: '来源事件进入 Inbox',
      detail: `${event.sourceName} · ${event.kind} · ${event.title}`,
    });
  }
  items.push({
    at: ticket.createdAt,
    kind: 'ticket',
    title: `创建 Ticket #${ticket.number}`,
    detail: `${ticket.sourceName} · ${ticket.externalId}`,
  });
  for (const entry of audit) {
    if (entry.action === 'ticket.created') continue;
    items.push({
      at: entry.at,
      kind:
        entry.tone === 'error'
          ? 'error'
          : entry.tone === 'warn'
            ? 'warn'
            : entry.tone === 'success'
              ? 'success'
              : 'audit',
      title: entry.action,
      detail: entry.detail,
    });
  }
  for (const attempt of attempts) {
    items.push({
      at: attempt.startedAt,
      kind: 'attempt',
      title: `Attempt ${attempt.number} 开始`,
      detail: `${attempt.workerName} · ${attempt.phase}`,
    });
    if (attempt.finishedAt) {
      items.push({
        at: attempt.finishedAt,
        kind: attempt.state === 'passed' ? 'verify' : 'error',
        title: `Attempt ${attempt.number} ${attempt.state === 'passed' ? '通过' : '失败'}`,
        detail:
          attempt.error ||
          `${attempt.evidence?.length || 0} 个门禁证据 · ${duration(attempt.startedAt, attempt.finishedAt)}`,
      });
    }
  }
  items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return items;
}

function ticketView(id) {
  const data = state.data;
  const caps = data.capabilities || {};
  const ticket = data.tickets.find(
    (candidate) => candidate.id === id || String(candidate.number) === String(id),
  );
  if (!ticket) {
    return `<div class="empty">找不到 Ticket ${esc(id)}。<div style="margin-top:10px"><button class="btn" data-route="#/tickets" type="button">返回 Tickets</button></div></div>`;
  }
  const attempts = data.attempts
    .filter((attempt) => attempt.ticketId === ticket.id)
    .sort((a, b) => Number(b.number) - Number(a.number));
  const deliveries = data.deliveries
    .filter((delivery) => delivery.ticketId === ticket.id)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const event = data.events.find((candidate) => candidate.id === ticket.sourceEventId);
  const source = data.sources.find((candidate) => candidate.id === ticket.sourceId);
  const worker = data.workers.find((candidate) => candidate.id === ticket.workerId);
  const audit = data.audit.filter(
    (entry) => entry.ticketId === ticket.id || entry.entityId === ticket.id,
  );
  const attemptValue = Number(ticket.attempts || 0) + (ticket.currentAttemptId ? 1 : 0);
  const timeline = buildTimeline(ticket, event, attempts, audit);
  const running = data.tickets.filter((candidate) =>
    ['claimed', 'working', 'verifying'].includes(candidate.state),
  ).length;
  const routeReasons = [
    {
      label: '来源连接器',
      ok: Boolean(source && source.status !== 'paused'),
      detail: source ? `${source.name} · ${source.kind}` : '未知来源',
    },
    {
      label: '去重键',
      ok: Boolean(event?.dedupeKey),
      detail: event?.dedupeKey || '未记录',
    },
    {
      label: '策略标签',
      ok: true,
      detail: ticket.labels?.length ? ticket.labels.join(', ') : 'ready-for-agent',
    },
    {
      label: '并发预算',
      ok: running <= data.config.maxConcurrent,
      detail: `${running}/${data.config.maxConcurrent} 个槽位被占用`,
    },
    {
      label: '独立验证',
      ok: attempts.some((attempt) => attempt.evidence?.length),
      detail: 'Verifier 在干净工作树复跑门禁',
    },
  ];

  return `
    <div class="detail-head">
      <div>
        <div class="detail-meta">
          <button class="btn btn-ghost btn-sm" data-route="#/tickets" type="button">${icon('arrowLeft')} Tickets</button>
          ${stateBadge(ticket.state)}
          ${sourceBadge(ticket.sourceKind)}
          <span class="badge badge-muted">${esc(ticket.priority)}</span>
          ${ticket.pr ? `<span class="badge badge-cyan">PR #${ticket.pr.number}</span>` : ''}
        </div>
        <h1 class="detail-title">#${ticket.number} ${esc(ticket.title)}</h1>
        <p class="page-sub">${esc(ticket.summary)}</p>
      </div>
      <div class="detail-actions">
        ${ticket.state === 'blocked' && caps.ticketAnswer ? `<button class="btn btn-primary" data-action="focus-answer" data-id="${ticket.id}" type="button">${icon('message')} 回答</button>` : ''}
        ${['blocked', 'failed'].includes(ticket.state) && caps.ticketRetry ? `<button class="btn" data-action="retry" data-id="${ticket.id}" type="button">${icon('refresh')} 重跑</button>` : ''}
        ${ticket.state === 'awaiting_review' && caps.ticketApprove ? `<button class="btn btn-primary" data-action="approve" data-id="${ticket.id}" type="button">${icon('check')} 验收通过</button>` : ''}
        ${!['done', 'dropped'].includes(ticket.state) && caps.ticketCancel ? `<button class="btn btn-danger" data-action="cancel" data-id="${ticket.id}" type="button">${icon('x')} 取消</button>` : ''}
      </div>
    </div>
    <div class="meta-grid">
      <div class="meta-box"><div class="meta-label">Source</div><div class="meta-value">${esc(ticket.sourceName)}</div><div class="meta-label" style="margin-top:4px">${esc(ticket.externalId)}</div></div>
      <div class="meta-box"><div class="meta-label">Worker</div><div class="meta-value">${esc(ticket.workerName || worker?.name || 'unassigned')}</div><div class="meta-label" style="margin-top:4px">${ticket.lease ? `lease ${timeUntil(ticket.lease.expiresAt)}` : 'no lease'}</div></div>
      <div class="meta-box"><div class="meta-label">Attempts</div><div class="meta-value">${attemptValue}/${ticket.maxAttempts}</div><div class="meta-label" style="margin-top:4px">${ticket.lastError ? 'last attempt failed' : attemptValue >= ticket.maxAttempts ? 'no retries left' : 'budget remaining'}</div></div>
      <div class="meta-box"><div class="meta-label">PR</div><div class="meta-value">${ticket.pr ? `#${ticket.pr.number}` : '—'}</div><div class="meta-label" style="margin-top:4px">${ticket.pr ? 'awaiting human review' : 'not opened'}</div></div>
    </div>
    <div class="detail-grid">
      <div class="stack">
        <section class="card">
          <div class="card-header"><div><div class="card-title">时间线</div><div class="card-sub">从来源事件到 Outbox 的完整链路</div></div><span class="badge badge-muted">${timeline.length} nodes</span></div>
          <div class="timeline">
            ${timeline
              .map(
                (item) => `<div class="timeline-item">
                  <span class="timeline-dot ${item.kind}"></span>
                  <div>
                    <div class="timeline-title">${esc(item.title)}</div>
                    <div class="timeline-detail">${esc(item.detail)}</div>
                    <div class="timeline-time">${fmtDate(item.at)}</div>
                  </div>
                </div>`,
              )
              .join('')}
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div><div class="card-title">Task Card</div><div class="card-sub">Router 交给 Worker 的最小上下文</div></div>${stateBadge(ticket.state)}</div>
          <div class="code">${esc(ticket.summary)}</div>
          <div class="split-line"></div>
          <div class="meta-label">Acceptance</div>
          <div class="list" style="margin-top:6px">
            ${(ticket.acceptance || [])
              .map(
                (item) => `<div class="list-row" style="padding:5px 0"><span style="color:var(--green)">${icon('check')}</span><div class="list-main"><div class="list-title">${esc(item)}</div></div></div>`,
              )
              .join('')}
          </div>
          <div class="split-line"></div>
          <div class="meta-label">Scope</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px">
            ${(ticket.scope || []).map((item) => `<span class="badge badge-muted mono">${esc(item)}</span>`).join('') || '<span class="dim">待 Planner 补全</span>'}
          </div>
          <div class="split-line"></div>
          <div class="meta-label">Risk</div>
          <div style="margin-top:6px"><span class="badge ${ticket.risk === 'high' ? 'badge-red' : ticket.risk === 'low' ? 'badge-green' : 'badge-amber'}">${esc(ticket.risk)}</span></div>
        </section>
        <section class="card">
          <div class="card-header"><div><div class="card-title">Attempts & evidence</div><div class="card-sub">Worker 只写 Attempt，Verifier 只写证据</div></div><span class="badge badge-muted">${attempts.length}</span></div>
          ${attempts.length ? attempts.map(attemptBlock).join('') : '<div class="inline-empty">还没有 Attempt</div>'}
        </section>
      </div>
      <div class="stack">
        ${
          ticket.state === 'blocked' && caps.ticketAnswer
            ? `<div class="question-box">
                <div class="question-label">${icon('alert')} 需要人工回答</div>
                <div class="question-text">${esc(ticket.humanQuestion || '请补充继续执行所需的信息。')}</div>
                <textarea id="answer-${ticket.id}" placeholder="写清楚决策或补充验收条件…"></textarea>
                <div style="display:flex;justify-content:flex-end;margin-top:8px">
                  <button class="btn btn-primary btn-sm" data-action="submit-answer" data-id="${ticket.id}" type="button">提交回答并重新排队</button>
                </div>
              </div>`
            : ticket.state === 'blocked'
              ? `<div class="question-box">
                  <div class="question-label">${icon('alert')} 需要人工处理</div>
                  <div class="question-text">${esc(ticket.humanQuestion || 'Router 需要人工决策。')}</div>
                  <div class="card-sub" style="margin-top:10px;line-height:1.65">
                    项目模式下回答应写回 Issue，并由 Router 重新读取；控制台只提供
                    <span class="mono">router recover</span>。在仓库中运行
                    <span class="mono">node scripts/router.mjs recover --ticket ${ticket.number} --repo .</span>。
                  </div>
                </div>`
            : ticket.humanAnswer
              ? `<div class="card" style="border-color:rgba(34,197,94,.3)"><div class="card-title">人工回答</div><div class="code" style="margin-top:8px">${esc(ticket.humanAnswer)}</div></div>`
              : ''
        }
        <section class="card">
          <div class="card-header"><div><div class="card-title">路由理由</div><div class="card-sub">为什么这个 Ticket 会在这里</div></div></div>
          <div class="list">
            ${routeReasons
              .map(
                (reason) => `<div class="list-row">
                  <span style="color:${reason.ok ? 'var(--green)' : 'var(--red)'};margin-top:2px">${icon(reason.ok ? 'check' : 'x')}</span>
                  <div class="list-main"><div class="list-title">${esc(reason.label)}</div><div class="list-sub">${esc(reason.detail)}</div></div>
                </div>`,
              )
              .join('')}
          </div>
        </section>
        <section class="card">
          <div class="card-header"><div><div class="card-title">投递</div><div class="card-sub">Outbox 只负责送达，不改 Ticket 状态</div></div><span class="badge badge-muted">${deliveries.length}</span></div>
          ${
            deliveries.length
              ? `<div class="list">${deliveries
                  .map(
                    (delivery) => `<div class="list-row">
                      <div class="list-main">
                        <div class="list-title">${esc(delivery.kind)} → ${esc(delivery.target)}</div>
                        <div class="list-sub">${esc(delivery.channel)} · attempts ${delivery.attempts}/${delivery.maxAttempts}${delivery.lastError ? ` · ${esc(delivery.lastError)}` : ''}</div>
                      </div>
                      ${deliveryBadge(delivery.state)}
                      ${['failed', 'dead'].includes(delivery.state) ? `<button class="btn btn-sm" data-action="replay-delivery" data-id="${delivery.id}" type="button">重投</button>` : ''}
                    </div>`,
                  )
                  .join('')}</div>`
              : '<div class="inline-empty">还没有投递记录</div>'
          }
        </section>
        <section class="card">
          <div class="card-header"><div><div class="card-title">来源事件</div><div class="card-sub">Inbox 里的原始记录</div></div></div>
          ${
            event
              ? `<div class="meta-grid" style="grid-template-columns:1fr 1fr;margin-bottom:0">
                  <div><div class="meta-label">Kind</div><div class="meta-value">${esc(event.kind)}</div></div>
                  <div><div class="meta-label">Status</div><div style="margin-top:3px">${eventBadge(event.status)}</div></div>
                  <div><div class="meta-label">External ID</div><div class="meta-value">${esc(event.externalId)}</div></div>
                  <div><div class="meta-label">Received</div><div class="meta-value">${fmtDate(event.receivedAt)}</div></div>
                </div>
                <div class="code" style="margin-top:10px">${esc(event.body || 'no body')}</div>`
              : '<div class="inline-empty">找不到来源事件</div>'
          }
        </section>
      </div>
    </div>
  `;
}

function attemptBlock(attempt) {
  return `<div class="attempt">
    <div class="attempt-head">
      <span class="badge ${attempt.state === 'passed' ? 'badge-green' : attempt.state === 'failed' ? 'badge-red' : 'badge-blue'}">${esc(attempt.state)}</span>
      <span class="attempt-id">${esc(attempt.id)}</span>
      <span class="dim">${esc(attempt.workerName)}</span>
      <span class="dim" style="margin-left:auto">${duration(attempt.startedAt, attempt.finishedAt)}</span>
    </div>
    <div class="attempt-meta">Attempt ${attempt.number} · ${esc(attempt.phase)}${attempt.error ? ` · ${esc(attempt.error)}` : ''}</div>
    ${
      attempt.evidence?.length
        ? `<table class="evidence">
            <thead><tr><th>Gate</th><th>Command</th><th>Exit</th><th>Time</th><th>Log</th></tr></thead>
            <tbody>${attempt.evidence
              .map(
                (item) => `<tr>
                  <td>${esc(item.gate)}</td>
                  <td class="mono">${esc(item.command)}</td>
                  <td><span class="badge ${item.exitCode === 0 ? 'badge-green' : 'badge-red'}">${item.exitCode}</span></td>
                  <td class="mono">${item.durationMs}ms</td>
                  <td>
                    <div class="evidence-path">
                      <span class="mono dim">${esc(item.outputPath || item.evidencePath || '—')}</span>
                      <button class="btn btn-ghost btn-icon" data-action="copy" data-id="ev-${attempt.id}-${item.exitCode}-${encodeURIComponent(item.command)}" data-copy="${esc(item.outputPath || item.evidencePath || '')}" type="button" title="复制证据路径">${icon('copy')}</button>
                    </div>
                    ${item.stderrPath ? `<div class="mono dim evidence-subpath">${esc(item.stderrPath)}</div>` : ''}
                  </td>
                </tr>`,
              )
              .join('')}</tbody>
          </table>`
        : ''
    }
  </div>`;
}

function outboxView() {
  const data = state.data;
  const caps = data.capabilities || {};
  const filter = state.filters.outbox;
  const deliveries = data.deliveries
    .filter((delivery) => filter === 'all' || delivery.state === filter)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Outbox</h1>
        <p class="page-sub">投递队列，不是任务归档。消息会重试、失败、进入死信。</p>
      </div>
      <div class="page-actions">
        ${filterChips('outbox', [['all', 'All'], ['pending', 'Pending'], ['sent', 'Sent'], ['failed', 'Failed'], ['dead', 'Dead']])}
        ${caps.outboxFlush ? `<button class="btn btn-primary" data-action="flush-outbox" type="button">${icon('outbox')} Flush</button>` : ''}
      </div>
    </div>
    ${
      !caps.outbox
        ? `<div class="mode-banner">
            ${icon('outbox')}
            <div>
              <div class="mode-banner-title">Outbox 未启用</div>
              <div class="mode-banner-sub">在 .self-loop.json 中配置 outbox.adapters 后，Router 会把状态写回持久化队列。</div>
            </div>
          </div>`
        : caps.mode === 'project'
          ? `<div class="mode-banner">
              ${icon('outbox')}
              <div>
                <div class="mode-banner-title">Outbox 由 Router 入队，Flush 单独执行</div>
                <div class="mode-banner-sub">Tick 不阻塞网络。GitHub / Jira / Slack 投递会记录状态码、request id、重试次数与死信；同一 idempotency key 不会重复发送。</div>
              </div>
            </div>`
          : ''
    }
    <div class="kpi-grid kpi-grid-4">
      ${kpi('Delivered', data.deliveries.filter((d) => d.state === 'sent').length, '已送达', 'var(--green)', 'check')}
      ${kpi('Pending', data.deliveries.filter((d) => d.state === 'pending').length, '等待投递', 'var(--amber)', 'clock')}
      ${kpi('Failed', data.deliveries.filter((d) => d.state === 'failed').length, '可重试', 'var(--red)', 'alert')}
      ${kpi('Dead', data.deliveries.filter((d) => d.state === 'dead').length, '需要人工介入', 'var(--dim)', 'x')}
    </div>
    <section class="card">
      <div class="card-header"><div><div class="card-title">Delivery queue</div><div class="card-sub">每个 Ticket 可以产生多条消息</div></div><span class="badge badge-muted">${deliveries.length}</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Ticket</th><th>Channel</th><th>Target</th><th>Kind</th><th>State</th><th>Attempts</th><th>Last error</th><th></th></tr></thead>
          <tbody>
            ${deliveries
              .map(
                (delivery) => `<tr>
                  <td class="mono dim nowrap">${fmtDate(delivery.createdAt)}</td>
                  <td><span class="link" data-route="#/tickets/${delivery.ticketId}">#${delivery.ticketNumber}</span></td>
                  <td>${sourceBadge(delivery.channel)}</td>
                  <td class="mono">${esc(delivery.target)}</td>
                  <td>${esc(delivery.kind)}</td>
                  <td>${deliveryBadge(delivery.state)}</td>
                  <td class="mono">${delivery.attempts}/${delivery.maxAttempts}</td>
                  <td class="dim" style="max-width:220px">${esc(delivery.lastError || '—')}</td>
                  <td>${caps.outbox && ['failed', 'dead'].includes(delivery.state) ? `<button class="btn btn-sm" data-action="replay-delivery" data-id="${delivery.id}" type="button">${icon('refresh')} 重投</button>` : ''}</td>
                </tr>`,
              )
              .join('') || `<tr><td colspan="9" class="dim">${caps.mode === 'project' ? '没有投递记录。Router 会在 Ticket 到达 Review / Blocked / Failed / Done 时入队。' : '没有匹配的投递'}</td></tr>`}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function sourcesView() {
  const data = state.data;
  const caps = data.capabilities || {};
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Sources</h1>
        <p class="page-sub">连接器把外部事件归一化后写入 Inbox。Router 不直接读 Jira 或 GitHub。</p>
      </div>
      <div class="page-actions">
        ${caps.sourceWrite ? `<button class="btn btn-primary" data-action="add-source" type="button">${icon('plus')} 添加连接器</button>` : ''}
      </div>
    </div>
    <div class="source-grid">
      ${data.sources
        .map(
          (source) => `<article class="source-card ${source.status === 'paused' ? 'paused' : ''}">
            <div class="source-head">
              <div class="source-icon">${icon(source.kind === 'github' ? 'git' : source.kind === 'jira' ? 'tickets' : source.kind === 'cron' ? 'clock' : source.kind === 'im' ? 'message' : 'zap')}</div>
              <div style="min-width:0">
                <div class="source-name">${esc(source.name)}</div>
                <div class="source-kind">${esc(source.kind)} · ${esc(source.id)}</div>
              </div>
              <span style="margin-left:auto" class="badge ${source.status === 'paused' ? 'badge-amber' : source.status === 'degraded' ? 'badge-amber' : 'badge-green'}">${esc(source.status)}</span>
            </div>
            <div class="source-health">${esc(source.health || '—')}</div>
            <div class="source-meta">
              <div><div class="meta-label">Events</div><div class="meta-value">${source.eventCount || 0}</div></div>
              <div><div class="meta-label">Last event</div><div class="meta-value">${source.lastEventAt ? timeAgo(source.lastEventAt) : '—'}</div></div>
              <div><div class="meta-label">Config</div><div class="meta-value">${esc(source.config?.repo || source.config?.project || source.config?.path || source.config?.schedule || source.config?.channel || source.config?.note || 'default')}</div></div>
              <div><div class="meta-label">Auth</div><div class="meta-value">${esc(source.config?.auth || 'connector')}</div></div>
            </div>
            <div class="source-actions">
              ${caps.sourceWrite ? `<button class="btn btn-sm" data-action="toggle-source" data-id="${source.id}" type="button">${icon(source.status === 'paused' ? 'play' : 'pause')} ${source.status === 'paused' ? '恢复' : '暂停'}</button>` : ''}
              <span class="dim" style="font-size:10px">created ${fmtDate(source.createdAt)}</span>
            </div>
          </article>`,
        )
        .join('')}
    </div>
    <div class="card" style="margin-top:14px;border-color:rgba(245,158,11,.25);background:rgba(245,158,11,.05)">
      <div class="card-title">MVP 边界</div>
      <p class="card-sub" style="font-size:11.5px;line-height:1.65;margin:6px 0 0">
        ${
          caps.mode === 'project'
            ? '项目模式从真实 .loop 状态推导 Source。连接器配置仍由项目 .self-loop.json 和 Router CLI 管理，控制台只读。'
            : '这一版把连接器、Inbox、Router、Worker、Verifier、Outbox 串起来。GitHub webhook 验签已接入；Jira / Slack OAuth、外部 API 限流和出站写回还没接。'
        }
      </p>
    </div>
  `;
}

function workersView() {
  const data = state.data;
  const caps = data.capabilities || {};
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Workers</h1>
        <p class="page-sub">Router 接各种 Worker：Codex、Claude、Orca、CI。Worker 只执行一个 Task Card。</p>
      </div>
    </div>
    <div class="worker-grid">
      ${data.workers
        .map(
          (worker) => `<article class="worker-card ${worker.paused ? 'paused' : ''}">
            <div class="worker-head">
              <div class="worker-icon">${icon(worker.kind === 'codex' ? 'zap' : worker.kind === 'claude' ? 'message' : worker.kind === 'orca' ? 'git' : 'database')}</div>
              <div style="min-width:0">
                <div class="worker-name">${esc(worker.name)}</div>
                <div class="worker-kind">${esc(worker.kind)} · concurrency ${worker.concurrency || 1}</div>
              </div>
              <span style="margin-left:auto">${workerBadge(worker)}</span>
            </div>
            <div class="worker-health">${worker.currentTicketId ? `正在处理 ${esc(worker.currentTicketId)}` : worker.paused ? '暂停接单，不领取新 Ticket' : '空闲，等待 Router 派单'}</div>
            <div class="worker-meta">
              <div><div class="meta-label">Heartbeat</div><div class="meta-value">${timeAgo(worker.lastHeartbeat)}</div></div>
              <div><div class="meta-label">Capabilities</div><div class="meta-value">${esc((worker.capabilities || []).join(', ') || '—')}</div></div>
            </div>
            <div class="worker-actions">
              ${caps.workerWrite ? `<button class="btn btn-sm" data-action="toggle-worker" data-id="${worker.id}" type="button">${icon(worker.paused ? 'play' : 'pause')} ${worker.paused ? '恢复接单' : '暂停接单'}</button>` : '<span class="dim" style="font-size:10px">由 Router 调度 · 只读</span>'}
            </div>
          </article>`,
        )
        .join('')}
    </div>
    <section class="card" style="margin-top:14px">
      <div class="card-header"><div><div class="card-title">Worker 协议</div><div class="card-sub">与具体 agent runtime 解耦</div></div><span class="badge badge-muted">v0</span></div>
      <div class="flow-strip" style="margin-bottom:0">
        <div class="flow-step"><div class="flow-step-label">1 · Register</div><div class="flow-step-value" style="font-size:13px">注册能力</div><div class="flow-step-note">kind / concurrency</div></div>
        <div class="flow-arrow">${icon('chevron')}</div>
        <div class="flow-step"><div class="flow-step-label">2 · Heartbeat</div><div class="flow-step-value" style="font-size:13px">持续心跳</div><div class="flow-step-note">lease 依赖它</div></div>
        <div class="flow-arrow">${icon('chevron')}</div>
        <div class="flow-step"><div class="flow-step-label">3 · Claim</div><div class="flow-step-value" style="font-size:13px">领取一个</div><div class="flow-step-note">一次一个 Task Card</div></div>
        <div class="flow-arrow">${icon('chevron')}</div>
        <div class="flow-step"><div class="flow-step-label">4 · Report</div><div class="flow-step-value" style="font-size:13px">提交结果</div><div class="flow-step-note">Attempt + PR</div></div>
      </div>
    </section>
  `;
}

function projectsView() {
  const data = state.data;
  const caps = data.capabilities || {};
  const projects = data.projects || { currentId: null, items: [] };
  const items = projects.items || [];
  const live = items.filter((project) => project.state === 'ready').length;
  const tickets = items.reduce((sum, project) => sum + Number(project.tickets || 0), 0);
  const blocked = items.reduce((sum, project) => sum + Number(project.blocked || 0), 0);
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Projects</h1>
        <p class="page-sub">一个控制面统一管理多个仓库。切换只改变当前读取的 .loop 状态，不复制 Ticket。</p>
      </div>
      <div class="page-actions">
        <button class="btn" data-action="refresh" type="button">${icon('refresh')} 刷新</button>
        ${caps.projectAdd ? `<button class="btn btn-primary" data-action="add-project" type="button">${icon('plus')} 添加项目</button>` : ''}
      </div>
    </div>
    <div class="kpi-grid kpi-grid-4">
      ${kpi('Registered', items.length, '持久化注册表', 'var(--cyan)', 'projects')}
      ${kpi('Live state', live, '可读取 .loop', 'var(--green)', 'database')}
      ${kpi('Tickets', tickets, '所有项目合计', 'var(--blue)', 'tickets')}
      ${kpi('Blocked', blocked, '需要人工介入', blocked ? 'var(--red)' : 'var(--dim)', 'alert')}
    </div>
    ${
      items.length
        ? `<div class="project-grid">
            ${items
              .map(
                (project) => `<article class="project-card ${project.current ? 'current' : ''}">
                  <div class="project-card-head">
                    <div class="project-card-icon">${icon('projects')}</div>
                    <div style="min-width:0">
                      <div class="project-card-name">${esc(project.name)}</div>
                      <div class="project-card-repo">${esc(project.repo || 'local repository')}</div>
                    </div>
                    <span class="badge ${project.state === 'ready' ? 'badge-green' : project.state === 'error' ? 'badge-red' : 'badge-amber'}">${esc(project.state)}</span>
                  </div>
                  <div class="project-path mono">${esc(project.path)}</div>
                  <div class="project-stats">
                    <div><div class="meta-label">Tickets</div><div class="meta-value">${project.tickets || 0}</div></div>
                    <div><div class="meta-label">Active</div><div class="meta-value">${project.activeTickets || 0}</div></div>
                    <div><div class="meta-label">Blocked</div><div class="meta-value">${project.blocked || 0}</div></div>
                    <div><div class="meta-label">Updated</div><div class="meta-value">${project.updatedAt ? timeAgo(project.updatedAt) : '—'}</div></div>
                  </div>
                  <div class="project-runtime">
                    <span>${icon('zap')} ${esc(project.executor?.adapter || 'command')}</span>
                    <span>${project.maxConcurrent || 1} slots</span>
                    ${project.lastSelectedAt ? `<span>selected ${timeAgo(project.lastSelectedAt)}</span>` : ''}
                  </div>
                  ${project.error ? `<div class="project-error">${esc(project.error)}</div>` : ''}
                  <div class="project-card-actions">
                    ${
                      project.current
                        ? '<span class="badge badge-cyan">current</span>'
                        : `<button class="btn btn-primary btn-sm" data-action="switch-project" data-id="${project.id}" type="button">${icon('chevron')} 切换</button>`
                    }
                    ${
                      caps.projectRemove
                        ? `<button class="btn btn-danger btn-sm" data-action="remove-project" data-id="${project.id}" type="button">${icon('x')} 移除</button>`
                        : ''
                    }
                  </div>
                </article>`,
              )
              .join('')}
          </div>`
        : `<div class="mode-banner">
            ${icon('projects')}
            <div>
              <div class="mode-banner-title">还没有注册项目</div>
              <div class="mode-banner-sub">
                当前是 demo 模式。运行 <code>npm run serve:project -- &lt;repo&gt;</code> 注册第一个项目；
                注册后重启会直接进入统一 project 模式，并可在这里继续添加仓库。
              </div>
            </div>
          </div>`
    }
    <section class="card" style="margin-top:14px">
      <div class="card-header">
        <div><div class="card-title">注册表边界</div><div class="card-sub">${caps.mode === 'project' ? '本地持久化 · 写操作需要 token' : 'demo 模式不写注册表'}</div></div>
        <span class="badge badge-muted">projects.json</span>
      </div>
      <div class="list">
        ${[
          ['一个地址', 'Projects 页面和侧栏切换器共享同一个控制面。'],
          ['仓库白名单', '只接受启动时注册或经 token 验证后添加的真实仓库。'],
          ['无第二份状态', `每个项目继续读取自己的 .loop/state.json；写入委托给 Router CLI。`],
          ['重启保留', '项目注册表与最后选择的项目会持久化，不需要重复传 --repo。'],
        ]
          .map(
            ([title, detail]) => `<div class="list-row"><span style="color:var(--cyan);margin-top:2px">${icon('shield')}</span><div class="list-main"><div class="list-title">${title}</div><div class="list-sub">${detail}</div></div></div>`,
          )
          .join('')}
      </div>
    </section>
  `;
}

function policyView() {
  const data = state.data;
  const caps = data.capabilities || {};
  const config = data.config;
  const readOnly = caps.configWrite ? '' : 'disabled';
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Policy</h1>
        <p class="page-sub">确定性控制面。LLM 可以建议，但不能授权、不能绕过门禁。</p>
      </div>
      <div class="page-actions">
        ${caps.pause ? `<button class="btn" data-action="toggle-pause" type="button">${icon(data.meta.paused ? 'play' : 'pause')} ${data.meta.paused ? '恢复 Router' : '暂停 Router'}</button>` : ''}
      </div>
    </div>
    <div class="grid grid-1-1">
      <section class="card">
        <div class="card-header"><div><div class="card-title">运行参数</div><div class="card-sub">${caps.configWrite ? '保存后立即生效' : '来自项目配置 · 只读'}</div></div><span class="badge badge-muted">config</span></div>
        <div class="form-grid">
          <div class="field"><label for="cfg-maxConcurrent">maxConcurrent</label><input class="input" id="cfg-maxConcurrent" type="number" min="1" max="8" value="${config.maxConcurrent}" ${readOnly}></div>
          <div class="field"><label for="cfg-maxAttempts">maxAttempts</label><input class="input" id="cfg-maxAttempts" type="number" min="1" max="5" value="${config.maxAttempts}" ${readOnly}></div>
          <div class="field"><label for="cfg-leaseMinutes">leaseMinutes</label><input class="input" id="cfg-leaseMinutes" type="number" min="1" max="240" value="${config.leaseMinutes}" ${readOnly}></div>
          <div class="field"><label for="cfg-tickMs">tickMs</label><input class="input" id="cfg-tickMs" type="number" min="500" max="60000" value="${config.tickMs}" ${readOnly}></div>
          <div class="field"><label for="cfg-workMs">workMs</label><input class="input" id="cfg-workMs" type="number" min="0" max="120000" value="${config.workMs}" ${readOnly}></div>
          <div class="field"><label for="cfg-verifyMs">verifyMs</label><input class="input" id="cfg-verifyMs" type="number" min="0" max="120000" value="${config.verifyMs}" ${readOnly}></div>
        </div>
        ${
          caps.configWrite
            ? `<div class="modal-actions" style="justify-content:flex-start">
                <button class="btn btn-primary" data-action="save-config" type="button">${icon('check')} 保存参数</button>
              </div>`
            : `<p class="card-sub" style="font-size:11px;line-height:1.6;margin-top:10px">项目模式只读；参数来自 .self-loop.json 与 Router 配置。tickMs / workMs / verifyMs 为 0 表示该项目不内置定时循环，由 cron、watchdog 或控制台 Run tick 驱动。</p>`
        }
      </section>
      <section class="card">
        <div class="card-header"><div><div class="card-title">硬边界</div><div class="card-sub">不可由配置绕过</div></div><span class="badge badge-red">invariants</span></div>
        <div class="list">
          ${[
            ['永不合并 PR', 'loop 只开 PR，合并永远由人完成。'],
            ['永不 push 默认分支', 'Worker 只推自己的分支。'],
            ['Router 唯一写 Ticket 状态', 'Worker 与 Verifier 只写 Attempt 证据。'],
            ['Inbox 事件不授权', '事件只唤醒 Router，不能绕过标签、lease、验收。'],
            ['验证独立', 'Verifier 在干净工作树复跑门禁，不信 Worker 自报。'],
            ['只有 retro 写 memory', '人工干预与投递不写项目记忆。'],
          ]
            .map(
              ([title, detail]) => `<div class="list-row"><span style="color:var(--green);margin-top:2px">${icon('shield')}</span><div class="list-main"><div class="list-title">${title}</div><div class="list-sub">${detail}</div></div></div>`,
            )
            .join('')}
        </div>
      </section>
    </div>
    <section class="card" style="margin-top:14px">
      <div class="card-header"><div><div class="card-title">门禁</div><div class="card-sub">每个 Ticket 到达 Review 前必须通过</div></div><span class="badge badge-muted">gates</span></div>
      <div class="source-meta" style="grid-template-columns:repeat(4,minmax(0,1fr));border-top:0;padding-top:0">
        <div><div class="meta-label">Test</div><div class="meta-value">npm test</div></div>
        <div><div class="meta-label">Node</div><div class="meta-value">node --test</div></div>
        <div><div class="meta-label">Diff</div><div class="meta-value">git diff --check</div></div>
        <div><div class="meta-label">Branch</div><div class="meta-value">no default push</div></div>
      </div>
    </section>
    <section class="card" style="margin-top:14px">
      <div class="card-header">
        <div><div class="card-title">本地写权限</div><div class="card-sub">HttpOnly 会话 + Bearer token + Origin 校验</div></div>
        <span class="badge badge-green">${icon('shield')} protected</span>
      </div>
      <div class="meta-grid" style="grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:0">
        <div class="meta-box"><div class="meta-label">Session</div><div class="meta-value">SameSite=Strict</div><div class="meta-label" style="margin-top:4px">浏览器自动携带</div></div>
        <div class="meta-box"><div class="meta-label">CLI</div><div class="meta-value">Authorization: Bearer</div><div class="meta-label" style="margin-top:4px">token 文件仅当前用户可读</div></div>
        <div class="meta-box"><div class="meta-label">Cross-site</div><div class="meta-value">403</div><div class="meta-label" style="margin-top:4px">读接口与 SSE 同样拒绝</div></div>
      </div>
      <div class="modal-actions" style="justify-content:flex-start;margin-top:12px">
        <button class="btn btn-danger" data-action="rotate-token" type="button">${icon('refresh')} 轮换 write token</button>
        <span class="dim" style="font-size:10.5px">旧会话会立即失效；token 文件不会被 URL 或读接口暴露。</span>
      </div>
    </section>
    <section class="card" style="margin-top:14px">
      <div class="card-header"><div><div class="card-title">审计日志</div><div class="card-sub">所有人工干预与 Router 决策</div></div><span class="badge badge-muted">${data.audit.length}</span></div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Detail</th><th>Ticket</th></tr></thead>
          <tbody>
            ${data.audit
              .slice(0, 20)
              .map(
                (entry) => `<tr>
                  <td class="mono dim nowrap">${fmtDate(entry.at)}</td>
                  <td class="mono">${esc(entry.actor)}</td>
                  <td class="mono">${esc(entry.action)}</td>
                  <td>${esc(entry.detail)}</td>
                  <td>${entry.ticketNumber ? `<span class="link" data-route="#/tickets/${entry.ticketId}">#${entry.ticketNumber}</span>` : '<span class="dim">—</span>'}</td>
                </tr>`,
              )
              .join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function render() {
  if (!state.data || state.modal) return;
  const previousRoute = state.lastRoute;
  const scrollY = window.scrollY;
  app.className = '';
  app.innerHTML = shell();
  state.lastRoute = location.hash || '#/overview';
  if (previousRoute === state.lastRoute) window.scrollTo(0, scrollY);
  document.title = `${pageTitle(state.route)} · self-loop console`;
}

function toast(message, kind = 'success') {
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.textContent = message;
  toastRoot.appendChild(item);
  setTimeout(() => {
    item.style.opacity = '0';
    item.style.transform = 'translateY(4px)';
    setTimeout(() => item.remove(), 180);
  }, 3200);
}

async function api(path, options = {}) {
  const { headers = {}, ...rest } = options;
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...rest,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function refresh() {
  state.data = await api('/api/state');
  render();
}

function isEditing() {
  return Boolean(
    document.activeElement &&
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName),
  );
}

function connectStream() {
  if (state.stream) state.stream.close();
  const stream = new EventSource('/api/stream');
  state.stream = stream;
  stream.addEventListener('state', (event) => {
    try {
      state.data = JSON.parse(event.data);
      if (!state.modal && !isEditing()) render();
    } catch {}
  });
  stream.onerror = () => {
    stream.close();
    setTimeout(connectStream, 3000);
  };
}

function closeModal() {
  state.modal = null;
  modalRoot.innerHTML = '';
  render();
}

function openEventModal() {
  const sources = state.data.sources.filter((source) => source.status !== 'paused');
  if (!sources.length) {
    toast('没有可用连接器，请先添加或恢复一个', 'warn');
    return;
  }
  state.modal = 'event';
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-backdrop="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <div>
            <div class="modal-title" id="modal-title">注入一个事件</div>
            <div class="modal-sub">模拟连接器收到 webhook。Router 会在下一次 tick 消费它。</div>
          </div>
          <button class="btn btn-ghost btn-icon" data-action="close-modal" type="button" aria-label="关闭">${icon('x')}</button>
        </div>
        <form id="event-form">
          <div class="form-grid">
            <div class="field">
              <label for="ev-source">来源</label>
              <select id="ev-source">${sources.map((source) => `<option value="${source.id}">${esc(source.name)} · ${source.kind}</option>`).join('')}</select>
            </div>
            <div class="field">
              <label for="ev-kind">事件类型</label>
              <select id="ev-kind">
                <option value="issue.opened">issue.opened</option>
                <option value="issue.labeled">issue.labeled</option>
                <option value="jira.issue.created">jira.issue.created</option>
                <option value="task.created">task.created</option>
                <option value="comment.created">comment.created</option>
              </select>
            </div>
            <div class="field full">
              <label for="ev-title">标题</label>
              <input class="input" id="ev-title" required value="Console: Worker 心跳面板">
            </div>
            <div class="field full">
              <label for="ev-body">正文</label>
              <textarea id="ev-body">在 Workers 页面展示心跳时间、当前 Ticket 和暂停状态。</textarea>
            </div>
            <div class="field">
              <label for="ev-priority">优先级</label>
              <select id="ev-priority">
                <option value="normal">normal</option>
                <option value="high">high</option>
                <option value="urgent">urgent</option>
                <option value="low">low</option>
              </select>
            </div>
            <div class="field">
              <label for="ev-labels">标签</label>
              <input class="input" id="ev-labels" value="console,worker">
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn" data-action="close-modal" type="button">取消</button>
            <button class="btn btn-primary" type="submit">${icon('plus')} 注入事件</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('event-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      sourceId: document.getElementById('ev-source').value,
      kind: document.getElementById('ev-kind').value,
      title: document.getElementById('ev-title').value.trim(),
      body: document.getElementById('ev-body').value.trim(),
      priority: document.getElementById('ev-priority').value,
      labels: document
        .getElementById('ev-labels')
        .value.split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      externalId: `manual-${Date.now()}`,
    };
    try {
      await api('/api/events', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await refresh();
      toast('事件已进入 Inbox');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  setTimeout(() => document.getElementById('ev-title')?.focus(), 40);
}

function openSourceModal() {
  state.modal = 'source';
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-backdrop="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <div>
            <div class="modal-title" id="modal-title">添加连接器</div>
            <div class="modal-sub">GitHub webhook 已支持验签；其他连接器的 OAuth 与出站调用仍在后续版本。</div>
          </div>
          <button class="btn btn-ghost btn-icon" data-action="close-modal" type="button" aria-label="关闭">${icon('x')}</button>
        </div>
        <form id="source-form">
          <div class="form-grid">
            <div class="field">
              <label for="src-name">名称</label>
              <input class="input" id="src-name" required value="Linear · LOOP">
            </div>
            <div class="field">
              <label for="src-kind">类型</label>
              <select id="src-kind">
                <option value="github">github</option>
                <option value="jira">jira</option>
                <option value="webhook">webhook</option>
                <option value="cron">cron</option>
                <option value="im">im</option>
              </select>
            </div>
            <div class="field full">
              <label for="src-note">配置备注</label>
              <input class="input" id="src-note" value="team=LOOP · labels=agent-ready">
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn" data-action="close-modal" type="button">取消</button>
            <button class="btn btn-primary" type="submit">${icon('plus')} 添加</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('source-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const payload = {
      name: document.getElementById('src-name').value.trim(),
      kind: document.getElementById('src-kind').value,
      config: { note: document.getElementById('src-note').value.trim() },
    };
    try {
      await api('/api/sources', { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await refresh();
      toast('连接器已添加');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  setTimeout(() => document.getElementById('src-name')?.focus(), 40);
}

function openProjectModal() {
  state.modal = 'project';
  modalRoot.innerHTML = `
    <div class="modal-backdrop" data-backdrop="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal-head">
          <div>
            <div class="modal-title" id="modal-title">添加本地项目</div>
            <div class="modal-sub">注册一个 Git 仓库或已初始化的 self-loop 项目。写入会记录到控制台审计。</div>
          </div>
          <button class="btn btn-ghost btn-icon" data-action="close-modal" type="button" aria-label="关闭">${icon('x')}</button>
        </div>
        <form id="project-form">
          <div class="form-grid">
            <div class="field full">
              <label for="prj-path">仓库路径</label>
              <input class="input mono" id="prj-path" required placeholder="/absolute/path/to/project">
            </div>
            <div class="field full">
              <label for="prj-name">显示名称（可选）</label>
              <input class="input" id="prj-name" placeholder="默认使用目录名或 GitHub 仓库名">
            </div>
          </div>
          <div class="mode-banner" style="margin:4px 0 0">
            ${icon('shield')}
            <div>
              <div class="mode-banner-title">只接受本地真实路径</div>
              <div class="mode-banner-sub">项目必须是 Git 仓库，或包含 <code>.self-loop.json</code> / <code>.loop</code>。控制台不会接收任意远程 URL。</div>
            </div>
          </div>
          <div class="modal-actions">
            <button class="btn" data-action="close-modal" type="button">取消</button>
            <button class="btn btn-primary" type="submit">${icon('plus')} 注册并切换</button>
          </div>
        </form>
      </div>
    </div>
  `;
  document.getElementById('project-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          path: document.getElementById('prj-path').value.trim(),
          name: document.getElementById('prj-name').value.trim(),
        }),
      });
      closeModal();
      location.hash = '#/projects';
      await refresh();
      toast('项目已注册并切换');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  setTimeout(() => document.getElementById('prj-path')?.focus(), 40);
}

async function handleAction(action, id) {
  try {
    if (action === 'toggle-pause') {
      await api('/api/config', {
        method: 'PATCH',
        body: JSON.stringify({ paused: !state.data.meta.paused }),
      });
      await refresh();
      toast(state.data.meta.paused ? 'Router 已暂停' : 'Router 已恢复');
      return;
    }
    if (action === 'tick') {
      await api('/api/tick', { method: 'POST' });
      await refresh();
      toast('Router tick 完成');
      return;
    }
    if (action === 'rotate-token') {
      if (!window.confirm('轮换 write token？所有旧会话和 Bearer token 会立即失效。')) return;
      await api('/api/auth/rotate', { method: 'POST' });
      await refresh();
      toast('write token 已轮换，当前浏览器已换用新会话');
      return;
    }
    if (action === 'refresh') {
      await refresh();
      toast('状态已刷新');
      return;
    }
    if (action === 'inject-event') return openEventModal();
    if (action === 'add-source') return openSourceModal();
    if (action === 'add-project') return openProjectModal();
    if (action === 'switch-project') {
      await api(`/api/projects/${encodeURIComponent(id)}/select`, { method: 'POST' });
      location.hash = '#/overview';
      await refresh();
      toast('已切换目标项目');
      return;
    }
    if (action === 'remove-project') {
      if (!window.confirm('从控制面移除这个项目？不会删除仓库或 .loop 数据。')) return;
      await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await refresh();
      toast('项目已从注册表移除', 'warn');
      return;
    }
    if (action === 'flush-outbox') {
      const result = await api('/api/outbox/flush', { method: 'POST' });
      await refresh();
      toast(result.detail || 'Outbox 已投递');
      return;
    }
    if (action === 'close-modal') return closeModal();
    if (action === 'focus-answer') {
      const element = document.getElementById(`answer-${id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.focus();
      return;
    }
    if (action === 'submit-answer') {
      const answer = document.getElementById(`answer-${id}`)?.value || '';
      await api(`/api/tickets/${id}/answer`, {
        method: 'POST',
        body: JSON.stringify({ answer }),
      });
      await refresh();
      toast('回答已提交，Ticket 重新排队');
      return;
    }
    if (action === 'retry') {
      await api(`/api/tickets/${id}/retry`, { method: 'POST' });
      await refresh();
      toast('Ticket 已重新排队');
      return;
    }
    if (action === 'cancel') {
      if (!window.confirm('取消这个 Ticket？运行中的 Attempt 会终止。')) return;
      await api(`/api/tickets/${id}/cancel`, { method: 'POST' });
      await refresh();
      toast('Ticket 已取消', 'warn');
      return;
    }
    if (action === 'approve') {
      await api(`/api/tickets/${id}/approve`, { method: 'POST' });
      await refresh();
      toast('人工验收通过；PR 未合并');
      return;
    }
    if (action === 'replay-delivery') {
      await api(`/api/outbox/${id}/replay`, { method: 'POST' });
      await refresh();
      toast('投递已重新排队');
      return;
    }
    if (action === 'toggle-source') {
      await api(`/api/sources/${id}/toggle`, { method: 'POST' });
      await refresh();
      toast('连接器状态已更新');
      return;
    }
    if (action === 'toggle-worker') {
      await api(`/api/workers/${id}/toggle`, { method: 'POST' });
      await refresh();
      toast('Worker 状态已更新');
      return;
    }
    if (action === 'save-config') {
      const patch = {
        maxConcurrent: Number(document.getElementById('cfg-maxConcurrent').value),
        maxAttempts: Number(document.getElementById('cfg-maxAttempts').value),
        leaseMinutes: Number(document.getElementById('cfg-leaseMinutes').value),
        tickMs: Number(document.getElementById('cfg-tickMs').value),
        workMs: Number(document.getElementById('cfg-workMs').value),
        verifyMs: Number(document.getElementById('cfg-verifyMs').value),
      };
      await api('/api/config', { method: 'PATCH', body: JSON.stringify(patch) });
      await refresh();
      toast('运行参数已保存');
      return;
    }
    if (action === 'copy') {
      const value = document.querySelector(`[data-copy-id="${id}"]`)?.dataset.copy;
      if (value) {
        await navigator.clipboard.writeText(value);
        toast('已复制');
      }
      return;
    }
    if (action === 'focus-tickets') {
      state.filters.tickets = id.filter || 'all';
      if (location.hash === '#/tickets') render();
      else location.hash = '#/tickets';
      return;
    }
    if (action === 'filter-inbox' || action === 'filter-outbox' || action === 'filter-tickets') {
      const group = action.replace('filter-', '');
      state.filters[group] = id.filter;
      render();
      return;
    }
    if (action === 'reload') {
      location.reload();
    }
  } catch (error) {
    toast(error.message, 'error');
  }
}

document.addEventListener('click', (event) => {
  if (event.target.dataset.backdrop === 'true') {
    closeModal();
    return;
  }
  const routeElement = event.target.closest('[data-route]');
  if (routeElement) {
    event.preventDefault();
    location.hash = routeElement.dataset.route;
    return;
  }
  const actionElement = event.target.closest('[data-action]');
  if (!actionElement) return;
  event.preventDefault();
  const action = actionElement.dataset.action;
  const id = actionElement.dataset;
  if (action === 'focus-tickets') {
    handleAction(action, { filter: id.filter });
    return;
  }
  if (action.startsWith('filter-')) {
    handleAction(action, { filter: id.filter });
    return;
  }
  handleAction(action, id.id || null);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.modal) closeModal();
});

document.addEventListener('change', async (event) => {
  if (!event.target.matches('[data-project-select]')) return;
  try {
    await api('/api/projects/select', {
      method: 'POST',
      body: JSON.stringify({ id: event.target.value }),
    });
    location.hash = '#/overview';
    await refresh();
    toast('已切换目标项目');
  } catch (error) {
    toast(error.message, 'error');
    await refresh();
  }
});

window.addEventListener('hashchange', () => {
  state.route = parseRoute();
  window.scrollTo(0, 0);
  render();
});

async function boot() {
  try {
    state.data = await api('/api/state');
    if (!location.hash) history.replaceState(null, '', '#/overview');
    state.route = parseRoute();
    render();
    connectStream();
  } catch (error) {
    app.className = 'app-loading';
    app.innerHTML = `<div class="boot"><p>无法连接 Router</p><p class="dim" style="font-size:11px">${esc(error.message)}</p><button class="btn" data-action="reload" type="button">重试</button></div>`;
  }
}

boot();
