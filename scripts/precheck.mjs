// Lightweight network precheck for scheduled runs. Exit 1 means "skip this run".
import { isMain } from './lib.mjs';

export async function githubReachable(timeoutMs = 10000) {
  try {
    const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) {
  if (await githubReachable()) {
    console.log('[precheck] GitHub reachable');
  } else {
    console.error('[precheck] GitHub unreachable; skipping scheduled run');
    process.exit(1);
  }
}
