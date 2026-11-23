# self-loop 产品形态

Status: product direction for the web console MVP

## 一句话

self-loop 不只是一个更长的 skill。skill 是 Worker 侧的执行协议；产品形态是一个
可视化 Router 控制台，让人看见任务从哪里来、现在卡在哪里、结果又被送到了哪里。

当前选择优先做 Web 控制台，而不是只做桌面客户端。它天然适合远程 Worker、多项目
接入和团队观察，也能把 Router 的确定性状态直接呈现出来。

## 产品结构

```text
Connectors → Listener → Inbox / Blackboard → Router
                                               ↓
                                  Worker → Verifier → Outbox
                                               ↓
                                        Human review
```

### 1. Connectors

连接器负责把外部系统的事件和数据归一化，而不是让 Router 直接理解每个平台的业务
细节。首批形态包括：

- GitHub Issues / Pull Requests
- Jira Issues
- Slack 或其他 IM
- 通用 Webhook
- Cron / Scheduler

连接器需要独立展示来源、配置、健康状态、最后事件时间和暂停状态。

### 2. Task Listener

监听层同时承接两类输入：

- 自动化任务：定时扫描、周期复盘、批量巡检。
- 事件触发：issue 标签变化、PR 评论、Slack 消息、Jira 字段更新、webhook。

事件只负责唤醒 Router 和提示优先级，不能直接授权执行，也不能绕过标签、lease 或
验证门禁。

### 3. Inbox / Blackboard

Inbox 是所有进入系统的事件和任务的黑板。它必须能看到：

- 待处理、处理中、已完成、已忽略的事件；
- 每条事件来自哪个连接器；
- 事件被消费后生成了哪个 Ticket；
- Worker 处理完成后，Ticket 与 Attempt 状态如何变化。

Inbox 不是历史任务归档，也不能代替 Ticket 状态机。

### 4. Outbox

Outbox 负责把执行结果送回外部系统，例如：

- 回写 GitHub Issue / PR 评论；
- 发送 Slack 线程消息；
- 更新 Jira 字段或评论；
- 触发下一个 webhook。

每条投递都要有状态、尝试次数、幂等键、错误原因和死信入口。失败可以重试，超过上限
进入死信，由人决定是否重投。

## 控制台必须回答的问题

控制台不是日志页面，而是一个观察和干预界面。第一屏和导航必须能回答：

1. Router 现在接了哪些外部来源？
2. Inbox 里有哪些待处理、正在处理和历史处理的事件？
3. 哪些 Ticket 正在执行、验证、等待 review 或阻塞？
4. Outbox 里哪些消息已送达、失败或进入死信？
5. 哪个 Worker 在线、忙碌或暂停？

当前 MVP 的页面映射：

| 页面 | 回答的问题 |
| --- | --- |
| Overview | 整个 Router 是否健康，积压和失败在哪里 |
| Inbox | 事件从哪里来，是否已被消费 |
| Tickets | 任务当前处于哪个生命周期阶段 |
| Ticket detail | 每个 Attempt、证据、阻塞问题和投递结果 |
| Outbox | 哪些结果没有成功送达 |
| Sources | 哪些连接器已接入，是否健康 |
| Workers | 谁可以接单，谁正在执行 |
| Policy | 哪些参数可调，哪些边界不可绕过 |

## 部署形态

### 当前：local-first 单租户

- Node 20+，无前端构建步骤；
- 状态落在 `.self-loop/state.json`；
- 默认只绑定 `127.0.0.1`；
- 没有鉴权，不面向公网；
- 适合本机演示、单项目控制和验证产品形态。

### 后续：hosted / 团队版

需要新增独立的架构决策，至少包括：

- 数据库、迁移和多进程锁；
- 用户、团队、项目和 RBAC；
- 连接器 OAuth、webhook 验签和密钥管理；
- 多租户隔离、审计和可观测性；
- 托管 Worker 或远程 Worker 注册协议。

## 真实能力与模拟能力

MVP 中以下能力是真实的：

- 事件去重、消费和 Inbox 状态；
- Ticket 创建、领取、lease、重试和阻塞；
- Attempt 生命周期和人工回答；
- Outbox 重试、死信和人工重投；
- Source / Worker 开关和审计记录；
- SSE 实时刷新和 HTTP API。
- GitHub webhook 原始报文验签、delivery 去重和 issue 事件归一化。

以下能力目前是模拟的：

- Worker 真实执行 agent 任务；
- Verifier 在真实 worktree 中复跑项目门禁；
- Jira / Slack 的 OAuth、事件接入和外部写回；
- GitHub API 轮询、OAuth 和出站评论写回。

## 产品边界

- Router 是 Ticket 状态的唯一写入者。
- Worker 只写 Attempt 和 PR 正文。
- Verifier 只写验证证据。
- 人拥有合并权和最终阻塞决策。
- 事件不能授权工作，只能唤醒 Router。
- 控制台不能绕过 gate，也不能自动合并 PR。

## 相关文档

- [Web console MVP](../server/README.md)
- [Local web console ADR](adr/0007-local-web-console.md)
- [Router protocol](../references/ROUTER.md)
