# self-loop

A project-agnostic issue and retro loop.

This repository was bootstrapped from the `loop/` template in
`RyanBrainNew/mind-tree-learn`. The imported snapshot lives in `loop/`; the
repository is being refactored into an installable agent skill with an optional
Orca adapter.

Design constraints:

- Core scripts run standalone: manual invocation, cron, or CI.
- Orca automation is optional, never a requirement.
- `memory/LESSONS.md`, `memory/code-standards.md`, and `memory/DECISIONS.md`
  remain first-class project inputs.
- The loop never merges PRs and never pushes the default branch.
