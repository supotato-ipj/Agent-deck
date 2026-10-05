---
name: agent-deck-worktree
description: agent-deck 单工单开发流程：开工（认领 issue、建 worktree、自检）与收尾（真机验收、PR 合流、master 快进、清理）。在本仓库开工新工单或收尾合流时使用。
---

<!--
本文件是 `agent-deck-worktree` skill 的**仓库权威副本**。

入库原因：此前它只以未跟踪文件的形式存在于某个检出的 `.zcode/skills/` 下，而 AGENTS.md
一直引用它 —— 全机唯一副本、协作者看不到、清一次目录就没了。

要在本机作为 skill 加载：把本文件（含上面的 frontmatter）整份复制到
`<检出>/.zcode/skills/agent-deck-worktree/SKILL.md`。`.zcode/` 已被 gitignore，
所以本地副本只是拷贝，改动请改这里。
-->

一张工单一个闭环：**一个 worktree、一条 `feat/<slug>` 分支、一个 PR、一次真机验收**。主检出 = `D:\test-folder\wallpaperengine-research`（master），worktree = `D:\test-folder\wallpaperengine-research--<slug>`。gh 命令语法见 `docs/agents/issue-tracker.md`。

## 开工

1. **认领工单**：`gh issue list --state open` 选定目标，认领 = `gh issue edit <n> --add-assignee @me`（本会话第一次写操作）。从工单标题提炼 `<slug>`。
2. **建 worktree**（在主检出执行）：

   ```
   git fetch origin
   git worktree add "D:\test-folder\wallpaperengine-research--<slug>" -b feat/<slug> origin/master
   ```

   完成判据：worktree 就位，分支基于最新 origin/master。
3. **自举**：worktree 的 `app/` 下 `npm ci`。koffi/esbuild 的 install-scripts 被 npm 策略拦掉是无害告警，发布包自带预编译产物。
4. **自检**：`npm run build && npm run typecheck && npm test`。完成判据：三项全绿。`tests/autostart.spec.ts` 的真 COM 用例在全量并行跑时常挂，是本机环境抖动（issue #33），不是回归——单跑 `npx vitest run tests/autostart.spec.ts` 绿即放行。
5. 开发与提交都在 worktree 进行；提交信息沿用 `type(scope): 工单N 描述`（现行格式以 git log 为准）。

## 收尾

1. **真机验收**：分支上自检全绿后，在 worktree 里 `npm run accept`。验收模式绕开单实例锁，可与在跑面板共存。完成判据：验收电池通过。**注意**：全量电池拉起的真面板子进程仍会抢单实例锁，且本机多个检出共享同一验收槽——一律经 accept-guard 托管，禁止裸跑，协议见 `AGENTS.md` 的「真机验收调度协议（accept-guard）」一节。
2. **PR 合流**：push `feat/<slug>` 并 `gh pr create`。gh 需 `HTTPS_PROXY=socks5h://127.0.0.1:1080`（本机直连 GitHub 常被重置；git 自身已在仓库配置带代理）。master 受 ruleset 保护，改动一律经 PR，CI（test.yml）绿后合并。完成判据：PR 合入 origin/master。
3. **master 快进**：主检出执行 `git checkout master && git pull --ff-only`。主检出的 `app/` 是开机自启目标，每次合流后都要快进保持最新。完成判据：`git rev-parse master origin/master` 输出相等。
4. **清理**（在主检出执行）：`git worktree remove "D:\test-folder\wallpaperengine-research--<slug>"`、`git branch -d feat/<slug>`、`gh issue close <n> --comment "<收尾摘要>"`。完成判据：worktree 已移除、本地分支已删、工单已关。删除**远端**分支前必须先取得用户明确确认。
