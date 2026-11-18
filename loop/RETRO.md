# Retro —— 每日复盘作业单(项目无关)

> 由 Orca 的独立每日 automation 派发。目标是把"踩过的坑"变成下次的规则,
> 而不是写一份好看的日报。

## 1. 读素材

- 运行 `node loop/run.mjs retro` → `.loop/retro.md`(提交、合并 PR、变动区域、窗口)。
- 读仓库里的复盘文件(有就读):
  - `memory/LESSONS.md`(默认;可用 `LOOP_LESSONS_PATH` 改)
  - `memory/code-standards.md`
  - `memory/DECISIONS.md`

## 2. 只记有证据的教训

盯三类:
1. **修完又返工** —— 同一处反复改。
2. **压根不该合** —— 引入回归、破坏兼容、与决策冲突。
3. **验证太糙** —— 只说"跑过了",没有可复现命令/结果。

每条格式:
- 一句规则(能执行,不是感想);
- 一段原因;
- 证据:commit / issue / PR 号。

做对的事也记,标 `✅ **Done right**`,让后来的 agent 照着来。

## 3. 转正

同一条教训在约 3 个不同日期的复盘里出现 → 提议写进 `memory/code-standards.md`,
变成硬门禁;不要只留在错题本里。

## 4. 交付

1. 从默认分支出 `loop/retro-YYYY-MM-DD`。
2. 只改复盘/标准相关文件,不顺手改业务代码。
3. 开 PR,标题 `chore(loop): retro YYYY-MM-DD`,写清本次新增/修改了哪些规则。
4. **绝不合并**,不 push 默认分支。
5. 没有值得记的内容 → 说明检查过哪些提交,直接结束,不硬凑。

## 边界

- 不为了"有产出"编造教训;证据不足就写"本轮无新增"。
- 不删别人的历史教训;要推翻先更新 `memory/DECISIONS.md` 并说明理由。
