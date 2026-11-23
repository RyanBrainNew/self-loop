# 0010: 多仓库控制面使用持久化项目注册表

## Status

Accepted

## Context

第一版控制台由 `--repo` 决定允许访问的仓库。这个边界安全，但产品形态仍然
是“一个地址一个项目”：重启后项目列表丢失，用户必须在启动命令里穷举仓库，
也无法在控制台内注册新项目。

## Decision

控制台维护一个本地项目注册表，默认路径是
`~/.self-loop/projects.json`，可用 `--projects-file` 或
`SELF_LOOP_CONSOLE_PROJECTS` 覆盖。

- 注册项包含稳定 `id`、规范化绝对路径、显示名、加入时间和最后选择时间。
- `--repo` 保留为“注册并打开”的兼容入口。
- 没有 `--repo` 时，注册表非空即进入 project 模式；注册表为空才进入 demo 模式。
- Project 模式在同一个地址内切换仓库；切换只改变当前读取目标，不复制 Ticket。
- 添加、移除、选择项目都要求本地 write token 或同源会话，并写入控制台审计。
- 不能移除最后一个项目；移除当前项目时自动选择剩余项目。
- 添加路径必须是真实目录，并且是 Git 仓库或包含 `.self-loop.json` / `.loop`。

## Consequences

控制台从单仓库观察器变成多仓库控制面。注册表本身不是业务状态，也不是 Ticket
状态的第二份副本；每个项目仍只读取自己的 `.loop/state.json`、
`.loop/inbox.json` 和 `.loop/outbox.json`。所有 Ticket 写操作继续委托给
`scripts/router.mjs` 的锁边界。
