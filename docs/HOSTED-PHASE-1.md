# Hosted control plane: phase 2 contract

This document records the current implementation slice of ADR 0013. It is a
contract for the hosted service, not a claim that the local console is safe to
expose publicly.

## Implemented

- `server/hosted-rbac.mjs`: default-deny tenant/project authorization.
- `server/hosted-oidc.mjs`: OIDC discovery, PKCE, authorization-code exchange,
  RS256/ES256 ID Token verification against JWKS, issuer/audience/expiry/nonce
  checks, and token fingerprints.
- Roles: `owner`, `maintainer`, `operator`, `viewer`.
- Permissions: tenant read/manage, project read/write, ticket read/operate/
  approve, source/worker/automation/outbox management, audit, and secrets.
- Project-level role overrides inside a tenant; cross-tenant access is denied
  before role lookup.
- `server/hosted-auth.mjs`: one-time login transactions, PKCE verifier storage,
  ID Token verification, user upsert, and opaque server-side sessions.
- `server/hosted-http.mjs`: `/auth/login`, `/auth/callback`, `/auth/logout`,
  `/api/me`, `/api/tenants`, tenant/project read routes, and tenant-scoped
  Ticket list/detail routes. Unsafe methods reject origins outside the
  allowlist and `Sec-Fetch-Site` cross-site requests.
- `server/hosted-session.mjs`: hashed session and login-transaction stores,
  strict cookies, and open-redirect protection.
- `server/hosted-pg.mjs`: PostgreSQL session/login/user/project/ticket
  adapters. Tenant reads run inside a transaction with
  `self_loop.tenant_id`; membership lookups set `self_loop.user_id`. Ticket
  claiming uses `FOR UPDATE SKIP LOCKED`; state changes use an expected
  `version` predicate.
- `server/hosted-secrets.mjs`: AES-256-GCM encrypted tenant connector
  credentials with AAD binding, metadata-only list APIs, rotation, revocation,
  and runtime-only decryption.
- `server/hosted-ingress.mjs`: GitHub and Slack webhook ingress with raw-body
  signature verification, repository/team binding resolution, fixed-window
  rate limits, idempotent event insertion, and normalized Inbox events.
- `server/hosted-index.mjs`: fail-fast hosted entry point that loads OIDC
  discovery, a PostgreSQL pool, and the optional `pg` package.
- `migrations/001_hosted.sql`: PostgreSQL tables, idempotency constraints,
  optimistic `version` columns, indexes, and tenant-isolation RLS policies.
- `migrations/002_hosted_connectors.sql`: encrypted credential columns,
  connector bindings, ingress rate limits, and the controlled
  `resolve_connector_binding` function used before tenant context is known.
- Opt-in trusted-proxy identity header parsing for an OIDC reverse proxy. It
  never reads or returns bearer tokens.

## Running the hosted surface

The hosted surface is separate from `npm run serve`; it requires a real OIDC
provider and PostgreSQL. Apply `migrations/001_hosted.sql` and
`migrations/002_hosted_connectors.sql`, then set:

```text
HOSTED_ISSUER=https://idp.example.com
HOSTED_CLIENT_ID=self-loop
HOSTED_CLIENT_SECRET=...
HOSTED_REDIRECT_URI=https://console.example.com/auth/callback
DATABASE_URL=postgres://...
HOSTED_ALLOWED_ORIGINS=https://console.example.com
HOSTED_SECRET_KEY=<base64-or-hex 32-byte key>
HOSTED_SECRET_KEY_VERSION=v1
```

Generate the connector key with
`[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))`
in PowerShell, or `openssl rand -base64 32`. Keep it in the deployment secret
store; changing it without re-encrypting existing credentials makes them
unreadable.

Run `npm run serve:hosted`. It binds `127.0.0.1:4327` by default and refuses a
non-HTTPS redirect URI outside localhost. `pg` is an optional dependency so the
local console and core scripts stay dependency-free.

Connector APIs (all require an authenticated session and `source:manage`):

```text
GET    /api/tenants/:tenant/projects/:project/credentials
POST   /api/tenants/:tenant/projects/:project/credentials
POST   /api/tenants/:tenant/projects/:project/credentials/:id/rotate
DELETE /api/tenants/:tenant/projects/:project/credentials/:id
GET    /api/tenants/:tenant/projects/:project/bindings
POST   /api/tenants/:tenant/projects/:project/bindings
DELETE /api/tenants/:tenant/projects/:project/bindings/:id
```

Unauthenticated webhook ingress:

```text
POST /hooks/github   (X-Hub-Signature-256, X-GitHub-Delivery)
POST /hooks/slack    (X-Slack-Signature, X-Slack-Request-Timestamp)
```

`HOSTED_INGRESS_RATE_LIMIT` and `HOSTED_INGRESS_RATE_WINDOW_SECONDS` control the
per-binding fixed window (defaults: 120 requests / 60 seconds).

## Not implemented

- Provider OAuth authorization/installation and automatic token refresh. The
  current credential API stores, rotates, and revokes encrypted credentials,
  but the administrator supplies the provider secret/token.
- Hosted Jira polling/webhook ingress and tenant-scoped email invites.
- KMS/Secret Manager and object storage for Attempt artifacts.
- Centralized audit export, tracing, and alert delivery.
- A PostgreSQL integration test against a real database in CI.
- Local `.loop` -> hosted import/export and rollback tooling.
- A hosted browser console; phase 1 exposes the API and auth surface only.

## Security invariants

- Every hosted query must include `tenant_id`; RLS is defense in depth, not the
  only boundary.
- Webhook routing may happen before tenant context exists, but it must use the
  controlled `resolve_connector_binding(provider, external_id)` function. It
  never performs a general cross-tenant table scan.
- Connector secrets are encrypted with tenant/project/provider/credential AAD.
  Read APIs return metadata only; plaintext exists only in the ingress process
  for signature verification or an Outbox adapter call.
- Project ids are never globally addressable without their tenant.
- Login state, nonce, and the transaction cookie are one-time values; the
  authorization code and raw tokens never enter a URL after the callback.
- Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` outside
  localhost.
- The Router remains the only Ticket-state writer.
- Idempotency keys are unique per tenant + project.
- No token or secret enters a URL, read API, log line, or audit detail.

## Next slice

1. Add provider OAuth authorization/installation and automatic refresh.
2. Add hosted Jira polling and webhook ingress.
3. Add a real PostgreSQL integration job for migrations and RLS.
4. Add a local -> hosted export/import dry run.
5. Add a hosted browser console backed by the same RBAC API.
6. Add hosted Attempt/Worker execution on top of the Ticket claim contract.
