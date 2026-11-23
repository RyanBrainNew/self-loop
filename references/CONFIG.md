# Configuration Reference

Most projects should use the agent-facing setup conversation once and not edit
this file by hand. The bundled `scripts/setup-project.mjs` is the deterministic
writer behind that conversation. Configuration is project-local and lives at:

```text
<target-repo>/.self-loop.json
```

All paths are resolved relative to the target repository and must stay inside
it. Precedence is:

```text
CLI > environment > .self-loop.json > defaults
```

## Minimal example

Setup usually writes a small version of this:

```json
{
  "githubRepo": "owner/name",
  "language": "zh-CN",
  "executor": {
    "command": ["codex", "exec", "--full-auto"]
  },
  "verifier": {
    "commands": ["npm test", "npm run lint"]
  }
}
```

## Top-level fields

| Field | Default | Meaning |
| --- | --- | --- |
| `language` | `zh-CN` | Language for PR titles/bodies and person-facing Router text: `zh-CN` or `en` |
| `policy` | `ready-for-agent` | `ready-for-agent`, `label:<name>`, `do`, or `off` |
| `claimTtlMinutes` | `180` | How long another run treats an assignment as a live claim |
| `retroDays` | `2` | Fallback retrospective window |
| `outDir` | `.loop` | Router state, artifacts, locks, and worktrees |
| `githubRepo` | `origin` remote | GitHub `owner/name` |
| `lessonsPath` | `memory/LESSONS.md` | Top-level override for the mistake log |
| `codeStandardsPath` | `memory/code-standards.md` | Top-level merge-gate override |
| `decisionsPath` | `memory/DECISIONS.md` | Top-level decision-log override |

The three memory paths can also be nested under `memory`:

```json
{
  "memory": {
    "lessons": "memory/LESSONS.md",
    "codeStandards": "memory/code-standards.md",
    "decisions": "memory/DECISIONS.md"
  }
}
```

`lessonsPath`, `codeStandardsPath`, and `decisionsPath` are accepted at the top
level as aliases. Setup writes the nested form when `--memory-dir` is used.

## Executor

```json
{
  "executor": {
    "adapter": "codex",
    "command": ["codex"],
    "args": [],
    "timeoutMinutes": 45,
    "concurrency": 1,
    "capabilities": ["issue-to-pr"]
  },
  "verifier": {
    "commands": ["npm test", "npm run lint"]
  }
}
```

The older explicit form remains valid and takes precedence:

```json
{
  "executor": {
    "command": ["codex", "exec", "--full-auto"],
    "args": []
  }
}
```

`command` may be an array (preferred, no shell) or a command string (run through
a shell). Built-in adapters are `command`, `codex`, and `claude`. A custom adapter
name is accepted as a generic command adapter; scheduler-specific integrations
live under `adapters/`. `timeoutMinutes` bounds one Attempt. `concurrency` and
`capabilities` are descriptive Worker registration fields.

When `adapter: "codex"` or `"claude"` is used with a bare command, the adapter
supplies a protocol prompt that tells the agent to read `references/WORK.md` and
write `SELF_LOOP_RESULT`. Explicit `command`/`args` are preserved unchanged.

The Worker also receives:

```text
SELF_LOOP_REPO
SELF_LOOP_TICKET
SELF_LOOP_TASK_CARD
SELF_LOOP_CONTEXT
SELF_LOOP_RESULT
SELF_LOOP_EXECUTOR_ADAPTER
```

## Router

| Field | Default | Meaning |
| --- | --- | --- |
| `router.maxAttempts` | `2` | Total Worker Attempts, not extra retries |
| `router.leaseMinutes` | `45` | Lease before recovery or blocking |
| `router.maxConcurrent` | `1` | Tickets the Router may keep in `queued/working/verifying` at once |
| `router.dispatchMode` | `wait` | `wait` runs an executor inline; `background` detaches it and collects its Result Envelope on a later tick |
| `router.inboxLimit` | `200` | Maximum retained inbox events; handled events are pruned first |
| `router.lockMinutes` | `30` | Stale state-lock threshold |
| `router.llmAdvisory` | `false` | Allows advisory LLM help; it never grants authority |
| `router.comments` | `true` | Maintain one marked status comment on the Issue |
| `router.worktreeMode` | `local` | `local` or `external` |
| `router.worktreeDir` | `.loop/worktrees` | Worktree parent inside the repo |
| `router.context.routerChars` | `2000` | Router projection limit |
| `router.context.workerChars` | `8000` | Worker projection limit |

`worktreeMode: "external"` means an adapter owns worktree creation. The core
still owns Ticket state, leases, gates, and verification.

To process more than one Issue per tick, set `maxConcurrent` above `1` and use
`dispatchMode: "background"` for true parallelism. With `wait`, the Router still
admits up to `maxConcurrent` Tickets but runs their executors one after another
inside the same tick.

## Verifier

```json
{
  "verifier": {
    "commands": ["npm test", "npm run lint"],
    "timeoutMinutes": 30
  }
}
```

When `commands` is empty or absent, setup and the Router discover
`package.json` scripts in this order: `test`, `lint`, `typecheck`, `build`.
No command means `human_review`, never an automatic pass.

The Verifier runs in a detached clean worktree at the PR head or branch. It
does not trust the Worker's report.

## Outbox

