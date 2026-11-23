import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export const JIRA_CURSOR_VERSION = 1;

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJsonPrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {}
  renameSync(temporary, file);
  try {
    chmodSync(file, 0o600);
  } catch {}
}

export function jiraCursorPath(outDir) {
  return join(outDir, 'connectors', 'jira.json');
}

export function emptyJiraCursor() {
  return {
    version: JIRA_CURSOR_VERSION,
    updatedAt: null,
    lastSyncAt: null,
    status: 'idle',
    lastError: null,
    issues: {},
  };
}

export function loadJiraCursor(outDir) {
  const parsed = readJson(jiraCursorPath(outDir), emptyJiraCursor());
  return {
    ...emptyJiraCursor(),
    ...parsed,
    issues: parsed?.issues && typeof parsed.issues === 'object' && !Array.isArray(parsed.issues)
      ? parsed.issues
      : {},
  };
}

function valueAt(object, path) {
  if (!path) return undefined;
  return String(path)
    .split('.')
    .filter(Boolean)
    .reduce((current, key) => current?.[key], object);
}

function plainText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (Array.isArray(value.content)) return value.content.map(plainText).filter(Boolean).join(' ');
    if (Array.isArray(value.items)) return value.items.map(plainText).filter(Boolean).join(' ');
  }
  return String(value);
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean);
  const text = plainText(value).trim();
  return text ? [text] : [];
}

function acceptanceFromBody(body) {
  const values = [];
  let inSection = false;
  for (const line of String(body || '').split(/\r?\n/)) {
    if (/^\s*#{1,6}\s+.*(acceptance|acceptance criteria|验收)/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^\s*#{1,6}\s+/.test(line)) inSection = false;
    const item = line.match(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/);
    if (item) values.push(item[1].trim());
  }
  return [...new Set(values.filter(Boolean))];
}

function jqlDate(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

function jqlString(value) {
  return `"${String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

export function buildJiraJql(config, cursor, now = Date.now()) {
  const clauses = [];
  const base = String(config.jql || '').trim()
    || (config.project ? `project = ${jqlString(config.project)}` : '');
  if (base) clauses.push(`(${base})`);
  const since = cursor.updatedAt
    ? Date.parse(cursor.updatedAt) - 60_000
    : now - Number(config.initialLookbackMinutes || 1440) * 60_000;
  clauses.push(`updated >= ${jqlString(jqlDate(since))}`);
  return `${clauses.join(' AND ')} ORDER BY updated ASC`;
}

function mappedIssue(issue, config, previous, now) {
  const fields = issue.fields || {};
  const key = String(issue.key || issue.id || '');
  const updated = String(fields.updated || issue.updated || new Date(now).toISOString());
  const status = plainText(valueAt(fields, config.fieldMap.status)) || 'unknown';
  const title = plainText(valueAt(fields, config.fieldMap.title)) || key;
  const body = plainText(valueAt(fields, config.fieldMap.body));
  const acceptanceValue = valueAt(fields, config.fieldMap.acceptance);
  const acceptance = normalizeList(acceptanceValue).length
    ? normalizeList(acceptanceValue)
    : acceptanceFromBody(body);
  const labels = normalizeList(valueAt(fields, config.fieldMap.labels));
  const priority = plainText(valueAt(fields, config.fieldMap.priority)) || 'normal';
  const kind = !previous
    ? 'jira.issue.created'
    : previous.status !== status
      ? 'jira.issue.transitioned'
      : 'jira.issue.updated';
  const externalId = `jira:${key}:${updated}:${status}`;
  return {
    kind,
    title,
    body,
    actor: plainText(fields.creator?.displayName) || 'jira',
    externalId,
    externalKey: key,
    dedupeKey: `jira:${key}:${updated}:${status}`,
    priority: /^(highest|urgent|critical|blocker)$/i.test(priority)
      ? 'urgent'
      : /^high$/i.test(priority)
        ? 'high'
        : /^(low|lowest)$/i.test(priority)
          ? 'low'
          : 'normal',
    labels: [...new Set([...labels, 'jira'])],
    acceptance,
    scope: config.project ? [`jira:${config.project}`] : [],
    risk: 'medium',
    connector: {
      issueKey: key,
      status,
      updated,
    },
    sourceUrl: config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/browse/${key}` : '',
  };
}

async function jiraSearchPage({
  config,
  token,
  jql,
  startAt,
  fetchImpl,
  signal,
}) {
  const url = new URL(`${config.baseUrl.replace(/\/$/, '')}/rest/api/3/search`);
  url.searchParams.set('jql', jql);
  url.searchParams.set('startAt', String(startAt));
  url.searchParams.set('maxResults', String(config.pageSize || 50));
  url.searchParams.set(
    'fields',
    [
      config.fieldMap.title,
      config.fieldMap.body,
      config.fieldMap.acceptance,
      config.fieldMap.priority,
      config.fieldMap.labels,
      config.fieldMap.status,
      'updated',
      'creator',
    ].filter(Boolean).join(','),
  );
  const auth = Buffer.from(`${config.email}:${token}`).toString('base64');
  const response = await fetchImpl(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
    },
    signal,
  });
  if (!response.ok) {
    const retryAfter = response.headers?.get?.('retry-after');
    return {
      ok: false,
      status: response.status,
      retryAfterMs: retryAfter ? Number(retryAfter) * 1000 : null,
      error: `HTTP ${response.status}`,
    };
  }
  return {
    ok: true,
    status: response.status,
    body: await response.json(),
  };
}

