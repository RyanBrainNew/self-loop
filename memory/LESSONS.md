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
