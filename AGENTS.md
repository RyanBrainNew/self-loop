# AGENTS.md

## Repository purpose

This repository is the installable `self-loop` skill plus an optional local web
console. `SKILL.md` is the routing document; detailed workflows live in
`references/`. The project is open source under Apache-2.0; keep `LICENSE` and
the `package.json` license field in sync.

## Layout

- `scripts/` - scheduler-agnostic core (`setup-project`, `run`, `triage`,
  `select`, `retro`, `router`, `verifier`, `outbox`, `executors`, `lib`,
  `precheck`, `init-memory`, `automations`, `workers`, `backup`, optional
  `sqlite-store`, `migrate-store`, `e2e-executor`, tests).
- `references/` - workflow, memory, and policy documentation.
- `templates/memory/` - generic project memory templates.
- `adapters/orca/` - optional Orca setup, prompts, precheck, and live E2E probe.
- `deploy/` - systemd units and Prometheus alert rules for self-hosting.
- `server/` - local-first Router console: HTTP API, demo seed, project-state
  adapter, persistent multi-repo registry (`project-store.mjs`), local write
  auth, Slack/Jira connector adapters, observability, and the dependency-free
  bilingual web UI. `hosted-rbac.mjs`, `hosted-oidc.mjs`, `hosted-auth.mjs`,
  `hosted-http.mjs`, `hosted-pg.mjs`, `hosted-secrets.mjs`,
  `hosted-ingress.mjs`, and `hosted-index.mjs` are the separate hosted
  OIDC/RBAC/PostgreSQL/connector surface; `migrations/` contains the RLS schema
  and connector migrations.
- `site/` - dependency-free static landing page deployed through GitHub Pages.
- `docs/` and `GLOSSARY.md` - accepted design decisions and shared vocabulary.
- `tests/console/` - Playwright browser E2E and axe accessibility checks.

## Invariants

- Core scripts must not mention or require Orca.
- Core scripts must not import `server/`; the console is an optional caller.
- The console binds to localhost by default and must not be exposed publicly
  without authentication.
- Console writes require the local token or same-origin session; cross-site
  requests are rejected. The token must never enter a URL, read API, or SSE.
- Project-mode console reads `.loop/state.json` / `.loop/inbox.json` /
  `.loop/outbox.json` and must delegate state mutations to
  `scripts/router.mjs` under the same lock. It must not keep a second writable
  Ticket state.
- The console project registry persists in `~/.self-loop/projects.json`
  (`--projects-file` / `SELF_LOOP_CONSOLE_PROJECTS`). One console instance
  serves many registered repos; it never accepts arbitrary filesystem paths
  from the API.
- Router ticks only enqueue Outbox deliveries; outbound network calls happen
  in `router outbox flush`. Delivery history is durable in `.loop/outbox.json`.
- Connectors only append normalized `task` Inbox events through the Router.
  They never write Ticket state directly. A task event still passes Task Card,
  acceptance, lease, and Verifier gates.
- Slack ingress verifies the raw-body signing secret and timestamp window.
  Jira advances `.loop/connectors/jira.json` only after a complete successful
  scan; 429/auth failures preserve the previous cursor.
- Multi-project webhook ingress selects the owning project: GitHub by
  `repository.full_name`, Slack by per-project signing secret and
  `allowedChannels`. Never route an inbound task to the currently selected
  project by accident.
- `storage.backend` is `json` by default. The optional `sqlite` backend uses
  `node:sqlite`, keeps JSON as a mirror, and enforces unique event ids and
  Outbox idempotency keys. The hosted PostgreSQL adapters are separate from
  these local stores and require `DATABASE_URL` plus the optional `pg` package.
- Hosted authorization is default-deny. `server/hosted-rbac.mjs` is the tested
  role contract; hosted queries must include `tenant_id` and set the RLS
  transaction variable. The local write token is never a hosted identity.
  Hosted login uses one-time state/nonce transactions and HttpOnly sessions;
  project and ticket routes resolve membership before reading the database.
  Hosted Ticket claims use `FOR UPDATE SKIP LOCKED` and version predicates;
  hosted HTTP never writes Ticket state.
