# Executor E2E status

| Adapter | Harness | Live evidence | Notes |
| --- | --- | --- | --- |
| `codex` | `npm run test:e2e:codex` | yes, see `docs/EVIDENCE-CODEX-E2E.md` | authenticated Codex CLI |
| `claude` | `npm run test:e2e:codex -- --adapter claude` | blocked | this host has no Claude CLI or API/oauth token |
| `orca` scheduler | `npm run test:e2e:orca` | yes, see `docs/EVIDENCE-ORCA-E2E.md` | live create/list/show/remove of a disabled automation |
| `command` / custom | `npm run test:e2e:codex -- --adapter command --command <cmd>` | covered by unit fixtures | use for CI-owned deterministic executors |

The default test suite never requires an agent login. Real executor checks are
opt-in and fail explicitly when the CLI or credential is unavailable.

For a hosted runner, use the manual **Live executor E2E** GitHub workflow and
configure `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` as a repository secret. It is
`workflow_dispatch` only and is not part of the default CI gate.
