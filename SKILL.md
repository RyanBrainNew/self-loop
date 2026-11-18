---
name: self-loop
description: Run or schedule a project-agnostic issue implementation loop and retrospective loop for a GitHub repository, with configurable memory and merge gates.
---

# self-loop

Use this skill to triage open issues, select one eligible issue, implement it on
a branch, open a PR, and run evidence-based retrospectives. The loop never
merges PRs and never pushes the default branch.

## Locate the skill files

Set `SKILL_DIR` to the directory containing this `SKILL.md`. The scripts are at
`$SKILL_DIR/scripts/`, references at `$SKILL_DIR/references/`, and memory
templates at `$SKILL_DIR/templates/memory/`.

The target project does **not** need a `loop/` directory. Always pass the project
root explicitly:

```bash
node "$SKILL_DIR/scripts/run.mjs" triage --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" select --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" retro --repo /path/to/project
```

## First run

```bash
node "$SKILL_DIR/scripts/init-memory.mjs" --repo /path/to/project
node "$SKILL_DIR/scripts/run.mjs" triage --repo /path/to/project
```

`init-memory` creates the configured memory files and never overwrites existing
ones. Defaults are `memory/LESSONS.md`, `memory/code-standards.md`, and
`memory/DECISIONS.md`, all relative to the target repo.

## Read next

- `references/LOOP.md` - issue-loop workflow and delivery rules.
- `references/WORK.md` - implement exactly one selected issue.
- `references/RETRO.md` - turn evidence into durable lessons.
- `references/MEMORY.md` - memory protocol and configuration.
- `references/POLICY.md` - labels, policies, claims, deduplication, exit codes.

Orca is optional. Its scheduler setup and prompts live only under
`adapters/orca/`; the core scripts run from a terminal, cron, or CI without it.
