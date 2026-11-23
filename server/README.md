# self-loop console

A local-first web control plane for the Router. It shows the whole shape:
Sources → Inbox → Ticket → Attempt → Verifier → Outbox, plus Workers and
Policy.

The console has two explicit modes. They do not maintain two contradictory
Ticket states.

| Mode | State source | Writes |
| --- | --- | --- |
| **demo** | `.self-loop/state.json` | in-process demo Router |
| **project** | target repo `.loop/state.json` + `.loop/inbox.json` | delegated to `scripts/router.mjs`, same lock as the CLI |

## Run

```bash
# Demo mode: synthetic Router, seeded on first launch
npm run serve
# http://127.0.0.1:4317

# Project mode: read the real Router state
npm run serve:project -- /path/to/project

# Multiple allowlisted projects; switch from the console header
npm run serve:project -- /path/to/project-a /path/to/project-b

# Project with a custom .loop output directory
node server/index.mjs --repo /path/to/project --out .loop
```

Project mode is startup-selected and allowlisted. The HTTP API never accepts an
arbitrary filesystem path, so a browser cannot point the console at another
directory.

Options:

```bash
node server/index.mjs --port 4317 --host 127.0.0.1
node server/index.mjs --repo /path/to/project
node server/index.mjs --auth-file ~/.self-loop/console-token
node server/index.mjs --rotate-token
node server/index.mjs --data .self-loop/state.json   # demo only
node server/index.mjs --reset                        # demo only
node server/index.mjs --no-demo --no-tick             # demo only
```

## Local write token

The console is local-first, not public. It binds to `127.0.0.1` by default and
refuses a non-loopback bind unless `--allow-remote` is explicit.

On first startup it creates `~/.self-loop/console-token` with 32 random bytes.
The file is not overwritten on later starts. Rotate it explicitly:

```bash
npm run rotate-token
# or
node server/index.mjs --rotate-token
```

- Browser: `GET /` sets an `HttpOnly`, `SameSite=Strict`, path-scoped session
  cookie derived from the token. The token itself is never put in a URL.
- CLI: send `Authorization: Bearer <token>` on every `POST` or `PATCH`.
- Every unsafe method rejects a missing/invalid credential with `401`.
- Every API request rejects a cross-site `Origin` with `403`; this also covers
  reads and SSE. CORS is intentionally not enabled.
- `POST /api/auth/rotate` requires the current credential, rotates the token,
  invalidates every old session and Bearer token, and returns the new token once.
- Write audit records include actor, source, IP, action, project, and result.

The token protects local writes and accidental cross-site calls. It is not a
substitute for user accounts, SSO, RBAC, TLS, or a public deployment. See
`docs/PRODUCT.md` for the local vs hosted split.

## Project mode behavior

- `GET` endpoints read the state files on demand; a watcher broadcasts SSE when
  `state.json` or `inbox.json` changes.
- `POST /api/tick` runs `node scripts/router.mjs tick --repo <target>`.
- `POST /api/tickets/:id/retry` runs `node scripts/router.mjs recover`.
- Demo-only actions return `409`: pause, event injection, source/worker edits,
  config edits, answer, cancel, approve, and Outbox replay.
- The Router remains the only writer of Ticket state. The console does not
  import core scripts to mutate state directly.
- Outbox history is not persisted by the core Router yet. Project mode shows an
  explicit empty state instead of inventing sent/failed records.

## API

