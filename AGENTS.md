# AGENTS.md

本仓库是 AGENT DECK（desktop-deck）：本地数据服务 + 桌面图标编排的独立项目，不依赖 Wallpaper Engine。

## Worktree 布局（平行开发）

- **主检出**：`D:\local_works\agent-deck`，常驻 `master`；数据服务、看门狗与自启链路以主检出为准，master 随时保持可推送。
- **feature worktree**：`D:\local_works\agent-deck-wt\<slug>`（分支 `feat/<slug>`）；并行跑数据服务用 `QD_PORT` 分端口，5000 留给主检出。
- 开工/收尾的完整流程（建树、环境自举、测试自检、合并清理）见 `agent-deck-worktree` skill。

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签词汇（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.
