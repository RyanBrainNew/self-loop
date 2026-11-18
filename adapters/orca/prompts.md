# Orca Prompt Templates

Orca is an optional scheduler. The core commands are the same as a cron or CI
run; only the prompt wrapper changes.

`setup.mjs` writes absolute paths for the installed skill and target repo. If you
edit a prompt manually, use these shapes (replace the placeholders):

```text
SELF_LOOP_SKILL=/absolute/path/to/self-loop
TARGET_REPO=/absolute/path/to/project
```

## Issue loop

```text
这是 <repo> 的 issue loop。以下命令可在任意目录执行:
1. node "$SELF_LOOP_SKILL/scripts/run.mjs" triage --repo "$TARGET_REPO"
2. node "$SELF_LOOP_SKILL/scripts/run.mjs" select --repo "$TARGET_REPO" --policy ready-for-agent
若 select 退出码为 3,直接结束,不要改代码。
否则读 "$TARGET_REPO/.loop/work.json",按 "$SELF_LOOP_SKILL/references/LOOP.md"
与 "$SELF_LOOP_SKILL/references/WORK.md" 实现这个 issue:
分支 -> 门禁 -> PR(第一行 Closes #N)。绝不合并,绝不 push 默认分支。
```

## Retro loop

```text
这是 <repo> 的每日复盘 loop。以下命令可在任意目录执行:
node "$SELF_LOOP_SKILL/scripts/run.mjs" retro --repo "$TARGET_REPO"
然后按 "$SELF_LOOP_SKILL/references/RETRO.md" 更新项目记忆文件
(默认 memory/LESSONS.md)。用分支 + PR 交付
(chore(self-loop): retro YYYY-MM-DD)。没有值得记的教训就说明检查范围并结束,
不要硬凑。绝不合并。
```

The precheck for both automations is:

```text
node "$SELF_LOOP_SKILL/adapters/orca/precheck.mjs"
```