export async function syncJira({
  outDir,
  config,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now(),
  applyEvent = null,
  maxIssues = 2000,
} = {}) {
  if (!config?.enabled) return { status: 'disabled', events: [], cursor: loadJiraCursor(outDir) };
  if (!config.baseUrl || !config.email) {
    return {
      status: 'configuration_error',
      error: 'connectors.jira.baseUrl and email are required',
      events: [],
      cursor: loadJiraCursor(outDir),
    };
  }
  const token = env[config.tokenEnv || 'JIRA_API_TOKEN'];
  if (!token) {
    return {
      status: 'auth_error',
      error: `missing ${config.tokenEnv || 'JIRA_API_TOKEN'}`,
      events: [],
      cursor: loadJiraCursor(outDir),
    };
  }

  const cursor = loadJiraCursor(outDir);
  const jql = buildJiraJql(config, cursor, now);
  const issues = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let startAt = 0;
  try {
    while (issues.length < maxIssues) {
      const page = await jiraSearchPage({
        config,
        token,
        jql,
        startAt,
        fetchImpl,
        signal: controller.signal,
      });
      if (!page.ok) {
        const nextSyncAt = page.retryAfterMs
          ? new Date(now + page.retryAfterMs).toISOString()
          : null;
        return {
          status: page.status === 401 || page.status === 403 ? 'auth_error' : 'degraded',
          error: page.error,
          statusCode: page.status,
          nextSyncAt,
          events: [],
          cursor,
          jql,
        };
      }
      const batch = Array.isArray(page.body?.issues) ? page.body.issues : [];
      issues.push(...batch);
      startAt += batch.length;
      const total = Number(page.body?.total);
      if (!batch.length || !Number.isFinite(total) || startAt >= total) break;
    }
  } catch (error) {
    return {
      status: error.name === 'AbortError' ? 'degraded' : 'network_error',
      error: error.name === 'AbortError' ? 'Jira request timed out' : error.message,
      events: [],
      cursor,
      jql,
    };
  } finally {
    clearTimeout(timeout);
  }

  const events = issues.map((issue) => mappedIssue(
    issue,
    config,
    cursor.issues[String(issue.key || '')],
    now,
  ));
  for (const event of events) {
    if (applyEvent) await applyEvent(event);
  }
  const nextIssues = { ...cursor.issues };
  for (const issue of issues) {
    const key = String(issue.key || '');
    if (!key) continue;
    nextIssues[key] = {
      updated: String(issue.fields?.updated || issue.updated || ''),
      status: plainText(valueAt(issue.fields || {}, config.fieldMap.status)) || 'unknown',
    };
  }
  const issueEntries = Object.entries(nextIssues)
    .sort((left, right) => Date.parse(right[1].updated) - Date.parse(left[1].updated))
    .slice(0, 10_000);
  const updatedAt = issues.reduce((max, issue) => {
    const at = Date.parse(issue.fields?.updated || issue.updated || 0);
    return Number.isFinite(at) ? Math.max(max, at) : max;
  }, cursor.updatedAt ? Date.parse(cursor.updatedAt) : 0);
  const nextCursor = {
    ...cursor,
    updatedAt: updatedAt ? new Date(updatedAt).toISOString() : new Date(now).toISOString(),
    lastSyncAt: new Date(now).toISOString(),
    status: 'healthy',
    lastError: null,
    issues: Object.fromEntries(issueEntries),
  };
  writeJsonPrivate(jiraCursorPath(outDir), nextCursor);
  return {
    status: 'healthy',
    events,
    cursor: nextCursor,
    jql,
    fetched: issues.length,
  };
}
