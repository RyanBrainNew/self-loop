# self-loop Router Design

Status: accepted. First version implemented; deferred items are listed at the end.

This design combines three ideas:

- durable Tickets and explicit human handoffs from the DeepSeek Super Agent
  prototype;
- one context assembly, one result envelope, leases, and idempotency from the
  Ooder SuperAgent engineering notes;
- independent verification, atomic tasks, shared project facts, and
  gardener-style environment improvement from the SpaceX bot-team methodology.

## Confirmed decisions

- Router is a deterministic control plane. An LLM may advise on triage, Task
  Cards, or semantic review, but never grants authority or overrides a gate.
- The first version covers `issue -> PR` only. PR follow-ups and review
  workflows come later.
- Every Ticket that reaches delivery must pass an independent Verifier. Worker
  self-report is not evidence.
- The first version includes a minimal Task Card.
- Context Packet and Result Envelope are first-class parts of the first version.
- Worker concurrency defaults to one.
- The three memory files remain the only required memory files. The Feature Map
  concept maps to `AGENTS.md` and those files.
- The core creates isolated worktrees by default; an external orchestrator such
  as Orca may own worktree creation through an adapter.
- Lease expiry consumes an Attempt. The Router auto-recovers only while
  `attempts < maxAttempts` and the safety checks pass; otherwise the Ticket
  becomes `blocked` and needs `recover`.
- A Planner may draft a Task Card with explicit assumptions. If no concrete,
  verifiable acceptance can be produced, the Ticket is returned to a person.
- The first Verifier uses a clean worktree and a separate process, not a
  container or sandbox. Missing gates produce `human_review`, never a false
  pass.
- Only `retro` and the `init-memory` routine write memory. Setup invokes that
  routine to create missing files. Workers may propose lessons in their Result
  Envelope.
- The Router owns Issue comments and status notifications. The Worker owns the
  pull request body. The Verifier writes artifacts only. Automatic comments use
  stable idempotency markers.
- `AGENTS.md` may contain an optional `## Feature Map` section; `init-memory`
  never rewrites it.
- `maxAttempts` means total Attempts, not extra retries. The proposed default is
  two Attempts; lease expiry and verification failure both consume one Attempt.
- A worktree is retained while the pull request is under review and while the
  Ticket is blocked or failed. It is removed after the pull request closes or a
  person runs `router clean`.
- Context projection limits are configurable; the proposed defaults are 2,000
  characters for the Router projection and 8,000 for the Worker projection.
- Self-loop has no SSO integration. An executor adapter may supply an already
  authenticated identity or short-lived credentials; the core stores neither.

## Goals

- Keep the core scheduler-agnostic: terminal, cron, CI, and Orca are callers,
  not dependencies.
- Preserve the five role labels and the existing
  `ready-for-agent | label:<name> | do | off` policies.
- Preserve the memory protocol: `memory/LESSONS.md`,
  `memory/code-standards.md`, and `memory/DECISIONS.md` by default.
- Make one Ticket recoverable across Worker crashes without duplicating work.
- Require objective evidence before a pull request reaches human review.
- Never merge a pull request and never push the default branch.
- Keep the target project free of a project-local `loop/` directory.

## Non-goals

- Auto-merge.
- A 50-Bot concurrent workforce.
- A distributed message bus, VFS, or multi-tenant scheduler.
- Automatic decomposition of every large issue.
- Replacing human review with an LLM.
- Adding new GitHub labels for progress or claims.

## Architecture

```text
GitHub issues, labels, pull requests
                 |
                 v
        Router tick (any scheduler)
                 |
      +----------+-----------+
      |                      |
  eligibility            state + lease
  and claim              + artifacts
      |                      |
      +----------+-----------+
                 |
          Task Card + Context Packet
                 |
                 v
              Worker
          isolated worktree
                 |
          Result Envelope
                 |
                 v
              Verifier
        clean worktree + gates
                 |
       pass / fail / human_review
                 |
                 v
           Human review
                 |
                 v
          Retro / Gardener
                 |
                 v
          memory + CI gates
```

The Router is the only writer of Ticket state. Workers and Verifiers write
Attempt-scoped artifacts, not `state.json`.

## Roles

### Router

The Router is a control plane and behaves like a Chief of Staff. It:

- reads Issues, open pull requests, labels, and existing Tickets;
- applies policy and the five role labels;
- reuses the existing claim TTL and open-PR deduplication;
- creates or updates a Task Card;
- assembles a Context Packet and dispatch packet;
- starts at most the configured number of Workers;
- runs deterministic gates and advances or blocks a Ticket;
- records one concrete human question when work cannot continue.

The Router does not implement business changes, write a technical
implementation plan, or merge.

### Planner

The Planner is an optional semantic step, not a separate required process. It
may turn an ambiguous Issue into a Task Card, but:

- it cannot widen the Issue's authorization;
- it cannot invent acceptance criteria without marking them as assumptions;
- it cannot write code;
- it cannot decide that a Ticket is done.

