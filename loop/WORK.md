# Work —— 实现本轮选中的那个 issue

> 项目无关。issue 号来自 `.loop/work.json` 或环境变量 `ISSUE_NUMBER`。

## 1. 确认对象

- 读 `.loop/work.json`;没有就退出,打印 `no issue to work`。
- 一次**只做一个** issue。不要在同一轮里顺手做别的。
- 若 issue 已有 open PR、已被别人指派、或已关闭 → 停下,不要重复做。

## 2. 开工前

按本仓库现有约定读(有就读,没有就跳过):
- `AGENTS.md` —— 路由表与必读文档;
- `memory/code-standards.md` —— 合并门禁;
- `memory/DECISIONS.md` —— 不可擅自推翻的决策;
- `memory/LESSONS.md` —— 错题本。

## 3. 实现

1. `git pull --ff-only`,从默认分支出 `loop/<N>-<短 slug>`。
2. 只改 issue 需要的内容,保持向后兼容。
3. 跑门禁。**不要照抄别的项目命令**:
   - `AGENTS.md` / `code-standards` 写了就照做;
   - 否则从清单文件自动判断(如 `npm test`、`make test`);
   - 都没有就跑最接近的编译/冒烟,并在 PR 里说明。
4. 有多余中间提交就 squash 成一个干净提交。

## 4. 交付

1. 推分支,开 PR,第一行 `Closes #N`。
2. 逐条写验收:命令、目录、结果;没跑写 **Not run**。
3. 把 PR 链接回贴到 issue。
4. **不合并**,不 push 默认分支。

## 边界

- 涉及安全、删数据、破坏性、发版、审美/产品方向 → 只开 PR,注明需要人类拍板。
- 无法在本地真实验证 → 明确写 **Not run** 与原因。
- 发现不该在 loop 里做 → 在 issue 说明并停下。
