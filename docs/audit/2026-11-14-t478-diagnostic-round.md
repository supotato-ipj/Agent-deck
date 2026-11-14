# 工单478 诊断轮取证：开机链卡点 / explorer 图标回归点 / 工具图标慢启动归因 / CPU 对照采样

> 2026-11-14，本机真机取证（Win11）。分支 `feat/478-forensics`，worktree
> `D:\test-folder\wallpaperengine-research--feat478-forensics`（基点 `feat/472-perf-integration`
> @ f2afe08，含 #473 常驻事件日志与 #474 优化）。探针入库 `app/accept/experiments/t478-*.js`，
> 轮证据 `app/accept/evidence/t478-*`。GUI/真机轮一律经 accept-guard 托管；只读探针（案2 窗口
> 判据重放、launch 通道对照）零注入零打扰随时跑。
> 本票是诊断票：产出为实锤数据与本报告，不含产品代码改动。

## TL;DR

- **案2 explorer 图标（定谳）**：点击「从不打开」的直接根因是 **launch 通道对 explorer.exe
  特定失败**——面板 launchExe = `shell.openPath('C:\Windows\explorer.exe')`（Electron
  ShellExecute 'open' verb）在真机实测恒返回 `"Failed to open path"`（86ms、零窗口），而
  同语义 CreateProcess（`spawn('explorer.exe')`）**成功开窗**（"Home - File Explorer"）；
  notepad.exe 对照组 openPath 成功（313ms 开窗）。失败回执只进主进程记账事件，渲染层
  无任何视觉反馈（onAppClick 注释明示 launch/activate/minimize 无需回显）⇒ 用户视角
  「点了没反应」。**回归点（时点）= 2026-10-14 08:16:31 explorer 被手钉进任务栏**
  （`userData/taskbar-layout.json` iconKey 时间戳 1791936991458）：手钉后图标恒在场、
  无资源管理器窗口时点击恒走 launch 通道、通道恒失败。通道实现（shellOpen）与 Electron
  版本（44.4.3）此后均未变更，故「从某时刻起坏」与手钉时刻吻合。#482 票面嫌疑
  「桌面宿主窗误路由」被活体证据**排除**：Progman 带 WS_EX_TOOLWINDOW 位，恒被
  shouldShowOnTaskbar 拒（见 §二）。修复方向：explorer.exe 特判走 spawn/explorer 专用
  通道（有窗置前路径现状正常）。
- **案1 开机链（部分定谳 + 待自然重启观察项）**：链内（bootT0→panel-visible）热机形态
  实锤 **3.15 秒**（生产 userData/events.jsonl @ 12:52:55 轮，#473 boot-phase 6 相位全戳）；
  最大单段 = autostart 同步 PowerShell **1.19 秒**（热态、单次 read；冷态上界 20s，开机
  窗口 PowerShell/.NET/COM 冷启会显著放大）。代码级无界等待点：`await
  kernel.desktopWorkspace?.start()`（index.ts 裸 await，无显式上界——ADR-0032 列名嫌疑，
  未修）；`kernel.panelData.whenReady` 有界（15s 超时放行）；`kernel.start()` 热态 188ms。
  开机分钟级缺口的**前段**（登录→自启项执行→electron 进程→bootT0）在面板进程之外，
  本轮无插桩手段；外部锚已在档（Kernel-Boot 事件：2026-11-14 09:48:35 等）。带插桩
  冷启动复测的完整定谳待自然重启（前置：#473 形态随 #472 并流正式部署后，
  events.jsonl 自动积累 boot-phase 数据，首轮开机即可读出「卡在哪一秒」）。见 §一。
- **案3 工具图标慢启动（数据轮已跑，见 §三）**：面板侧 spawn 链（shellOpen 返回）与
  工具自身冷启（openPath 返回→首个合格窗出现）分开计量。
- **案4 CPU 对照（数据轮已跑，见 §四）**：基线 7.38%（2026-11-14 存档）vs 优化中形态
  （worktree 集成 tip 含 #474-#477）vs 生产形态（master 基线代码）同法三组各 3×20s。

## 一、案1：开机链「卡在哪一秒」

### 已有实锤（本轮取证）

