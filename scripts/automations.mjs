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

export const AUTOMATIONS_VERSION = 1;

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

function nextRunFrom(now, everyMinutes) {
  return new Date(now + positiveMinutes(everyMinutes) * 60_000).toISOString();
}

export function normalizeAutomation(input = {}, now = Date.now()) {
  const everyMinutes = positiveMinutes(input.everyMinutes, 60);
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
    everyMinutes,
    schedule: String(input.schedule || `every ${everyMinutes}m`),
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
    nextRunAt: input.nextRunAt || new Date(now).toISOString(),
    lastEventId: input.lastEventId || null,
  };
}

export function addAutomation(settings, input, now = Date.now()) {
  const data = loadAutomations(settings);
  const automation = normalizeAutomation(input, now);
  data.automations.push(automation);
  saveAutomations(settings, data);
  return automation;
}

export function toggleAutomation(settings, id, enabled = null, now = Date.now()) {
  const data = loadAutomations(settings);
  const automation = data.automations.find((item) => item.id === id);
  if (!automation) throw new Error(`unknown automation: ${id}`);
  automation.enabled = enabled === null ? !automation.enabled : Boolean(enabled);
  automation.updatedAt = new Date(now).toISOString();
  automation.nextRunAt = automation.enabled
    ? nextRunFrom(now, automation.everyMinutes)
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
      connector: { automationId: automation.id },
    },
  };
}

export function runAutomation(settings, id, now = Date.now()) {
  const data = loadAutomations(settings);
  const automation = data.automations.find((item) => item.id === id);
  if (!automation) throw new Error(`unknown automation: ${id}`);
  const input = automationEventInput(automation, now);
  const result = appendEvent(settings, { ...input, now });
  automation.lastRunAt = new Date(now).toISOString();
  automation.nextRunAt = nextRunFrom(now, automation.everyMinutes);
  automation.lastEventId = result.event.id;
  automation.updatedAt = new Date(now).toISOString();
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
    automation.lastRunAt = new Date(now).toISOString();
    automation.nextRunAt = nextRunFrom(now, automation.everyMinutes);
    automation.lastEventId = result.event.id;
    automation.updatedAt = new Date(now).toISOString();
    results.push({ automation, event: result.event, duplicate: result.duplicate });
  }
  if (results.length) saveAutomations(settings, data);
  return results;
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
    };
    console.log(JSON.stringify(addAutomation(settings, input), null, 2));
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
  throw new Error('usage: automations --repo <repo> list|add|toggle|run [--id] [--data JSON]');
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
