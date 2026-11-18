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

Project configuration lives at `<repo>/.self-loop.json`:

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
accepted. `outDir` and memory paths must stay inside the target repo.

Precedence is CLI > environment > `.self-loop.json` > defaults.

## Environment variables

Every `SELF_LOOP_*` variable has a legacy `LOOP_*` fallback where applicable.

| Purpose | Preferred | Legacy |
| --- | --- | --- |
| Target repo | `SELF_LOOP_REPO` | `LOOP_REPO` |
| Policy | `SELF_LOOP_POLICY` | `LOOP_POLICY` |
| Claim TTL | `SELF_LOOP_CLAIM_TTL_MINUTES` | `LOOP_CLAIM_TTL_MINUTES` |
| Retro days | `SELF_LOOP_RETRO_DAYS` | `LOOP_RETRO_DAYS` |
| Explicit retro window | `SELF_LOOP_RETRO_SINCE` | `LOOP_RETRO_SINCE` |
| Output directory | `SELF_LOOP_OUT_DIR` | `LOOP_OUT_DIR` |
| Lessons path | `SELF_LOOP_LESSONS_PATH` | `LOOP_LESSONS_PATH` |
| Standards path | `SELF_LOOP_CODE_STANDARDS_PATH` | `LOOP_CODE_STANDARDS_PATH` |
| Decisions path | `SELF_LOOP_DECISIONS_PATH` | `LOOP_DECISIONS_PATH` |
| Self login | `SELF_LOOP_SELF_LOGIN` | `LOOP_SELF_LOGIN` |
| Agent command | `SELF_LOOP_AGENT` | `LOOP_AGENT` |
| Max Attempts | `SELF_LOOP_MAX_ATTEMPTS` | `LOOP_MAX_ATTEMPTS` |
| Lease minutes | `SELF_LOOP_LEASE_MINUTES` | `LOOP_LEASE_MINUTES` |
| Max concurrency | `SELF_LOOP_MAX_CONCURRENT` | `LOOP_MAX_CONCURRENT` |
| State lock minutes | `SELF_LOOP_LOCK_MINUTES` | `LOOP_LOCK_MINUTES` |
| Issue comments | `SELF_LOOP_COMMENTS` | `LOOP_COMMENTS` |
| Worktree mode | `SELF_LOOP_WORKTREE_MODE` | `LOOP_WORKTREE_MODE` |
| Worktree directory | `SELF_LOOP_WORKTREE_DIR` | `LOOP_WORKTREE_DIR` |
| Router context chars | `SELF_LOOP_CONTEXT_ROUTER_CHARS` | `LOOP_CONTEXT_ROUTER_CHARS` |
| Worker context chars | `SELF_LOOP_CONTEXT_WORKER_CHARS` | `LOOP_CONTEXT_WORKER_CHARS` |
| Verifier commands | `SELF_LOOP_VERIFY_COMMANDS` | - |
| Verifier timeout | `SELF_LOOP_VERIFY_TIMEOUT_MINUTES` | `LOOP_VERIFY_TIMEOUT_MINUTES` |

GitHub also accepts `GITHUB_TOKEN` / `GH_TOKEN`, and `GITHUB_REPOSITORY` for the
repository slug.

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
