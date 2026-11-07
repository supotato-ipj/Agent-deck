# 工单429 真机取证记录：guard 拿槽清场两级阶梯（优雅 WM_CLOSE 径→有界等待→强杀兜底）——优雅径三连红落回退线，「强杀产僵尸」升级为在档实证

- 日期：2026-11-07
- 工单：[#429](https://github.com/supotato-ipj/Agent-deck/issues/429)（spec：guard 优雅退出治产源侧——拿槽清理两级阶梯）；回退线后续票 [#431](https://github.com/supotato-ipj/Agent-deck/issues/431)（面板 second-instance 退出语义，needs-triage）
- 改动载体：guard（`D:\test-folder\.accept-guard\`，**非 git 独立目录**，全部代码改动不进本仓库）；本仓库内足迹仅本篇取证记录（spec #429 Implementation Decisions 既定口径）
- 判读素材：`D:\test-folder\.accept-guard\t429-*`（不进仓库，逐文件索引见 §5）
- 真机轮：3 轮（r1/r2/r3），一律经 accept-guard 托管（`hold --as zcode --purpose accept-sprint`，验收命令为 3s 占位 `node -e setTimeout(function(){},3000)`）；面板拉起方式与自启 lnk 完全一致（主检出 app，仅附加 `DECK_EVENT_LOG` 存证环境变量供断言③取事件流，不改面板代码/入口）
- 面板侧本轮**零改动**（只读源码归因，守 spec Out of Scope 边界）

## 1. 背景：因果链此前为拼合推断，本轮目标是坐实或证伪

「guard 强杀 → 面板来不及走退出链向托盘注销自家图标 → explorer 侧僵尸图标滞留呈现面」这条因果链，
此前在档（GLOSSARY「僵尸图标」词条、PR #428）仅为**拼合推断**——在档文档无直接原文实证。

工单 #429 据此立了产源侧治理：guard 拿槽清场改两级阶梯——先对枚举面板进程发优雅退出信号
（`taskkill` 不带 `/F`，即向顶层窗发 `WM_CLOSE`），面板走既有退出链自然注销托盘图标后自行退出；
有界等待后仍有残留才落既有强杀兜底。spec 预设的唯一残留不确定性是**面板主窗对 `WM_CLOSE` 有无
close 拦截**，并给定回退线：真机实证优雅径不通，则本票按两级阶梯现状收口，面板侧
second-instance 退出语义另立票（即后来的 #431）。

本轮真机取证就是 spec Testing Decisions 点名的那一轮，断言三件套：
① 面板主进程自发退出（kill-mode=graceful）② 真托盘无 electron 僵尸残留 ③ 回收（reaped）事件不因本轮触发。

## 2. 两级阶梯实现（guard 侧改动清单）

guard 为非 git 独立目录，以下行号引 `D:\test-folder\.accept-guard\guard.mjs` 当前工作副本：

| 位点 | 落点 | 内容 |
|---|---|---|
| 内建默认 | `guard.mjs:32-35` | `gracefulPanelsCmd`（枚举 electron.exe + 路径前缀匹配，逐 PID `taskkill /PID` 不带 `/F`）与 `gracefulWaitMs: 5000` |
| 配置校验 | `guard.mjs:95-96` | `gracefulWaitMs` 必须为非负数，否则退出 |
| 清场序列 | `guard.mjs:257-271` | 优雅径触达 → `waitPidsGone`（`guard.mjs:242`，预算内 500ms 轮询、PID 全消失提前出）→ 残留则强杀兜底并输出 `kill-mode=forced`（附残留 PID 清单），无残留输出 `kill-mode=graceful` |
| live 配置 | `D:\test-folder\.accept-guard\config.json` | 补 `gracefulPanelsCmd` + `gracefulWaitMs: 5000` 两键（缺键回落内建默认） |
| selftest 沙箱 | `guard.mjs:499-500` | `gracefulPanelsCmd: markerCmd('graceful')`（写标记 no-op、不触真机进程）、`gracefulWaitMs: 100`（防真等） |
| selftest T1 | `guard.mjs:576-577` | 触达序断言由 `['clear','notify']` 改 `['graceful','clear','notify']`（三步序：优雅→清场→通知），追加断言 hold 输出含 `kill-mode=graceful`；不新增缝位，T2-T10 未动 |

selftest 复核：本记录入库前实跑 `node D:\test-folder\.accept-guard\guard.mjs selftest`
→ `tests 10 / pass 10 / fail 0`（沙箱跑，不碰真实租约与真实面板）。

## 3. 真机取证过程与断言结果

### 3.1 断言① kill-mode 落点：三轮全 forced（红，落 spec 预设回退线）

每轮 guard hold 输出（`t429-rN.log`，`grep "kill-mode" t429-r*.log` 三行全中）：

| 轮 | 优雅径触达 | SUCCESS 信号 | 优雅等待 | 残留 | 强杀兜底 | 落点 |
|---|---|---|---|---|---|---|
| r1 | 15 PID | 6（含主进程 77500） | 5017ms | 14 | 14 PID | **forced** |
| r2 | 15 PID | 6 | 5011ms | 14 | 14 PID | **forced** |
| r3 | 15 PID | 6 | 5014ms | 14 | 14 PID | **forced** |

（计数命令：`grep -o "graceful [0-9]*" / "SUCCESS: Sent termination signal" / "kill [0-9]* "` 逐轮 `wc -l`；
等待时长取 `grep -o "优雅等待：触达 [0-9]* 个面板 PID，等 [0-9]*ms"`。）

判读：`gracefulWaitMs=5000` 硬预算等满后仍有 14/15 残留 → 强杀兜底。**优雅径三连不通**，
与 spec 预设的回退线触发条件（「close 拦截存在」）一致。

### 3.2 断言①b 面板主进程非自退

- 优雅等待残留清单**首位即面板主进程 PID**（r1=77500，与清场前枚举 `t429-r1-pids-before.txt` 首位一致）——
  主进程在 5s 预算内未走完退出链，非子进程拖尾。
- 源码归因（只读，面板侧零改动）：数据面托管窗 close 事件 `preventDefault + hide`
  （`app/src/main/conversation/window.ts:66-70`，注释原文「关窗只收起（ADR-0018）」）——
  guard 优雅径按 spec 决策「不甄别主/子」对全部枚举 PID 发 `WM_CLOSE`，正撞此拦截；
  主窗退出链在 `app/src/main/index.ts:756`（`win.on('closed', () => app.quit())`），
  收到 WM_CLOSE 的路径根本走不到这里。

### 3.3 断言② 托盘僵尸：琥珀识别色对照实验坐实（红=僵尸在场）

**【口径替代声明】** 规程指定的「koffi 工具栏按钮级枚举（t119 口径）」在本机不可执行：
探针 `t429-tray-probe.cjs`（Shell_TrayWnd / NotifyIconOverflowWindow 下搜 `ToolbarWindow32`，
跨进程 TBBUTTON→TRAYDATA→ownerPid）在本机 Win11 26300 XAML 任务栏实测 `toolbars: 0`
（`t429-tray-before-r1.json`）——经典 SysPager/ToolbarWindow32 子树已不存在，UIA 树从
`Shell_TrayWnd`/`SystemTray_Main` 根亦不可达。t119 审计文档的「按钮级」在本机语境本就是
UIA 呈现树 dump（`docs/audit/2026-10-11-t119-uia-tray-empty-name.md` §3）。故僵尸判定改用
电池既有先例口径（tray-spike.js P4/P7）：**真托盘条带/浮层截图 + 琥珀识别色像素计数**
（`capture.ps1` 截图 + `amber-count.ps1` 计数）。

- 识别色：面板托盘图标为程序化琥珀 `#f5a623` 四点（`app/src/main/tray.ts:16`，注释明示其为电池托盘识别色）。
- 基线（面板在场，`t429-tray-baseline-shot.json`）：托盘溢出浮层琥珀 **30** 像素 = 单图标在场。
- 每轮 forced 清场后（面板进程已 0，`Get-CimInstance` 断言）**即刻**取证
  （`t429-tray-r{1,2,3}-shot.json`）：浮层琥珀仍 **30** 像素，三轮一致 =
  **面板僵尸图标滞留呈现面**——宿主进程已死、图标仍在。
- 轮次间开箱/悬停会把上一轮僵尸清掉（`t429-tray-pre-r2-shot.json` 琥珀回到 31=单图标口径；
  pre-r1/pre-r3 同族），与本证不冲突。
- 结论：**「guard 强杀 → 来不及注销 → explorer 侧僵尸」从拼合推断升级为在档实证。**

### 3.4 断言③ reaped：时间窗内 0 条（弱证据注记）

事件流 `t429-panel-events.jsonl` 共 880 行，`grep -ci reaped` = **0**——三轮时间窗内回收事件未因本轮触发。
弱证据注记：reaped 由面板侧回收监视广播（`app/src/main/trayhost/host.ts:440`，
`onEvent(reapedTrayEvent(...))`），面板被清后本机无监视者在场，该通道当时无人在位——
「回收未因本轮触发」字面成立但非强验证（对照 spec423 P7 需活面板在场）。

### 3.5 观察项：NotifyIconSettings electron 条目 14 → 16（仅观察，不当谓词，ADR-0012 口径）

- 前（`t429-registry-before.txt`）：`electron entries total: 14`；后（`t429-registry-after.txt`）：**16**。
- +2 新条目（hash `3679954367851932224`、`433875315615793758`）均属
  `wallpaperengine-research--325-p14-corpus` 检出——开跑时该并行检出正持槽跑工单325 取证轮2
  （PID 80300），为其验收清场/注册所产。
- 主检出条目恒 3 条，本轮 3 次清场**未新增**主检出条目。按 ADR-0012 口径仅观察、不当验收谓词。

## 4. 因果实证结论与回退线

| 因果半边 | 判定 | 依据 |
|---|---|---|
| 强杀产僵尸 | **实证坐实** | §3.3 对照实验：清场后面板进程 0 而琥珀僵尸图标滞留呈现面（r1/r2/r3 一致 30 像素） |
| 优雅径零僵尸 | **未能实证（优雅径不通）** | §3.1 三连 forced；close 拦截在档（§3.2 源码归因） |

按 spec #429 回退线裁定：本票按两级阶梯现状收口——强杀兜底保留为最后一级（不可拆除），
产源未绝但被显示侧兜底（工单423 回收机制）+ 悬停被动清除兜住；面板侧
second-instance 退出语义已另立票 [#431](https://github.com/supotato-ipj/Agent-deck/issues/431)
（needs-triage），不阻塞本票关账。建票时已核对：`gh issue view 429` 对齐原文 +
`grep` 三份 `t429-*.log` 核实三轮全 forced。

## 5. 证据文件索引（D:\test-folder\.accept-guard\，不进仓库）

| 组 | 文件 | 内容 |
|---|---|---|
| guard 输出 | `t429-r1.log` / `t429-r2.log` / `t429-r3.log` | 每轮 hold 全程：优雅径触达、优雅等待、kill-mode=forced 与强杀清单 |
| 清场前枚举 | `t429-r1-pids-before.txt` / `t429-r2-*` / `t429-r3-*` | 每轮清场前面板 PID 表（残留主进程比对基准） |
| 窗口存证 | `t429-r1-window.txt` / `t429-r2-*` / `t429-r3-*` | 每轮取证窗口起点时间戳 |
| 托盘判定 | `t429-tray-{baseline,pre-r1,pre-r2,pre-r3,r1,r2,r3,post-restore}-shot.json` + 同名 `-flyout.png`（及 `-maintray.png`） | 琥珀像素计数与截图（僵尸判定主证据） |
| 探针 | `t429-tray-probe.cjs` / `t429-tray-before-r1.json` / `t429-tray-dump.ps1` / `t429-tray-dump-baseline.jsonl` | koffi 按钮级枚举实测不可执行的证据（toolbars=0）与 UIA dump |
| 注册表 | `t429-registry-before.txt` / `t429-registry-after.txt` | NotifyIconSettings electron 条目 14→16 明细（§3.5） |
| 事件流 | `t429-panel-events.jsonl` | 面板侧 `DECK_EVENT_LOG` 存证（reaped 计数 0） |
| 工具脚本 | `t429-tray-shot.cjs` / `t429-flyout-open.cjs` / `amber-count.ps1` | 截图、开浮层、琥珀计数（tray-spike P4/P7 口径） |

## 6. 环境波折与边界注记

- 开跑时验收槽被同名 zcode 并行会话（工单325）持有约 4 分钟，按规程轮询 `guard.mjs status` 等空闲（未抢）；
  期间预拉的常驻面板被对方清场杀掉，r1 前重拉。
- 收尾已按原样恢复常驻面板（去存证变量，托盘图标注册琥珀 32 像素），验收槽空闲。
- guard / 面板代码本轮取证**零改动**：guard 侧阶梯改动系工单实现（§2），面板侧全程只读。
