// Lightweight network precheck for scheduled runs. Exit 1 means "skip this run".
import { isMain } from './lib.mjs';

export function githubStatusReachable(status) {
  return Number.isFinite(status) && status > 0 && status < 500;
}

export async function githubReachable(timeoutMs = 10000) {
  try {
    const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(timeoutMs) });
    // 401/403 still prove the network and GitHub are reachable. The actual API
    // call uses a token from gh or the environment.
    return githubStatusReachable(res.status);
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
