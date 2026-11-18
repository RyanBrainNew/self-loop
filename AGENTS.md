# AGENTS.md

## Repository purpose

This repository is the installable `self-loop` skill. `SKILL.md` is the routing
document; detailed workflows live in `references/`.

## Layout

- `scripts/` - scheduler-agnostic core (`run`, `triage`, `select`, `retro`,
  `lib`, `precheck`, `init-memory`, tests).
- `references/` - workflow, memory, and policy documentation.
- `templates/memory/` - generic project memory templates.
- `adapters/orca/` - optional Orca setup, prompts, and precheck.

## Invariants

- Core scripts must not mention or require Orca.
- Core scripts must not assume the current directory or a project-local `loop/`
  directory. Accept `--repo`, then `SELF_LOOP_REPO`, then legacy `LOOP_REPO`.
- All git operations, output, and memory paths stay inside the target repo.
- Keep the five-label taxonomy and the `ready-for-agent | label:<name> | do |
  off` policies.
- Never merge PRs or push a default branch from the loop.
- Do not copy product-specific memory from other repositories into templates.

## Commands

```bash
npm test
node --test scripts/self-loop.test.mjs
node scripts/init-memory.mjs --repo /path/to/project --dry-run
```

## Change rules

- Preserve behavior unless the task explicitly changes it.
- Keep scripts dependency-free and Node 20+ compatible.
- Update `references/` when changing configuration, paths, or workflow behavior.
- Use `rg` for string/config searches; use MCP graph tools when available for
  code discovery.
