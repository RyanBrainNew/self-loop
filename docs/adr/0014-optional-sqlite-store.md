# 0014: SQLite is an optional single-machine concurrency backend

## Status

Accepted

## Context

The Router originally used an atomic JSON write plus a repository-local lock.
That is simple to inspect and works on Node 20, but multiple Worker, Connector,
and Web processes need a stronger concurrency and idempotency boundary. A
hosted deployment still needs PostgreSQL; moving local state directly to a
remote database would make the default developer experience heavier.

## Decision

Keep JSON as the default and add SQLite as an opt-in backend:

```json
{
  "storage": {
    "backend": "sqlite",
    "sqlitePath": ".loop/self-loop.db"
  }
}
```

SQLite is canonical for Router state, Tickets, Inbox events, and Outbox
deliveries when enabled. JSON files remain as an atomically written mirror so
the project-mode console and human debugging keep the same files.

- `events.id` is the primary key.
- `deliveries.idempotency_key` has a unique constraint.
- Writes use `BEGIN IMMEDIATE`, WAL, `synchronous=FULL`, and `busy_timeout`.
- Migration runs in one transaction, never deletes the JSON source, and supports
  `--dry-run` and `--export`.
- The Router lock remains the transaction boundary for its complete
  read-modify-write tick. SQLite protects lower-level writes and unique keys.
- Node versions without `node:sqlite` keep using JSON; CI covers both Node 20
  and Node 24.

## Consequences

The default remains dependency-free and Node 20 compatible. SQLite is a
single-machine optimization, not a hosted multi-tenant answer. PostgreSQL,
row-level locking, object storage, and tenant isolation remain covered by ADR
0013.

## Verification

`scripts/sqlite-store.test.mjs` covers dry-run migration, lossless migration,
JSON preservation, unique idempotency, migration failure rollback, and two child
processes writing distinct Tickets without losing either.
