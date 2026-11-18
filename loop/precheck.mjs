// Orca precheck: skip the scheduled run when GitHub is unreachable.
try {
  const res = await fetch('https://api.github.com', { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
} catch (error) {
  console.error(`[loop] GitHub unreachable (${error.message}); skipping scheduled run`);
  process.exit(1);
}
