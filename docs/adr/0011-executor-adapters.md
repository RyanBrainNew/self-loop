# 0011: Executor 通过适配层启动真实 Agent

## Status

Accepted

## Context

Router 已有通用 `executor.command`，但缺少明确的 adapter 契约。不同 Agent
CLI 的参数、提示词入口和运行方式不同，控制台也无法解释当前 Worker 类型。

## Decision

核心新增 `scripts/executors.mjs`：

- 内置 `command`、`codex`、`claude` 三种 invocation builder。
- 配置 `executor.adapter` 可声明自定义 adapter 名称；未识别的名称按通用命令处理。
- 通用 `executor.command` / `executor.args` 仍然优先，保留已有项目配置。
- Adapter 只负责构造进程调用，不读写 Ticket 状态。
- Router 继续负责 lease、Attempt、Result Envelope、超时、进程存活检测和取消。
- 后台进程超过 `executor.timeoutMinutes`、退出但没有 Result Envelope，或租约
  被人工取消时，Router 释放并发槽并记录原因。
- 调度器特定 adapter（例如 Orca）放在 `adapters/`，核心脚本不得引用其名称。

## Consequences

真实 Codex / Claude 可以通过配置直接运行，其他 Agent 也能以自定义 adapter
名称接入。Worker 仍只能写 Attempt 产物和 Result Envelope；Ticket 状态的唯一
写入者仍是 Router。
