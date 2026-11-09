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

   **另两条本机既有信号（2026-11-01 实测，与本机改动无关，基线 `origin/master` 同现）**——别把它们当回归去追，也别因此放宽任何断言：

   | 信号 | 形态 | 判据 |
   |---|---|---|
   | `npm test` 以 **exit 1** 收尾，但**用例全绿** | 末尾一条未处理错误 `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`（vitest worker IPC 超时），计数行仍是 `Test Files 134 passed (134)` / `Tests 2605 passed (2605)` / `0` 失败 | **看计数不看退出码**：`Tests` 行 0 失败即放行。要坐实是既有信号，把改动 `git stash` 后原样复跑一次，错误照样出现即定谳 |
   | `tests/contract.spec.ts` 在**全量并行**时红 | `EPERM: operation not permitted, rename ... config.json.tmp -> config.json`（Windows 文件占用） | 单跑 `npx vitest run tests/contract.spec.ts` → `107 passed` 即放行 |

   两条都出在「全量并行 + 本机负载高」的窗口。**判据始终是计数行**：`Test Files` / `Tests` 的通过数与失败数，以及完整失败输出（真失败要留全文，别截断）。
5. 开发与提交都在 worktree 进行；提交信息沿用 `type(scope): 工单N 描述`（现行格式以 git log 为准）。

## 收尾

> **切根后并流纪律（2026-10-25 起）**：master 历史按 7 天滚动窗定期钝切（force-push，见 `AGENTS.md`「历史保留窗」）。切根后，一切基于旧链的分支**并流前必须先 rebase 到新 master**——merge 会把旧链对象整链带回，把已切掉的历史重新撑爆。在途 worktree 分支平时不动，各自并流时 rebase（冲突按工单语义解）。切根执行者同样受约束：**force-push 前必须 re-fetch 核对 origin/master 仍等于重建基点，前进过就重跑两刀**（2026-10-25 #285 被覆盖事故）。

1. **真机验收**：分支上自检全绿后，在 worktree 里 `npm run accept`。验收模式绕开单实例锁，可与在跑面板共存。完成判据：验收电池通过。**注意**：全量电池拉起的真面板子进程仍会抢单实例锁，且本机多个检出共享同一验收槽——一律经 accept-guard 托管，禁止裸跑，协议见 `AGENTS.md` 的「真机验收调度协议（accept-guard）」一节。
2. **PR 合流**：push `feat/<slug>` 并 `gh pr create`。master 受 ruleset 保护，改动一律经 PR，CI（test.yml）绿后合并。完成判据：PR 合入 origin/master。

   **网络**：`gh` 与 `git` 都不带代理配置（仓库 `.git/config` 只有 `[http] version = HTTP/1.1`，全局 `.gitconfig` 亦无 proxy 键）——本机直连 GitHub 慢而不稳，`push` 新建远端分支这类握手较重的操作容易长时间无输出。稳妥做法是两个命令都显式带上代理，别依赖任何已配置的代理：

   ```powershell
   $env:HTTPS_PROXY='socks5h://127.0.0.1:1080'   # gh 与 git 共用
   git push -u origin feat/<slug>
   gh pr create --base master --head feat/<slug>
   ```

   裸 `gh` 直连常被重置；裸 `git` 不是必然失败（`git ls-remote` 直连实测可用），但别把「有时能直连」当成有代理兜底。push 卡住时先确认自己设了代理或设了超时，别空等。

   **代理没在跑时的兜底（2026-11-01 实测）**：本机 `127.0.0.1:1080` 的 SOCKS 代理可能压根没起（`Test-NetConnection 127.0.0.1 -Port 1080` → `TcpTestSucceeded=False`），此时上面的代理写法不成立。实测此时的通路是**直连 + HTTP/2**：仓库 `.git/config` 钉的 `[http] version = HTTP/1.1` 会被 GitHub 重置（`Recv failure: Connection was reset` 或 `Failed to connect to github.com:443`），而同一时刻 `api.github.com` 是通的（`curl` 200、gh 全套 API 正常）——**只挡 `github.com` 的 TLS/SNI 通路**。所以 `gh` 那套照常用，`git` 侧显式覆成 HTTP/2 并允许重试：

   ```powershell
   git -c http.version=HTTP/2 push -u origin feat/<slug>      # 重试到 exit=0 为止
   git -c http.version=HTTP/2 pull --ff-only                    # master 快进同理
   ```

   直连链路本身是间歇性的（同一分钟内 `ls-remote` 可能成也可能败），**别把一次失败当成路不通就改用 API 拼 commit**——重试 2~4 次通常就成了；`gh pr create` 走 `api.github.com`，不受此影响。
3. **master 快进**：主检出执行 `git checkout master && git pull --ff-only`。主检出的 `app/` 是开机自启目标，每次合流后都要快进保持最新。完成判据：`git rev-parse master origin/master` 输出相等。
4. **工作区卫生（收尾前核对）**：电池在哪个检出跑，就核对该检出的 `git status`——电池每轮会重写 `app/accept/evidence` 的文本审计链（jsonl/log），**不改段的验收轮/健康轮/自测轮**跑完后要么随在途 PR 入库、要么 `git restore` 还原，不留未提交差异挂着（面板「更改」计数与后续会话会一直看到它；2026-11-09 状态卫生 PR #448 即此残留的清账）。会话底稿/探针一律写 `.scratch/`（已整目录 ignore）或仓库外，不得落在 `app/src/`、`research/` 等入库路径。完成判据：`git status --short` 输出为空。
5. **清理**（在主检出执行）：`git worktree remove "D:\test-folder\wallpaperengine-research--<slug>"`、`git branch -d feat/<slug>`、`gh issue close <n> --comment "<收尾摘要>"`。完成判据：worktree 已移除、本地分支已删、工单已关。远端分支由仓库的「合并后自动删除」接管（PR 合并即清），清理清单**不含远端分支项**，也不要提议删除已合并 PR 的远端分支；删未合并在途分支的保护规则见 AGENTS.md 远端分支纪律。

## 孤儿检出清理

`git worktree list` 只认已登记的检出。收尾时若 `git worktree remove` 失败或手工删过目录，`D:\test-folder\wallpaperengine-research--<slug>` 会留下无 `.git` 的孤儿目录——`git worktree prune` 清不掉它（prune 只清登记元数据，不删目录）。

- **盘点**：`node app/scripts/cleanup-local.js` 的 `orphan-checkouts` 类别列出「带 `<repo>--` 前缀但未登记」的目录与体积（只报告，不自动删）。
- **处置**：确认目录内无未提交工作后整目录删除；有未提交工作先拷出或补提交。
- **悬空 junction**：`.scratch/` 下若有指向已删目标的联接，`Get-Item <path> -Force | Select LinkType` 确认后用 `Remove-Item` 删链接本身，不要递归删目标。
- **核对**：清理后 `git status` 不应出现 "could not open directory" 警告。