1. **生产常驻事件日志已在档一轮全链插桩**（`%APPDATA%\agent-deck-panel\events.jsonl`，
   boot 事件 t=1794631976890 = 2026-11-14 12:52:55，pid 33056——含 #473 代码的面板实例，
   热机形态）：

   | 相位 | elapsedMs | 段增量 | 说明 |
   |---|---|---|---|
   | config-loaded | 11 | 11ms | 同步 loadConfig |
   | autostart-applied | 1205 | **1194ms** | 同步 PowerShell spawnSync（read 单次，autostart.ps1 COM WScript.Shell） |
   | kernel-started | 1393 | 188ms | kernel.start() 服务装配 |
   | panel-data-ready | 2079 | 686ms | 数据面子进程首拍（whenReady 有界 15s） |
   | window-wired | 2728 | 649ms | 开窗 + 任务栏控制器 + **`await desktopWorkspace.start()`**（无上界） + 四控制器 |
   | panel-visible | 3146 | 418ms | ready-to-show 首显 |
   | taskbar-ready | +151ms | — | 条带装配完成 |

   ⇒ **热机全链 3.15 秒**，链内无分钟级段；ADR-0032 的「热机重启约 7 秒」与本链 3.15s
   的差值是进程 spawn + 模块加载 + 首帧渲染（bootT0 之前的 electron 侧 + 首显后用户可感）。

2. **同步 PowerShell 段**（autostart-applied，index.ts config-loaded→autostart-applied）：
   每次启动必跑 `spawnSync('powershell.exe', …, { timeout: 20000 })` 读 Startup .lnk
   （autostart.ts runHelper，滞后哨兵 'autostart' 标签）。热态 1.19s；开机窗口 PowerShell
   5.1 + .NET + COM 冷启按常见形态放大至数秒~15s 级（上界 20s）。**这是开机窗口链内
   最可疑的确定性放大段**。

3. **无界等待点（代码定位，未修——诊断票不混入修复）**：
   - `app/src/main/index.ts` 770：`await kernel.desktopWorkspace?.start()`——裸 await 无显式
     上界（doStart → reconcileNow → 桌面事实读取；#474 已把常驻路径改为进程内 FFI 直读 +
     reg.exe fallback，开机窗口 shell/COM 未就绪时的时长不可控）；
   - `await kernel.start()`（index.ts 658）与 `await kernel.panelData.whenReady`（720，15s
     有界）热态合计 0.87s，开机窗口存在放大可能但非无界。

4. **bootT0 之前的前段缺口**（登录 → Startup .lnk 执行 → electron 进程创建 → 模块加载 →
   bootT0）：面板进程之外的系统段（shell 处理 Startup 文件夹的时机、磁盘 IO 风暴、
   electron 模块加载）。本轮无插桩手段，**无实锤，不做推测**。外部锚已采样在档：
   System 日志 Kernel-Boot 事件（2026-11-14 09:48:35、2026-11-13 21:27:49、11-13 02:10/02:08、
   11-01 11:07/11:05、10-31 21:15、10-29 05:51）——首轮插桩冷启动可与之对齐读出前段缺口。

### 待自然重启观察项（如实列明，不用推测充当实锤）

- **W1（冷启动哪一秒的终局定谳）**：#473 形态正式部署为生产后**首次自然开机**：
  读 `userData/events.jsonl` 该轮 boot-phase 六相位分布 → 与 12:52 热机轮逐段对照，
  放大段即冷启动卡点；boot 事件 t 与 Kernel-Boot/6005 事件时刻之差 = 前段缺口
  （登录→面板进程起跳）。若 autostart 段与 window-wired 段（含 workspace.start()）
  都没有分钟级放大而总缺口在分钟级，则卡点在前段（系统侧），需要另一层锚
  （如自启项执行时刻的系统级审计）——届时另立取证。
- **W2（shadow 已知嫌疑的终验）**：冷启动轮的 lag-sentinel sidecar（DECK_LAG_SENTINEL
  若启用）'autostart' span 的冷态实测值。

## 二、案2：explorer 图标回归点（定谳）

### 现象与语义

任务栏应用组手钉的 explorer 条目（`C:\Windows\explorer.exe`，label "explorer"），点击
期望「有资源管理器窗口则置前、无则新开『此电脑』」（#482）。用户确认属回归、
「从某时刻起再也点不开」。

### 点击链路（代码）

