# Keep the core scheduler-agnostic

Status: accepted

The self-loop core must run from Node, cron, CI, or another scheduler without
requiring Orca. Orca is an optional adapter under `adapters/orca/`; it may
provide scheduling, prompts, and worktree setup, but the core exposes explicit
CLI commands and accepts `--repo`.

This was chosen over embedding Orca commands in the core because scheduler
lock-in would make the skill unusable outside Orca and would put orchestration
policy in the wrong layer. The cost is that each adapter must supply its own
execution wiring.
