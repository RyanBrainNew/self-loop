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
| `GET` | `/api/automations` | scheduled automation definitions |
| `POST` | `/api/automations` | create an automation |
| `PATCH` | `/api/automations/:id` | edit automation name, schedule, labels, or acceptance |
| `DELETE` | `/api/automations/:id` | remove an automation |
| `GET` | `/api/automations/:id/history` | recent automation run history |
| `POST` | `/api/automations/:id/toggle` | enable or pause an automation |
| `POST` | `/api/automations/:id/run` | run an automation now |
| `GET` | `/api/workers` | local and remote worker pools |
| `POST` | `/api/workers/register` | register a remote worker and return its token |
| `POST` | `/api/workers/:id/rotate` | rotate a remote worker token |
| `DELETE` | `/api/workers/:id` | revoke a remote worker |
| `POST` | `/api/remote/heartbeat` | worker-token heartbeat |
| `POST` | `/api/remote/claim` | worker-token claim of one queued Ticket |
| `POST` | `/api/remote/complete` | worker-token Result Envelope submission |
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
| `GET` | `/api/observability` | queue and worker health summary |
| `GET` | `/metrics` | Prometheus text metrics |

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

PR comments can request follow-up work without turning every review comment
into a Ticket. A comment on a pull request (including `pull_request_review`
and `pull_request_review_comment` payloads) is normalized when it contains
`/loop` or `@self-loop`. The resulting `task` event carries `prNumber`,
`commentId`, `commentUrl`, and a stable external id, so the follow-up Ticket
stays traceable to the review thread and webhook retries are idempotent.

`GET /api/audit` accepts `action`, `actor`, `source`, `ok`, `q`, `before`, and
`limit` query parameters and returns both the filtered list and a merged
`entries` stream. The Policy page uses the same fields for its search table.

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

## Automations

The Automations page reads `.loop/automations.json`. Project-mode writes call
`router automations add|toggle|run`, so the Router keeps the same lock and the
same gate sequence. `router tick` runs any due automation and appends one
`task` event; the event does not become a Ticket until the normal drain step.

Demo mode keeps an in-memory automation list and a 30-second checker so the UI
could be exercised without a real repository.

## Remote workers

`POST /api/workers/register` requires the console session/token and returns a
one-time `sw_...` worker token. The token is stored only as a SHA-256 hash in
`.loop/workers.json`.

Remote workers call:

```text
POST /api/remote/heartbeat   Authorization: Bearer sw_...
POST /api/remote/claim       Authorization: Bearer sw_...
POST /api/remote/complete    Authorization: Bearer sw_...
```

`claim` returns the Task Card, Context Packet paths, lease, and Ticket. The
worker executes on its own machine and submits a Result Envelope. The Router
applies it; the independent Verifier runs on the next tick. Remote endpoints
are project-mode only and reject cross-site Origins.

## Observability and backup

- `GET /api/observability` returns queue lengths, worker health, and state
  counts for dashboards.
- `GET /metrics` returns Prometheus text metrics with stable zero-valued
  series for known ticket/delivery states.
- The `Observability / 可观测性` page combines queue health, ticket and
  delivery distributions, connector/Worker health, and actionable alerts.
- `deploy/prometheus/self-loop.rules.yml` contains starter alert rules.
- `npm run backup -- --repo <repo>` writes a timestamped backup with a
  manifest; `npm run restore -- --repo <repo> --backup <dir> --dry-run`
  previews a restore. `worktrees/` is excluded and `artifacts/` is opt-in.
- systemd tick/backup examples and the full recovery runbook live in
  [`docs/OPERATIONS.md`](../docs/OPERATIONS.md).

## Themes and bilingual UI

The console ships four themes (Graphite, Ocean, Plum, Paper) selectable in the
top bar and persisted in localStorage. English technical terms carry a Chinese
short label; the Glossary page (`#/glossary`) gives a plain-language
explanation for every term. The shell includes a skip link, `main` landmark,
`aria-current` navigation, and labelled controls.

Browser E2E is a dev-only dependency:

```bash
npm ci
npx playwright install chromium
npm run test:e2e:console
```

It starts a two-project fixture, walks every primary route, runs axe WCAG 2
A/AA checks, and verifies theme persistence, project switching, audit filters,
and the glossary. See `tests/console/`.

## Hosted control-plane contract

The local console is still local-first. `server/hosted-rbac.mjs` defines the
default-deny tenant/project role matrix for the future hosted service, and
`migrations/001_hosted.sql` defines PostgreSQL tables, idempotency constraints,
optimistic versions, indexes, and tenant-isolation RLS policies. See
[`docs/HOSTED-PHASE-1.md`](../docs/HOSTED-PHASE-1.md) for what is implemented
versus still deferred.

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