`GET` endpoints are local-only and reject cross-site Origins. `POST` and
`PATCH` also require the write token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | health, mode, project, auth boundary |
| `GET` | `/api/state` | full console snapshot |
| `GET` | `/api/overview` | dashboard counters |
| `GET` | `/api/stream` | SSE state stream |
| `GET` | `/api/projects` | allowlisted projects |
| `POST` | `/api/projects/select` | switch the active project |
| `POST` | `/api/auth/rotate` | rotate the local write token |
| `GET` | `/api/events` | inbox events |
| `POST` | `/api/events` | inject an event (demo only) |
| `GET` | `/api/tickets` | tickets, optional `state` |
| `GET` | `/api/tickets/:id` | ticket, attempts, deliveries, timeline |
| `POST` | `/api/tickets/:id/answer` | answer a blocked ticket (demo only) |
| `POST` | `/api/tickets/:id/retry` | requeue a blocked/failed ticket |
| `POST` | `/api/tickets/:id/cancel` | drop a ticket (demo only) |
| `POST` | `/api/tickets/:id/approve` | accept review; never merges (demo only) |
| `GET` | `/api/outbox` | delivery queue |
| `POST` | `/api/outbox/:id/replay` | replay a failed/dead delivery (demo only) |
| `GET` | `/api/workers` | worker pool |
| `POST` | `/api/workers/:id/toggle` | pause/resume a worker (demo only) |
| `GET` | `/api/sources` | connectors |
| `POST` | `/api/sources` | add a connector config (demo only) |
| `PATCH` | `/api/sources/:id` | update connector config (demo only) |
| `POST` | `/api/sources/:id/toggle` | pause/resume a connector (demo only) |
| `POST` | `/hooks/github` | signed GitHub webhook ingress |
| `GET` | `/api/audit` | Router audit plus console write audit |
| `GET` | `/api/config` | resolved runtime config |
| `PATCH` | `/api/config` | update runtime config (demo only) |
| `POST` | `/api/tick` | run one Router tick |

## GitHub webhook

Demo mode configures the secret on the GitHub Source. Project mode reads
`SELF_LOOP_GITHUB_WEBHOOK_SECRET` or `GITHUB_WEBHOOK_SECRET`; it writes the
event into the real `.loop/inbox.json` through `router post`.

```powershell
$body = @{ config = @{ webhookSecret = $env:GITHUB_WEBHOOK_SECRET } } | ConvertTo-Json
Invoke-RestMethod -Method Patch `
  -Uri http://127.0.0.1:4317/api/sources/src_github `
  -Headers @{ Authorization = "Bearer $(Get-Content ~/.self-loop/console-token)" } `
  -ContentType application/json -Body $body
```

Point GitHub at `http://<local-host>:4317/hooks/github`, content type
`application/json`, and the same secret. For a remote repository, put a tunnel
in front of the console; do not expose the console directly.

Supported issue actions are `opened`, `reopened`, `labeled`, and `edited`.
`edited` is visible in Inbox but recorded as ignored because metadata changes
do not create a new Ticket. Every delivery is deduplicated by
`X-GitHub-Delivery`.

## What is real

- Demo Router: events, Tickets, Attempts, deliveries, workers, and audit state.
- Project Router: real `.loop/state.json`, `.loop/inbox.json`, Ticket records,
  Attempt artifacts, and the core lock.
- Deduplication, event consumption, concurrency limits, leases, retries, dead
  letters, and human handoff.
- GitHub webhook raw-body HMAC-SHA256 verification and delivery-id dedupe.
- Local write token, same-origin session, Origin checks, rotation, and audit.
- SSE live updates and the HTTP API.

## What is simulated or absent

- Demo Worker execution is a timer; project mode reads real Tickets but does not
  run an agent from the web process.
- Demo Verifier evidence is synthetic; project mode surfaces real verifier
  evidence when the Router has written it.
- Jira and Slack connectors store configuration only in demo mode.
- Project-mode Outbox history is not persisted by the core Router yet.
- The JSON store is single-process. There is no database, multi-tenancy, SSO,
  RBAC, or hosted deployment.

## Design boundaries

- The Router is the only writer of Ticket state.
- Workers write Attempt artifacts and the PR body; the Verifier writes evidence
  only.
- Inbox events wake the Router and hint at priority. They never authorize work.
- Outbox is a delivery queue, not a task archive.
- The console never merges a pull request or pushes a default branch.
- The server is optional. Core scripts do not import `server/`.
