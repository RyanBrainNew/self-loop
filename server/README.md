# self-loop console

A local-first web control plane for the Router. It shows the whole shape:
Sources → Inbox → Ticket → Attempt → Verifier → Outbox, plus Workers and
Policy.

The console has two explicit modes. They do not maintain two contradictory
Ticket states.

| Mode | State source | Writes |
| --- | --- | --- |
| **demo** | `.self-loop/state.json` | in-process demo Router |
| **project** | target repo `.loop/state.json` + `.loop/inbox.json` + `.loop/outbox.json` | delegated to `scripts/router.mjs`, same lock as the CLI |

## Run

```bash
# Demo mode: synthetic Router, seeded on first launch
npm run serve
# http://127.0.0.1:4317

# Project mode: read the real Router state
npm run serve:project -- /path/to/project

# Register multiple projects; switch in the Projects page or sidebar
npm run serve:project -- /path/to/project-a /path/to/project-b

# Project with a custom .loop output directory
node server/index.mjs --repo /path/to/project --out .loop
```

Project mode uses a persistent registry at `~/.self-loop/projects.json`.
`--repo` registers projects on first use; later starts load the registry even
without `--repo`. Added projects must be a Git repository or contain
`.self-loop.json` / `.loop`. The API accepts a path only on an authenticated
`POST /api/projects`, never on read routes.

Options:

```bash
node server/index.mjs --port 4317 --host 127.0.0.1
node server/index.mjs --repo /path/to/project
node server/index.mjs --projects-file ~/.self-loop/projects.json
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
  `state.json`, `inbox.json`, or `outbox.json` changes.
- `POST /api/tick` runs `node scripts/router.mjs tick --repo <target>`.
- `POST /api/tickets/:id/retry` runs `node scripts/router.mjs recover`.
- `POST /api/tickets/:id/cancel` runs `node scripts/router.mjs cancel`.
- `POST /api/outbox/flush` runs `node scripts/router.mjs outbox flush`.
- `POST /api/outbox/:id/replay` runs `node scripts/router.mjs outbox retry`.
- `POST /api/connectors/jira/sync` runs one Jira incremental scan and posts
  normalized events through `router post --type task`.
- Slack `POST /hooks/slack` is signature-verified and also posts a durable
  `task` event through the Router lock boundary.
- Demo-only actions return `409`: pause, event injection, source/worker edits,
  config edits, answer, and approve.
- The Router remains the only writer of Ticket state. The console does not
  import core scripts to mutate state directly.
- Outbox history comes from the real `.loop/outbox.json`. Flush is explicit so
  Router tick never blocks on external APIs.

## API

`GET` endpoints are local-only and reject cross-site Origins. `POST` and
`PATCH` also require the write token.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | health, mode, project, auth boundary |
| `GET` | `/api/state` | full console snapshot |
| `GET` | `/api/overview` | dashboard counters |
| `GET` | `/api/stream` | SSE state stream |
| `GET` | `/api/projects` | registered projects with live health/counts |
| `POST` | `/api/projects` | register a local project path |
| `POST` | `/api/projects/select` | switch the active project |
| `POST` | `/api/projects/:id/select` | switch the active project |
| `DELETE` | `/api/projects/:id` | remove a project (never the last one) |
| `POST` | `/api/auth/rotate` | rotate the local write token |
| `GET` | `/api/events` | inbox events |
| `POST` | `/api/events` | inject an event (demo only) |
| `GET` | `/api/tickets` | tickets, optional `state` |
| `GET` | `/api/tickets/:id` | ticket, attempts, deliveries, timeline |
| `POST` | `/api/tickets/:id/answer` | answer a blocked ticket (demo only) |
| `POST` | `/api/tickets/:id/retry` | requeue a blocked/failed ticket |
| `POST` | `/api/tickets/:id/cancel` | stop a running Attempt and drop the ticket |
| `POST` | `/api/tickets/:id/approve` | accept review; never merges (demo only) |
| `GET` | `/api/outbox` | delivery queue |
| `POST` | `/api/outbox/flush` | send due deliveries |
| `POST` | `/api/outbox/:id/replay` | requeue a failed/dead delivery |
| `POST` | `/api/connectors/jira/sync` | run one Jira incremental sync |
| `GET` | `/api/workers` | worker pool |
| `POST` | `/api/workers/:id/toggle` | pause/resume a worker (demo only) |
| `GET` | `/api/sources` | connectors |
| `POST` | `/api/sources` | add a connector config (demo only) |
| `PATCH` | `/api/sources/:id` | update connector config (demo only) |
| `POST` | `/api/sources/:id/toggle` | pause/resume a connector (demo only) |
| `POST` | `/hooks/github` | signed GitHub webhook ingress |
| `POST` | `/hooks/slack` | signed Slack Events API / `/loop` ingress |
| `GET` | `/api/audit` | Router audit plus console write audit |
| `GET` | `/api/config` | resolved runtime config |
| `PATCH` | `/api/config` | update runtime config (demo only) |
| `POST` | `/api/tick` | run one Router tick |

## GitHub webhook

Demo mode configures the secret on the GitHub Source. Project mode reads
`connectors.github.webhookSecretEnv` (default
`SELF_LOOP_GITHUB_WEBHOOK_SECRET`, falling back to
`GITHUB_WEBHOOK_SECRET`), selects the registered project by
`repository.full_name`, and writes the event into that project's real
`.loop/inbox.json` through `router post`.

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

## Slack ingress

Enable Slack in `.self-loop.json`:

```json
{
  "connectors": {
    "slack": {
      "enabled": true,
      "signingSecretEnv": "SLACK_SIGNING_SECRET",
      "botTokenEnv": "SLACK_BOT_TOKEN",
      "allowedChannels": ["C01234567"],
      "respondToMessages": false
    }
  }
}
```

Point the Slack app at `http://<local-host>:4317/hooks/slack`. The handler:

- verifies `X-Slack-Signature` against the raw body and rejects timestamps more
  than five minutes old;
- selects the registered project by per-project signing secret (and
  `allowedChannels` when several projects match);
- answers `url_verification`;
- accepts `app_mention`, configured `message` events, and `/loop`;
- deduplicates on team + channel + timestamp, or slash-command `trigger_id`;
- returns an immediate ephemeral acknowledgement for `/loop`;
- forwards `task` events through the Router and preserves channel + `thread_ts`
  so Outbox replies stay in the thread.

Slash syntax:

```text
/loop Fix login redirect | redirect works; regression test added
```

## Jira incremental sync

Jira configuration lives under `connectors.jira`; the token stays in the named
environment variable. The console polls each registered project at
`pollMinutes`, and the Sources page has a manual **立即同步** action.

The key/value pairs live at `.loop/connectors/jira.json`. The connector:

- combines the configured JQL with an incremental `updated >=` clause;
- follows Jira pagination and maps title/body/acceptance/priority/labels/status
  from `fieldMap`;
- creates `jira.issue.created`, `jira.issue.transitioned`, or
  `jira.issue.updated` task events;
- advances its cursor only after the full scan succeeds;
- surfaces 429, authentication, and network errors as `degraded` without losing
  the previous cursor.

Jira status never substitutes for a Router gate or a Verifier result.

## What is real

- Demo Router: events, Tickets, Attempts, deliveries, workers, and audit state.
- Project Router: real `.loop/state.json`, `.loop/inbox.json`, Ticket records,
  `.loop/outbox.json`, Attempt artifacts, and the core lock.
- Deduplication, event consumption, concurrency limits, leases, retries, dead
  letters, and human handoff.
- GitHub webhook raw-body HMAC-SHA256 verification and delivery-id dedupe.
- Slack raw-body signing-secret verification, replay window, `/loop`, and
  thread-aware writeback.
- Jira incremental polling with a durable cursor, field mapping, pagination,
  429 backoff visibility, and auth-error degradation.
- Local write token, same-origin session, Origin checks, rotation, and audit.
- Persistent multi-repository registry, project switching, add/remove.
- Executor adapter registration, timeouts, process-death detection, and cancel.
- Real GitHub/Jira/Slack Outbox adapters with retry, 429 backoff, dead-letter,
  request ids, and stable idempotency keys.
- SSE live updates and the HTTP API.
- Optional SQLite storage with transactional Ticket/Inbox/Outbox writes,
  migration, JSON mirror, and database-enforced unique idempotency keys.

## What is simulated or absent

- Demo Worker execution is a timer. Project mode starts the configured executor
  only through `router tick`, never from the web process.
- Demo Verifier evidence is synthetic; project mode surfaces real verifier
  evidence when the Router has written it.
- Demo connector cards and their event feed remain synthetic.
- Jira polling and Slack webhook handlers are implemented, but hosted OAuth app
  installation, secret rotation, and multi-tenant credential storage are not.
- SQLite is optional and single-machine. The default JSON store remains the
  compatibility path; there is no PostgreSQL, multi-tenancy, SSO, RBAC, or
  hosted deployment.

## Design boundaries

- The Router is the only writer of Ticket state.
- Workers write Attempt artifacts and the PR body; the Verifier writes evidence
  only.
- Inbox events wake the Router and hint at priority. They never authorize work.
- Outbox is a delivery queue, not a task archive.
- The console never merges a pull request or pushes a default branch.
- The server is optional. Core scripts do not import `server/`.