- 渲染层 `taskbar.ts onAppClick` → `taskbar/app-click`（桥）→ 主进程
  `services/taskbar.ts appClick` → 纯函数 `decideAppClick(windows, foregroundHwnd)`
  （taskbar/interactions.ts）：windows 空 = launch；单窗未前台 = activate；多窗 = pick。
- `windows` = `nativeTaskbarWindows()`（枚举全可见顶层窗）过 `shouldShowOnTaskbar`
  （apps-plan.ts，唯一裁决点）后按 exe 归一取集。
- launch 路径：`launchExe` 默认实现 = `desktop/adapter.ts shellOpen` = Electron
  `shell.openPath(exe)`。activate 路径：`nativeFocusExeWindow`（z 序首个该 exe 合格窗置前）。

### 活体探针（只读，零注入；探针入库 app/accept/experiments/t478-explorer-probe.js）

真机枚举 explorer.exe 可见顶层窗 + shouldShowOnTaskbar 判据重放（2026-11-14 13:25）：

- explorer 的可见窗族：`Shell_TrayWnd`（空标题→拒）、6×`DummyDWMListenerWindow`
  （toolWindow+cloaked→拒）、**`Progman`（title "Program Manager"）**。
- **Progman 活体特征**：visible=true、cloaked=false、`toolWindow=true`（WS_EX_TOOLWINDOW
  位在场）、owned=false、title="Program Manager" → **被 toolWindow 分支拒**。
- ⇒ 判据重放 `eligibleByShouldShowOnTaskbar = []`：**explorer 无合格运行窗 → running=false
  → 点击恒走 launch**。#482 票面嫌疑「桌面宿主窗误路由」**排除**：Progman 恒不合格，
  不可能进运行态/置前候选。

### launch 通道三对照（探针 t478-explorer-launch-spawn-probe.js / t478-shellopen-*-probe.js）

| 通道 | 结果 | 耗时 |
|---|---|---|
| `spawn('explorer.exe')`（CreateProcess，与 ShellExecute open 同语义） | **开窗成功** "Home - File Explorer"，随后 WM_CLOSE 清理无残留 | — |
| Electron `shell.openPath('C:\Windows\explorer.exe')` | **失败** `"Failed to open path"`、零窗口 | 86ms |
| Electron `shell.openPath('C:\Windows\notepad.exe')`（对照组） | 成功开窗 "无标题 - Notepad"，WM_CLOSE 清理无残留 | 313ms |

⇒ 通道本身对普通 exe 正常，**对 explorer.exe 特定失败**（ShellExecute 'open' 对 shell
本体 exe 的激活路径行为）。

### 失败反馈链

`onAppClick`（renderer/taskbar.ts 779-797）拿到 `ok:false` 只 `host.notify('taskbar-app-result')`
记账，**零视觉反馈**（注释明示「launch/activate/minimize 无需回显」）⇒ 用户视角完全无反应。

### 回归点结论

- **时点**：2026-10-14 08:16:31（iconKey 时间戳 1791936991458，`taskbar-layout.json`
  pinned[explorer]）。手钉之前 explorer 不在应用组，无可点击入口；手钉后图标恒在场，
  无资源管理器窗时点击恒走 launch → 恒失败 → 「从某时刻起再也点不开」与之吻合。
- **非回归项**：launchExe 实现（shellOpen）自 dock 时代未变（git log：adapter.ts 最近
  实质性变更止于 8f7a525 合并），Electron 版本 44.4.3 恒定——**通道对 explorer 的失败
  是恒久语义，不是某次代码变更打坏**；变的是「图标开始出现在栏上且被点击」（手钉）。
  窗口过滤逻辑的相关历史变更（工单321 Shell 宿主过滤 4a3afb0、工单370 win-facts 收口
  9dc5e2e、工单380 跨桌面 fa8664e）均不改变本案路径（explorer 恒无合格窗 → 恒 launch）。
- **给 #482 的修复方向**：launch 路径对 explorer.exe 特判（spawn('explorer.exe') 等价
  通道已实测开窗成功，或 explorerReveal 形态）；「有窗置前」路径现状正常
  （CabinetWClass 合格、nativeFocusExeWindow 命中真窗）；可一并补「点击失败可见反馈」
  （属 T7「启动中态」票面语义）。

## 三、案3：工具图标慢启动归因（双形数据）

