# Hosted OAuth 是什么，为什么现在还没做

这不是当前控制台的一个 bug，而是“本机单租户”与“托管多租户”之间的产品边界。

## 现在的方式

本机版把凭据放在**运行进程的环境变量**里：

- Slack：`SLACK_SIGNING_SECRET`、`SLACK_BOT_TOKEN`
- Jira：`JIRA_API_TOKEN`
- GitHub：`SELF_LOOP_GITHUB_WEBHOOK_SECRET` 或 `GITHUB_WEBHOOK_SECRET`

这适合一个人、一台机器、一个团队自己部署：

1. 你自己创建 Slack App / Jira API Token；
2. 把值写进环境变量；
3. 启动控制台；
4. 凭据不会进入仓库，也不会出现在控制台读接口里。

## 托管版遇到的问题

如果 self-loop 变成一个公网 SaaS，让很多团队注册使用，环境变量就不够了：

- 不能让所有租户共用同一个 Slack App secret；
- 不能要求每个用户自己改服务器环境变量；
- 需要让用户在网页里点“连接 Slack / Jira”，走 OAuth 授权；
- 需要按租户保存 token、refresh token、scope、安装信息和过期时间；
- 需要支持轮换、撤销、审计，以及“这个 token 属于哪个租户/项目”；
- 需要防止 A 租户的 webhook 或 token 读到 B 租户的数据。

**Hosted OAuth** 就是把“创建 App、保存凭据、刷新 token、撤销授权”做成平台能力，而不是让用户手工配环境变量。

反过来说：如果你只是自己在一台机器上运行控制台，或者团队把它放在受控内网里，
当前的环境变量方式已经可用，不需要先做 OAuth。真正需要它的触发条件是：
控制台要作为公网 SaaS 提供给多个互不信任的团队使用。

## 两种方式的对比

| 维度 | 本机版（当前） | 托管版（未来） |
| --- | --- | --- |
| 谁创建 Slack/Jira App | 用户自己 | 平台统一创建 |
| 凭据存放 | 进程环境变量 | KMS / Secret Manager + 租户数据库 |
| 安装方式 | 手工复制 secret | 网页 OAuth 一键安装 |
| token 刷新 | 用户自己维护 | 平台自动刷新 |
| 撤销 | 删除环境变量 | 租户级撤销 + 审计 |
| 多租户隔离 | 单机单租户 | RBAC + tenant 隔离 |

## 结论

当前 MVP 已经能完成真实的 Slack 验签、`/loop`、Jira 增量同步和 Outbox 写回；它只是采用“本机凭据”的方式。

Hosted OAuth 属于 ADR 0013 里的托管版能力，需要 PostgreSQL、RBAC、密钥管理、OAuth 回调、租户隔离和审计一起设计。它不会阻塞本机版继续使用。