The deterministic Router may create a Task Card directly when the Issue already
contains clear scope and acceptance criteria.

### Worker

The Worker receives one Task Card and one Context Packet. It:

- works in an isolated worktree created by the core or by an external adapter;
- changes only the allowed scope;
- runs the project's checks;
- commits, pushes its branch, and opens a pull request;
- returns a Result Envelope with artifact references.

The Worker cannot merge, push the default branch, add labels, edit policy, or
mark its own work verified.

### Verifier

The Verifier is required for every Ticket that reaches delivery. It:

- checks out the pull request head in a clean worktree;
- runs as a separate process from the Worker; the first version does not
  require a container or sandbox;
- runs the required project gates independently;
- records command, directory, exit code, output path, and duration;
- returns `pass`, `fail`, or `human_review`;
- never edits code, never gives repair instructions, and never trusts a
  Worker's self-report.

### Reviewer

An optional Reviewer may assess semantic quality, risk, and consistency with
project decisions. It is separate from the deterministic Verifier. It cannot
merge and cannot override a failed gate.

### Retro / Gardener

Retro reads the Ticket, Attempts, Result Envelopes, and artifacts. It writes
lessons with evidence. Repeated lessons become a proposed code-standard or CI
gate. Only Retro and `init-memory` may write memory.

## Ticket lifecycle

```text
queued -> claimed -> working -> verifying -> awaiting_review -> done
  |          |          |           |
  |          |          +-----------+--> blocked
  |          +-----------------------> failed
  +----------------------------------> dropped
```

- `blocked` returns to `queued` only after a person answers the concrete
  question.
- `failed` may return to `queued` while `attempts < maxAttempts`.
- `claimed` and `working` become recoverable only through an explicit
  watchdog/recover check.
- `done` is recorded when the pull request is closed or merged by a person.
- Internal state lives only in `.loop/`; GitHub labels remain unchanged.

### Lease and recovery

The proposed settings are `leaseMinutes: 45` and `maxAttempts: 2`. A lease
expiry consumes an Attempt. `router tick` may requeue an expired Ticket only
when:

- the Attempt count is below `maxAttempts`;
- there is no open pull request;
- there is no usable branch at the recorded head;
- no completed Result Envelope exists for the Attempt;
- the idempotency key is still pending.

If any check fails, the Ticket becomes `blocked` and waits for
`router recover --ticket <N>`.

## Gates

| Gate | Deterministic check |
| --- | --- |
| Eligibility | Policy, five labels, open PR dedupe, assignee, claim TTL |
| Claim | Atomic claim, single writer, no active duplicate |
| Task Card | Scope, acceptance, required checks, out-of-scope paths |
| Work | Branch, worktree, allowed diff, no default-branch push |
| Verification | Clean worktree, project gates, evidence, no Worker self-certification |
| Delivery | `Closes #N`, PR body has validation and Not run, no merge |
| Human review | A person decides; Router records the outcome |
| Retro | Every lesson has commit/issue/PR evidence |

`ready` means ready for review, not ready to merge.

A Task Card may include `assumptions`, but those assumptions are not
authorization. If the Issue, `AGENTS.md`, `memory/code-standards.md`, and
existing tests cannot support a concrete acceptance criterion, the Ticket is
blocked and returned to a person.

## Context and result protocol

```text
.loop/
  state.json
  lock
  tickets/
    42.json
  artifacts/
    42/
      task-card.json
      context.router.json
      context.worker.json
      attempts/
        01/
          result.json
          diff.patch
          verify.jsonl
          review.json
```

### Task Card

```json
{
  "ticket": 42,
  "goal": "Fix the expired-session redirect",
  "inScope": ["src/auth/**", "tests/auth/**"],
  "outOfScope": ["billing/**"],
  "acceptance": [
    "Expired sessions return to the login page",
    "Existing tests pass",
    "A regression test is added"
  ],
  "requiredChecks": ["npm test", "npm run lint"],
  "risk": "May affect session recovery",
  "rollback": "Close the branch and pull request",
  "assumptions": []
}
```

### Context Packet

The Router assembles facts once and creates role projections:

- Router projection includes candidates, claims, open pull requests, leases,
  Attempts, and pending human questions.
- Worker projection includes the Ticket, Task Card, memory excerpts, artifact
  references, and constraints.
- Worker projection excludes unrelated Tickets and scheduler internals.

The packet is read-only, degradable, and budgeted. Missing memory or artifacts
do not block dispatch; the packet records the omission and marks truncation.

### Result Envelope

```json
{
  "ticket": 42,
  "attempt": 1,
  "state": "ready",
  "humanText": "PR #123 is open; tests passed; browser verification was not run.",
  "artifactRefs": [
    {
      "id": "verify",
      "path": ".loop/artifacts/42/attempts/01/verify.jsonl",
      "summary": "npm test: 21 passed"
    }
  ],
  "error": null,
  "clarify": null,
  "notify": true,
  "asOf": "2026-11-18T00:00:00.000Z"
}
```

