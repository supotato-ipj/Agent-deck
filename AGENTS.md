# AGENTS.md

本仓库产出 **AGENT DECK 独立面板**：常驻桌面的 Electron 应用，以卡片网格与底部 dock 呈现五工具会话、Qoder 任务进度与硬件指标，并自绘承载桌面项。架构决策见 `docs/adr/0004-electron-cordis-standalone-panel.md`，领域词汇见 `CONTEXT.md`。Python 数据服务、看门狗与 WE 壁纸链已于 2026-09-29 退役（工单11），壁纸资产只读封存于 `archive/`。

## Worktree 布局（平行开发）

- **主检出**：`D:\local_works\agent-deck`，常驻 `master`，随时保持可推送。**开机自启指向主检出的 `app/`**——worktree 会被清理，自启项不指向它。
- **feature worktree**：`D:\local_works\agent-deck-wt\<slug>`（分支 `feat/<slug>`）。面板是**单实例**（二次拉起自动退出），并行 worktree 不要各拉一个常驻面板；真机验收用 `npm run accept`（验收模式绕开单实例锁，可与在跑的面板共存）。
- 开工/收尾的完整流程（建树、环境自举、测试自检、合并清理）见 `agent-deck-worktree` skill。

## 远端分支纪律

- 删除远端分支（`git push origin --delete <branch>` 等）前，必须先取得用户明确确认；未经确认，严禁删除 gh 仓库里非用户本人检出的分支。本地 `git branch -d` 不受限。

## 项目探查

- 探查项目架构或定位代码时，先用 codebase-memory-mcp（cbm）查代码图谱、用 `openwiki/` 证据索引建立全貌，再按需精读相关源码深入细节。

## Agent skills

### Issue tracker

Issues 以本地 markdown 文件形式存放在 `.scratch/<feature>/`。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签词汇（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `CONTEXT.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
