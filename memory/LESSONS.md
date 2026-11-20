# Lessons

> The mistake log. Record durable, evidence-backed lessons here; do not use it
> as a status report or a place for guesses.

## Rules

- One lesson per entry, with a date and a short title.
- State the rule first, then why it matters, then the commit / issue / PR evidence.
- Write rules that a later agent can execute, not vague reflections.
- Record things that went right too, marked **Done right**.
- Do not delete history. If a lesson is superseded, link the newer decision.

## Format

### YYYY-MM-DD - Short title

- Rule: What to do next time.
- Why: The failure mode or cost this prevents.
- Evidence: `commit`, issue, or PR references.
- Status: active | superseded by ...

## Entries

### 2026-11-19 - Orca prompts must target the per-run worktree, not an absolute repo path

- Rule: In Orca adapter prompts, call the installed skill as
  `node "<skill>/scripts/run.mjs" <mode> --repo .` and read `.loop/*` by
  relative path. Resolve absolute paths only for the skill's own scripts and
  references.
- Why: Orca starts a fresh worktree per run. An absolute `--repo` sends the
  loop to the original checkout, so `.loop/` output and any branch or commit
  land outside the worktree Orca handed to the agent. The run can then build on
  stale state or collide with a concurrent run, and the collision is invisible
  in the PR.
- Evidence: `050fc5d` shipped prompts with an absolute `TARGET_REPO`;
  `36a938c` (2026-11-18 14:42, 1h43m later, branch `refactor/generic-skill`)
  switched them to `--repo .` and added assertions for `--repo \.` and
  `doesNotMatch /--repo "\/work\/project"/`.
- Status: active

### 2026-11-19 - Reachability prechecks must not treat 4xx as "GitHub is down"

- Rule: A network reachability check counts any HTTP status from 1 to 499 as
  reachable. Only transport errors, timeouts, and 5xx mean "skip this run".
  Never gate a scheduled run on `res.ok`.
- Why: 401/403/404 still prove DNS, TLS, and HTTP work. Gating on `res.ok`
  silently skips every scheduled run when a proxy requires auth, a token is
  stale, or a shared CI IP is rate-limited. The skip looks like "nothing to
  do" in the log, so the loop can be dead for days without anyone noticing.
- Evidence: `050fc5d` used `res.ok`; `fdbc644` (2026-11-18 14:39, branch
  `refactor/generic-skill`) added `githubStatusReachable(status)` as
  `status > 0 && status < 500`, with tests for 401, 403, 404, 500, 503, and 0.
- Status: active

### 2026-11-19 - Spawned-process tests must clear ambient GitHub config

- Rule: Every test that spawns the CLI passes an explicit minimal environment:
  delete `GITHUB_REPOSITORY`, `GH_REPO`, `GH_HOST`, and token variables, then
  assert that the repo identity comes from `--repo` or `.self-loop.json`.
- Why: Repo resolution reads `GITHUB_REPOSITORY` before config. In GitHub
  Actions that variable is already set, so a test can pass locally and assert
  the wrong repo (or fail) in CI. Test results stop being reproducible.
- Evidence: `16ffc03` added the "router status runs through run.mjs with
  --repo from outside the target" test using `cleanEnv()`; `55608a0`
  (2026-11-18 16:33, two minutes later, branch `refactor/generic-skill`) had
  to add `delete env.GITHUB_REPOSITORY` because `cleanEnv()` only strips
  `SELF_LOOP_*` and `LOOP_*`.
- Status: active

### 2026-11-19 - Done right: fixes land with the assertion that would have caught them

- Rule: When fixing a loop bug, add the failing-case assertion in the same
  commit, not in a follow-up.
- Why: All three fixes above shipped their regression test together, so the
  same class of bug cannot silently return. This is the pattern to repeat on
  every `fix(...)` commit.
- Evidence: `fdbc644` (status table), `36a938c` (prompt assertion),
  `55608a0` (env deletion), branch `refactor/generic-skill`.
- Status: active

### 2026-11-19 - Done right: the imported loop snapshot verifies on its own

- Rule: Import vendored automation together with its tests, and run them in the
  fresh worktree before trusting the snapshot.
- Why: `de8724b` imported 16 files including `loop/loop.test.mjs`; running
  `node --test loop/loop.test.mjs` on 2026-11-19 gave 10 passed, 0 failed in
  this worktree. The import was verifiable without the source repository.
- Evidence: `de8724b`; local run `node --test loop/loop.test.mjs` → `pass 10`,
  `fail 0`.
- Status: active

### 2026-11-20 - Project setup is an agent conversation, not a user-facing one-liner

