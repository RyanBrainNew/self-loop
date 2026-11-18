# Loop —— 两个由 Orca 调度的自迭代循环(可迁移)

这套 `loop/` 不绑定具体项目、技术栈或标签体系之外的流程。把整个文件夹拷进
任意 GitHub 个人仓库即可复用;调度、频率、执行策略都在 **Orca** 里配置。

## 两个 Loop

| Loop | 频率(建议) | 干什么 | 产物 |
| --- | --- | --- | --- |
| **Issue Loop** | 每小时 | 读全部 open issue,按策略选一个实现 | 分支 + PR(`Closes #N`) |
| **Retro Loop** | 每天 | 复盘近期提交,沉淀教训 | 更新错题本的 PR |

两者互不依赖,各有独立 automation、独立失败边界。**都不合并 PR**,合并永远由人。

## 文件

```
loop/
  run.mjs           # 唯一入口: triage | select | issue | retro | agent
  triage.mjs        # 读全部 open issue -> .loop/triage.json / .md
  select.mjs        # 按 Orca 策略选一个并领取 -> .loop/work.json
  retro.mjs         # 收集复盘素材 -> .loop/retro.md
  lib.mjs           # 标签/策略/选择规则
  LOOP.md           # Issue Loop 作业单
  WORK.md           # 单个 issue 的实现作业单
  RETRO.md          # 复盘作业单
  orca.md           # Orca 定时任务配置(策略在这里)
  orca-setup.mjs    # 为当前仓库创建两条 Orca automation
  precheck.mjs      # Orca precheck: GitHub 不可达就跳过
  loop-setup.md     # 机器侧一次性准备
  loop.test.mjs     # 标签/策略/选择规则的单元测试
```

## 标签:复用 Matt 的 `/triage`

不新增任何标签。只认下面五个角色(来自 `docs/agents/triage-labels.md`):

`needs-triage` · `needs-info` · `ready-for-agent` · `ready-for-human` · `wontfix`

默认策略只做 `ready-for-agent`。`needs-triage` / `needs-info` / `ready-for-human` /
`wontfix` 一律不动;防重入靠「指派 + 关联 open PR + 领取超时」,不靠新标签。

## 策略归 Orca

仓库脚本不判断"该不该做",只执行传入的策略:

| 策略 | 行为 |
| --- | --- |
| `ready-for-agent`(默认) | 只做带 `ready-for-agent` 的 issue |
| `label:<name>` | 只做带指定标签的 issue |
| `do` | 采纳 triage 的 `do` 判断(最接近 Magpie 全自动) |
| `off` | 只出报告,不动手 |

策略字符串写在 Orca automation 的 prompt 里(例如
`node loop/run.mjs select --policy ready-for-agent`)。每个项目、每条 automation
可以不同,改 Orca 即可,不用改仓库代码。

## 手动跑(调试用)

```bash
node loop/run.mjs triage --policy ready-for-agent
node loop/run.mjs select --policy ready-for-agent
node loop/run.mjs retro
```

产物都在 `.loop/`(已 gitignore,本地调试用,不跨轮持久化)。

## 一次性接到 Orca

```bash
node loop/orca-setup.mjs --policy ready-for-agent
```

它会为当前仓库创建 `issue-loop` 与 `retro-loop` 两条 automation(默认禁用,
先看报告再启用)。完整说明、策略修改、迁移到别的项目见 [`orca.md`](orca.md)。

## 环境变量(全部可选)

- `GITHUB_TOKEN` / `GH_TOKEN` —— 否则回退 `gh auth token`。
- `LOOP_POLICY` —— 等价于 `--policy`。
- `LOOP_CLAIM_TTL_MINUTES` —— 领取超时,默认 `180`。
- `LOOP_RETRO_DAYS` —— 没有历史复盘提交时的回看天数,默认 `2`。
- `LOOP_LESSONS_PATH` —— 复盘文件位置,默认 `memory/LESSONS.md`。
- `LLM_BASE` / `LLM_KEY` / `LLM_CHEAP_MODEL` —— 可选,triage 的便宜模型建议。
- `LOOP_AGENT` —— 仅 `node loop/run.mjs agent` 手动模式使用;Orca 自己会起 agent。

## 原则

- **先报告后动手**:第一周用 `--disabled` 或 `--policy off`,看 triage/retro 质量。
- **一次一件事**:一轮只做一个 issue / 只开一个 PR。
- **没有证据不算验证**:没跑就写 **Not run**。
