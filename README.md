# self-loop

一个通用、可安装的 self-loop skill：读取 GitHub issue，按策略选择一条，在分支上实现并开 PR；另一个独立循环做基于证据的复盘。核心只依赖 Node、git 和 GitHub API，可由终端、cron、CI 或任意调度器调用。

硬边界：

- 永不合并 PR，永不直接 push 默认分支。
- 不新增标签，只使用 `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- 不绑定项目技术栈，不假设项目里有 `loop/` 目录。
- Orca 只是 `adapters/orca/` 里的可选适配器。

## 安装

要求 Node.js 20+、git；访问 GitHub 需要 `GITHUB_TOKEN` / `GH_TOKEN` 或已登录的 `gh`。

### Magpie Library

本仓库本身就是 skill，`SKILL.md` 在仓库根。Magpie Library 从 GitHub 安装时：

- 独立安装本仓库：源填 `RyanBrainNew/self-loop`，路径选择**仓库根**（即 `SKILL.md` 所在处）；
- 如果使用的集合仓库以 `skills/<name>/` 组织技能，则选择该集合仓库里的 `skills/self-loop` 子目录。

安装后必须同时保留 `SKILL.md`、`scripts/`、`references/`、`templates/`。不要只复制 `scripts/`。

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

## 初始化项目

```bash
node "$SKILL_DIR/scripts/init-memory.mjs" --repo "$TARGET_REPO"
```

默认创建：

- `memory/LESSONS.md`：错题本；
- `memory/code-standards.md`：合并门禁；
- `memory/DECISIONS.md`：已拍板决策。

已有文件不会被覆盖。可用 `--memory-dir docs/memory` 或单独路径参数改变位置，详见 `references/MEMORY.md`。

建议把 `.loop/` 加入目标项目的 `.gitignore`。

## 手动运行

```bash
# 只读 triage，生成 .loop/triage.json / .loop/triage.md
node "$SKILL_DIR/scripts/run.mjs" triage --repo "$TARGET_REPO"

# 选一个 issue 并领取，写入 .loop/work.json
node "$SKILL_DIR/scripts/run.mjs" select --repo "$TARGET_REPO" --policy ready-for-agent

# 只选择不领取，用于调试
node "$SKILL_DIR/scripts/run.mjs" select --repo "$TARGET_REPO" --no-claim

# 生成复盘素材 .loop/retro.md
node "$SKILL_DIR/scripts/run.mjs" retro --repo "$TARGET_REPO"
```

`select` 退出码 `3` 表示没有候选，`2` 表示配置、token、网络或领取失败。策略和标签规则见 `references/POLICY.md`。

## 项目配置

在目标仓库根放 `.self-loop.json`（全部可选）：

```json
{
  "policy": "ready-for-agent",
  "claimTtlMinutes": 180,
  "retroDays": 2,
  "outDir": ".loop",
  "githubRepo": "owner/name",
  "memory": {
    "lessons": "memory/LESSONS.md",
    "codeStandards": "memory/code-standards.md",
    "decisions": "memory/DECISIONS.md"
  }
}
```

优先级：CLI > 环境变量 > `.self-loop.json` > 默认值。输出目录和 memory 路径必须位于目标仓库内。

常用环境变量：

```bash
SELF_LOOP_REPO=/path/to/project
SELF_LOOP_POLICY=ready-for-agent
SELF_LOOP_CLAIM_TTL_MINUTES=180
SELF_LOOP_RETRO_DAYS=2
SELF_LOOP_LESSONS_PATH=memory/LESSONS.md
GITHUB_TOKEN=...
```

旧名 `LOOP_REPO`、`LOOP_POLICY`、`LOOP_CLAIM_TTL_MINUTES`、`LOOP_RETRO_DAYS`、`LOOP_LESSONS_PATH` 等继续兼容；完整列表见 `references/MEMORY.md`。

## cron / CI

核心脚本不依赖 Orca。cron 示例：

```cron
0 * * * * node /opt/skills/self-loop/scripts/run.mjs issue --repo /srv/project >> /var/log/self-loop.log 2>&1
30 6 * * * node /opt/skills/self-loop/scripts/run.mjs retro --repo /srv/project >> /var/log/self-loop-retro.log 2>&1
```

`issue` 做 triage + select；真正实现 issue 的 agent 由调用方提供：

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
- run: node .self-loop-skill/scripts/run.mjs triage --repo "$GITHUB_WORKSPACE"
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    GITHUB_REPOSITORY: ${{ github.repository }}
```

生产环境建议先用 `--policy off` 跑报告，再启用领取和实现。

## Orca（可选）

Orca 只负责调度。先安装 skill，再运行适配器：

```bash
node "$SKILL_DIR/adapters/orca/setup.mjs" \
  --repo "$TARGET_REPO" \
  --policy ready-for-agent \
  --disabled
```

适配器生成的 prompt 调用已安装 skill 的绝对脚本路径，例如
`node ".../self-loop/scripts/run.mjs" triage --repo ".../project"`，不会调用 `node loop/run.mjs`。移动 skill 后重跑 `setup.mjs --replace`。详见 `adapters/orca/README.md`。

自动化名称按仓库生成：`<owner>-<repo>-issue-loop` 和
`<owner>-<repo>-retro-loop`，因此不同仓库不会互相覆盖。旧版固定名称
`issue-loop` / `retro-loop` 会在 `--replace` 时重命名。

## 升级

```bash
git -C "$SKILL_DIR" pull --ff-only
node "$SKILL_DIR/scripts/init-memory.mjs" --repo "$TARGET_REPO"
```

升级不会覆盖目标项目 memory，也不会修改目标项目业务代码。若使用 Orca，移动或升级后重跑：

```bash
node "$SKILL_DIR/adapters/orca/setup.mjs" --repo "$TARGET_REPO" --replace --disabled
```

然后用项目自己的门禁与 `node --test` 验证 skill 或目标项目。

## Memory 协议

- `LESSONS.md`：有证据的错题、返工和验证失误；一条规则 + 原因 + commit/issue/PR 证据。
- `code-standards.md`：重复出现约三次的教训升级为硬门禁。
- `DECISIONS.md`：已拍板约束；要推翻必须新增决策并链接旧条目。

复盘窗口默认从「上次修改 lessons 文件的提交」开始，因此新 worktree / CI runner 不依赖本地状态。显式 `--since <ref>` 或 `SELF_LOOP_RETRO_SINCE` 可覆盖。详见 `references/MEMORY.md` 和 `references/RETRO.md`。

## 从旧 `loop/` 迁移

旧快照来自 `mind-tree-learn/loop`（本仓库导入 commit `de8724b`），只作为历史参考。迁移到新 skill：

1. 保留目标项目的 `memory/*` 内容，不要复制 mind-tree-learn 的产品特定教训。
2. 删除目标项目里的 `loop/` 目录，以及 `AGENTS.md` / 文档中指向 `node loop/...` 的旧命令。
3. 安装本 skill，运行 `init-memory.mjs`（已有 memory 文件会跳过）。
4. 更新 Orca / cron / CI 命令为已安装 skill 的 `scripts/run.mjs --repo <target>`。
5. 重跑 triage 和 retro 检查输出；策略、标签、TTL、open PR 去重行为保持兼容。

旧环境变量名仍可作为 fallback，但新配置建议使用 `SELF_LOOP_*`。

## 验证

```bash
npm test
```

CI 在 push 和 PR 上运行 `node --test`。测试覆盖策略/标签/选择、配置与 memory 路径解析、`--repo` 解析、open PR 去重、领取 TTL、retro 显式窗口和 memory 初始化不覆盖。
