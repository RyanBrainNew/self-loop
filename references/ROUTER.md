# Router Work Reference

> The Router is a deterministic control plane. It owns Ticket state, claims,
> leases, context assembly, dispatch, verification gates, retries, and human
> handoffs. It never writes business code and never merges a pull request.

An LLM may advise on triage, a Task Card draft, or semantic review. It cannot
grant authority, invent a candidate outside the Issue set, or override a
deterministic gate.

## Commands

All commands run from the installed skill directory and take an explicit target
repository:

```bash
SKILL_DIR=/absolute/path/to/self-loop
TARGET_REPO=/absolute/path/to/project

node "$SKILL_DIR/scripts/run.mjs" router tick     --repo "$TARGET_REPO"
node "$SKILL_DIR/scripts/run.mjs" router status   --repo "$TARGET_REPO" --json
node "$SKILL_DIR/scripts/run.mjs" router verify   --repo "$TARGET_REPO" --ticket 42
node "$SKILL_DIR/scripts/run.mjs" router report   --repo "$TARGET_REPO" --file result.json
node "$SKILL_DIR/scripts/run.mjs" router recover  --repo "$TARGET_REPO" --ticket 42
node "$SKILL_DIR/scripts/run.mjs" router clean    --repo "$TARGET_REPO" --ticket 42
node "$SKILL_DIR/scripts/run.mjs" router watchdog --repo "$TARGET_REPO"
```

| Command | Purpose |
| --- | --- |
| `tick` | Select one eligible Issue when idle, recover an expired safe Attempt, dispatch, or verify. This is the cron entry point. |
| `status` | Print `state.json`, or a compact Ticket summary without `--json`. |
| `verify` | Run the independent Verifier for one Ticket. |
| `report` | Apply a Worker's Result Envelope written outside the process. |
| `recover` | Put a blocked Ticket back in the queue for one more Attempt. A person runs this. |
| `clean` | Remove worktrees for terminal Tickets, or one Ticket with `--ticket`. |
| `watchdog` | Apply expired-lease recovery/blocking transitions; `--dry-run` only reports. |

`tick --dry-run` previews the Task Card without creating a Ticket, consuming an
Attempt, creating a worktree, or posting a comment. `--no-notify` suppresses
the Issue status comment for any command.

Exit codes:

- `0`: success, including a blocked Ticket that was recorded correctly.
- `2`: configuration, authentication, network, or gate execution failure.
- `3`: no eligible Issue.

## Target repository resolution

The order is always:

1. `--repo`
2. `SELF_LOOP_REPO`
3. legacy `LOOP_REPO`
4. the current Git root, then the current directory

A subdirectory passed to `--repo` is normalized to the repository root. Git
operations, `.loop/` state, worktrees, and memory paths are all resolved
relative to that root, never relative to the directory that launched Node.

## State layout

```text
.loop/
  state.json
  lock
  tickets/
    42.json
  artifacts/
    42/
      task-card.json
      attempt-1/
        context.router.json
        context.worker.json
        result.json
        verify.jsonl
        verify-1.stdout.txt
        verify-1.stderr.txt
```

Only the Router writes `state.json`, `tickets/`, and the lock. A Worker writes
its Attempt-scoped Result Envelope and PR body. A Verifier writes only
evidence artifacts. Neither Worker nor Verifier edits Ticket state.

`state.json` is an index; `tickets/<N>.json` is the durable Ticket record. Both
are written atomically. A stale lock is cleared after `router.lockMinutes`.

## Lifecycle

```text
queued -> working -> verifying -> awaiting_review -> done
  |          |           |
  |          |           +--> blocked
  |          +--------------> failed
  +-------------------------> dropped
```

- `awaiting_review` means the independent Verifier passed. A person still
  decides whether to merge.
- `blocked` means the Router needs one concrete human answer, or the retry
  budget is exhausted.
- A successful `recover` returns a blocked Ticket to `queued` and grants one
  final Attempt.
- GitHub labels are never used for progress or claims. Only the five role
  labels are recognized.

## Leases, Attempts, and Q9 recovery

`maxAttempts` is the **total** number of Worker Attempts, not extra retries.
The default is two. A lease defaults to 45 minutes.

An Attempt is consumed when it is dispatched. Lease expiry and verification
failure both consume that Attempt.

When `tick` or `watchdog` sees an expired lease, it checks:

1. Is an open pull request recorded?
2. Does a completed Result Envelope exist?
3. Does the recorded branch already contain commits?
4. Is `attempts >= maxAttempts`?

If any check is true, the Ticket becomes `blocked` with the reason and waits for
`router recover --ticket <N>`. Otherwise it returns to `queued`, and the next
`tick` may dispatch another Attempt.

This is deliberately conservative. Partial branch work is not thrown away or
silently duplicated; a person reviews it first.

## Task Card

```json
{
  "ticket": 42,
  "goal": "Fix the expired-session redirect",
  "inScope": ["src/auth/**", "tests/auth/**"],
  "outOfScope": ["billing/**"],
  "acceptance": [
    "Expired sessions return to the login page",
    "A regression test is added"
  ],
  "requiredChecks": ["npm test", "npm run lint"],
  "risk": "May affect session recovery",
  "rollback": "Close the branch and pull request.",
  "assumptions": [],
  "blockedReason": null
}
```

