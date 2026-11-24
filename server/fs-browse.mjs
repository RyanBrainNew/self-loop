import { existsSync, statSync } from 'node:fs';
import { opendir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';

const DEFAULT_LIMIT = 400;
const MAX_LIMIT = 2000;

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function mapFsError(error, target) {
  if (error?.statusCode) return error;
  if (error?.code === 'ENOENT') {
    return statusError(`directory not found: ${target}`, 404);
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return statusError(`permission denied: ${target}`, 403);
  }
  if (error?.code === 'ENOTDIR') {
    return statusError(`not a directory: ${target}`, 400);
  }
  return error;
}

export function normalizeBrowsePath(value, { cwd = process.cwd() } = {}) {
  if (value === undefined || value === null || value === '') return homedir();
  if (typeof value !== 'string') {
    throw statusError('path must be a string', 400);
  }
  const trimmed = value.trim();
  if (!trimmed) return homedir();
  if (trimmed.length > 4096) {
    throw statusError('path is too long', 400);
  }
  if (!isAbsolute(trimmed)) {
    throw statusError('path must be absolute', 400);
  }
  return resolve(cwd, trimmed);
}

function breadcrumbsFor(target) {
  const parsed = parse(target);
  const root = parsed.root || (process.platform === 'win32' ? `${target.slice(0, 2)}\\` : '/');
  const relative = target.slice(root.length);
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  const crumbs = [{ label: root, path: root }];
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

export function listRoots({
  cwd = process.cwd(),
  home = homedir(),
  platform = process.platform,
} = {}) {
  const roots = [];
  const seen = new Set();
  function add(path, label, kind) {
    const key = platform === 'win32' ? path.toLowerCase() : path;
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ path, label, kind });
  }

  add(home, 'Home · 用户目录', 'home');
  add(cwd, 'Working directory · 当前目录', 'cwd');
  if (platform === 'win32') {
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      if (existsSync(drive)) add(drive, drive, 'drive');
    }
  } else {
    add('/', '/ · 根目录', 'root');
    if (platform === 'darwin' && existsSync('/Volumes')) {
      add('/Volumes', '/Volumes · 磁盘', 'volume');
    }
  }
  return {
    roots,
    separator: platform === 'win32' ? '\\' : '/',
  };
}

export async function listDirectories(value, {
  cwd = process.cwd(),
  limit = DEFAULT_LIMIT,
} = {}) {
  const target = normalizeBrowsePath(value, { cwd });
  let stats;
  try {
    stats = statSync(target);
  } catch (error) {
    throw mapFsError(error, target);
  }
  if (!stats.isDirectory()) {
    throw statusError(`not a directory: ${target}`, 400);
  }

  const max = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT));
  const entries = [];
  let truncated = false;
  let dir;
  try {
    dir = await opendir(target);
    for await (const dirent of dir) {
      if (dirent.name === '.' || dirent.name === '..') continue;
      let isDirectory = dirent.isDirectory();
      if (!isDirectory && dirent.isSymbolicLink()) {
        try {
          isDirectory = statSync(join(target, dirent.name)).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (!isDirectory) continue;
      if (entries.length >= max) {
        truncated = true;
        break;
      }
      entries.push({
        name: dirent.name,
        path: join(target, dirent.name),
        hidden: dirent.name.startsWith('.'),
      });
    }
  } catch (error) {
    throw mapFsError(error, target);
  } finally {
    if (dir) await dir.close().catch(() => {});
  }

  entries.sort((left, right) => (
    Number(left.hidden) - Number(right.hidden)
    || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  ));
  const parent = dirname(target);
  return {
    path: target,
    parent: parent === target ? null : parent,
    breadcrumbs: breadcrumbsFor(target),
    entries,
    truncated,
    limit: max,
  };
}
