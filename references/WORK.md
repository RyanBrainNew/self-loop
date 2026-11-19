# Work Reference: One Selected Issue

> The issue number comes from `work.json` in the configured output directory or
> from `ISSUE_NUMBER`. A Worker does one issue per dispatch even when the Router
> runs several Tickets concurrently.

## Output language

The language comes from the Context Packet (`language`), the Task Card
(`language`), and `SELF_LOOP_LANGUAGE`. The default is `zh-CN`.

- `zh-CN`: write the PR title and body in Simplified Chinese. Keep code,
  commands, paths, identifiers, and verbatim log lines unchanged. Keep the
  closing reference `Closes #N` literal so GitHub can link it.
- `en`: write the PR title and body in English, with the same exclusions.

Do not translate a command or an error message that was copied from a real run;
put the Chinese explanation around it.

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
2. Write the title and body in the configured language; do not leave English
   prose when `language` is `zh-CN`.
3. List each acceptance check with command, directory, and result.
4. Mark everything else **Not run**.
5. Link the PR back to the issue.
6. Do not merge and do not push the default branch.

When dispatched by the Router, also write the Result Envelope named by
`SELF_LOOP_RESULT`. Use the schema in `ROUTER.md`; do not edit `.loop/state.json`
or any memory file. The Router owns Issue status comments; the Worker owns only
the PR body.

## Boundaries

- Security, destructive changes, releases, and product direction require a human.
- Missing environment or credentials means **Not run**, not a guessed result.
- If the work does not belong in the loop, explain on the issue and stop.
