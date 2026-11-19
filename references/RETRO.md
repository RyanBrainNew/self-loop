# Retrospective Work Reference

> The retrospective turns evidence into durable rules. It is not a daily status
> report. It runs independently from the issue loop.

## 1. Gather evidence

```bash
node "$SKILL_DIR/scripts/run.mjs" retro --repo "$TARGET_REPO"
```

This writes `retro.md` in the configured output directory (default `.loop/`).
The window is:

1. explicit `--since` or `SELF_LOOP_RETRO_SINCE`;
2. otherwise the last commit that changed the configured lessons file
   (`memory/LESSONS.md` by default);
3. otherwise the last `retroDays` days (default 2).

Read the retro material and the project memory files:

- `memory/LESSONS.md`;
- `memory/code-standards.md`;
- `memory/DECISIONS.md`.

Use configured paths when they differ from the defaults.

## 2. Record only evidence-backed lessons

Look for:

1. rework after a fix;
2. a change that should not have merged;
3. weak verification, such as "tests passed" without a command or result.

Each entry needs:

- one executable rule;
- the reason or failure mode it prevents;
- commit / issue / PR evidence;
- a date and a short title.

Record successful practices too, marked **Done right**.

## 3. Promote repeated lessons

When the same lesson appears on about three different dates, propose moving it
to `memory/code-standards.md` as a hard merge gate. Do not leave a repeated
failure buried in the mistake log.

## 4. Deliver

1. Create `loop/retro-YYYY-MM-DD` from the default branch.
2. Change only retrospective or memory-standard files.
3. Open a PR titled `chore(self-loop): retro YYYY-MM-DD`; write the body in the
   project `language` (default `zh-CN`), keeping commands and verbatim evidence
   unchanged.
4. Explain which rules were added or changed and cite the evidence.
5. Never merge and never push the default branch.

If nothing is worth recording, state what was checked and stop. Do not invent
lessons to create output.

## Boundaries

- Do not delete another person's history. Supersede it with a new decision or
  lesson entry and link the old one.
- If evidence is insufficient, say so instead of generalizing.
