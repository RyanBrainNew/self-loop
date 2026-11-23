import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { git, resolveRepo } from '../scripts/lib.mjs';

export const PROJECT_STORE_VERSION = 1;

export function defaultProjectsFile(env = process.env) {
  if (env.SELF_LOOP_CONSOLE_PROJECTS) return resolve(env.SELF_LOOP_CONSOLE_PROJECTS);
  return join(homedir(), '.self-loop', 'projects.json');
}

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function projectId(repoRoot) {
  return `prj_${createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)}`;
}

function writePrivateJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {}
  try {
    renameSync(temporary, file);
  } catch {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  try {
    chmodSync(file, 0o600);
  } catch {}
}

function emptyStore() {
  return {
    version: PROJECT_STORE_VERSION,
    lastSelectedId: null,
    projects: [],
  };
}

export function inspectProjectPath(value, { cwd = process.cwd(), name = '' } = {}) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('project path is required');
  }
  const repoRoot = resolveRepo({ repo: resolve(cwd, value.trim()) });
  if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
    throw new Error(`project path is not a directory: ${value}`);
  }
  const isGit = git(repoRoot, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const initialized = existsSync(join(repoRoot, '.self-loop.json'))
    || existsSync(join(repoRoot, '.loop'));
  if (!isGit && !initialized) {
    throw new Error(
      `project must be a Git repository or contain .self-loop.json / .loop: ${repoRoot}`,
    );
  }
  return {
    id: projectId(repoRoot),
    path: repoRoot,
    name: String(name || '').trim() || basename(repoRoot),
  };
}

export class ProjectStore {
  constructor(file = defaultProjectsFile(), { cwd = process.cwd(), now = Date.now } = {}) {
    this.file = resolve(file);
    this.cwd = cwd;
    this.now = now;
    this.state = emptyStore();
    if (existsSync(this.file)) {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('projects registry must be a JSON object');
      }
      this.state = {
        ...emptyStore(),
        ...parsed,
        projects: Array.isArray(parsed.projects) ? parsed.projects : [],
      };
    }
    if (
      this.state.lastSelectedId
      && !this.state.projects.some((project) => project.id === this.state.lastSelectedId)
    ) {
      this.state.lastSelectedId = this.state.projects[0]?.id || null;
    }
  }

  save() {
    writePrivateJson(this.file, this.state);
  }

  list() {
    return this.state.projects.map((project) => ({ ...project }));
  }

  get(id) {
    return this.state.projects.find((project) => project.id === id) || null;
  }

  add(value, { name = '' } = {}) {
    const inspected = inspectProjectPath(value, { cwd: this.cwd, name });
    const existing = this.state.projects.find(
      (project) => project.id === inspected.id || project.path === inspected.path,
    );
    if (existing) {
      if (name && existing.name !== name) {
        existing.name = name;
        existing.updatedAt = nowIso(this.now());
        this.save();
      }
      return { project: { ...existing }, added: false };
    }
    const at = nowIso(this.now());
    const project = {
      ...inspected,
      addedAt: at,
      updatedAt: at,
      lastSelectedAt: null,
    };
    this.state.projects.push(project);
    if (!this.state.lastSelectedId) this.state.lastSelectedId = project.id;
    this.save();
    return { project: { ...project }, added: true };
  }

  remove(id) {
    if (this.state.projects.length <= 1) {
      const error = new Error('cannot remove the last registered project');
      error.statusCode = 409;
      throw error;
    }
    const index = this.state.projects.findIndex((project) => project.id === id);
    if (index < 0) {
      const error = new Error(`unknown project: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    const [removed] = this.state.projects.splice(index, 1);
    if (this.state.lastSelectedId === id) {
      this.state.lastSelectedId = this.state.projects[Math.min(index, this.state.projects.length - 1)].id;
    }
    this.save();
    return removed;
  }

  select(id) {
    const project = this.get(id);
    if (!project) {
      const error = new Error(`unknown project: ${id}`);
      error.statusCode = 404;
      throw error;
    }
    this.state.lastSelectedId = id;
    project.lastSelectedAt = nowIso(this.now());
    project.updatedAt = project.lastSelectedAt;
    this.save();
    return { ...project };
  }

  current() {
    return this.get(this.state.lastSelectedId)
      || (this.state.projects[0] ? { ...this.state.projects[0] } : null);
  }
}
