#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const required = ['README.md', 'LICENSE', 'SKILL.md', 'CHANGELOG.md'];
const missing = required.filter((file) => !existsSync(join(root, file)));

const checks = [
  { name: 'package version', ok: Boolean(pkg.version), detail: pkg.version || 'missing' },
  { name: 'license', ok: pkg.license === 'Apache-2.0', detail: pkg.license || 'missing' },
  { name: 'required files', ok: missing.length === 0, detail: missing.join(', ') || 'ok' },
];

try {
  execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'pipe' });
  checks.push({ name: 'git diff --check', ok: true, detail: 'clean' });
} catch (error) {
  checks.push({
    name: 'git diff --check',
    ok: false,
    detail: String(error.stdout || error.stderr || error.message).trim(),
  });
}

try {
  const output = execSync('npm pack --dry-run --json', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pack = JSON.parse(output)[0];
  checks.push({
    name: 'npm pack --dry-run',
    ok: pack.files.length > 0,
    detail: `${pack.files.length} files, ${pack.size} bytes`,
  });
} catch (error) {
  checks.push({
    name: 'npm pack --dry-run',
    ok: false,
    detail: String(error.stderr || error.message).trim(),
  });
}

const ok = checks.every((check) => check.ok);
console.log(JSON.stringify({ ok, version: pkg.version, checks }, null, 2));
if (!ok) process.exit(1);
