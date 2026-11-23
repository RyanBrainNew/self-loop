# 0016: Automations and remote Workers stay behind the Router boundary

## Status

Accepted

## Context

The console needs two more ways to create work:

- scheduled automations (for example a daily dependency check);
- Workers running on another machine, not inside the console process.

Both can accidentally become a second Router if they are allowed to create
Tickets or change Ticket state directly.

## Decision

### Automations

- Definitions live in `.loop/automations.json`.
- `router tick` appends one durable `task` Inbox event for each due automation.
- The event then follows the normal Task Card, acceptance, lease, Verifier, and
  human-review path.
- The Automations page delegates add/toggle/run to the Router CLI.

### Remote Workers

- Registration returns a one-time `sw_...` token; `.loop/workers.json` stores
  only its SHA-256 hash.
- A remote Worker heartbeats, claims one queued Ticket, executes on its own
  machine, and submits a Result Envelope through `complete`.
- `claim` writes the lease, Task Card, and Context Packet paths. `complete`
  validates the ticket/worker binding and applies the Result Envelope.
- The Router remains the only Ticket-state writer; the independent Verifier
  still runs on the next tick.
- HTTP endpoints are project-mode only and reject cross-site browser Origins.

### Operations

- `/api/observability` and `/metrics` expose queue, Ticket, delivery, Worker,
  and automation state.
- Backups include automations and the Worker registry but exclude worktrees,
  and exclude artifacts unless explicitly requested.

## Consequences

- A broken or stale remote Worker can never bypass the Router gates.
- Automations are not a separate scheduler; `router tick` is still the
  execution heartbeat.
- Worker tokens must be stored by the remote machine; losing the token means
  registering again.
- Hosted multi-tenant Worker identity remains ADR 0013.
