# self-loop 运维手册

这份手册面向自托管部署：控制台、Router tick、Prometheus 告警和备份恢复。
所有命令都假设仓库安装在 `/opt/self-loop`，目标项目在 `/srv/project`。

## 1. 进程与定时器

推荐拆成三个独立单元：

- `self-loop-console.service`：只提供本地 Web 控制台和 API，不启动真实 Worker。
- `self-loop-tick.timer`：按固定节奏执行 `router tick`，负责消费 Inbox、领取 Ticket、
  应用 Result Envelope 和入队 Outbox。
- `self-loop-backup.timer`：每天备份 `.loop` 与 `.self-loop.json`。

```bash
sudo cp deploy/systemd/self-loop-*.service /etc/systemd/system/
sudo cp deploy/systemd/self-loop-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now self-loop-console.service
sudo systemctl enable --now self-loop-tick.timer
sudo systemctl enable --now self-loop-backup.timer
```

控制台默认绑定 `127.0.0.1`。不要把 `--host 0.0.0.0` 直接暴露到公网；如需远程访问，
在前面加带 OIDC/SSO 的反向代理和 TLS，并保留本地 write token。

## 2. 健康检查

```bash
curl -fsS http://127.0.0.1:4317/api/health
curl -fsS http://127.0.0.1:4317/api/observability
curl -fsS http://127.0.0.1:4317/metrics
```

控制台的 Observability 页面把以下信息聚合在一页：

- Router 是否暂停、最后一次 tick、运行时长；
- Inbox pending、活跃 Ticket、Outbox pending/dead；
- Ticket 状态分布和投递状态分布；
- Source 健康、Worker 在线/忙碌/离线；
- blocked Ticket、dead delivery、degraded connector、offline remote worker 告警。

## 3. Prometheus 告警

`deploy/prometheus/self-loop.rules.yml` 提供一组可直接加载的规则：

- `SelfLoopRouterPaused`
- `SelfLoopInboxBacklog`
- `SelfLoopOutboxDead`
- `SelfLoopBlockedTickets`
- `SelfLoopNoOnlineWorkers`
- `SelfLoopConnectorDegraded`

示例抓取配置：

```yaml
scrape_configs:
  - job_name: self-loop
    metrics_path: /metrics
    static_configs:
      - targets: ["127.0.0.1:4317"]
```

指标名保持稳定，未知状态也会输出零值序列，便于 Grafana 图例和告警表达式长期使用。

## 4. 备份与恢复

```bash
npm run backup -- --repo /srv/project
npm run backup -- --repo /srv/project --include-artifacts
npm run restore -- --repo /srv/project --backup ~/.self-loop/backups/project-2026-01-01 --dry-run
npm run restore -- --repo /srv/project --backup ~/.self-loop/backups/project-2026-01-01 --force
```

备份包含 `.loop` 与 `.self-loop.json`，默认排除 `worktrees/` 和 `artifacts/`。
恢复默认拒绝覆盖已有 `.loop`；先跑 `--dry-run`，确认清单后再使用 `--force`。

建议把 `~/.self-loop/backups/` 同步到对象存储，并至少每季度做一次真实恢复演练。

## 5. 发布

```bash
npm test
npm run release:check
npm pack
git tag v0.5.0
git push origin v0.5.0
```

`v*` 标签会触发 `.github/workflows/release.yml`：在 Node 20 上重跑测试和发布检查，
打包 tarball，并创建 GitHub Release。发布流程不自动合并 PR，也不 push 默认分支。

可选的 GitHub 真实连通性检查是只读的：

```bash
GITHUB_TOKEN=... npm run test:github:live -- --repo owner/name
```

它只读取仓库元数据和最近 issue，不会创建 issue、评论、标签或 PR；没有 token
时会明确退出，不会让默认 CI 依赖真实 GitHub 凭据。

## 6. 故障处理顺序

1. 先看 Observability 页面的 Router 状态和 Alerts。
2. 检查 `router tick` 定时器是否运行，是否有 lock 残留。
3. 检查 Inbox 是否积压，Source 是否 degraded。
4. 检查 blocked Ticket 是否需要人工回答、recover 或 retry。
5. 检查 Outbox dead delivery 的状态码和错误，修复凭据后重投。
6. 需要回滚时先停止 tick timer，再按备份清单恢复 `.loop`。

Router 是 Ticket 状态的唯一写入者。不要手工编辑 `.loop/state.json` 来“修状态”；
人工操作应通过控制台或 `scripts/router.mjs`，以便保留锁和审计。