探针：`app/accept/experiments/t478-tool-launch-probe.js`（guard 槽内真拉起轮
13:46:23–13:49:17，证据 `app/accept/evidence/t478-tool-launch-evidence.json`）。
口径：**面板侧链路时延** = shell.openPath 返回耗时（launchExe 同通道同实现，返回即
「启动命令已发出」）；**工具自身冷启** = openPath 返回 → 该 exe 首个合格顶层窗出现
（shouldShowOnTaskbar 同款判据）。

| 工具 | 面板侧链路（openPath 返回） | 工具自身冷启（返回→首窗） | 点击→首窗全景 | 备注 |
|---|---|---|---|---|
| MiniMax Code | **6796ms** | **8790ms** | **15586ms** | 双形数据有效；窗 "MiniMax Code"（Chrome_WidgetWin_1）；探针轮末 WM_CLOSE + 新增 pid 收割，零残留 |
| ZCode | 已在运行（19 pid），不重复拉起 | — | — | 用户点击走置前链路，本轮不计量 |
| Qoder CN Launcher | 2344ms，openPath 返回 success | **计量无效**（探针判据盲区） | **>120s 未见 Launcher exe 名下的合格窗** | 见下 |

**MiniMax 归因定谳**：用户感知的「点图标十几秒」分解为面板侧 spawn 链 **~6.8 秒**
（shellOpen 同步阻塞到 ShellExecute 完成）＋ 工具自身冷启 **~8.8 秒**——两条各占约一半，
**面板侧 6.8s 是面板账上的优化空间**（launchExe 若改 async fire-and-forget + 反馈态，
用户等待感即消除，工具自身 8.8s 属 T7 口径「重型工具自身启动不记账」）。

**Qoder 计量无效的如实说明**：Launcher shellOpen 2.34s 返回成功后，主程序
`Qoder CN\Qoder CN.exe`（进程名 "Qoder CN"，非 Launcher exe）被拉起成 15 进程树；探针的
首窗判据按「目标 exe（Launcher 路径）」匹配，主程序 exe 不同 → 120s 窗口内未捕获首窗
（轮后核查 13:58 主程序可见窗 "Qoder CN" 已在场——出现时刻无法回溯，可能在 120s 内）。
**Qoder 的有效双形计量需修正探针（按进程树而非单 exe 匹配）重取**——列入 §五 deviations；
本轮只能实锤：launcher 通道 panelSide 2.3s + 主程序进程树拉起成功 + 「首窗时延 ≥ 探针
可见窗判据的捕获能力上限」，不充当「几分钟」级的定量实锤。探针拉起的 15 个 Qoder 进程
已全部收割（Stop-Process，核对零残留）。

负载标注：轮时段 13:43–13:52 为 guard 槽内（无并行验收轮在跑）；zcode 常驻会话在跑
（非验收负载，计入背景）。

## 四、案4：CPU 对照采样

口径：既有采样脚本 `deck-cpu-sample.ps1`（20s 窗、按进程名 electron 取面板进程组、
16 核整机百分比、TotalProcessorTime 差分）。存档基线 7.38%（2026-11-14 早间采样，
生产 master 形态，ADR-0032 引）。本轮 guard 槽内成对采样（13:44–13:52，各 3×20s、
60s 预热后取、两形态串行）：

| 形态 | round1 | round2 | round3 | 均值 |
|---|---|---|---|---|
| 集成形态（worktree tip @ f2afe08，#474-#477 已落） | 2.79 | 3.46 | 3.33 | **3.19%** |
| 生产形态（主检出 master dist，基线代码） | 3.30 | 3.70 | 3.51 | **3.50%** |

证据：`app/accept/evidence/t478-round-summary.json`（逐进程逐轮全表）+ 两形态隔离事件档
`t478-int-events.jsonl` / `t478-prod-events.jsonl`。

判读（如实标注，不拿抖动当实锤）：

- **同环境成对对照**：优化中形态比生产基线低约 0.3 个百分点（3.19 vs 3.50，相对 -9%）
  ——方向与 #474-#477 优化一致但幅度小；两形态 3×20s 内波动带（±0.4pp）与该差值同量级，
  **不足以单独定谳优化幅度**，供 T12 终验以更长窗口（健康轮口径、多次重复）裁决。
