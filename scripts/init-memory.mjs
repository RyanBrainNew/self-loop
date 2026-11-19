// Initialize project memory from the skill's generic templates.
// Existing files are never overwritten.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isMain,
  loadConfig,
  parseArgs,
  repoRelativePath,
  resolveRepo,
  resolveSettings,
} from './lib.mjs';

const templatesDir = fileURLToPath(new URL('../templates/memory/', import.meta.url));

export function initMemory({ repoRoot, settings, dryRun = false } = {}) {
  const resolved = settings || resolveSettings(repoRoot);
  const files = [
    ['LESSONS.md', resolved.lessonsPath],
    ['code-standards.md', resolved.codeStandardsPath],
    ['DECISIONS.md', resolved.decisionsPath],
  ];
  const created = [];
  const skipped = [];

  for (const [templateName, target] of files) {
    const source = join(templatesDir, templateName);
    if (!existsSync(source)) throw new Error(`missing template: ${source}`);
    if (existsSync(target)) {
      skipped.push(target);
      continue;
    }
    if (!dryRun) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
    created.push(target);
  }
  return { created, skipped, repoRoot, dryRun };
}

function main() {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepo({ repo: values.repo });
  const config = loadConfig(repoRoot);
  const memoryDir = values['memory-dir'] || values.dir;
  const memoryOverrides = memoryDir
    ? {
        lessonsPath: join(memoryDir, 'LESSONS.md'),
        codeStandardsPath: join(memoryDir, 'code-standards.md'),
        decisionsPath: join(memoryDir, 'DECISIONS.md'),
      }
    : {};
  const settings = resolveSettings(repoRoot, {
    ...memoryOverrides,
    lessonsPath: values.lessons || memoryOverrides.lessonsPath,
    codeStandardsPath: values.standards || memoryOverrides.codeStandardsPath,
    decisionsPath: values.decisions || memoryOverrides.decisionsPath,
  });
  const result = initMemory({ repoRoot, settings, dryRun: Boolean(flags['dry-run']) });

  for (const file of result.created) {
    console.log(`[init-memory] ${result.dryRun ? 'would create' : 'created'} ${repoRelativePath(repoRoot, file)}`);
  }
  for (const file of result.skipped) {
    console.log(`[init-memory] kept existing ${repoRelativePath(repoRoot, file)}`);
  }
  if (Object.keys(config).length === 0) {
    console.log('[init-memory] no .self-loop.json found; used default memory paths');
  }
}

if (isMain(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`[init-memory] ${error.message}`);
    process.exit(2);
  }
}
