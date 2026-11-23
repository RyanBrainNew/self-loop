# AGENTS.md

## Repository purpose

This repository is the installable `self-loop` skill plus an optional local web
console. `SKILL.md` is the routing document; detailed workflows live in
`references/`. The project is open source under Apache-2.0; keep `LICENSE` and
the `package.json` license field in sync.

## Layout

- `scripts/` - scheduler-agnostic core (`setup-project`, `run`, `triage`,
  `select`, `retro`, `router`, `verifier`, `outbox`, `executors`, `lib`,
  `precheck`, `init-memory`, tests).
- `references/` - workflow, memory, and policy documentation.
- `templates/memory/` - generic project memory templates.
- `adapters/orca/` - optional Orca setup, prompts, and precheck.
- `server/` - local-first Router console: HTTP API, demo seed, project-state
  adapter, persistent multi-repo registry (`project-store.mjs`), local write
  auth, and the dependency-free web UI.
- `site/` - dependency-free static landing page deployed through GitHub Pages.
- `docs/` and `GLOSSARY.md` - accepted design decisions and shared vocabulary.

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
node --test server/server.test.mjs
npm run serve
npm run serve:project -- /path/to/project
node scripts/setup-project.mjs --repo /path/to/project --dry-run
node scripts/init-memory.mjs --repo /path/to/project --dry-run
node scripts/run.mjs router status --repo /path/to/project --json
node scripts/router.mjs outbox flush --repo /path/to/project
```

## Change rules

- Preserve behavior unless the task explicitly changes it.
- Keep scripts dependency-free and Node 20+ compatible.
- Update `references/SETUP.md`, `references/CONFIG.md`, `references/ROUTER.md`,
  and `references/MEMORY.md` when changing setup, configuration, paths, state,
  or workflow behavior.
- Use `rg` for string/config searches; use MCP graph tools when available for
  code discovery.
