# self-loop

一个通用、可安装的 self-loop skill：读取 GitHub issue，按策略选择一条，在分支上实现并开 PR，再由独立 Verifier 复跑门禁；另一个独立循环做基于证据的复盘。核心只依赖 Node、git 和 GitHub API，可由终端、cron、CI 或任意调度器调用。

核心是一个确定性的 Router 控制面：它拥有 Issue 选择、Ticket 状态、lease、Task Card、Context Packet、Attempt、验证门禁和人工交接。大模型只能在 triage、Task Card 草稿或语义 review 上给建议，不能授权、不能绕过门禁。

官网：<https://ryanbrainnew.github.io/self-loop/>

硬边界：

- 永不合并 PR，永不直接 push 默认分支。
- 不新增标签，只使用 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- 不绑定项目技术栈，不假设项目里有 `loop/` 目录。
- Orca 只是 `adapters/orca/` 里的可选适配器。

## 产品形态

完整产品不是“把 skill 写长一点”，而是一个以 Router 为中心的 Web 控制面：

1. **Connectors**：接入 GitHub、Jira、Slack、Webhook、Cron 等外部来源；
2. **Task Listener**：同时承接定时自动化任务和外部事件；
3. **Inbox / Blackboard**：展示所有采集到的事件、Ticket 和实时处理状态；
4. **Outbox**：把完成结果回写到 GitHub、IM 或其他外部系统。

控制台围绕这些能力提供 `Overview`、`Inbox`、`Tickets`、`Outbox`、`Sources`、
`Workers` 和 `Policy` 页面，并允许人工回答、重跑、取消、验收和重投。skill 仍然是
Worker 侧的执行协议；Web 控制台是观察和干预 Router 的产品表面。

产品结构、部署形态和真实/模拟能力边界见
[`docs/PRODUCT.md`](docs/PRODUCT.md)。

## Web 控制台（MVP）

`server/` 提供一个本地优先的 Router 控制台。它把 Source → Inbox →
Ticket → Attempt → Verifier → Outbox 的链路可视化，并允许人工回答、
重跑、取消、验收和重投。

```bash
npm run serve
# http://127.0.0.1:4317
```

首次启动会写入演示数据；状态保存在 `.self-loop/state.json`，该目录已被
gitignore。MVP 只绑定本机、没有鉴权，不要暴露到公网。

连接器配置、事件注入、Ticket 生命周期和 Outbox 重试是真实的；Worker
执行与 Verifier 证据目前是定时模拟，真实 OAuth、webhook 验签和外部 API
调用在下一版接入。详见 `server/README.md`。

## 官网

静态官网源码在 `site/`，无构建步骤和外部运行时依赖。推送到 `main` 后，
`.github/workflows/pages.yml` 会通过 GitHub Pages 发布 `site/`。

首次启用时在仓库 `Settings > Pages` 选择 `GitHub Actions`，部署完成后再把
仓库 About 的 Website 指向 `https://ryanbrainnew.github.io/self-loop/`。

## 安装

要求 Node.js 20+、git；访问 GitHub 需要 `GITHUB_TOKEN` / `GH_TOKEN` 或已登录的 `gh`。

### 通过 skill library 安装

本仓库本身就是 skill，`SKILL.md` 在仓库根。支持 GitHub 源安装的 skill
管理器通常按目录内容复制，常见选择是：

- 独立安装本仓库：源填 `RyanBrainNew/self-loop`，路径选**仓库根**（留空或填 `.`）；
- 如果使用以 `skills/<name>/` 组织的集合仓库，则路径填 `skills/self-loop`；
- 安装后必须同时保留 `SKILL.md`、`scripts/`、`references/`、`templates/`，不要只复制 `scripts/`。

不同 skill 管理器的安装入口和更新命令不同；升级时按管理器记录的
`repo + path` 重新拉取即可。手工维护时直接重新 clone 或 `git pull --ff-only`。

