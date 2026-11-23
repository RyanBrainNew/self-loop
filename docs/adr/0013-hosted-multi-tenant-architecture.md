# 0013: 托管版采用独立的多租户架构

## Status

Proposed

## Context

当前 `server/` 是本机单租户控制面：状态在目标仓库的 `.loop/` 或 demo JSON
文件中，身份是本机 write token，项目注册表是 `~/.self-loop/projects.json`。
这些假设适合本机演示和单人开发，不能直接带到公网或团队环境。

托管版至少需要回答：

- 谁属于哪个团队，谁能看/操作哪个项目；
- 连接器凭据和 webhook secret 如何隔离、轮换和审计；
- 多个 Web/Worker/Connector 进程如何并发写同一份 Ticket 状态；
- Worker 如何注册、领取、续租、吊销和隔离；
- 如何限流、重放保护、追踪和保留审计。

## Decision

托管版是独立服务和新数据模型，不是把本地 console 直接暴露到公网。

### 身份与权限

- 使用 OIDC / SSO 登录，服务端维护 user、team、project、membership 和 role。
- 角色至少分为 `owner`、`maintainer`、`operator`、`viewer`。
- 所有 API 先做 tenant 解析，再做 project 级 RBAC；默认拒绝。
- 本地 write token 不进入托管版；本地和托管版只共享 Worker 协议与数据导出格式。

### 数据与并发

- 默认使用 PostgreSQL，而不是共享 JSON 文件或单机 SQLite。
- 表至少包括：tenants、users、teams、projects、memberships、events、tickets、
  attempts、deliveries、sources、workers、audit_log。
- Ticket 状态写入使用事务 + 行级锁或乐观版本号；Router 仍是唯一 Ticket 状态
  写入者。
- `idempotency_key` 在 events 和 deliveries 上有唯一约束。
- 大对象（Attempt 日志、验证证据）放对象存储，数据库只存引用和摘要。

### 连接器与 Webhook

- 每个项目独立配置 source、凭据引用和 webhook secret。
- Webhook ingress 在边缘做签名校验、时间戳窗口、body 大小限制和 rate limit，
  再写入队列；不接受未验签的原始请求直接写业务表。
- Connector 轮询与 Webhook 消费都由独立 worker 处理，cursor 和 health 持久化。
- 连接器事件只唤醒 Router 和提示优先级，不能授权执行或绕过 gate。

### Worker

- Worker 通过注册 API 声明 kind、capabilities、concurrency、版本和租约能力。
- Router 下发 Task Card、Context Packet 和短期 lease；Worker 只能写 Attempt
  产物，不能写 Ticket 状态。
- Worker 的注册、heartbeat、领取、完成、失败、取消和吊销都带 tenant/project
  作用域；跨租户访问默认拒绝。
- 远程 Worker 与托管 Worker 使用同一协议，但凭据和网络隔离不同。

### 运维与可观测性

- 队列用于 Connector 事件、Outbox 投递和 Worker 调度；失败进入可观测的
  retry/dead-letter 路径。
- 结构化日志、指标、trace、审计和保留策略是托管版的一等能力。
- 密钥放 KMS/Secret Manager，不进入仓库、日志、URL 或 API 读响应。

## Threat model

必须覆盖：

- 跨租户读取、写入、枚举和 timing 侧信道；
- 被盗 Worker 凭据、伪造 heartbeat、越权领取和 lease 重放；
- 伪造/重放 webhook、secret 泄露和连接器 OAuth token 泄露；
- 通过项目路径、Webhook URL、Outbox target 或日志注入进行 SSRF/命令注入；
- 审计缺失、日志含 secret、对象存储越权访问；
- 单租户假设被直接复用到多租户，导致默认信任所有项目。

## Rollout

1. 本地版已补可选 SQLite/并发存储；真实 executor harness 已提供，运行验收
   需要对应 CLI 凭据。
2. 抽出可复用的 Router 协议、Connector runtime 和 Worker 协议。
3. 新建托管 control plane：身份、项目、RBAC、PostgreSQL、队列。
4. 先接 GitHub，再接 Slack/Jira；每个连接器独立 feature flag 和灰度。
5. 提供 local -> hosted 的导出/导入和回滚路径，不一次性重写本地版。

## Consequences

- 托管版不会复用本地 token、JSON store 或单进程锁。
- 本地版仍是默认入口和开发/调试路径；托管版是独立产品面。
- 该 ADR 只定义架构方向，不授权直接上线公网；实现前需要单独的安全评审和
  数据迁移计划。
