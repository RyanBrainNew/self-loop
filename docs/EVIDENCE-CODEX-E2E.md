# Codex executor E2E evidence

Date: 2026-11-23  
Adapter: `codex` (`codex-cli 0.171.0`)  
Command:

```bash
node scripts/e2e-executor.mjs --adapter codex --timeout 8 --keep
```

The harness creates a temporary Git repository, dispatches Ticket 1 through
`tickRouter`, lets the real Codex CLI edit and commit on the Ticket branch, and
then runs the independent Verifier in a clean worktree.

Result:

```json
{
  "ok": true,
  "adapter": "codex",
  "state": "awaiting_review",
  "attempts": 1,
  "branch": "loop/1-prove-the-real-executor-protocol",
  "worker": {
    "adapter": "codex",
    "exitCode": 0,
    "timeoutMinutes": 8
  },
  "verification": {
    "status": "pass",
    "checks": [
      {
        "status": "pass",
        "exitCode": 0
      }
    ]
  }
}
```

The run also proves:

- the Worker wrote a Result Envelope instead of Ticket state;
- the Ticket branch was committed by the real executor;
- the independent Verifier passed the acceptance command in a clean worktree;
- the Router transitioned the Ticket to `awaiting_review` without a human
  edit of state;
- `--add-dir <repo>/.git` gives Codex's `workspace-write` sandbox normal Git
  write access to the shared worktree admin directory.

Claude Code was not installed on this machine, so its end-to-end acceptance
run remains pending. The same harness accepts `--adapter claude`.
