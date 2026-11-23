import { createHmac, timingSafeEqual } from 'node:crypto';

export const SLACK_MAX_SKEW_SECONDS = 300;

function safeEqual(left, right) {
  const actual = Buffer.from(String(left || ''));
  const expected = Buffer.from(String(right || ''));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function verifySlackSignature(
  secret,
  rawBody,
  timestamp,
  signature,
  now = Date.now(),
) {
  if (!secret || !signature || !timestamp) return false;
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) return false;
  if (Math.abs(Math.floor(now / 1000) - seconds) > SLACK_MAX_SKEW_SECONDS) return false;
  const expected = `v0=${createHmac('sha256', secret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`;
  return safeEqual(signature, expected);
}

export function parseSlackBody(rawBody, contentType = '') {
  if (String(contentType).includes('application/x-www-form-urlencoded')) {
    return { form: Object.fromEntries(new URLSearchParams(rawBody)) };
  }
  try {
    return { json: JSON.parse(rawBody) };
  } catch {
    throw Object.assign(new Error('invalid Slack payload'), { statusCode: 400 });
  }
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function stripSlackMentions(text) {
  return String(text || '')
    .replace(/<@[A-Z0-9]+>/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function acceptanceFromText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const values = [];
  let inSection = false;
  for (const line of lines) {
    if (/^\s*(acceptance|验收)( criteria)?\s*:?\s*$/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s*#{1,6}\s+/.test(line)) inSection = false;
    const item = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/);
    if (item) values.push(item[1].trim());
  }
  return [...new Set(values.filter(Boolean))];
}

function slashTask(text) {
  const [head, tail = ''] = String(text || '').split('|');
  let title = head.trim();
  if (!title) title = 'Slack /loop task';
  const acceptance = tail
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    title: title.slice(0, 160),
    body: String(text || '').trim(),
    acceptance,
  };
}

export function normalizeSlackEvent(payload, {
  respondToMessages = false,
  allowedChannels = [],
} = {}) {
  if (payload?.type === 'url_verification') {
    return {
      challenge: String(payload.challenge || ''),
      eventInput: null,
      ignoredReason: null,
    };
  }

  if (payload?.type !== 'event_callback' || !payload.event) {
    return {
      challenge: null,
      eventInput: null,
      ignoredReason: `不支持的 Slack payload：${payload?.type || 'unknown'}`,
    };
  }

  const event = payload.event;
  const channel = String(event.channel || '');
  const allowed = new Set((allowedChannels || []).map(String));
  if (allowed.size && !allowed.has(channel)) {
    return {
      challenge: null,
      eventInput: null,
      ignoredReason: `Slack channel ${channel || 'unknown'} is not allowed`,
    };
  }
  if (event.bot_id || ['bot_message', 'message_changed', 'message_deleted'].includes(event.subtype)) {
    return { challenge: null, eventInput: null, ignoredReason: 'ignored bot or message mutation' };
  }
  if (!['app_mention', 'message'].includes(event.type)) {
    return {
      challenge: null,
      eventInput: null,
      ignoredReason: `不支持的 Slack event：${event.type || 'unknown'}`,
    };
  }
  if (event.type === 'message' && !respondToMessages && event.channel_type !== 'im') {
    return { challenge: null, eventInput: null, ignoredReason: 'plain channel messages are disabled' };
  }

  const text = stripSlackMentions(event.text);
  if (!text) {
    return { challenge: null, eventInput: null, ignoredReason: 'Slack message is empty' };
  }
  const ts = String(event.ts || payload.event_time || '');
  if (!ts) {
    return { challenge: null, eventInput: null, ignoredReason: 'Slack event has no timestamp' };
  }
  const team = String(payload.team_id || payload.team || '');
  const externalId = `slack:${team}:${channel}:${ts}`;
  const title = firstLine(text).slice(0, 160) || 'Slack message';
  const threadTs = String(event.thread_ts || event.ts || '');
  return {
    challenge: null,
    ignoredReason: null,
    eventInput: {
      kind: 'task.created',
      title,
      body: text,
      actor: String(event.user || payload.authorizations?.[0]?.user_id || 'slack'),
      externalId,
      dedupeKey: externalId,
      priority: 'normal',
      labels: ['slack'],
      acceptance: acceptanceFromText(text),
      scope: channel ? [`slack:${channel}`] : [],
      risk: 'medium',
      connector: {
        channel,
        threadTs,
        team,
        eventTs: String(event.ts || ''),
      },
    },
  };
}

export function normalizeSlackCommand(form = {}, { allowedChannels = [] } = {}) {
  const command = String(form.command || '').trim();
  if (command !== '/loop') {
    return {
      ignoredReason: `不支持的 Slack command：${command || 'unknown'}`,
      eventInput: null,
      acknowledgement: '只支持 /loop <任务标题> | <验收项; 验收项>',
    };
  }
  const channel = String(form.channel_id || '');
  const allowed = new Set((allowedChannels || []).map(String));
  if (allowed.size && !allowed.has(channel)) {
    return {
      ignoredReason: `Slack channel ${channel || 'unknown'} is not allowed`,
      eventInput: null,
      acknowledgement: '这个频道没有启用 /loop。',
    };
  }
  const text = String(form.text || '').trim();
  if (!text) {
    return {
      ignoredReason: 'Slack /loop requires task text',
      eventInput: null,
      acknowledgement: '用法：/loop <任务标题> | <验收项; 验收项>',
    };
  }
  const task = slashTask(text);
  const team = String(form.team_id || '');
  const externalId = `slack:slash:${team}:${channel}:${form.trigger_id || form.ts || Date.now()}`;
  return {
    ignoredReason: null,
    eventInput: {
      kind: 'task.created',
      title: task.title,
      body: task.body,
      actor: String(form.user_id || 'slack'),
      externalId,
      dedupeKey: externalId,
      priority: 'normal',
      labels: ['slack', 'slash-command'],
      acceptance: task.acceptance,
      scope: channel ? [`slack:${channel}`] : [],
      risk: 'medium',
      connector: {
        channel,
        threadTs: String(form.thread_ts || ''),
        team,
        triggerId: String(form.trigger_id || ''),
        responseUrl: String(form.response_url || ''),
      },
    },
    acknowledgement: `已收到 #${task.title}`,
  };
}