- Rule: Present onboarding as inspect → report → confirm → apply. In `README.md`
  and `SKILL.md`, do not tell users to run `setup-project.mjs`; reserve it for
  the agent's internal write step and headless CI. Configure only when the user
  asks to configure, enable, or repair the loop, and run `--dry-run` first when
  a config already exists.
- Why: The first setup release sold a single command as "只需一次". Six minutes
  later the same author replaced that flow: a blind command asks users to
  memorize Node and flags, applies project changes without showing what will be
  preserved, and never asks for confirmation before writing.
- Evidence: `8c3113b` added "首次接入（只需一次）" with
  `node setup-project.mjs`; `d0b93c0` (2026-11-18 23:54:17, six minutes later)
  changed it to "首次接入（由 agent 对话完成）" and added the `AGENTS.md`
  invariant "Project setup is an agent conversation. `setup-project.mjs` is the
  internal deterministic writer and CI fallback, not the user-facing onboarding
  flow."
- Status: active

### 2026-11-20 - Thread the project language through every generated artifact

- Rule: Write `language` (default `zh-CN`) into the project config and pass it
  to the Task Card, Context Packet, `SELF_LOOP_LANGUAGE`, Orca prompts, Issue
  status comments, and the PR title/body. Before merge, read the generated PR
  title and body and confirm they use the configured language; keep commands,
  paths, identifiers, and verbatim logs unchanged.
- Why: PRs produced by the loop were "经常是英文" in a Chinese-facing project.
  Language was only a prompt convention, so each Worker could choose
  differently and reviewers got inconsistent person-facing output. Making it a
  configured value carried into every artifact removes that choice.
- Evidence: PR #1 and PR #3 bodies are English; `8ee186f` added `language`,
  the `references/WORK.md` output-language rules, and
  `SELF_LOOP_LANGUAGE`; its PR body names the problem directly; PR #5 body is
  Chinese. The test `language defaults to Chinese and reaches Task Cards and
  Context Packets` covers the propagation.
- Status: active

### 2026-11-20 - Namespace scheduler resources by repository

- Rule: Any adapter that creates shared scheduler resources must derive names
  from the full `<owner>/<repo>` slug when available, sanitized to
  `[a-z0-9._-]`, not from a fixed `issue-loop` / `retro-loop` name or a bare
  directory basename. On `--replace`, rename the legacy resource instead of
  creating a duplicate.
- Why: Two projects with the same directory leaf would edit or skip the same
  automation. One project's setup can rename or overwrite another project's
  automation, so one loop stops or runs with the wrong schedule and prompt.
- Evidence: `050fc5d` used fixed `ISSUE_NAME` / `RETRO_NAME`; `1a3d9a9`
  (2026-11-18 14:37:48, 1h38m later) added `automationNamesForRepo`, passed
  `--name` on edit so legacy names are renamed, and added the test
  `Orca automation names are sanitized and repository-specific`, which asserts
  two different `app` repositories get different names.
- Status: active

### 2026-11-20 - Done right: concurrency shipped with capacity and idempotency tests

- Rule: For Router concurrency or dispatch changes, add tests for
  `maxConcurrent` capacity, idempotent inbox replay, completed-result
  collection, and both `wait` and `background` dispatch. Merge only after the
  PR's CI run is green.
- Why: These failures are timing-dependent and rarely reproduce in a single
  happy-path run. This change shipped the whole matrix and merged only after CI
  succeeded, so duplicate dispatch, lost results, and capacity overruns are
  covered by assertions instead of production luck.
- Evidence: `8ee186f`; PR #5; local `npm test` on 2026-11-20 →
  `tests 58`, `pass 58`, `fail 0`; CI run `44522543351` succeeded at
  `2026-11-19T12:17:54Z`, and the merge landed at `12:18:31Z`.
- Status: active

### 2026-11-20 - A deploy workflow must prove its repository settings before merge

- Rule: When adding a workflow that depends on repository settings (Pages,
  environments, secrets), enable the setting or pass the action's `enablement`
  option before merge, and check the first deploy run. A green CI job is not
  deploy verification.
- Why: The Pages workflow was merged before Pages was enabled, so the deploy
  failed immediately with `Get Pages site failed ... Not Found`. The README
  already said to enable Pages, but documentation did not prevent the failed
  run; only the repository setting did.
- Evidence: merge `02b2973` at `2026-11-19T08:14:18Z`; Pages run `44485910971`
  failed at `08:14:24Z` with `Not Found` from `actions/configure-pages@v5`;
  rerun `44486501843` succeeded at `08:18:33Z` on the same commit after Pages
  was enabled.
- Status: active
