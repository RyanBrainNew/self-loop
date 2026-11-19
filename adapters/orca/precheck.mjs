// Orca precheck adapter: skip the scheduled run when GitHub is unreachable.
import { githubReachable } from '../../scripts/precheck.mjs';

if (await githubReachable()) {
  console.log('[orca-precheck] GitHub reachable');
} else {
  console.error('[orca-precheck] GitHub unreachable; skipping scheduled run');
  process.exit(1);
}
