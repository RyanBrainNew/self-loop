# 0015: Connector ingress creates tasks through the Router inbox

## Status

Accepted

## Context

The console needs Slack and Jira to be more than configuration cards. Slack is
an interactive human entry point; Jira is a polling source with its own cursor
and field mapping. If either connector wrote Tickets directly, it would become
a second Router and bypass acceptance, lease, verifier, or retry gates.

## Decision

Connectors only normalize external input into durable Inbox `task` events.

```text
Slack webhook ─┐
Jira poller   ─┼→ task event → Router → Ticket → Worker → Verifier
Other source  ─┘
```

- A task event carries `source`, stable `externalId` / `externalKey`, title,
  body, acceptance, labels, and connector metadata.
- The Router allocates a local Ticket number at or above `100000`, records the
  source/key, and deduplicates on source + `externalId`.
- Slack verifies the raw-body signing secret and a five-minute timestamp
  window. It deduplicates by channel + `ts` or slash-command `trigger_id`.
- Slack channel and `thread_ts` are copied to the Ticket so Outbox replies stay
  in the same thread.
- Jira combines configured JQL with an incremental `updated` clause, maps fields
  from `fieldMap`, follows pagination, and persists its cursor at
  `.loop/connectors/jira.json`.
- Jira advances its cursor only after a complete successful scan. 429,
  authentication, and network failures are visible as degraded health without
  discarding the prior cursor or inventing a Ticket.
- Project-mode console writes still delegate to `scripts/router.mjs post`; the
  connector never writes `state.json`, `tickets/`, or `inbox.json` itself.

## Consequences

Slack and Jira now share one task-creation path, and future connectors can reuse
it. The event is a request, not authorization: a Ticket still needs concrete
acceptance criteria and still passes every Router and Verifier gate.

Hosted OAuth installation, tenant-scoped secret storage, and secret rotation
remain hosted concerns in ADR 0013.

## Verification

Connector tests cover Slack signature rejection, stale requests, replay
deduplication, `/loop`, thread metadata, Jira pagination, stable event ids,
persisted cursor, custom field mapping, 429 degradation, and missing
credentials.
