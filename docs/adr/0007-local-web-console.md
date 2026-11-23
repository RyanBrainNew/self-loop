# A local-first web console sits beside the skill

Status: accepted for the MVP

## Context

The skill is an execution-side contract. It tells an agent how to claim work,
write an Attempt, and hand a Ticket to the Verifier. It is not a supervision
surface: a person cannot watch the queue, answer a blocked Ticket, or inspect
delivery state from a skill.

The first console MVP must show the whole Router shape without inventing
production guarantees. It must also keep the core scheduler-agnostic and free
of Orca dependencies.

## Decision

Add `server/` as a separate, dependency-free Node 20+ package. It owns:

- a durable JSON store at `.self-loop/state.json`;
- a deterministic tick loop: consume events, claim Tickets, advance Attempts,
  verify, and enqueue deliveries;
- an HTTP API and Server-Sent Events stream;
- a static console for Sources, Inbox, Tickets, Outbox, Workers, and Policy;
- a demo seed and synthetic events so the shape is visible on first launch.

The server is single-tenant, binds to `127.0.0.1` by default, and has no
authentication. It never merges a pull request or pushes a default branch.

## Consequences

- The skill remains the worker-side integration protocol. The console is an
  optional control plane, not a replacement.
- Core scripts stay scheduler-agnostic and free of server imports.
- Ticket state leaves the target repository for the console, so the JSON store
  is now the source of truth for this MVP. The existing repo-local Router
  remains unchanged.
- Worker execution and Verifier evidence are simulated by timers. A real
  executor adapter, connector OAuth, webhook signature verification, and a
  database are follow-up work.
- A hosted or multi-tenant version changes the data model, credentials, and
  permissions. It needs a new ADR; this one does not authorize it.
