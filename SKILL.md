---
name: self-loop
description: Configure through an agent conversation when a project wants the loop, then run or schedule a project-agnostic issue-to-PR workflow with deterministic routing, independent verification, configurable memory, and merge gates.
---

# self-loop

Use this skill to triage open issues, select eligible issues (one per Worker),
implement each on a branch, open a PR, verify it independently, and run
evidence-based retrospectives. The loop never merges PRs and never pushes the
default branch.

Each Worker implements exactly one Issue. The Router may keep several Tickets in
flight when `router.maxConcurrent` is greater than `1`, and it can be woken by
durable inbox events instead of waiting for the next cron slot.

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
node "$SKILL_DIR/scripts/run.mjs" router post --repo /path/to/project --type issue --ticket 42
node "$SKILL_DIR/scripts/run.mjs" retro --repo /path/to/project
```

`--repo` wins over `SELF_LOOP_REPO`, then legacy `LOOP_REPO`. Git operations,
`.loop/` output, worktrees, and memory paths stay inside the target repository.

## Configure a project through conversation

Run project setup only when the user asks to configure or enable self-loop, or
when they ask for automated issue-to-PR work and the project has no usable
`.self-loop.json`. Do not write project configuration for a one-off triage,
select, or retrospective command.

When setup is needed, read `references/SETUP.md` and follow it as an agent
conversation:

1. Explore the target repository instead of assuming its setup.
2. Report what you found and what can be detected automatically.
3. Ask only about choices that genuinely branch, normally a missing GitHub
   repository or executor.
4. Show the proposed configuration and let the user confirm it.
5. Run the built-in `scripts/setup-project.mjs` helper to apply the agreed
   configuration, then report exactly what was created or preserved.
6. Show the first `router tick --dry-run` command.

The user should not need to memorize Node commands or hand-write JSON. The
helper is the deterministic implementation behind the conversation, not the
user-facing setup method. Re-running setup is safe and never overwrites existing
memory or explicit choices.

Default memory paths are `memory/LESSONS.md`, `memory/code-standards.md`, and
`memory/DECISIONS.md`, all relative to the target repo.

The default `language` is `zh-CN`: PR titles and bodies, plus person-facing
Router text, are Simplified Chinese while code, commands, paths, identifiers,
and verbatim logs stay unchanged. Set `"language": "en"` for English.

Install this repository as a skill (a skill library, a collection repository's
`skills/self-loop` path, or a manual clone). Keep `SKILL.md`, `scripts/`,
`references/`, `templates/`, and optionally `adapters/` together. Locate scripts
from the directory containing this file, not from the target project.

For explicit one-shot initialization with no setup conversation, install the
companion skill from `setup-self-loop/` and invoke `setup-self-loop` directly.

## Read next

- `references/LOOP.md` - issue-loop workflow and delivery rules.
- `references/SETUP.md` - one-time project onboarding and automatic detection.
- `references/ROUTER.md` - deterministic Router, Ticket state, Task Card,
  Context Packet, Result Envelope, leases, worktrees, inbox events, concurrency,
  and verification.
- `references/WORK.md` - implement exactly one selected issue.
- `references/RETRO.md` - turn evidence into durable lessons.
- `references/MEMORY.md` - memory protocol and write permissions.
- `references/CONFIG.md` - advanced configuration and environment variables.
- `references/POLICY.md` - labels, policies, claims, deduplication, exit codes.

Orca is optional. Its scheduler setup and prompts live only under
`adapters/orca/`; the core scripts run from a terminal, cron, or CI without it.
When an external scheduler owns worktree creation, configure
`router.worktreeMode: "external"`; the core still owns Ticket state and gates.
