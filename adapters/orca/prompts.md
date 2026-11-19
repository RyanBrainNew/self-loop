# Orca Prompt Templates

Orca is an optional scheduler. The core commands are the same as a cron or CI
run; only the prompt wrapper changes.

`setup.mjs` writes absolute paths for the installed skill and target repo. If you
edit a prompt manually, use these shapes (replace the placeholders):

```text
SELF_LOOP_SKILL=/absolute/path/to/self-loop
```

## Issue loop

```text
这是 <repo> 的 issue loop。以下命令在 Orca 启动的当前仓库 worktree 中执行:
1. node "$SELF_LOOP_SKILL/scripts/run.mjs" triage --repo .
2. node "$SELF_LOOP_SKILL/scripts/run.mjs" select --repo . --policy ready-for-agent
若 select 退出码为 3,直接结束,不要改代码。
否则读 ".loop/work.json",按 "$SELF_LOOP_SKILL/references/LOOP.md"
与 "$SELF_LOOP_SKILL/references/WORK.md" 实现这个 issue:
分支 -> 门禁 -> PR(第一行 Closes #N)。绝不合并,绝不 push 默认分支。
PR 标题和正文使用项目 language 配置（默认简体中文）；代码、命令、路径、
标识符和日志原文保持原样。
```

## Retro loop

```text
这是 <repo> 的每日复盘 loop。以下命令在 Orca 启动的当前仓库 worktree 中执行:
node "$SELF_LOOP_SKILL/scripts/run.mjs" retro --repo .
然后按 "$SELF_LOOP_SKILL/references/RETRO.md" 更新项目记忆文件
(默认 memory/LESSONS.md)。用分支 + PR 交付
(chore(self-loop): retro YYYY-MM-DD)。没有值得记的教训就说明检查范围并结束,
不要硬凑。绝不合并。PR 标题和正文使用项目 language 配置。
```

## Router tick (optional, external worktree)

Use this only when the target project sets
`"router": { "worktreeMode": "external" }` and Orca owns the worktree:

```text
这是 <repo> 的 Router tick。当前目录是 Orca 为本轮创建的 worktree:
node "$SELF_LOOP_SKILL/scripts/run.mjs" router tick --repo .
按 "$SELF_LOOP_SKILL/references/ROUTER.md" 处理输出。
绝不合并,绝不 push 默认分支。
```

`router.maxConcurrent` 大于 1 时，一次 tick 可以推进多条 Ticket；
`dispatchMode: "background"` 会立即返回，后台 Worker 的 Result Envelope
由下一次 tick 收集。

The precheck for these automations is:

```text
node "$SELF_LOOP_SKILL/adapters/orca/precheck.mjs"
```

## Inbox / event wake-up

When another scheduler or webhook already owns the trigger, post an event and
then tick:

```text
node "$SELF_LOOP_SKILL/scripts/run.mjs" router post --repo . \
  --type issue --action labeled --ticket <N> --id <delivery-id> --file event.json
node "$SELF_LOOP_SKILL/scripts/run.mjs" router tick --repo .
```

The same `--id` is idempotent. The event only wakes the Router; it does not
authorize work or skip a gate.
