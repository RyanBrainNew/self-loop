# Issue Loop —— 作业单(项目无关)

> 由 Orca automation 派发。本文件只描述"怎么干",**策略从 Orca prompt 传入**,
> 不在仓库里写死。适合任意 GitHub 项目。

## 输入

1. 在仓库根目录运行 `node loop/run.mjs triage` → `.loop/triage.json` / `.loop/triage.md`。
2. 运行 `node loop/run.mjs select --policy <policy>` → `.loop/work.json`。
   - 退出码 `3` = 本轮没有可做的 issue,直接结束,不要改代码。
3. 若 `.loop/work.json` 存在,它就是本轮唯一要做的 issue。

## 标签:只复用 Matt 的五个角色

| 标签 | 含义 | loop 的动作 |
| --- | --- | --- |
| `needs-triage` | 等人评估 | **不动**,先由 `/triage` 归类 |
| `needs-info` | 等作者补充 | **不动**,可回复要信息 |
| `ready-for-agent` | 已完整定义 | 默认只做这一类 |
| `ready-for-human` | 需要人做 | **不动** |
| `wontfix` | 明确不做 | **不动**;若开着且策略允许,回复固定话术并关 |

**不要创建 `auto` / `in-progress` 或任何新标签。** 防重入用:
- issue 已有 open PR(`Closes #N` / `Fixes #N`)→ 跳过;
- 已指派给别人 → 跳过;
- 已指派给本轮 bot 且在 `LOOP_CLAIM_TTL_MINUTES`(默认 180 分钟)内 → 跳过(防并发);
- 超时且仍无 PR → 允许重新领取(防 agent 崩溃后永久卡死)。

## 策略(Orca 决定)

`select` 支持:
- `ready-for-agent`(默认):只做带该标签的 issue。
- `label:<name>`:只做带指定标签的 issue。
- `do`:采纳 triage 便宜模型的 `do` 判断(最接近 Magpie 全自动);Matt 的阻塞标签仍然优先。
- `off`:只出报告,不动手。

策略写在 Orca automation 的 prompt 里(见 `loop/orca.md`),每个项目/每条 automation
可以不同。仓库脚本不替 Orca 做决定。

## 实现

1. 给 issue 建分支:从最新 `main` 拉,分支名 `loop/<N>-<短 slug>`。
2. 先读本仓库的 `AGENTS.md`(若有)与 `memory/*`(若有),按其中门禁执行。
3. **不要假设技术栈**。按仓库约定找命令:
   - `AGENTS.md` 里写的命令优先;
   - 否则看 `package.json` / `Makefile` / `pyproject.toml` / 其它清单文件;
   - 都没有就以"能编译 + 逻辑自洽 + 手动冒烟"为准。
4. 逐条验收写清「跑了什么、在哪跑」;没跑就写 **Not run**,绝不假装。

## 交付

1. 推分支,开 PR 到默认分支,描述第一行 `Closes #N`。
2. 写清:改了什么、跑了什么门禁、在哪跑的、哪些 Not run。
3. **绝不合并**。合并永远由人类在 GitHub 审。
4. 不直接 push 默认分支;不改 secrets;不做发版。

## 边界

- 安全、删数据、破坏性变更、发版、审美/产品方向 → 只开 PR 或留评论请人拍板。
- 无法复现/缺少环境 → 写 **Not run** 并说明缺什么,不编造结果。
- 发现"这不该由 loop 做" → 在 issue 说明原因并停下。
- PR review 不在本作业单内;需要时用单独 automation 扩展,不要在这里顺手 merge。
