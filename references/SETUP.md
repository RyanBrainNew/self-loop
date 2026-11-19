# Project Setup as an Agent Conversation

This is a prompt-driven setup method, not a command the user has to remember.
The agent explores the project, reports findings, asks only about real
ambiguities, confirms the proposed setup, and applies it with the bundled
deterministic helper.

Do not make the user hand-write `.self-loop.json`, memorize flags, or run the
helper themselves.

When the user explicitly invokes the separate `setup-self-loop` skill, follow
that skill's direct one-shot flow instead: invocation is consent, so do not ask
for a proposal confirmation.

## 1. Decide whether setup is needed

Run this flow only when:

- the user asks to configure, initialize, or enable self-loop; or
- the user wants an automated issue-to-PR loop and the project has no usable
  `.self-loop.json`; or
- an existing setup is incomplete and the user asks to repair or upgrade it.

Do not write project configuration for a one-off `triage`, `select`, or
`retro` command. Do not enable a scheduler or automation as part of setup
unless the user explicitly asks for that separate step.

## 2. Explore before asking

Inspect the target repository. Do not assume defaults without checking.

- `git remote -v`, `.git/config`: is this a GitHub repository? Which one?
- `.self-loop.json`: does a project config already exist? Which explicit
  choices must be preserved?
- `memory/LESSONS.md`, `memory/code-standards.md`, `memory/DECISIONS.md`: do
  memory files already exist, including in a custom directory?
- `package.json`, `Makefile`, `pyproject.toml`, `AGENTS.md`: what commands
  actually verify this project?
- `.loop/`, `loop/`, cron files, CI workflows, Orca setup: is an old loop or a
  scheduler already present?
- Local agent commands: is `codex` or `claude` available? Is
  `SELF_LOOP_AGENT` already set?
- Project language: are `README.md`, `AGENTS.md`, or design docs predominantly
  Chinese or English? Is `language` already set in `.self-loop.json`?
- `gh auth status` and `gh label list`: can labels be created? Do any of the
  five roles already exist?

Use the repository's real state. A check that found nothing should be reported
as missing, not guessed.

## 3. Report findings

Summarize concisely:

```text
Repository: owner/name
Existing config: none | path and preserved choices
Executor: detected command | not detected
Verifier: detected commands | not detected
Language: zh-CN | en | detected from project docs
Memory: existing files | will create defaults
Labels: already present | can create | gh unavailable
Old loop/scheduler: none | found at ...
```

Also say what will not change: existing memory, existing explicit config, and
the target project's business code.

## 4. Ask only about real branches

Do not ask about values that were detected or that have safe defaults. Ask one
question at a time, and only for choices that cannot be inferred:

- no GitHub repository: ask for `owner/name`, or whether to add an `origin`
  remote;
- no executor: ask which agent command to use, recommending a detected
  `codex`/`claude` command when available;
- no verifier: propose the project's test command; ask only if no sensible
  command exists;
- custom memory location: ask only when existing memory lives somewhere other
  than `memory/`.

Never ask the user to choose retry, lease, context, lock, or other advanced
values for a first setup. Those defaults are already safe and documented in
`CONFIG.md`.

## 5. Confirm the proposal

Show a short proposal before writing:

```text
I will configure:
- GitHub: owner/name
- Executor: codex exec --full-auto
- Independent checks: npm test, npm run lint
- Language: zh-CN (PR title/body and person-facing Router text)
- Memory: memory/LESSONS.md, memory/code-standards.md, memory/DECISIONS.md
- Labels: create only the five self-loop roles if missing
- Ignore: .loop/

I will preserve: existing memory, existing explicit choices, business code.
Proceed?
```

Only the user's confirmation is required. Do not dump the full JSON schema.

## 6. Apply through the bundled helper

Run the helper yourself; it is the deterministic writer behind this
conversation. The user does not need to run it or know its flags.

```bash
node "$SKILL_DIR/scripts/setup-project.mjs" \
  --repo "$TARGET_REPO" \
  [--github owner/name] \
  [--executor "<command>"] \
  [--verify "<command>"] \
  [--language zh-CN|en] \
  [--memory-dir <path>] \
  [--no-labels] \
  [--dry-run] \
  [--json]
```

For an existing config, run with `--dry-run` first and compare the reported
changes with the confirmed proposal. Then run without `--dry-run`.

The helper:

- merges `.self-loop.json` without removing unknown fields;
- fills `language` from an explicit flag, existing config, or project docs, and
  defaults to `zh-CN`;
- creates only missing memory files;
- adds `.loop/` or the configured output directory to `.gitignore`;
- tries to create the five role labels with `gh`;
- prints the first `router tick --dry-run` command.

If the helper cannot run, stop and report the error. Do not silently replace it
with a large hand-written config unless the user asks for that fallback.

## 7. Report the result, then stop

Report:

- what was detected, created, or preserved;
- any warnings, especially missing executor, verifier, or label creation;
- the exact first dry-run command.

Setup does not run triage, implement work, install cron, or enable an external
scheduler. Those are separate decisions.

## Re-running

Re-running is safe and is the normal repair/upgrade path. It only fills missing
configuration and preserves existing memory and explicit choices. Use
`--dry-run` first when the project already has a config.