- Hosted webhook ingress runs before tenant context exists only through the
  controlled `resolve_connector_binding(provider, external_id)` SQL function.
  It must verify the raw-body signature, enforce a per-binding rate limit,
  dedupe by provider delivery id, and insert only normalized Inbox events.
- Connector credentials are encrypted at rest with tenant/project/provider/
  credential AAD. Read APIs return metadata only; plaintext is decrypted only
  for signature verification or an Outbox adapter call. The current
  `HOSTED_SECRET_KEY` is a single local key, not KMS/Secret Manager.
- Scheduled automations only append `task` Inbox events on a due tick. They do
  not bypass Task Card, acceptance, lease, Verifier, or human gates.
- Remote worker tokens are returned once and stored only as SHA-256 hashes in
  `.loop/workers.json`. Remote workers use `claim`/`complete`; the Router still
  applies the Result Envelope and remains the only Ticket-state writer.
- The console UI must keep English technical terms paired with Chinese
  explanations and provide multiple color themes. Accessibility landmarks
  (`main`, skip link, aria labels) are part of the contract.
- GitHub PR review comments only create Tasks when they contain an explicit
  `/loop` or `@self-loop` command. A follow-up keeps the PR/comment link and
  delivery-id dedupe; a plain review comment remains ignored context.
- Core scripts must not assume the current directory or a project-local `loop/`
  directory. Accept `--repo`, then `SELF_LOOP_REPO`, then legacy `LOOP_REPO`.
- All git operations, output, and memory paths stay inside the target repo.
- Keep the five-label taxonomy and the `ready-for-agent | label:<name> | do |
  off` policies.
- The Router is the only writer of Ticket state. Workers write Attempt
  artifacts and the PR body; the independent Verifier writes evidence only.
- Inbox events wake the Router and hint at priority; they never authorize work
  or bypass a gate. Concurrency is bounded by `router.maxConcurrent`.
- Person-facing output follows the project `language` (default `zh-CN`); code,
  commands, paths, identifiers, and verbatim logs stay unchanged.
- Only `retro` and `init-memory` write memory.
- Lease expiry and verification failure consume an Attempt. Retry only below
  `maxAttempts`; otherwise block for `router recover`.
- Never merge PRs or push a default branch from the loop.
- Do not copy product-specific memory from other repositories into templates.
- Project setup is an agent conversation. `setup-project.mjs` is the internal
  deterministic writer and CI fallback, not the user-facing onboarding flow.

## Commands

```bash
npm test
node --test scripts/self-loop.test.mjs
node --test scripts/sqlite-store.test.mjs
node --test server/server.test.mjs
npm run serve
npm run serve:project -- /path/to/project
npm run serve:hosted
npm run migrate:sqlite -- --repo /path/to/project --dry-run
npm run test:e2e:codex
npm run test:e2e:console
npm run test:e2e:orca
npm run test:github:live -- --repo owner/name
node scripts/setup-project.mjs --repo /path/to/project --dry-run
node scripts/init-memory.mjs --repo /path/to/project --dry-run
node scripts/run.mjs router status --repo /path/to/project --json
node scripts/router.mjs outbox flush --repo /path/to/project
node scripts/run.mjs router automations list --repo /path/to/project
node scripts/run.mjs router workers list --repo /path/to/project
npm run backup -- --repo /path/to/project
npm run release:check
curl http://127.0.0.1:4317/metrics
```

## Change rules

- Preserve behavior unless the task explicitly changes it.
- Keep scripts dependency-free and Node 20+ compatible.
- Update `references/SETUP.md`, `references/CONFIG.md`, `references/ROUTER.md`,
  and `references/MEMORY.md` when changing setup, configuration, paths, state,
  or workflow behavior.
- Keep `node:sqlite` optional so Node 20 and dependency-free JSON mode keep
  working. Do not make a real agent login a CI prerequisite.
- Browser E2E uses Playwright + axe as dev-only dependencies and must keep the
  core runtime dependency-free. Real Claude/Orca checks stay opt-in.
- Use `rg` for string/config searches; use MCP graph tools when available for
  code discovery.
