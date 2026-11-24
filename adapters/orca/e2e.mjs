#!/usr/bin/env node
// Opt-in live Orca adapter probe. It creates, reads, and removes one disabled
// automation. It never launches an agent and never edits project files.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { isMain, parseArgs } from '../../scripts/lib.mjs';

function orca(args) {
  const executable = process.env.ORCA_CLI_COMMAND || 'orca';
  const output = execFileSync(executable, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
  if (!output) return null;
  return JSON.parse(output);
}

function maybeOrca(args) {
  try {
    return orca(args);
  } catch {
    return null;
  }
}

export function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs(argv);
  const repo = resolve(values.repo || process.cwd());
  const name = `self-loop-e2e-${Date.now()}`;
  let id = null;
  try {
    const created = orca([
      'automations', 'create',
      '--name', name,
      '--trigger', '0 0 1 1 *',
      '--prompt', 'self-loop live adapter probe; this automation is disabled',
      '--provider', 'codex',
      '--disabled',
      '--json',
    ]);
    const automation = created?.result?.automation || created?.result;
    id = automation?.id;
    if (!id) throw new Error('Orca did not return an automation id');

    const listed = orca(['automations', 'list', '--json']);
    const found = (listed?.result?.automations || []).find((item) => item.id === id);
    if (!found) throw new Error(`created automation ${id} is missing from the list`);
    const shown = orca(['automations', 'show', id, '--json']);
    const shownAutomation = shown?.result?.automation || shown?.result;
    if (shownAutomation?.id !== id) throw new Error(`automations show returned ${shownAutomation?.id}`);

    console.log(JSON.stringify({
      ok: true,
      adapter: 'orca',
      repo,
      id,
      name,
      disabled: Boolean(found.disabled || found.enabled === false),
      provider: found.provider || null,
      trigger: found.trigger || found.schedule || null,
      note: 'created, listed, read, and removed one disabled Orca automation; no agent was launched',
    }, null, 2));
    return 0;
  } finally {
    if (id) maybeOrca(['automations', 'remove', id, '--json']);
  }
}

if (isMain(import.meta.url)) {
  try {
    const code = main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[e2e-orca] ${error.message}`);
    process.exit(2);
  }
}
