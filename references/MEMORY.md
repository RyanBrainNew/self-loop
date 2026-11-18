# Memory Protocol

Self-loop keeps project memory in three files under the target repository:

| File | Purpose | Default |
| --- | --- | --- |
| `LESSONS.md` | Mistake log with evidence | `memory/LESSONS.md` |
| `code-standards.md` | Hard merge gates | `memory/code-standards.md` |
| `DECISIONS.md` | Settled decisions | `memory/DECISIONS.md` |

The templates in `$SKILL_DIR/templates/memory/` are generic. Do not copy another
project's product-specific lessons.

## Initialization

The normal project path is the one-time setup command:

```bash
node "$SKILL_DIR/scripts/setup-project.mjs" --repo "$TARGET_REPO"
```

It creates only missing files. If memory is the only thing needed, the smaller
command is:

```bash
node "$SKILL_DIR/scripts/init-memory.mjs" --repo "$TARGET_REPO"
```

The command creates missing files and leaves existing files untouched. It also
accepts:

```bash
--memory-dir docs/memory
--lessons docs/memory/LESSONS.md
--standards docs/memory/code-standards.md
--decisions docs/memory/DECISIONS.md
--dry-run
```

All paths resolve relative to `--repo`. Paths that escape the target repository
are rejected.

## Configuration

Project configuration lives at `<repo>/.self-loop.json`. Setup writes it
automatically. The full field and environment reference is in `CONFIG.md`.

The memory-specific part can look like:

```json
{
  "policy": "ready-for-agent",
  "claimTtlMinutes": 180,
  "retroDays": 2,
  "outDir": ".loop",
  "githubRepo": "owner/name",
  "memory": {
    "lessons": "memory/LESSONS.md",
    "codeStandards": "memory/code-standards.md",
    "decisions": "memory/DECISIONS.md"
  }
}
```

Top-level `lessonsPath`, `codeStandardsPath`, and `decisionsPath` are also
accepted. Memory paths must stay inside the target repo. CLI and environment
overrides still work for CI or one-off runs.

## Rules

- `LESSONS.md` records evidence and executable rules, not status updates.
- `code-standards.md` contains gates backed by repeated evidence.
- `DECISIONS.md` records settled constraints. Changing one requires a new entry
  and an explicit reason, not a silent rewrite.
- Read all three before implementation and retro work when they exist.
- Never overwrite history. Supersede it and link the replacement.
- Retro windows use the last commit touching the lessons file so state survives
  fresh worktrees and CI runners.
- Only `retro` and `init-memory` write these files. A Worker proposes a lesson
  in its Result Envelope; a Verifier writes evidence artifacts only.
