# self-loop console (MVP)

A local-first web control plane for the Router. It shows the whole shape:
Sources → Inbox → Ticket → Attempt → Verifier → Outbox, plus Workers and
Policy.

## Run

```bash
npm run serve
# open http://127.0.0.1:4317
```

Options:

```bash
node server/index.mjs --port 4317 --host 127.0.0.1
node server/index.mjs --data .self-loop/state.json
node server/index.mjs --reset        # replace state with demo data
node server/index.mjs --no-demo      # no synthetic events
node server/index.mjs --no-tick      # start paused
```

State lives in `.self-loop/state.json` by default and is gitignored. The MVP
binds to localhost and has no authentication. Do not expose it to a public
network.

## What is real

- Durable event, Ticket, Attempt, Delivery, Worker, and audit state.
- Deduplication, event consumption, concurrency limits, leases, retries, dead
  letters, and human handoff.
- GitHub webhook ingress with raw-body HMAC-SHA256 verification and delivery-id
  deduplication.
- A live console over Server-Sent Events.
- Console actions: inject an event, answer a blocked Ticket, retry, cancel,
  approve, replay a delivery, pause the Router, pause a Worker.
- Connector configuration and source health.

## What is simulated

- Worker execution is a timer. No agent runs a real task.
- Verifier evidence is synthetic. No gate runs against a worktree.
- Jira and Slack connectors store configuration only. OAuth, provider-specific
  rate limits, and external API writes are not implemented.
- GitHub API polling and outbound GitHub writes are not implemented. The
  inbound webhook path is real.
- The JSON store is single-process. There is no database, multi-tenancy, SSO,
  RBAC, or hosted deployment.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | health and mode |
| `GET` | `/api/state` | full snapshot |
| `GET` | `/api/overview` | dashboard counters |
| `GET` | `/api/stream` | SSE state stream |
| `GET` | `/api/events` | inbox events |
| `POST` | `/api/events` | inject an event |
| `GET` | `/api/tickets` | tickets, optional `state` |
| `GET` | `/api/tickets/:id` | ticket, attempts, deliveries, timeline |
| `POST` | `/api/tickets/:id/answer` | answer a blocked ticket |
| `POST` | `/api/tickets/:id/retry` | requeue a blocked/failed ticket |
| `POST` | `/api/tickets/:id/cancel` | drop a ticket |
| `POST` | `/api/tickets/:id/approve` | accept review; never merges |
| `GET` | `/api/outbox` | delivery queue |
| `POST` | `/api/outbox/:id/replay` | replay a failed/dead delivery |
| `GET` | `/api/workers` | worker pool |
| `POST` | `/api/workers/:id/toggle` | pause/resume a worker |
| `GET` | `/api/sources` | connectors |
| `POST` | `/api/sources` | add a connector config |
| `PATCH` | `/api/sources/:id` | update connector name or config |
| `POST` | `/api/sources/:id/toggle` | pause/resume a connector |
| `POST` | `/hooks/github` | signed GitHub webhook ingress |
| `GET` | `/api/audit` | audit log |
| `GET` | `/api/config` | runtime config |
| `PATCH` | `/api/config` | update runtime config |
| `POST` | `/api/tick` | run one Router tick |

## GitHub webhook

Configure a GitHub Source with a secret. The API masks the secret in reads but
stores it in the local JSON state; do not share that state file.

```powershell
$body = @{ config = @{ webhookSecret = $env:GITHUB_WEBHOOK_SECRET } } | ConvertTo-Json
Invoke-RestMethod -Method Patch `
  -Uri http://127.0.0.1:4317/api/sources/src_github `
  -ContentType application/json -Body $body
```

Point the GitHub webhook at `http://<local-host>:4317/hooks/github`, content
type `application/json`, and the same secret. For a remote GitHub repository,
put a local tunnel in front of the console; do not expose the console directly
to the public network.

Supported issue actions are `opened`, `reopened`, `labeled`, and `edited`.
`edited` is visible in Inbox but recorded as ignored because metadata changes
do not create a new Ticket. Every delivery is deduplicated by
`X-GitHub-Delivery`.

## Design boundaries

- The Router is the only writer of Ticket state.
- Workers write Attempt artifacts and the PR body; the Verifier writes evidence
  only.
- Inbox events wake the Router and hint at priority. They never authorize work.
- Outbox is a delivery queue, not a task archive.
- The console never merges a pull request or pushes a default branch.
- The server is optional. Core scripts do not import it.
