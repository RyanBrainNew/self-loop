# Orca Adapter (Optional)

The core self-loop commands are scheduler-agnostic. This adapter only creates
Orca automations and supplies an Orca-specific precheck.

## Setup

Install the skill first (see the repository `README.md`), then run:

```bash
node /absolute/path/to/self-loop/adapters/orca/setup.mjs \
  --repo /absolute/path/to/project \
  --policy ready-for-agent \
  --disabled
```

It creates:

- `<owner>-<repo>-issue-loop`, hourly by default;
- `<owner>-<repo>-retro-loop`, daily at 06:30 by default;
- disabled by default so you can inspect one manual run first.

Names are derived from the target repository's GitHub slug, sanitized to
lowercase `[a-z0-9._-]`. Two projects with the same directory name therefore do
not collide. If an older `issue-loop` or `retro-loop` automation exists, rerun
with `--replace` to rename it instead of creating a duplicate.

The generated prompt calls the installed skill's
`scripts/run.mjs` with `--repo .`, so it targets the worktree Orca starts for
the run (including `new_per_run` worktrees):

```text
node "/skills/self-loop/scripts/run.mjs" triage --repo .
```

The project still needs no `loop/` directory. If you move the installed skill,
rerun `setup.mjs --replace` so prompts and the precheck keep valid script paths.

The default adapter prompt keeps the compatible triage/select/agent path. To
use the deterministic Router while Orca owns worktree creation, set
`"router": { "worktreeMode": "external" }` in the target project and have the
scheduled prompt call:

```text
node "/skills/self-loop/scripts/run.mjs" router tick --repo .
```

The Router then keeps Ticket state, leases, and gates, while Orca supplies the
worktree and process. The core still has no Orca dependency.

The generated prompts read `language` from the project config (default
`zh-CN`) and require Chinese PR titles/bodies unless it is set to `en`. To drive
the Router from events instead of the hourly trigger, use `router post` plus
`router tick`; see `prompts.md`.

## Commands

```bash
orca automations list --json
orca automations run <automationId> --json
orca automations edit <automationId> --enabled --json
npm run test:e2e:orca
```

`test:e2e:orca` is a live, no-agent probe: it creates a uniquely named disabled
automation in the current Orca worktree, verifies it through create/list/show,
and removes it in a `finally` block. Evidence is recorded in
`docs/EVIDENCE-ORCA-E2E.md`.

## Optional Router executor adapter

When Orca should launch the Worker instead of the core command adapter, keep
`worktreeMode: "external"` and declare an adapter name plus the exact Orca
command that starts an agent in the current worktree:

```json
{
  "executor": {
    "adapter": "orca",
    "command": ["orca", "..."],
    "timeoutMinutes": 45,
    "capabilities": ["issue-to-pr"]
  },
  "router": {
    "worktreeMode": "external",
    "dispatchMode": "background"
  }
}
```

The command receives the installed `references/WORK.md` path as its final
argument and must write the Result Envelope to `SELF_LOOP_RESULT`. The core
executor registry accepts any custom adapter name without importing this
adapter, so Orca remains optional and absent from core scripts.

## Verify

```bash
node "$SELF_LOOP_SKILL/scripts/run.mjs" triage --repo "$TARGET_REPO"
node "$SELF_LOOP_SKILL/scripts/run.mjs" select --repo "$TARGET_REPO" --no-claim
node "$SELF_LOOP_SKILL/scripts/run.mjs" retro --repo "$TARGET_REPO"
```

`select` exits `3` when no issue is eligible and `2` when token, network, or
claiming fails. Review `.loop/triage.md` before enabling an automation.
