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

- `issue-loop`, hourly by default;
- `retro-loop`, daily at 06:30 by default;
- disabled by default so you can inspect one manual run first.

The generated prompt calls the installed skill's
`scripts/run.mjs` with an explicit `--repo`, for example:

```text
node "/skills/self-loop/scripts/run.mjs" triage --repo "/work/project"
```

There is no project-local `loop/` directory. If you move the installed skill,
rerun `setup.mjs --replace` so prompts and the precheck keep valid paths.

## Commands

```bash
orca automations list --json
orca automations run <automationId> --json
orca automations edit <automationId> --enabled --json
```

## Verify

```bash
node "$SELF_LOOP_SKILL/scripts/run.mjs" triage --repo "$TARGET_REPO"
node "$SELF_LOOP_SKILL/scripts/run.mjs" select --repo "$TARGET_REPO" --no-claim
node "$SELF_LOOP_SKILL/scripts/run.mjs" retro --repo "$TARGET_REPO"
```

`select` exits `3` when no issue is eligible and `2` when token, network, or
claiming fails. Review `.loop/triage.md` before enabling an automation.