- **与存档基线 7.38% 不可直接比**：同一生产基线代码（master）本轮采出 3.5% vs 基线轮
  7.38%——两轮采样环境/时段差异（基线轮语境未在本轮复现，机器总负载不同）**大于形态
  差异**；本轮两组读数均显著低于 7.38%，只能说明「7.38% 的语境未复现」，不能反过来
  声称基线被优化代码拉低（生产形态本轮就是基线代码）。7.38% 基线维持存档原样，
  T12 终验以本轮验证过的成对同窗方法重取正式对照。

## Deviations（独立问题清单，建议另立票，本票不修）

1. **explorer.exe 的 shell.openPath 恒失败**（案2 根因本体）——修复归 #482，此处不混入。
2. **点击失败零可见反馈**（onAppClick ok:false 无回显）——与 #483「启动中态」票面语义
   重叠，建议在 #483 落地失败反馈，不另立。
3. **autostart 每次启动同步 spawnSync PowerShell**（热态 1.2s、上界 20s、开机窗口放大）——
   ADR-0032「自启项维护去同步化」的实现票范围（#481 骨架屏/启动重排票），本票仅留
   计时证据，不修。
4. **`await desktopWorkspace.start()` 无显式上界**——ADR-0032「启动链上一切外部等待
   必须有显式上界」的实现票范围（#481），本票仅代码定位，不修。
5. **生产 dist 形态漂移**：主检出 app/dist（Nov 14 00:20 构建）与 master 分支源码一致
   （无 #473），但生产面板 13:10 轮未写 events.jsonl——常驻事件日志的「生产默认开启」
   要等 #472 并流正式部署后生效（事实记录，非缺陷）。
6. **案3 探针首窗判据盲区（本票取证工具缺陷，如实记录）**：`t478-tool-launch-probe.js`
   按「目标 exe 精确路径」匹配首窗，对「中介 launcher 拉起另一主程序 exe」形态（Qoder CN
   Launcher → Qoder CN.exe）失效——Qoder 的工具自身冷启计量无效（§三）。重取时按进程树
   匹配（launcher 启动后跟踪其 pid 树的任何合格顶层窗）。探针拉起的全部进程已收割核对
   零残留（Qoder 15 pid、MiniMax 8 pid，见恢复核对）。

## 恢复核对（诊断期生产配置改动）

- 本票**未改动**任何生产配置/落点：
  - 未改 `app/config.json`、`taskbar-layout.json`、自启项 .lnk、注册表；
  - 轮内拉起的面板一律 `DECK_RESIDENT_EVENT_LOG` 隔离落点（`accept/evidence/`），零注入
    生产 events.jsonl（12:52 轮为本轮取证前已存在的既有数据，仅读取）；
  - 案2/案3 探针开出的窗口全部 WM_CLOSE 清理并核对零残留（notepad/资源管理器窗）；
  - guard 大轮（13:43–13:52）末尾按纪律把生产面板拉回原形态
    （`electron.exe <主检出 app> --panel`，restoreProcessCount=10，
    `accept/evidence/t478-round-summary.json` 在档）；
  - **后续面板状态归并行验收轮调度**：13:53 起后续验收轮按 guard 协议拿槽清场（含我拉回
    的生产面板——协议行为，非本票残留）。本票收尾时若槽空即再次拉回生产面板并核验，
    槽仍忙则由最后一个收尾轮按同命令恢复（见下「收尾恢复」）；
  - 生产 dist 未替换（冷启动插桩部署留给 #472 并流后的正式部署）。

**收尾恢复命令**（面板缺席时使用）：`Start-Process <主检出>/app/node_modules/electron/dist/electron.exe
-ArgumentList '"D:\test-folder\wallpaperengine-research\app" --panel' -WorkingDirectory
'D:\test-folder\wallpaperengine-research\app' -WindowStyle Hidden`（与自启项/dev:panel 同语义）。

## 待办交接（给并流者/实现票）

- #481（骨架屏/启动重排）：拿走 §一 的 3/4 两条代码定位与 PowerShell 段计时证据。
- #482（explorer 修复）：拿走 §二 全案（含探针复跑方法）。
- #483（启动中态）：拿走 §三 双形数据与「失败反馈」建议。
- #484（SLO 终验）：拿走 §四 对照数据；冷启动 SLO 终验读 W1 观察项。
