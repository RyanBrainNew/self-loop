---
name: self-loop
description: Set up once per project, then run or schedule a project-agnostic issue-to-PR loop with deterministic routing, independent verification, configurable memory, and merge gates.
---

# self-loop

Use this skill to triage open issues, select one eligible issue, implement it on
a branch, open a PR, verify it independently, and run evidence-based
retrospectives. The loop never merges PRs and never pushes the default branch.

The Router is a deterministic control plane. An LLM may advise on triage, a Task
Card draft, or semantic review, but it cannot grant authority or override a
gate. Only `retro` and `init-memory` write project memory.

## Locate the skill files

Set `SKILL_DIR` to the directory containing this `SKILL.md`. The scripts are at
`$SKILL_DIR/scripts/`, references at `$SKILL_DIR/references/`, and memory
templates at `$SKILL_DIR/templates/memory/`.

The target project does **not** need a `loop/` directory. Always pass the project
root explicitly:

```bash
node "$SKILL_DIR/scripts/run.mjs" triage --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" select --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" router tick --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" retro --repo /path/to/project
```

`--repo` wins over `SELF_LOOP_REPO`, then legacy `LOOP_REPO`. Git operations,
`.loop/` output, worktrees, and memory paths stay inside the target repository.

## First run in a project

```bash
node "$SKILL_DIR/scripts/setup-project.mjs" --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" router tick --repo /path/to/project --dry-run
```

Run setup once. It detects the GitHub repository, executor, verifier commands,
and memory location; writes `.self-loop.json`; creates missing memory; updates
`.gitignore`; and tries to create the five role labels. Re-running is safe and
does not overwrite existing choices or memory.

Ask the user only when setup reports a genuinely missing choice, such as no
executor. Do not ask them to hand-write the full configuration. Default memory
paths are `memory/LESSONS.md`, `memory/code-standards.md`, and
`memory/DECISIONS.md`, all relative to the target repo.

Install this repository as a skill (Magpie Library, a collection repository's
`skills/self-loop` path, or a manual clone). Keep `SKILL.md`, `scripts/`,
`references/`, `templates/`, and optionally `adapters/` together. Locate scripts
from the directory containing this file, not from the target project.

## Read next

- `references/LOOP.md` - issue-loop workflow and delivery rules.
- `references/SETUP.md` - one-time project onboarding and automatic detection.
- `references/ROUTER.md` - deterministic Router, Ticket state, Task Card,
  Context Packet, Result Envelope, leases, worktrees, and verification.
- `references/WORK.md` - implement exactly one selected issue.
- `references/RETRO.md` - turn evidence into durable lessons.
- `references/MEMORY.md` - memory protocol and write permissions.
- `references/CONFIG.md` - advanced configuration and environment variables.
- `references/POLICY.md` - labels, policies, claims, deduplication, exit codes.

Orca is optional. Its scheduler setup and prompts live only under
`adapters/orca/`; the core scripts run from a terminal, cron, or CI without it.
When an external scheduler owns worktree creation, configure
`router.worktreeMode: "external"`; the core still owns Ticket state and gates.
