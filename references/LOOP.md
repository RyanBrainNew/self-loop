# Issue Loop Work Reference

> This file describes how to do the work. The policy is supplied by the caller
> (CLI, environment, or `.self-loop.json`), not hard-coded in the repository.

For the deterministic Router, prefer `references/ROUTER.md`. The Router adds
Ticket state, leases, Task Cards, Context Packets, Result Envelopes, and an
independent Verifier around this same issue loop.

## Inputs

Set `SKILL_DIR` to the installed skill directory and `TARGET_REPO` to the project
root.

```bash
node "$SKILL_DIR/scripts/run.mjs" triage --repo "$TARGET_REPO"
node "$SKILL_DIR/scripts/run.mjs" select --repo "$TARGET_REPO" --policy <policy>
```

`triage` writes `.loop/triage.json` and `.loop/triage.md` under the target repo.
`select` writes `.loop/work.json`. If the configured `outDir` is different, use
that directory instead.

- Exit `3` from `select`: no eligible issue; stop without changing code.
- Exit `2`: token, network, or claim failure; report it and stop.
- If `work.json` exists, it is the only issue for this run.

## Labels: reuse the five triage roles

| Label | Meaning | Loop action |
| --- | --- | --- |
| `needs-triage` | Not classified yet | Do not implement |
| `needs-info` | Waiting for the author | Do not implement; information request is allowed |
| `ready-for-agent` | Fully specified | Default queue |
| `ready-for-human` | Requires a person | Do not implement |
| `wontfix` | Explicitly declined | Do not implement |

Do not create `auto`, `in-progress`, or any other label. Re-entry is prevented
by:

- an open PR that closes or fixes the issue;
- an assignee other than this run;
- this run's own claim within `claimTtlMinutes` (default 180);
- an expired claim with no PR becomes eligible again.

## Policy

See `POLICY.md`. The default is `ready-for-agent`. The policy never overrides
the blocking labels above.

## Implementation

1. Read the target repo's `AGENTS.md`, `memory/code-standards.md`,
   `memory/DECISIONS.md`, and `memory/LESSONS.md` when present.
2. Create a branch from the latest default branch, named
   `loop/<N>-<short-slug>` or the project's equivalent convention.
3. Change only what the issue requires. Preserve compatibility unless the issue
   explicitly changes it.
4. Do not assume a stack. Use commands named by `AGENTS.md` or the merge gates,
   then the repository manifest (`package.json`, `Makefile`, `pyproject.toml`,
   etc.).
5. Record every verification command, directory, and result. Write **Not run**
   for anything not executed; never invent a result.

## Delivery

1. Push the branch and open a PR against the default branch.
2. Put `Closes #N` on the first line of the PR body.
3. Explain what changed, what was run, where it ran, and what is **Not run**.
4. Link the PR back to the issue.
5. Never merge. Never push the default branch.

## Boundaries

- Security, data deletion, destructive changes, releases, and product or visual
  direction require a human decision.
- If the issue cannot be reproduced or the environment is missing, stop with an
  explicit **Not run** note.
- If the issue should not be handled by the loop, explain why on the issue and
  stop.
- PR review is a separate workflow. Do not merge as a side effect.
