import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listDirectories, listRoots, normalizeBrowsePath } from './fs-browse.mjs';

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'self-loop-fs-'));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('directory listing returns only child directories and marks hidden entries', async () => {
  const context = workspace();
  try {
    mkdirSync(join(context.dir, 'alpha'));
    mkdirSync(join(context.dir, 'beta'));
    mkdirSync(join(context.dir, '.git'));
    writeFileSync(join(context.dir, 'note.txt'), 'not a directory');

    const result = await listDirectories(context.dir);
    assert.equal(result.path, context.dir);
    assert.deepEqual(result.entries.map((entry) => entry.name), ['alpha', 'beta', '.git']);
    assert.equal(result.entries.at(-1).hidden, true);
    assert.equal(result.parent, normalizeBrowsePath(join(context.dir, '..')));
    assert.equal(result.breadcrumbs.at(-1).path, context.dir);
    assert.equal(result.truncated, false);
  } finally {
    context.cleanup();
  }
});

test('directory listing rejects relative, missing, and non-directory paths', async () => {
  const context = workspace();
  try {
    const file = join(context.dir, 'note.txt');
    writeFileSync(file, 'x');

    assert.throws(() => normalizeBrowsePath('relative/path'), /absolute/);
    await assert.rejects(
      () => listDirectories('relative/path'),
      (error) => error.statusCode === 400 && /absolute/.test(error.message),
    );
    await assert.rejects(
      () => listDirectories(join(context.dir, 'missing')),
      (error) => error.statusCode === 404,
    );
    await assert.rejects(
      () => listDirectories(file),
      (error) => error.statusCode === 400 && /not a directory/.test(error.message),
    );
  } finally {
    context.cleanup();
  }
});

test('directory listing caps results and reports truncation', async () => {
  const context = workspace();
  try {
    for (const name of ['a', 'b', 'c', 'd']) mkdirSync(join(context.dir, name));
    const result = await listDirectories(context.dir, { limit: 2 });
    assert.equal(result.entries.length, 2);
    assert.equal(result.truncated, true);
    assert.equal(result.limit, 2);
  } finally {
    context.cleanup();
  }
});

test('roots include home and cwd only once', () => {
  const result = listRoots({
    home: 'C:\\Users\\tester',
    cwd: 'C:\\Users\\tester',
    platform: 'linux',
  });
  assert.deepEqual(result.roots.map((root) => root.path), ['C:\\Users\\tester', '/']);
  assert.equal(result.separator, '/');
});
