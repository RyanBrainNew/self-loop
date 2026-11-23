# The console reads the project Router instead of owning a second state

Status: accepted

## Context

The first console MVP kept Ticket state in `.self-loop/state.json`. The skill's
Router keeps Ticket state in the target repository at `.loop/state.json`, under
`.loop/lock`. Two writable state chains would drift and contradict each other.

Issue #15 requires the console to either read/drive the project Router or become
an explicitly separate hosted control plane. The local-first product direction
is the former.

## Decision

Add an explicit project mode:

```bash
node server/index.mjs --repo /path/to/project
```

- Project mode reads `.loop/state.json`, `.loop/inbox.json`, and Ticket
  artifacts. It derives the console view model; it does not copy Ticket state.
- The startup `--repo` list is the allowlist. The UI may switch among those
  entries. The HTTP API never accepts an arbitrary filesystem path.
- `tick` and `recover` spawn `scripts/router.mjs` with `--repo <target>`. That
  reuses the Router's existing state lock and transaction boundary.
- The console process never mutates Ticket state directly. The Router remains
  the only writer.
- Demo mode remains available for first-run UX and tests. It is labeled `demo`
  in the UI and is not presented as project truth.
- Project mode disables actions that have no core Router equivalent, including
  pause, event injection, source/worker edits, answer, cancel, approve, and
  Outbox replay. Unsupported writes return `409` with an explanation.
- Project-mode Outbox is empty until the core Router persists delivery records.
  The console does not synthesize sent/failed history.

## Consequences

- One Ticket has one source of truth: the project `.loop` state.
- The console cannot bypass a Router gate by writing state itself.
- A long-running web process does not need to own a dispatch loop in project
  mode; the scheduled or CLI Router still does.
- Project mode is a local observer/driver, not a hosted multi-tenant control
  plane. Hosted deployment still requires a database, migrations, identity,
  RBAC, and a new ADR.
- Reading real state exposes only derived views; write audit is stored
  separately and never becomes Ticket state.