### 显式初始化技能

仓库还提供独立的 `setup-self-loop` 技能。它和 `self-loop` 同仓库，但安装路径不同：

- `self-loop`：仓库根（留空或 `.`）；
- `setup-self-loop`：`setup-self-loop/`。

先安装 `self-loop`，再安装 `setup-self-loop`。以后只需要显式调用
`setup-self-loop`，不需要描述配置、确认提案或记命令。它会定位已安装的
`self-loop`，直接完成配置，只在缺 GitHub 仓库或 executor 时问一个最短问题。

### 手动安装

```bash
git clone https://github.com/RyanBrainNew/self-loop.git ~/.codex/skills/self-loop
# 或 ~/.claude/skills/self-loop，或团队统一的 skills 目录
```

安装后从 `SKILL.md` 所在目录定位脚本。以下示例使用：

```bash
SKILL_DIR="$HOME/.codex/skills/self-loop"
TARGET_REPO="/absolute/path/to/project"
```

目标项目**不需要** `loop/` 目录。所有命令都显式传 `--repo`。

### Skill 安装 vs 项目内 `loop/`

| | 安装为 skill（本仓库） | 固定在项目里的 `loop/` |
| --- | --- | --- |
| 升级 | 改一处 skill，所有项目共用 | 每个项目各有一份，容易漂移 |
| 项目污染 | 目标项目只有 `.self-loop.json`、`memory/`、被忽略的 `.loop/` | 业务仓库里多一套调度代码和文档 |
| 调度器 | 核心与 cron/CI/Orca 解耦 | 容易把项目路径和调度器写死 |
| 复用 | 同一套门禁、标签、memory 协议 | 每个仓库重新复制、重新修 |
| 可审计性 | skill 版本可 pin 到 commit，PR 只改业务 | 代码与业务改动混在同一 PR |

如果团队要求“skill 代码必须和业务仓库同 commit 才能发布”，仍可把 skill 作为子模块或包固定版本；但运行入口仍应从 `SKILL.md` 所在目录定位，而不是假设项目里有 `loop/`。

## 首次接入（由 agent 对话完成）

不需要自己跑 Node、背参数或手写 JSON。只有当这个项目确实要启用 loop 时，
直接在项目里对 agent 说：

> 用 self-loop 的 setup 配置这个项目，先告诉我你会改什么。

Agent 会进入 skill 内置的 setup 对话，按 `references/SETUP.md` 执行：

1. 先检查 git remote、已有 `.self-loop.json`、memory、测试命令、旧 `loop/` 和本机 agent；
2. 报告探测结果，以及哪些已有选择会被保留；
3. 只对无法推断的选项提问，通常是“仓库是哪个”或“用哪个 agent”；
4. 给出简短配置提案，等你确认；
5. 在内部调用 skill 自带的确定性写入器完成配置，而不是让你执行命令；
6. 报告实际创建/保留的内容，并给出第一次 `router tick --dry-run`。

它会自动处理 GitHub 仓库、executor、测试门禁、三份 memory、`.gitignore` 和五个角色标签。
已有 memory 和显式配置不会被覆盖。Setup 不会顺便启用 cron、Orca automation 或开始实现 issue。

`scripts/setup-project.mjs` 仍然存在，但它是这套对话背后的执行器，不是用户入口；
无 agent 的 CI/维护环境可以直接调用它。Agent 必须遵循 `references/SETUP.md`，不要把
完整配置表丢给用户。

## 手动运行

