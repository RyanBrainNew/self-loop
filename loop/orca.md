# 用 Orca 调度这套 Loop

Orca 是调度层:它决定**什么时候跑、跑哪个 agent、用什么策略**。仓库里的脚本
只提供确定性动作(triage / select / retro)。

## 为什么是两条 automation

- `issue-loop` 可以频繁跑(建议每小时),失败不影响复盘。
- `retro-loop` 每天固定跑一次,窗口按 git 提交推进,不和 issue 事件互相切碎。

Orca 默认 `new_per_run` 会为每次运行创建新 worktree,所以 `.loop/` 不跨轮持久化。
这正是 `retro.mjs` 用「上次修改 `memory/LESSONS.md` 的提交」作为窗口起点的原因;
不要把状态存进本地文件。

## 一次性创建

```bash
# 在任意项目根目录
node loop/orca-setup.mjs --policy ready-for-agent --disabled

# 看报告满意后启用
orca automations list --json
orca automations edit <automationId> --enable --json   # 旧版没有 --enable 时用 UI 开启
```

`orca-setup.mjs` 会:
1. 从 `orca repo list` 找到当前仓库;
2. 创建 `issue-loop`(默认每小时)与 `retro-loop`(默认每天 06:30);
3. 两条都带 `precheck: node loop/precheck.mjs`(GitHub 不可达就跳过);
4. 默认 `--disabled`,避免第一次就无人值守改代码。

## 两条 automation 的 prompt

Orca 的策略就在这两段 prompt 里。改 prompt 即改策略,不用动仓库代码。

**issue-loop**

```text
这是 <repo> 的 issue loop。在仓库根目录依次执行:
1. node loop/run.mjs triage
2. node loop/run.mjs select --policy ready-for-agent
若 select 退出码为 3,直接结束,不要改代码。
否则读 .loop/work.json,按 loop/LOOP.md 与 loop/WORK.md 实现这个 issue:
分支 -> 门禁 -> PR(第一行 Closes #N)。绝不合并,绝不 push 默认分支。
```

**retro-loop**

```text
这是 <repo> 的每日复盘 loop。在仓库根目录执行 node loop/run.mjs retro,
然后按 loop/RETRO.md 更新 memory/LESSONS.md(不存在则按项目约定创建),
用分支 + PR 交付(chore(loop): retro YYYY-MM-DD)。
没有值得记的教训就说明检查范围并结束,不要硬凑。绝不合并。
```

## 策略怎么改

只改 prompt 里的 `--policy`:

| 想要的效果 | prompt 里写 |
| --- | --- |
| 最稳:只做 triage 已判定的 | `--policy ready-for-agent` |
| 全自动:让便宜模型决定 | `--policy do` |
| 自定义标签队列 | `--policy label:good-first-issue` |
| 只观察不动手 | `--policy off` |

Matt 的五个标签始终优先:`needs-info` / `ready-for-human` / `wontfix` /
`needs-triage` 永远不会被实现。`do` 只是放开"必须带 `ready-for-agent`"这一条。

## 迁移到另一个 GitHub 项目

1. 把整个 `loop/` 拷到目标仓库根目录。
2. 确认目标仓库用 Matt 的标签体系(`needs-triage` / `needs-info` /
   `ready-for-agent` / `ready-for-human` / `wontfix`)。没有就让 `/triage` 先建。
3. 在目标仓库根目录运行:
   ```bash
   node loop/orca-setup.mjs --policy ready-for-agent --disabled
   ```
4. 在 Orca 里检查两条 automation 的 prompt,把 `<repo>` 换成实际名字。
5. 先手动 `orca automations run <issueId>` 看一轮,再启用。

## 权限与前置

- `gh auth login` 一次,或给 runner 设 `GITHUB_TOKEN`;需要 issue 读写与开 PR 的权限。
- 本机需要 `node`、`git`、`gh`、`curl`、`bash`(Orca 的终端环境已具备)。
- Orca 的 `precheck` 只判断 GitHub 可达,不判断 token;token 失效时 triage 会以
  `exit 2` 明确报错。

## 排错

- `orca automations runs --id <id> --json` 看每次运行状态。
- 本地复现:`node loop/run.mjs triage --policy ready-for-agent`。
- `select` 退出码 `3` = 没有候选;`2` = token/网络/领取失败。
- 想确认标签判定:`cat .loop/triage.md` 看每条的 role / verdict / eligible / reason。
