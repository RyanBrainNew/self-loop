# AGENTS.md

## Repository purpose

This repository is the installable `self-loop` skill. `SKILL.md` is the routing
document; detailed workflows live in `references/`.

## Layout

- `scripts/` - scheduler-agnostic core (`setup-project`, `run`, `triage`,
  `select`, `retro`, `router`, `verifier`, `lib`, `precheck`, `init-memory`,
  tests).
- `references/` - workflow, memory, and policy documentation.
- `templates/memory/` - generic project memory templates.
- `adapters/orca/` - optional Orca setup, prompts, and precheck.
- `site/` - dependency-free static landing page deployed through GitHub Pages.
- `docs/` and `GLOSSARY.md` - accepted design decisions and shared vocabulary.

## Invariants

- Core scripts must not mention or require Orca.
- Core scripts must not assume the current directory or a project-local `loop/`
  directory. Accept `--repo`, then `SELF_LOOP_REPO`, then legacy `LOOP_REPO`.
- All git operations, output, and memory paths stay inside the target repo.
- Keep the five-label taxonomy and the `ready-for-agent | label:<name> | do |
  off` policies.
- The Router is the only writer of Ticket state. Workers write Attempt
  artifacts and the PR body; the independent Verifier writes evidence only.
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
node scripts/setup-project.mjs --repo /path/to/project --dry-run
node scripts/init-memory.mjs --repo /path/to/project --dry-run
node scripts/run.mjs router status --repo /path/to/project --json
```

## Change rules

- Preserve behavior unless the task explicitly changes it.
- Keep scripts dependency-free and Node 20+ compatible.
- Update `references/SETUP.md`, `references/CONFIG.md`, `references/ROUTER.md`,
  and `references/MEMORY.md` when changing setup, configuration, paths, state,
  or workflow behavior.
- Use `rg` for string/config searches; use MCP graph tools when available for
  code discovery.
