#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isMain, parseArgs, resolveRepo, resolveSettings } from './lib.mjs';

function stamp(now = Date.now()) {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

function copyTree(source, target, { exclude = new Set(), dryRun = false } = {}) {
  if (!existsSync(source)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  if (!dryRun) mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (exclude.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      const nested = copyTree(from, to, { exclude, dryRun });
      files += nested.files;
      bytes += nested.bytes;
    } else if (entry.isFile()) {
      files += 1;
      bytes += statSync(from).size;
      if (!dryRun) cpSync(from, to);
    }
  }
  return { files, bytes };
}

export function createBackup({ repoRoot, outDir = null, includeArtifacts = false, dryRun = false, now = Date.now() } = {}) {
  const settings = resolveSettings(repoRoot, {});
  const target = resolve(
    outDir || join(homedir(), '.self-loop', 'backups', `${basename(repoRoot)}-${stamp(now)}`),
  );
  const exclude = new Set(['worktrees', ...(includeArtifacts ? [] : ['artifacts'])]);
  const loop = copyTree(settings.outDir, join(target, '.loop'), { exclude, dryRun });
  let config = { files: 0, bytes: 0 };
  const configFile = join(repoRoot, '.self-loop.json');
  if (existsSync(configFile)) {
    config = { files: 1, bytes: statSync(configFile).size };
    if (!dryRun) cpSync(configFile, join(target, '.self-loop.json'));
  }
  const manifest = {
    version: 1,
    createdAt: new Date(now).toISOString(),
    repo: repoRoot,
    outDir: settings.outDir,
    includeArtifacts,
    files: loop.files + config.files,
    bytes: loop.bytes + config.bytes,
  };
  if (!dryRun) {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { ok: true, dryRun, target, manifest };
}

export function restoreBackup({ repoRoot, backupDir, dryRun = false, force = false } = {}) {
  const source = resolve(backupDir);
  const manifestFile = join(source, 'manifest.json');
  if (!existsSync(manifestFile)) throw new Error(`backup manifest not found: ${manifestFile}`);
  const settings = resolveSettings(repoRoot, {});
  const targetLoop = settings.outDir;
  if (existsSync(targetLoop) && !force && !dryRun) {
    throw new Error('target .loop already exists; pass --force to overwrite matching files');
  }
  const loop = copyTree(join(source, '.loop'), targetLoop, { dryRun });
  let config = { files: 0, bytes: 0 };
  const configFile = join(source, '.self-loop.json');
  if (existsSync(configFile)) {
    config = { files: 1, bytes: statSync(configFile).size };
    if (!dryRun) cpSync(configFile, join(repoRoot, '.self-loop.json'));
  }
  return {
    ok: true,
    dryRun,
    repo: repoRoot,
    target: targetLoop,
    files: loop.files + config.files,
    bytes: loop.bytes + config.bytes,
  };
}

function main(argv = process.argv.slice(2)) {
  const { values, flags } = parseArgs(argv);
  const repoRoot = resolveRepo({ repo: values.repo });
  if (flags.restore) {
    if (!values.backup) throw new Error('restore requires --backup <dir>');
    const result = restoreBackup({
      repoRoot,
      backupDir: values.backup,
      dryRun: Boolean(flags['dry-run']),
      force: Boolean(flags.force),
    });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  const result = createBackup({
    repoRoot,
    outDir: values.out,
    includeArtifacts: Boolean(flags['include-artifacts']),
    dryRun: Boolean(flags['dry-run']),
  });
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    const code = main();
    if (code) process.exit(code);
  } catch (error) {
    console.error(`[backup] ${error.message}`);
    process.exit(2);
  }
}

export { main };