```bash
# 只读 triage，生成 .loop/triage.json / .loop/triage.md
node "$SKILL_DIR/scripts/run.mjs" triage --repo "$TARGET_REPO"

# 选一个 issue 并领取，写入 .loop/work.json
node "$SKILL_DIR/scripts/run.mjs" select --repo "$TARGET_REPO" --policy ready-for-agent

# 只选择不领取，用于调试
node "$SKILL_DIR/scripts/run.mjs" select --repo "$TARGET_REPO" --no-claim

# 预览 Router 会生成的 Task Card；不创建 Ticket、不消耗 Attempt、不发评论
node "$SKILL_DIR/scripts/run.mjs" router tick --repo "$TARGET_REPO" --dry-run

# 正式推进一个 Ticket：选择 -> 领取 -> Task Card -> Worker -> 独立验证
node "$SKILL_DIR/scripts/run.mjs" router tick --repo "$TARGET_REPO"

# 追加一个 inbox 事件（等价的 GitHub webhook 适配见 adapters/github-actions/）
node "$SKILL_DIR/scripts/run.mjs" router post --repo "$TARGET_REPO" \
  --type issue --action labeled --ticket 42

# 查看事件队列
node "$SKILL_DIR/scripts/run.mjs" router inbox --repo "$TARGET_REPO" --pending

# 查看当前 Ticket、Attempt、lease、PR 和阻塞问题
node "$SKILL_DIR/scripts/run.mjs" router status --repo "$TARGET_REPO" --json

# 人看完证据后解除 blocked，再给一次 Attempt
node "$SKILL_DIR/scripts/run.mjs" router recover --repo "$TARGET_REPO" --ticket 42

# 生成复盘素材 .loop/retro.md
node "$SKILL_DIR/scripts/run.mjs" retro --repo "$TARGET_REPO"
```

`select` 退出码 `3` 表示没有候选，`2` 表示配置、token、网络或领取失败。策略和标签规则见 `references/POLICY.md`。
Router 的完整状态机、Result Envelope、lease 和验证规则见 `references/ROUTER.md`。

## 中文 PR 与并发 / 事件

PR 标题和正文默认使用简体中文。配置项是 `.self-loop.json` 的 `language`：

```json
{
  "language": "zh-CN"
}
```

`zh-CN` 下只翻译说明性文字；代码、命令、路径、标识符和日志原文保持原样，
`Closes #N` 也保持英文，GitHub 才能正确关联 Issue。需要英文时改为 `"en"`。
新建或修复配置时，`setup` 会从 `README.md` / `AGENTS.md` 检测语言并写入，
已有显式值不会被覆盖。

默认 `maxConcurrent` 是 `1`，所以一次 tick 只派发一个 Worker；其他 Ticket 要等
下一次 tick。要在一个循环里并行处理多条 Issue：

```json
{
  "router": {
    "maxConcurrent": 3,
    "dispatchMode": "background"
  }
}
```

`background` 会把 Worker 放到后台，tick 立即返回；下一次 tick 读取 Worker 写好的
`result.json`，再进入独立验证。`wait` 仍然可用，但多个 Worker 会在同一次 tick 内
串行执行。`blocked`、`awaiting_review` 不占并发名额，人可以同时 review 多个 PR。
临时调试也可以直接传：

```bash
node "$SKILL_DIR/scripts/run.mjs" router tick --repo "$TARGET_REPO" \
  --concurrent 3 --dispatch-mode background
```

`router post` 把事件写进 `.loop/inbox.json`，`router tick` 先消费事件再选 Issue。
同一 `--id` 重复提交是幂等的；事件只是唤醒和优先级提示，不会绕过标签、领取、
验收标准和验证门禁。GitHub Actions 适配器在 `adapters/github-actions/`。

## 项目配置

正常使用时不需要读或写配置。Agent 的 setup 对话已经把项目差异写进目标仓库根的
`.self-loop.json`；默认值本身也能工作。这个文件只属于目标项目，不是 skill 源码。

需要理解时，只看四块：

- `executor`：用哪个 agent 执行 Ticket；
- `verifier`：独立验证时复跑哪些命令；
- `language`：PR 标题/正文和 Router 面向人的文字用中文还是英文；
- `router`：重试次数、lease、并发和工作树归属；
- `memory` / `policy`：三份 memory 的位置和选 Issue 的标签策略。

