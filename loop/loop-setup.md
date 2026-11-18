# Loop 机器侧准备(一次性)

目标是让 Orca 能按需替你跑两件事:实现 issue、每天复盘。脚本本身不绑定项目。

## 1. 机器上要有

- `node` 18+、`git`、`gh`、`curl`(Orca 终端环境通常已具备)
- 一个能在本机非交互运行的 coding agent(Orca 里配置,如 `codex` / `claude`)
- `gh auth login` 一次(或给运行环境设 `GITHUB_TOKEN`)

## 2. 仓库里要有

- 整个 `loop/` 目录
- Matt 的五个 triage 标签(`needs-triage` / `needs-info` / `ready-for-agent` /
  `ready-for-human` / `wontfix`),由 `/triage` 维护
- 可选的 `AGENTS.md` 与 `memory/*`(门禁、决策、错题本),loop 会优先遵守

## 3. 创建两条 Orca automation

```bash
node loop/orca-setup.mjs --policy ready-for-agent --disabled
```

默认创建:
- `issue-loop`:每小时(`0 * * * *`)
- `retro-loop`:每天 06:30(`30 6 * * *`)
- 时区 `Asia/Shanghai`,precheck 为 `node loop/precheck.mjs`

`--disabled` 是有意的:先看报告,再启用。

## 4. 验证 checklist

- [ ] `node loop/run.mjs triage --policy ready-for-agent` 能生成 `.loop/triage.md`,
      且 Matt 标签被正确识别
- [ ] `node loop/run.mjs select --policy ready-for-agent` 选中预期 issue(或退出码 3)
- [ ] `node loop/run.mjs retro` 能生成 `.loop/retro.md`
- [ ] `orca automations list --json` 能看到 `issue-loop` / `retro-loop`
- [ ] `orca automations run <id>` 手动跑一轮,确认 agent 按 `loop/LOOP.md` / `loop/RETRO.md` 执行
- [ ] 满意后再启用 automation

## 5. 迁移到别的仓库

把 `loop/` 拷过去,在该仓库根目录重新跑一次 `node loop/orca-setup.mjs ...`。
策略、频率、时区都在 Orca 的 automation prompt 里,按项目改即可。

完整说明见 [`orca.md`](orca.md)。
