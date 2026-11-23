#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { appendEvent } from './inbox.mjs';
import { isMain, parseArgs, resolveRepo, resolveSettings } from './lib.mjs';

export const AUTOMATIONS_VERSION = 2;
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const cronCache = new Map();
const formatterCache = new Map();

export function automationsPath(settings) {
  return join(settings.outDir, 'automations.json');
}

export function emptyAutomations() {
  return { version: AUTOMATIONS_VERSION, updatedAt: null, automations: [] };
}

export function loadAutomations(settings) {
  const file = automationsPath(settings);
  if (!existsSync(file)) return emptyAutomations();
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('automations must be a JSON object');
  }
  return {
    version: AUTOMATIONS_VERSION,
    updatedAt: parsed.updatedAt || null,
    automations: Array.isArray(parsed.automations) ? parsed.automations : [],
  };
}

export function saveAutomations(settings, data) {
  mkdirSync(settings.outDir, { recursive: true });
  const file = automationsPath(settings);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({
    version: AUTOMATIONS_VERSION,
    updatedAt: new Date().toISOString(),
    automations: data.automations || [],
  }, null, 2)}\n`);
  renameSync(temporary, file);
}

function positiveMinutes(value, fallback = 60) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseCronField(spec, min, max, label) {
  const values = new Set();
  for (const part of String(spec).split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step in ${label}: ${part}`);
    }
    let start;
    let end;
    if (range === '*') {
      start = min;
      end = max;
    } else if (range.includes('-')) {
      const pieces = range.split('-').map(Number);
      start = pieces[0];
      end = pieces[1];
    } else {
      start = Number(range);
      end = stepText === undefined ? start : max;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < min || end > max || start > end) {
      throw new Error(`invalid cron range in ${label}: ${part}`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression) {
  const key = String(expression || '').trim();
  if (cronCache.has(key)) return cronCache.get(key);
  const fields = key.split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('cron must have five fields: minute hour day month weekday');
  }
  const parsed = {
    minute: parseCronField(fields[0], 0, 59, 'minute'),
    hour: parseCronField(fields[1], 0, 23, 'hour'),
    day: parseCronField(fields[2], 1, 31, 'day'),
    month: parseCronField(fields[3], 1, 12, 'month'),
    weekday: new Set([...parseCronField(fields[4], 0, 7, 'weekday')].map((day) => day === 7 ? 0 : day)),
  };
  cronCache.set(key, parsed);
  return parsed;
}

function formatter(timezone) {
  const key = String(timezone || 'UTC');
  if (formatterCache.has(key)) return formatterCache.get(key);
  let value;
  try {
    value = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
      hourCycle: 'h23',
    });
  } catch {
    throw new Error(`invalid timezone: ${key}`);
  }
  formatterCache.set(key, value);
  return value;
}

function zonedParts(ms, timezone) {
  const parts = {};
  for (const part of formatter(timezone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour),
    day: Number(parts.day),
    month: Number(parts.month),
    weekday: WEEKDAYS[parts.weekday],
  };
}

export function nextCronRun(expression, from = Date.now(), timezone = 'UTC') {
  const cron = parseCron(expression);
  formatter(timezone);
  const start = Math.ceil(from / 60_000) * 60_000;
  const limit = start + 366 * 24 * 60 * 60_000;
  for (let at = start; at <= limit; at += 60_000) {
    const parts = zonedParts(at, timezone);
    if (!cron.minute.has(parts.minute)) continue;
    if (!cron.hour.has(parts.hour)) continue;
    if (!cron.day.has(parts.day)) continue;
    if (!cron.month.has(parts.month)) continue;
    if (!cron.weekday.has(parts.weekday)) continue;
    return new Date(at).toISOString();
  }
  throw new Error(`cron did not match within one year: ${expression}`);
}

function nextRunFrom(now, automation) {
  if (automation.scheduleType === 'cron') {
    return nextCronRun(automation.cron, now, automation.timezone);
  }
  return new Date(now + positiveMinutes(automation.everyMinutes) * 60_000).toISOString();
}