高级配置、完整字段、环境变量和优先级统一放在 `references/CONFIG.md`。日常不要手改；
需要修复或升级时，对 agent 说“检查现有 self-loop 配置并只补缺失项”，它会先 dry-run
再应用。CI 只需要显式设置 `SELF_LOOP_REPO` 或传 `--repo`，GitHub 凭据使用
`GITHUB_TOKEN` / `GH_TOKEN`。

## cron / CI

核心脚本不依赖 Orca。cron 示例：

```cron
*/15 * * * * node /opt/skills/self-loop/scripts/run.mjs router tick --repo /srv/project >> /var/log/self-loop.log 2>&1
30 6 * * *  node /opt/skills/self-loop/scripts/run.mjs retro --repo /srv/project >> /var/log/self-loop-retro.log 2>&1
```

`router tick` 在空闲时选择并领取 Issue（默认一条，`maxConcurrent` 可调），生成 Task Card 和 Context Packet，交给配置的 executor；Worker 交付后由独立 Verifier 复跑门禁。也可以继续使用无 Router 的旧式流水线：

```bash
SELF_LOOP_AGENT='codex exec --full-auto' \
  node "$SKILL_DIR/scripts/run.mjs" agent --repo "$TARGET_REPO"
```

GitHub Actions 可把 skill 单独 checkout 到 runner 临时目录，再用显式 `--repo`：

```yaml
- uses: actions/checkout@v4
- uses: actions/checkout@v4
  with:
    repository: RyanBrainNew/self-loop
    path: .self-loop-skill
- run: node .self-loop-skill/scripts/run.mjs router tick --repo "$GITHUB_WORKSPACE"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GITHUB_REPOSITORY: ${{ github.repository }}
```

生产环境建议先用 `router tick --dry-run` 和 `--policy off` 跑报告，再启用领取、实现和自动化。

## Orca（可选）

Orca 只负责调度。先安装 skill，再运行适配器：

```bash
node "$SKILL_DIR/adapters/orca/setup.mjs" \
  --repo "$TARGET_REPO" \
  --policy ready-for-agent \
  --disabled
```

适配器生成的 prompt 调用已安装 skill 的绝对脚本路径，例如
`node ".../self-loop/scripts/run.mjs" triage --repo .`，在 Orca 为本次运行启动的 worktree 内执行；不会调用 `node loop/run.mjs`。移动 skill 后重跑 `setup.mjs --replace`。详见 `adapters/orca/README.md`。

自动化名称按仓库生成：`<owner>-<repo>-issue-loop` 和
`<owner>-<repo>-retro-loop`，因此不同仓库不会互相覆盖。旧版固定名称
`issue-loop` / `retro-loop` 会在 `--replace` 时重命名。

如果由 Orca 或其他外部编排器创建 worktree，在目标项目配置
`"router": { "worktreeMode": "external" }`，并让调度 prompt 调用
`router tick --repo .`；核心不会重复创建 worktree，但仍拥有 Ticket 状态、lease 和验证门禁。当前 Orca 适配器默认保留 triage/select/agent 的兼容路径，Router 调度是可选升级项。

## 升级

通过 skill library 安装时，使用该管理器的 update/install 操作按原来的
`repo + path` 重新拉取。手动安装时：

```bash
git -C "$SKILL_DIR" pull --ff-only
```

升级后，对项目里的 agent 说：

> 用 self-loop setup 检查现有配置，只补缺失项，先 dry-run。

无 agent 的维护环境才直接调用确定性执行器：

```bash
node "$SKILL_DIR/scripts/setup-project.mjs" --repo "$TARGET_REPO" --dry-run
node "$SKILL_DIR/scripts/setup-project.mjs" --repo "$TARGET_REPO"
```