Acceptance criteria come from a heading containing `Acceptance`, `Acceptance
criteria`, or `验收`, followed by list items or checkboxes. If no concrete,
verifiable criterion is found, the Router does not guess: it sets `blocked` and
returns one question to a person.

An optional Planner may draft a Task Card with explicit assumptions, but those
assumptions are not authorization and cannot replace acceptance.

## Context Packet

The Router assembles project facts once and projects them per role:

- Router projection: candidate, claim, lease, Attempts, PR, and open question.
- Worker projection: Ticket, Task Card, memory excerpts, artifact references,
  and hard constraints.

Defaults are 2,000 characters for the Router projection and 8,000 for the
Worker projection. Long memory text is truncated with a marker while file and
artifact paths remain intact. Missing memory is recorded as absent, not fatal.

`AGENTS.md` is included. A project may add an optional `## Feature Map` section
there; the first version does not require a fourth memory file.

## Result Envelope

```json
{
  "ticket": 42,
  "attempt": 1,
  "state": "ready",
  "humanText": "PR #123 is open; tests passed; browser verification was not run.",
  "artifactRefs": [
    {
      "id": "verify",
      "path": ".loop/artifacts/42/attempt-1/verify.jsonl",
      "summary": "npm test: 27 passed"
    }
  ],
  "error": null,
  "clarify": null,
  "notify": true,
  "pr": 123,
  "prHead": "abc123",
  "asOf": "2026-11-18T00:00:00.000Z"
}
```

Allowed states:

`progress | waiting | ready | blocked | failed | dropped | timeout | undeliverable`

- `ready` moves the Ticket to independent verification.
- `failed` requeues below `maxAttempts`, then blocks.
- `blocked`, `timeout`, and `undeliverable` block with one question.
- `dropped` closes the internal Ticket as done.

Errors use a fixed code plus optional `userCause`, `userAction`, and `system`
fields. Large logs and diffs stay in artifacts and are referenced by path.

## Worktrees and executors

Core default: `worktreeMode: "local"`. The Router creates one worktree per
Ticket under `.loop/worktrees/<N>` and records the branch.

External scheduler: `worktreeMode: "external"`. The Router passes the target
repository and packet paths, but the adapter owns worktree creation. The
optional Orca adapter is one such scheduler; the core never requires it.

```json
{
  "executor": {
    "kind": "local",
    "command": ["codex", "exec", "--full-auto"]
  }
}
```

The Worker receives:

```text
SELF_LOOP_REPO=<target repo>
SELF_LOOP_TICKET=<N>
SELF_LOOP_TASK_CARD=<.../task-card.json>
SELF_LOOP_CONTEXT=<.../context.worker.json>
SELF_LOOP_RESULT=<.../result.json>
```

The installed `references/WORK.md` path is also passed as the executor's final
argument, for both array and string executor commands.

The Worker works only in its worktree, pushes its branch, opens a PR whose body
starts with `Closes #N`, and writes a Result Envelope. It never merges, never
pushes the default branch, and never edits labels or policy.

The Router owns the single status comment on the Issue. It is updated in place
using the hidden marker `<!-- self-loop:status -->`. Notification failure is
logged and does not change a gate result.

## Independent verification

The Verifier is required before `awaiting_review`. It:

1. discovers `verifier.commands` from `.self-loop.json`, or common
   `package.json` scripts (`test`, `lint`, `typecheck`, `build`);
2. creates a detached, clean worktree at `prHead`, branch, or `HEAD`;
3. runs each command in a separate process with `CI=1`;
4. records command, directory, exit code, signal, duration, stdout path, and
   stderr path in `verify.jsonl`;
5. returns `pass`, `fail`, or `human_review`.

No discovered command means `human_review`; it is never a false pass. A
timeout is a failure. A `fail` consumes the Attempt and either requeues or
blocks at the budget. The first version uses a clean worktree and process, not
a container or sandbox.

## Memory write permissions

Only `retro` and `init-memory` write memory. A Worker may propose a lesson in
its Result Envelope, and a Reviewer may cite one, but neither edits:

- `memory/LESSONS.md`
- `memory/code-standards.md`
- `memory/DECISIONS.md`

Configured paths remain relative to the target repository. See `MEMORY.md`.

## Scheduler examples

```cron
*/15 * * * * node /opt/skills/self-loop/scripts/run.mjs router tick --repo /srv/project >> /var/log/self-loop.log 2>&1
30 6 * * *  node /opt/skills/self-loop/scripts/run.mjs retro --repo /srv/project >> /var/log/self-loop-retro.log 2>&1
```

CI uses the same command with the project checkout as `--repo`. A scheduler only
decides when to call the Router; it does not own Ticket state or gates.

## Safety rules

- Never merge a pull request.
- Never push the default branch.
- Never add a sixth label.
- Never trust Worker self-verification.
- Never treat missing verification as a pass.
- Never let a configured path escape the target repository.
- Never delete another person's memory history; supersede and link it.
