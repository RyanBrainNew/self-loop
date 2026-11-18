# Project Setup

Run setup once per target repository. The goal is that the user does not have
to learn or hand-write the configuration format.

```bash
node "$SKILL_DIR/scripts/setup-project.mjs" --repo "$TARGET_REPO"
```

`SKILL_DIR` is the directory containing the installed `SKILL.md`. The target
repository does not need a copied `loop/` directory.

## What setup detects

| Item | Detection order |
| --- | --- |
| GitHub repository | `--github`, existing `.self-loop.json`, `GITHUB_REPOSITORY`, `origin` remote |
| Executor | `--executor`, existing config, `SELF_LOOP_AGENT` / `LOOP_AGENT`, local `codex`, local `claude` |
| Verifier | `--verify`, existing config, `package.json` scripts (`test`, `lint`, `typecheck`, `build`) |
| Memory | existing config, defaults under `memory/`, or `--memory-dir` |

Setup then:

- writes or merges `.self-loop.json`;
- creates missing memory files from `templates/memory/`;
- adds the output directory, normally `.loop/`, to `.gitignore`;
- creates missing role labels with `gh`, if available;
- prints the exact dry-run and live `router tick` commands.

It never overwrites existing memory and never replaces an existing repository,
executor, verifier, or memory choice on a later run.

## Normal path

```text
setup-project.mjs
  -> report what was detected
  -> write project-local config
  -> create memory
  -> print one dry-run command
```

The user should only need to act when setup reports a missing branch:

- no GitHub repository: add an `origin` remote or pass `--github owner/name`;
- no executor: pass `--executor "<command>"`;
- no verifier: add a `package.json` test script or pass `--verify "<command>"`.

Do not ask the user to edit a large JSON file for these cases.

## Options

```bash
--repo <path>          target repository (also SELF_LOOP_REPO, then LOOP_REPO)
--github <owner/name>  override GitHub repository detection
--executor <command>   agent command, for example "codex exec --full-auto"
--verify <command>     one verifier command; overrides package-script discovery
--memory-dir <path>    memory directory, default memory/
--no-labels            do not call gh label
--dry-run              report actions without writing files
--json                 machine-readable result
```

`--repo` may point at a subdirectory; it is normalized to the repository root.

## Scheduling is separate

Setup configures the project. It does not install a cron entry or enable an
external scheduler. After the dry run:

```bash
node "$SKILL_DIR/scripts/run.mjs" router tick --repo "$TARGET_REPO"
```

Call that command from cron or CI when automation is desired. The optional Orca
adapter is documented in `adapters/orca/`.

## Re-running

Re-running setup is safe and is the normal upgrade step. It only fills missing
configuration and reports what it kept. Use `--dry-run` first when changing an
existing project.
