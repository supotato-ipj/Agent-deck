---
Status: accepted
---

# accept-guard 仓内化 + 拿槽/释放槽双侧任务栏还原兜底

电池收尾对面板是拔电式强杀（`handle.stop()` → taskkill /T /F），面板来不及还原原生任务栏的可见性账（SW_HIDE）；`--panel-accept` 电池面板又不带外层守卫/还原守护链。主电池与 taskbar 族电池在自己 finally 里有 `--icon-restore` 自救，但 placement / conversation / tiling 族六块电池没有——每跑一次就把「任务栏压死、鼠标触底无响应」的桌面留给用户（2026-11-15 真机取证定谳，工单495）。同时 guard 一直以仓外工具形态住在 `D:\test-folder\.accept-guard`，改动跨仓、无评审链（ADR-0008 曾因此放弃 guard 侧提示条方案）。

裁决两件一并落地：

1. **guard 仓内化**：源码迁入 `app/accept/guard/`（guard.mjs + README），与验收电池同仓演进、同 PR 评审。家目录（租约 guard.json、相位 status.json、生产 config.json、互斥 guard.lock）**固定在本机 `D:\test-folder\.accept-guard` 不随检出走**——既有租约状态与 `--panel-quit` 优雅径配置零迁移连续，运行态绝不写进 git 检出；源码位置与家目录分离后，selftest 子进程拉 `SCRIPT_PATH`（`import.meta.url`），不再从家目录找脚本。
2. **任务栏还原兜底走调度层**：新增 config 效果命令 `restoreTaskbarCmd`（默认 = 主检出 electron `--icon-restore` 自救通道：桌面图标还原 → appbar 落盘账复原 → 原生任务栏 SW_SHOW，幂等、不抢单实例锁），**拿槽与释放槽两侧各跑一次**——拿槽治愈 guard-dead 接管的残局，释放槽保证「槽还给了 = 桌面是干净的」。这是逐电池补 finally（候选①，漏网风险随新增电池增长）与 handle.stop() 内嵌（候选②，污染 50-taskbar-carry 按 reason 分径的存证断言）之外被用户拍板的第三条路：单点全覆盖、零电池代码改动、不碰任何电池断言。

## Considered Options

- **逐电池补 `--icon-restore` 兜底（照 battery.js 先例）** — 最合「电池自己清场」章法，但六块起改、未来新电池可忘接，漏网面随电池数增长。
- **panel-control `stop()` 内嵌还原** — 所有电池唯一收口，但强杀后多出 `reason=force` 的 `taskbar-restored` 存证，与 50-taskbar-carry A2/A3/A4 按 reason 分径的断言竞争；且违背其「零 koffi 零主机效果」模块纪律。
- **guard 调度层双侧兜底（采纳）** — 单点、全覆盖（含电池中途崩溃的异常路径——release 在 finally 里必达）、电池零改动；代价是每次 hold 多两次 electron 冷启（约 4–10s，相对多分钟级电池可忽略），且 guard 效果面从「清面板+通知」扩为「清面板+还原+通知」。

## Consequences

- 电池**不再被要求**自带任务栏清场（既有 battery.js / taskbar-carry / taskbar-appbar 的自救保留，双保险无害）；「轮末清场」章法对任务栏账的义务自本 ADR 起由调度层承担，电池侧漏网由 guard 兜住。
- `release --force`（应急解锁）**不跑还原**：持锁方可能还活着，还原会与在跑面板打架；应急路径保持「只清租约」。
- 家目录 config.json 无需手工迁移（`loadConfig` 浅合并，新键自动取默认）；`restoreTaskbarCmd` 置空字符串即禁用。
- guard selftest 沙箱替身同步扩为五效果（graceful/clear/restore/notify/restore），T1 触达序断言钉住双侧兜底的存在。
- guard 源码自此受仓库 CI 与评审管：改动走 PR，selftest（`npm run guard:selftest`）是它的行为电池；ADR-0008「guard 在仓库外改动跨仓」的事实陈述自此失效。
- 调度命令随之变更：`node D:\test-folder\wallpaperengine-research\app\accept\guard\guard.mjs hold …`（AGENTS.md 同步）。

关联工单：#495（本 ADR 落地）、#63（guard 诞生）、#496（跨进程账目投毒观察项——本 ADR 不修，engage 前消费落盘账另票处置）。
