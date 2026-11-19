---
name: setup-self-loop
description: Initialize the current repository for self-loop. Invoke explicitly once; detect settings, write config and memory, create labels, and report the result without a setup interview.
disable-model-invocation: true
---

# Setup self-loop

This is the explicit one-shot initializer. The user invoked it, so consent to
configure this repository is already given.

Do not ask for confirmation, explain the configuration model, or dump a JSON
schema. Act first, then report a compact result.

## Resolve the installed self-loop skill

Let `SETUP_SKILL_DIR` be the directory containing this `SKILL.md`. Find the
first directory that contains `scripts/setup-project.mjs`:

1. `$SELF_LOOP_SKILL`, when set;
2. `$SETUP_SKILL_DIR/../self-loop`;
3. `~/.codex/skills/self-loop`;
4. `~/.claude/skills/self-loop`.

If none exists, stop and say only:

```text
self-loop is not installed. Install RyanBrainNew/self-loop from the repository root, then invoke setup-self-loop again.
```

## Run

From the target repository root, run:

```bash
node "<resolved-self-loop-skill>/scripts/setup-project.mjs" --repo . --json
```

Do not add flags unless the user supplied them or the first attempt reports a
missing required choice.

Only two failures justify one short question:

| Failure | Ask only this |
| --- | --- |
| `cannot detect GitHub repo` | `GitHub repo owner/name?` |
| warning `No executor detected` | `Which agent command should self-loop use?` |

Then rerun with `--github owner/name` or `--executor "<command>"`.

Do not block on missing verifier commands. The independent Verifier will return
`human_review` instead of a false pass.

## Report

After success, print at most:

```text
self-loop configured: owner/repo
config: <path>
memory: created N, preserved N
labels: <status>
next: <the dry-run command returned by setup>
```

Add one line per real warning. Do not repeat the command instructions.

## Boundaries

- Never overwrite existing memory.
- Never add labels outside the five self-loop roles.
- Never enable cron, CI, or an external automation as part of setup.
- Never run triage, implement an issue, merge a PR, or push a default branch.
