# AGENTS.md

本仓库产出 **AGENT DECK 独立面板**：常驻桌面的 Electron 应用，以卡片网格与底部 dock 呈现五工具会话与硬件指标，并自绘承载桌面项。架构决策见 `docs/adr/0004-electron-cordis-standalone-panel.md`，领域词汇见 `GLOSSARY.md`。Python 数据服务、看门狗与 WE 壁纸链已于 2026-09-29 退役（工单11），壁纸资产只读封存于 `archive/`。

## 分支与 Worktree 布局（平行开发）

- **master**：GitHub 上的集成分支，受 ruleset 保护——改动一律走 `feat/<slug>` / `fix/<slug>` 分支 + PR（CI 绿才可合并），不直接推送。
- **主检出**：`D:\test-folder\wallpaperengine-research`，常驻本地 `master` 分支（每次合流后 `git pull --ff-only` 快进到 origin/master）。**开机自启指向主检出的 `app/`**——worktree 会被清理，自启项不指向它。
- **worktree**：`D:\test-folder\wallpaperengine-research--<slug>`。面板是**单实例**（二次拉起自动退出），并行 worktree 不要各拉一个常驻面板；真机验收用 `npm run accept`（控制器进程绕开单实例锁，但全量电池拉起的真面板子进程仍抢锁——一律走下节调度协议）。
- 开工/收尾的完整流程（建树、自检、PR、验收快进、清理）见 `docs/agents/worktree-workflow.md`。

## 真机验收调度协议（accept-guard）

本机两个并行检出共享同一**验收槽**：同一时刻只允许一个真机 GUI 验收在跑（桌面注入、单实例锁、共用 userData、托盘/前景窗断言互相踩踏）。任何验收入口（`npm run accept` / `accept:tray` / `accept:taskbar` 等 electron `--accept*` 模式）一律经 guard 托管，禁止裸跑：

    node D:\test-folder\.accept-guard\guard.mjs hold --as <zcode|kimicode> --purpose accept-sprint -- npm run accept

- hold 全自动完成整个生命周期：排队 → 拿槽 → 清理各检出面板进程 → 系统通知 → 驻留心跳 → 验收命令退出自动释放。
- 抢槽前先 `guard.mjs status` 看对方相位；要出验收证据的一轮用 `--purpose accept-sprint`（排队优先），空挡自测用默认 `selftest`。
- 发起前可声明相位让对方可见：`guard.mjs phase <dev|selftest|accept-sprint|human> --note "..."`。
- 排队最长等 30 分钟，超时以退出码 3 结束——转做不占主机的活，或请用户裁决（用户应急解锁：`guard.mjs release --force`）。
- guard 自带行为电池：`guard.mjs selftest`（沙箱跑，不碰真实租约与真实面板）。协议全文与词汇表见 guard 目录 README.md。

## 远端分支纪律

- 删除远端分支（`git push origin --delete <branch>` 等）前，必须先取得用户明确确认；未经确认，严禁删除 gh 仓库里非用户本人检出的分支。本地 `git branch -d` 不受限。

## 项目探查

- 探查项目架构或定位代码时，先用 codebase-memory-mcp（cbm）查代码图谱、用 `openwiki/` 证据索引建立全貌，再按需精读相关源码深入细节。

## Agent skills

### Issue tracker

Issues 在 GitHub Issues，经 `gh` CLI 操作；认领 = assign（`gh issue edit <n> --add-assignee @me`）。`.scratch/` 只是 2026-09-30 前的只读归档。See `docs/agents/issue-tracker.md`.

### Triage labels

使用默认五标签词汇（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

单上下文布局：根目录 `GLOSSARY.md` + `docs/adr/`（按需惰性创建）。See `docs/agents/domain.md`.

<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
