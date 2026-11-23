// Executor adapters translate one Ticket lease into a concrete agent process.
// They never mutate Ticket state; the Router owns state transitions.
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

export const EXECUTOR_ADAPTERS = Object.freeze([
  'command',
  'codex',
  'claude',
]);

function commandParts(configured) {
  if (Array.isArray(configured)) {
    return {
      file: configured.length ? String(configured[0]) : '',
      args: configured.slice(1).map(String),
      shell: false,
    };
  }
  const value = String(configured || '').trim();
  return { file: value, args: [], shell: Boolean(value) };
}

function inferredAdapter(command) {
  const name = basename(String(Array.isArray(command) ? command[0] || '' : command || ''))
    .replace(/\.(exe|cmd|bat|ps1)$/i, '')
    .toLowerCase();
  return EXECUTOR_ADAPTERS.includes(name) && name !== 'command' ? name : 'command';
}

function protocolPrompt(workReference) {
  return [
    `Read and follow the Worker protocol at ${workReference}.`,
    'Use SELF_LOOP_TASK_CARD and SELF_LOOP_CONTEXT as the authoritative task input.',
    'Complete the assigned Ticket, open or update the pull request when required,',
    'and write one Result Envelope JSON file to SELF_LOOP_RESULT.',
    'Do not modify Ticket state or merge a pull request.',
  ].join(' ');
}

const ADAPTER_DEFAULTS = Object.freeze({
  command: {
    args: [],
    prompt: (workReference) => workReference,
  },
  codex: {
    args: ['exec', '--full-auto'],
    prompt: protocolPrompt,
  },
  claude: {
    args: ['-p'],
    prompt: protocolPrompt,
  },
});

export function resolveExecutorAdapter(settings = {}) {
  const configured = String(settings.executor?.adapter || '').trim().toLowerCase();
  if (configured) {
    return configured;
  }
  return inferredAdapter(settings.executor?.command);
}

export function buildExecutorInvocation({
  settings,
  workReference,
  prompt,
} = {}) {
  const configured = settings?.executor?.command;
  if (!configured || (Array.isArray(configured) && configured.length === 0)) return null;
  const adapter = resolveExecutorAdapter(settings);
  const defaults = ADAPTER_DEFAULTS[adapter] || ADAPTER_DEFAULTS.command;
  const command = commandParts(configured);
  const extraArgs = (settings.executor.args || []).map(String);
  const commandAlreadyHasArgs = command.args.length > 0
    || (command.shell && /\s/.test(command.file))
    || extraArgs.length > 0;
  const defaultArgs = commandAlreadyHasArgs ? [] : defaults.args;
  const finalPrompt = prompt || (commandAlreadyHasArgs ? workReference : defaults.prompt(workReference));
  return {
    adapter,
    kind: adapter,
    file: command.file,
    args: [...command.args, ...defaultArgs, ...extraArgs, finalPrompt],
    shell: command.shell,
    timeoutMs: settings.executor.timeoutMinutes * 60 * 1000,
    capabilities: settings.executor.capabilities,
  };
}

export function executorRegistration(settings = {}) {
  const command = settings.executor?.command;
  const adapter = resolveExecutorAdapter(settings);
  return {
    adapter,
    kind: adapter,
    command: Array.isArray(command) ? command.join(' ') : String(command || ''),
    capabilities: settings.executor?.capabilities || [],
    concurrency: settings.executor?.concurrency || 1,
    timeoutMinutes: settings.executor?.timeoutMinutes || 0,
  };
}

export function processAlive(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  try {
    process.kill(number, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function stopExecutorProcess(pid) {
  const number = Number(pid);
  if (!Number.isInteger(number) || number <= 0) return false;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(number), '/T', '/F'], {
      encoding: 'utf8',
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  }
  try {
    process.kill(-number, 'SIGTERM');
  } catch {
    try {
      process.kill(number, 'SIGTERM');
    } catch {
      return false;
    }
  }
  return true;
}
