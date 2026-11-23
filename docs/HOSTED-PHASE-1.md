# Hosted control plane: phase 1 contract

This document records the first implementation slice of ADR 0013. It is a
contract for the hosted service, not a claim that the local console is safe to
expose publicly.

## Implemented

- `server/hosted-rbac.mjs`: default-deny tenant/project authorization.
- Roles: `owner`, `maintainer`, `operator`, `viewer`.
- Permissions: tenant read/manage, project read/write, ticket read/operate/
  approve, source/worker/automation/outbox management, audit, and secrets.
- Project-level role overrides inside a tenant; cross-tenant access is denied
  before role lookup.
- Opt-in trusted-proxy identity header parsing for an OIDC reverse proxy. It
  never reads or returns bearer tokens.
- `migrations/001_hosted.sql`: PostgreSQL tables, idempotency constraints,
  optimistic `version` columns, indexes, and tenant-isolation RLS policies.

## Not implemented

- OIDC discovery, authorization-code + PKCE login, callback/session cookies,
  and provider logout.
- A hosted HTTP server that wires RBAC into every route.
- A PostgreSQL adapter and transaction/lease implementation.
- KMS/Secret Manager, OAuth token refresh/revocation, and tenant-scoped email
  invites.
- Object storage for Attempt artifacts and tracing/alert delivery.
- Local `.loop` -> hosted import/export and rollback tooling.

## Security invariants

- Every hosted query must include `tenant_id`; RLS is defense in depth, not the
  only boundary.
- Project ids are never globally addressable without their tenant.
- The Router remains the only Ticket-state writer.
- Idempotency keys are unique per tenant + project.
- No token or secret enters a URL, read API, log line, or audit detail.

## Next slice

1. Add OIDC discovery + PKCE login and a server-side session store.
2. Implement the PostgreSQL adapter with `SET LOCAL self_loop.tenant_id`.
3. Wire route handlers through `authorize()` before any read or mutation.
4. Add a local -> hosted export/import dry run.