function scheduleLabel(input, everyMinutes, cron, timezone) {
  if (input.schedule) return String(input.schedule);
  return input.scheduleType === 'cron'
    ? `${cron} (${timezone})`
    : `every ${everyMinutes}m`;
}

export function normalizeAutomation(input = {}, now = Date.now()) {
  const scheduleType = input.scheduleType === 'cron' || input.cron ? 'cron' : 'interval';
  const everyMinutes = positiveMinutes(input.everyMinutes, 60);
  const cron = String(input.cron || '').trim();
  const timezone = String(input.timezone || 'UTC').trim() || 'UTC';
  if (scheduleType === 'cron') {
    if (!cron) throw new Error('cron automation requires a cron expression');
    nextCronRun(cron, now, timezone);
  }
  return {
    id: String(input.id || `aut_${randomUUID().slice(0, 10)}`),
    name: String(input.name || input.title || 'Scheduled task').slice(0, 120),
    title: String(input.title || input.name || 'Scheduled task').slice(0, 200),
    body: String(input.body || ''),
    acceptance: Array.isArray(input.acceptance)
      ? input.acceptance.map(String).filter(Boolean)
      : String(input.acceptance || '')
        .split(/[;\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    scheduleType,
    everyMinutes,
    cron,
    timezone,
    schedule: scheduleLabel(input, everyMinutes, cron, timezone),
    priority: String(input.priority || 'normal'),
    labels: Array.isArray(input.labels)
      ? input.labels.map(String)
      : String(input.labels || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    enabled: input.enabled !== false,
    createdAt: input.createdAt || new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    lastRunAt: input.lastRunAt || null,
    nextRunAt: input.nextRunAt || null,
    lastEventId: input.lastEventId || null,
    runs: Array.isArray(input.runs) ? input.runs.slice(-20) : [],
  };
}

export function addAutomation(settings, input, now = Date.now()) {
  const data = loadAutomations(settings);
  const automation = normalizeAutomation(input, now);
  if (!automation.nextRunAt) automation.nextRunAt = nextRunFrom(now, automation);
  data.automations.push(automation);
  saveAutomations(settings, data);
  return automation;
}

export function editAutomation(settings, id, patch = {}, now = Date.now()) {
  const data = loadAutomations(settings);
  const existing = data.automations.find((item) => item.id === id);
  if (!existing) throw new Error(`unknown automation: ${id}`);
  const merged = normalizeAutomation({
    ...existing,
    ...patch,
    id,
    createdAt: existing.createdAt,
    runs: existing.runs || [],
  }, now);
  merged.nextRunAt = patch.nextRunAt
    || (merged.enabled ? nextRunFrom(now, merged) : merged.nextRunAt);
  const index = data.automations.findIndex((item) => item.id === id);
  data.automations[index] = merged;
  saveAutomations(settings, data);
  return merged;
}

export function removeAutomation(settings, id) {
  const data = loadAutomations(settings);
  const index = data.automations.findIndex((item) => item.id === id);
  if (index < 0) throw new Error(`unknown automation: ${id}`);
  const [removed] = data.automations.splice(index, 1);
  saveAutomations(settings, data);
  return removed;
}

export function toggleAutomation(settings, id, enabled = null, now = Date.now()) {
  const data = loadAutomations(settings);
  const automation = data.automations.find((item) => item.id === id);
  if (!automation) throw new Error(`unknown automation: ${id}`);
  automation.enabled = enabled === null ? !automation.enabled : Boolean(enabled);
  automation.updatedAt = new Date(now).toISOString();
  automation.nextRunAt = automation.enabled
    ? nextRunFrom(now, automation)
    : automation.nextRunAt;
  saveAutomations(settings, data);
  return automation;
}

function automationEventInput(automation, runAt) {
  const stamp = new Date(runAt).toISOString();
  return {
    type: 'task',
    action: 'created',
    id: `automation:${automation.id}:${stamp}`,
    payload: {
      source: { id: 'src_automation', kind: 'automation', name: 'Automation' },
      externalId: `automation:${automation.id}:${stamp}`,
      externalKey: automation.id,
      title: automation.title,
      body: automation.body,
      acceptance: automation.acceptance,
      labels: ['automation', ...(automation.labels || [])],
      priority: automation.priority,
      connector: {
        automationId: automation.id,
        schedule: automation.schedule,
      },
    },
  };
}

function recordRun(automation, result, now) {
  automation.lastRunAt = new Date(now).toISOString();
  automation.nextRunAt = nextRunFrom(now, automation);
  automation.lastEventId = result.event.id;
  automation.updatedAt = new Date(now).toISOString();
  automation.runs = [
    ...(automation.runs || []),
    {
      at: automation.lastRunAt,
      eventId: result.event.id,
      duplicate: result.duplicate,
    },
  ].slice(-20);
}

export function runAutomation(settings, id, now = Date.now()) {
  const data = loadAutomations(settings);
  const automation = data.automations.find((item) => item.id === id);
  if (!automation) throw new Error(`unknown automation: ${id}`);
  const input = automationEventInput(automation, now);
  const result = appendEvent(settings, { ...input, now });
  recordRun(automation, result, now);
  saveAutomations(settings, data);
  return { automation, event: result.event, duplicate: result.duplicate };
}

export function runDueAutomations(settings, now = Date.now()) {
  const data = loadAutomations(settings);
  const due = data.automations.filter(
    (item) => item.enabled && Date.parse(item.nextRunAt || 0) <= now,
  );
  const results = [];
  for (const automation of due) {
    const input = automationEventInput(automation, now);
    const result = appendEvent(settings, { ...input, now });
    recordRun(automation, result, now);
    results.push({ automation, event: result.event, duplicate: result.duplicate });
  }
  if (results.length) saveAutomations(settings, data);
  return results;
}

export function automationHistory(settings, id) {
  const automation = loadAutomations(settings).automations.find((item) => item.id === id);
  if (!automation) throw new Error(`unknown automation: ${id}`);
  return {
    id: automation.id,
    name: automation.name,
    runs: [...(automation.runs || [])].reverse(),
  };
}

function main(argv = process.argv.slice(2)) {
  const { values, flags } = parseArgs(argv);
  const repo = values.repo;
  if (!repo) throw new Error('automations CLI requires --repo');
  const settings = resolveSettings(resolveRepo({ repo }), {}, process.env);
  const action = values.action || (flags.list ? 'list' : '');
  if (action === 'list') {
    console.log(JSON.stringify(loadAutomations(settings), null, 2));
    return 0;
  }
  if (action === 'add') {
    const input = values.data ? JSON.parse(values.data) : {
      name: values.name,
      title: values.title,
      body: values.body,
      everyMinutes: values['every-minutes'],
      cron: values.cron,
      timezone: values.timezone,
    };
    console.log(JSON.stringify(addAutomation(settings, input), null, 2));
    return 0;
  }
  if (action === 'edit') {
    console.log(JSON.stringify(
      editAutomation(settings, values.id, JSON.parse(values.data || '{}')),
      null,
      2,
    ));
    return 0;
  }
  if (action === 'remove') {
    console.log(JSON.stringify(removeAutomation(settings, values.id), null, 2));
    return 0;
  }
  if (action === 'history') {
    console.log(JSON.stringify(automationHistory(settings, values.id), null, 2));
    return 0;
  }
  if (action === 'toggle') {
    console.log(JSON.stringify(toggleAutomation(settings, values.id), null, 2));
    return 0;
  }
  if (action === 'run') {
    console.log(JSON.stringify(runAutomation(settings, values.id), null, 2));
    return 0;
  }
  throw new Error('usage: automations --repo <repo> list|add|edit|remove|history|toggle|run [--id] [--data JSON]');
}

if (isMain(import.meta.url)) {
  try {
    const code = main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[automations] ${error.message}`);
    process.exit(2);
  }
}

export { main };