升级不会覆盖目标项目 memory，也不会修改目标项目业务代码。若使用 Orca，移动或升级后重跑：

```bash
node "$SKILL_DIR/adapters/orca/setup.mjs" --repo "$TARGET_REPO" --replace --disabled
```

然后用项目自己的门禁与 `node --test` 验证 skill 或目标项目。若你直接改过
manager 的本地副本，优先保留本地改动；需要覆盖时使用管理器提供的强制更新选项。

## Memory 协议

- `LESSONS.md`：有证据的错题、返工和验证失误；一条规则 + 原因 + commit/issue/PR 证据。
- `code-standards.md`：重复出现约三次的教训升级为硬门禁。
- `DECISIONS.md`：已拍板约束；要推翻必须新增决策并链接旧条目。

只有 `retro` 和 `init-memory` 写 memory。Worker 只能在 Result Envelope 里提议教训，Verifier 只写验证 artifact，二者都不能直接改 memory。

复盘窗口默认从「上次修改 lessons 文件的提交」开始，因此新 worktree / CI runner 不依赖本地状态。显式 `--since <ref>` 或 `SELF_LOOP_RETRO_SINCE` 可覆盖。详见 `references/MEMORY.md` 和 `references/RETRO.md`。

## 从旧 `loop/` 迁移

旧快照来自 `mind-tree-learn/loop`（本仓库导入 commit `de8724b`），只作为历史参考。迁移到新 skill：

1. 保留目标项目的 `memory/*` 内容，不要复制 mind-tree-learn 的产品特定教训。
2. 删除目标项目里的 `loop/` 目录，以及 `AGENTS.md` / 文档中指向 `node loop/...` 的旧命令。
3. 安装本 skill；在项目里让 agent 走一次 setup 对话（已有的 memory 和配置会保留）。
4. 更新 Orca / cron / CI 命令为已安装 skill 的 `scripts/run.mjs --repo <target>`；需要 Router 时改为 `router tick --repo <target>`。
5. 先跑 `router tick --dry-run`、triage 和 retro 检查输出；策略、标签、TTL、open PR 去重行为保持兼容。
6. 确认 `.loop/` 已加入目标项目 `.gitignore`，且 memory 文件没有被模板覆盖。

旧环境变量名仍可作为 fallback，但新配置建议使用 `SELF_LOOP_*`。

## 验证

```bash
npm test
```

CI 在 push 和 PR 上运行 `node --test`。测试覆盖策略/标签/选择、配置与 memory 路径解析、`--repo` 解析、open PR 去重、领取 TTL、retro 显式窗口、一键 setup 的探测/合并/幂等行为，以及 memory 初始化不覆盖。

Router 额外覆盖：Task Card 缺验收时阻塞、lease 过期重试/耗尽阻塞、已有分支工作时阻塞、Verifier 的 pass/fail/人工复核转换、worktree 清理、state lock 冲突与 stale lock、inbox 幂等与结果事件、`maxConcurrent` 并发上限、`router status` 的 `--repo` 冒烟，以及只复制 skill 根目录后的独立运行。

服务端控制台另外覆盖事件去重、Ticket/Attempt 生命周期、人工回答、Outbox
重试、GitHub webhook 验签与幂等、secret 脱敏、连接器与 Worker 开关，以及
HTTP API。当前测试基线：`70` 个测试全部
通过（Node 20+）。

## 设计文档

- `docs/DESIGN.md`：Router 控制面、角色、生命周期、Context Packet / Result Envelope、验证和 rollout。
- `docs/adr/`：已接受的架构决策（scheduler-agnostic core、installable layout、Router control plane、independent verification、context protocol、inbox bounded concurrency、local web console）。
- `GLOSSARY.md`：统一术语，避免把 skill root、target repository、Ticket、Claim、Lease 混用。

## License

本项目采用 [Apache License 2.0](LICENSE) 开源协议。
Copyright 2026 self-loop contributors.
