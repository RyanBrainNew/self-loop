# 0012: Outbox 是独立持久化投递队列

## Status

Accepted

## Context

控制台已有 Outbox 视图，但项目模式没有真实投递历史。若在 Router tick 内直接
调用外部 API，网络延迟、限流和认证失败会阻塞调度循环。

## Decision

核心新增 `scripts/outbox.mjs`，将投递历史写入 `.loop/outbox.json`。

- Router 在 Ticket 到达 Review、Blocked、Failed 或 Done 时只入队，不发送网络请求。
- `router outbox flush` 单独领取到期投递并在锁外执行网络调用，完成后再回到锁内写结果。
- 首批 adapter：GitHub Issue/PR comment、Jira comment、Slack channel/thread。
- 每条投递有稳定 `idempotencyKey`，消息体携带同名 marker。
- 2xx 视为成功；429 按 `Retry-After` 或指数退避；5xx / 网络错误可重试；
  400/401/403/404/422 进入 dead-letter，可由人重投。
- 记录 request id、HTTP status、可读错误、Attempt 次数和下一次投递时间。

## Consequences

Outbox 与 Router 主循环解耦，tick 不会被外部 API 拖慢。投递队列不是 Ticket
状态，但仍由核心 CLI 持久化；控制台只读取并触发 flush/retry。
