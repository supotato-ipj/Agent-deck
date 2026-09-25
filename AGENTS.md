# AGENTS.md

本仓库用于 Wallpaper Engine「TERMINAL 02」壁纸改造：显示 Qoder 任务状态。

## Worktree 布局（平行开发）

- **主检出**：`D:\local_works\agent-deck`，常驻 `master`；数据服务、看门狗与自启链路以主检出为准，master 随时保持可推送。
- **feature worktree**：`D:\local_works\agent-deck-wt\<slug>`（分支 `feat/<slug>`）；并行跑数据服务用 `QD_PORT` 分端口，5000 留给主检出。
- 开工/收尾的完整流程（建树、环境自举、测试自检、合并清理）见 `agent-deck-worktree` skill。

## 远端分支纪律

- 删除远端分支（`git push origin --delete <branch>` 等）前，必须先取得用户明确确认；未经确认，严禁删除 gh 仓库里非用户本人检出的分支。本地 `git branch -d` 不受限。

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签词汇（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.
