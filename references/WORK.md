# Work Reference: One Selected Issue

> The issue number comes from `work.json` in the configured output directory or
> from `ISSUE_NUMBER`. Do only one issue per run.

## 1. Confirm the target

- Read the selected `work.json`.
- If it is missing, print `no issue to work` and stop.
- If the issue has an open PR, is assigned to another person, or is already
  closed, stop. Do not duplicate work.

## 2. Read project rules

Read these when they exist:

- `AGENTS.md` - routing and required checks;
- `memory/code-standards.md` - merge gates;
- `memory/DECISIONS.md` - settled decisions that must not be silently changed;
- `memory/LESSONS.md` - prior mistakes and proven practices.

Configured memory paths may differ. Resolve them from `.self-loop.json` or the
environment rather than assuming the defaults.

## 3. Implement

1. Update the default branch with `git pull --ff-only`, then create
   `loop/<N>-<short-slug>`.
2. Make the smallest coherent change that satisfies the issue.
3. Run the project's gates. Prefer commands from `AGENTS.md` or
   `code-standards.md`; otherwise inspect the manifest.
4. If verification is impossible, record **Not run** and the missing dependency.
5. Squash incidental intermediate commits into one clean commit when appropriate.

## 4. Deliver

1. Push the branch and open a PR. Start the body with `Closes #N`.
2. List each acceptance check with command, directory, and result.
3. Mark everything else **Not run**.
4. Link the PR back to the issue.
5. Do not merge and do not push the default branch.

When dispatched by the Router, also write the Result Envelope named by
`SELF_LOOP_RESULT`. Use the schema in `ROUTER.md`; do not edit `.loop/state.json`
or any memory file. The Router owns Issue status comments; the Worker owns only
the PR body.

## Boundaries

- Security, destructive changes, releases, and product direction require a human.
- Missing environment or credentials means **Not run**, not a guessed result.
- If the work does not belong in the loop, explain on the issue and stop.