```json
{
  "outbox": {
    "enabled": true,
    "maxAttempts": 5,
    "baseDelayMs": 1000,
    "maxDelayMs": 60000,
    "notifyOn": ["awaiting_review", "blocked", "failed", "done"],
    "adapters": {
      "github": {
        "enabled": true,
        "tokenEnv": "GITHUB_TOKEN"
      },
      "jira": {
        "enabled": true,
        "baseUrl": "https://example.atlassian.net",
        "email": "loop@example.com",
        "tokenEnv": "JIRA_API_TOKEN"
      },
      "slack": {
        "enabled": true,
        "channel": "#engineering",
        "botTokenEnv": "SLACK_BOT_TOKEN",
        "webhookUrlEnv": "SLACK_WEBHOOK_URL"
      }
    }
  }
}
```

`enabled` only turns on the queue. A channel is used only when its adapter is
also enabled. Router tick persists deliveries to `.loop/outbox.json`; it never
calls the network. Run `router outbox flush` from cron or the console to send.
GitHub requires a token; Jira uses Basic auth with `email` plus token; Slack uses
a bot token with `channel`, or an incoming webhook URL.

| Field | Default | Meaning |
| --- | --- | --- |
| `outbox.maxAttempts` | `5` | Attempts before dead-letter |
| `outbox.baseDelayMs` | `1000` | Base exponential retry delay |
| `outbox.maxDelayMs` | `60000` | Retry cap; 429 `Retry-After` is honoured |
| `outbox.requestTimeoutMs` | `20000` | Per-request network timeout |
| `outbox.notifyOn` | Review/Blocked/Failed/Done | Ticket states that enqueue a status delivery |

## Environment variables

Every applicable `SELF_LOOP_*` variable has a legacy `LOOP_*` fallback.

| Purpose | Preferred | Legacy |
| --- | --- | --- |
| Target repo | `SELF_LOOP_REPO` | `LOOP_REPO` |
| Language | `SELF_LOOP_LANGUAGE` | `LOOP_LANGUAGE` |
| Policy | `SELF_LOOP_POLICY` | `LOOP_POLICY` |
| Claim TTL | `SELF_LOOP_CLAIM_TTL_MINUTES` | `LOOP_CLAIM_TTL_MINUTES` |
| Retro days | `SELF_LOOP_RETRO_DAYS` | `LOOP_RETRO_DAYS` |
| Retro window | `SELF_LOOP_RETRO_SINCE` | `LOOP_RETRO_SINCE` |
| Output directory | `SELF_LOOP_OUT_DIR` | `LOOP_OUT_DIR` |
| Lessons path | `SELF_LOOP_LESSONS_PATH` | `LOOP_LESSONS_PATH` |
| Standards path | `SELF_LOOP_CODE_STANDARDS_PATH` | `LOOP_CODE_STANDARDS_PATH` |
| Decisions path | `SELF_LOOP_DECISIONS_PATH` | `LOOP_DECISIONS_PATH` |
| Self login | `SELF_LOOP_SELF_LOGIN` | `LOOP_SELF_LOGIN` |
| Executor | `SELF_LOOP_AGENT` | `LOOP_AGENT` |
| Max Attempts | `SELF_LOOP_MAX_ATTEMPTS` | `LOOP_MAX_ATTEMPTS` |
| Lease minutes | `SELF_LOOP_LEASE_MINUTES` | `LOOP_LEASE_MINUTES` |
| Max concurrency | `SELF_LOOP_MAX_CONCURRENT` | `LOOP_MAX_CONCURRENT` |
| Dispatch mode | `SELF_LOOP_DISPATCH_MODE` | `LOOP_DISPATCH_MODE` |
| Inbox limit | `SELF_LOOP_INBOX_LIMIT` | `LOOP_INBOX_LIMIT` |
| State lock minutes | `SELF_LOOP_LOCK_MINUTES` | `LOOP_LOCK_MINUTES` |
| LLM advisory | `SELF_LOOP_LLM_ADVISORY` | `LOOP_LLM_ADVISORY` |
| Issue comments | `SELF_LOOP_COMMENTS` | `LOOP_COMMENTS` |
| Worktree mode | `SELF_LOOP_WORKTREE_MODE` | `LOOP_WORKTREE_MODE` |
| Worktree directory | `SELF_LOOP_WORKTREE_DIR` | `LOOP_WORKTREE_DIR` |
| Router context chars | `SELF_LOOP_CONTEXT_ROUTER_CHARS` | `LOOP_CONTEXT_ROUTER_CHARS` |
| Worker context chars | `SELF_LOOP_CONTEXT_WORKER_CHARS` | `LOOP_CONTEXT_WORKER_CHARS` |
| Verifier commands | `SELF_LOOP_VERIFY_COMMANDS` | - |
| Verifier timeout | `SELF_LOOP_VERIFY_TIMEOUT_MINUTES` | `LOOP_VERIFY_TIMEOUT_MINUTES` |
| Executor adapter | `SELF_LOOP_EXECUTOR_ADAPTER` | - |
| Executor timeout | `SELF_LOOP_EXECUTOR_TIMEOUT_MINUTES` | - |

GitHub also accepts `GITHUB_TOKEN` / `GH_TOKEN`, and `GITHUB_REPOSITORY`.

## Deliberately not configurable

- The five role labels are fixed: `needs-triage`, `needs-info`,
  `ready-for-agent`, `ready-for-human`, `wontfix`.
- The loop never merges a PR and never pushes the default branch.
- Missing verification is never treated as a pass.