Allowed states:

`progress | waiting | ready | blocked | failed | dropped | timeout | undeliverable`

Errors use a fixed code plus `userCause`, `userAction`, and `system` fields.
Large logs and diffs stay in artifacts and are referenced by path.

## CLI and configuration

Existing commands remain:

```bash
node scripts/run.mjs triage --repo <target>
node scripts/run.mjs select --repo <target>
node scripts/run.mjs issue  --repo <target>
node scripts/run.mjs retro  --repo <target>
node scripts/run.mjs agent  --repo <target>
```

New commands:

```bash
node scripts/run.mjs router tick   --repo <target>
node scripts/run.mjs router status --repo <target>
node scripts/run.mjs router watchdog --repo <target>
node scripts/run.mjs router recover --repo <target> --ticket 42
node scripts/run.mjs router verify  --repo <target> --ticket 42
node scripts/run.mjs router report  --repo <target> --file result.json
node scripts/run.mjs router clean   --repo <target> --ticket 42
```

Resolution order remains `--repo`, `SELF_LOOP_REPO`, `LOOP_REPO`. All git
operations, `.loop/` output, and memory paths are relative to the target
repository.

Proposed configuration:

```json
{
  "policy": "ready-for-agent",
  "claimTtlMinutes": 180,
  "retroDays": 2,
  "outDir": ".loop",
  "memory": {
    "lessons": "memory/LESSONS.md",
    "codeStandards": "memory/code-standards.md",
    "decisions": "memory/DECISIONS.md"
  },
  "router": {
    "maxAttempts": 2,
    "leaseMinutes": 45,
    "maxConcurrent": 1,
    "lockMinutes": 30,
    "llmAdvisory": false,
    "comments": true,
    "worktreeMode": "local",
    "worktreeDir": ".loop/worktrees",
    "context": {
      "routerChars": 2000,
      "workerChars": 8000
    }
  },
  "executor": {
    "kind": "local",
    "command": ["codex", "exec", "--full-auto"]
  },
  "verifier": {
    "commands": ["npm test", "npm run lint"],
    "timeoutMinutes": 30
  }
}
```

`SELF_LOOP_AGENT` remains supported as a compatibility fallback. An executor
adapter owns the concrete worktree and process setup; the Router only passes the
Target repository and packet paths.

## Installation and migration

The skill is installed outside the target project. A target project contains
only `.self-loop.json`, `memory/`, and the ignored `.loop/` directory.

Magpie can install the repository root because `SKILL.md` is at the root. A
collection repository uses `skills/self-loop`. The installed skill must retain
`SKILL.md`, `scripts/`, `references/`, `templates/`, and `adapters/`.

Migration from an old `loop/` directory:

1. Keep the project's existing memory content.
2. Remove old `loop/` commands from project docs.
3. Install the skill and run `setup-project.mjs` once; existing config and
   memory are preserved.
4. Update cron, CI, and Orca prompts to call the installed `scripts/run.mjs`.
5. Re-run triage and retro; preserve policy, labels, TTL, and PR dedupe behavior.

## Testing and rollout

Required tests:

- policy, labels, selection, TTL, and open-PR dedupe;
- `--repo`, environment precedence, and repository-relative paths;
- memory path resolution and non-overwriting initialization;
- retro explicit window and lessons commit window;
- Ticket transitions, lease expiry, and idempotent dispatch;
- Context Packet projections and truncation;
- Result Envelope validation and artifact references;
- independent Verifier using a clean worktree;
- no merge and no default-branch push.

Rollout:

1. State, lock, claim, lease, and idempotency.
2. Context Packet and Result Envelope.
3. Local worktree executor and Worker protocol.
4. Independent Verifier and deterministic delivery gate.
5. Optional Planner, Reviewer, PR follow-ups, and multiple Workers.

Trust levels:

- L0: observe/triage only.
- L1: single Worker plus human review.
- L2: independent Verifier plus human merge.
- L3: multiple Workers plus human merge.

Self-loop stops at human merge; it never reaches an auto-merge stage.

## Design status

The design tree is complete for the first version. Self-loop does not integrate
SSO; identity and credentials are an executor-adapter concern.

Implemented in the first version:

- deterministic Ticket state, atomic writes, state lock, claims, leases, and
  `maxAttempts`;
- Task Card, Context Packet, Result Envelope, and artifact references;
- local or external worktrees and a pluggable executor command;
- independent Verifier with `pass | fail | human_review`, clean detached
  worktree, and JSONL evidence;
- idempotent Router-owned Issue status comments;
- `tick`, `status`, `verify`, `report`, `recover`, `clean`, and `watchdog`.

Deliberately deferred:

- PR follow-up, review-comment handling, and merge automation (merge is never
  automatic);
- optional semantic Reviewer and LLM-drafted Task Cards;
- multiple concurrent Workers;
- container or sandbox isolation;
- live GitHub integration tests for comments and claims; unit and CLI tests use
  local fixtures and fake repositories.
