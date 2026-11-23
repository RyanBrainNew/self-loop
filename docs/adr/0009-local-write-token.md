# Local console writes require a token and same-origin requests

Status: accepted

## Context

The MVP bound to localhost and had no authentication. Any local page or process
could call write endpoints. That is not a durable default, even for a
single-user local console.

Issue #13 requires a local write token, Origin/Host validation, no token in
URLs, rotation, and actor/source/action audit.

## Decision

- On first startup, generate 32 random bytes and store a prefixed token in
  `~/.self-loop/console-token` with owner-only permissions. Do not overwrite an
  existing valid token.
- Serve `GET /` with an `HttpOnly`, `SameSite=Strict`, path-scoped session
  cookie derived from the token. The browser never receives the raw token in a
  URL.
- `POST` and `PATCH` accept either the session cookie or
  `Authorization: Bearer <token>`.
- Reject unsafe requests with no valid credential (`401`).
- Reject cross-site `Origin` / `Sec-Fetch-Site` requests (`403`). Apply the same
  check to reads and SSE, and do not enable wildcard CORS.
- `/hooks/github` is exempt from the console token because GitHub authenticates
  with raw-body HMAC-SHA256. It still rejects a cross-site browser Origin.
- `POST /api/auth/rotate` requires the current credential and invalidates old
  sessions and Bearer tokens. The CLI can run `--rotate-token`.
- Record actor, source, IP, action, project, and result in a console audit log.
  Never include the token in state snapshots, SSE, or logs.

## Consequences

- The token protects local writes and accidental browser cross-site calls. It
  is not a user identity system, SSO, RBAC, TLS, or a public deployment.
- A local process that can read the token file is already inside the trust
  boundary.
- `--allow-remote` still requires the token, but a public deployment must add
  authenticated TLS termination, authorization, rate limits, and a new ADR.
- Tests must bootstrap a session or send a Bearer token for every mutation.
