# 停摆根因静态审计——koffi 同步 Win32 调用点与 sendSync 类 IPC 全清单（工单111）

- 工单：#111（spec #109 PR-C 取证组第一票）；上游现场：#107。
- 日期：2026-10-07。性质：纯静态审计 + 现场日志比对，零代码行为改动。
- 产出直接供给 #117 滞后哨兵：第 4 节的子系统清单即「哨兵要标注哪些子系统」的排序依据，第 5 节每个假设的「预期观测信号」即哨兵的记录字段清单。
- 证据基线：`D:\test-folder\.agent-notes\card-pluginization\battery-{run2,final,final3,final4,final5,baseline}.log`（#107 现场八轮中带取证 dump 的六轮）；行号引用基于本审计时的 `feat/main-stall-sentinel` tip（f82b010）。

## 1. 进程模型（谁在哪调用——审计与哨兵标注的第一坐标系）

同一 Electron 二进制按 argv 分出五个常驻/临时角色（见 `app/src/main/index.ts:31-44` 分发）：

| 进程角色 | 拉起方式 | 面板侧代码 | koffi 在场 |
|---|---|---|---|
| **面板主进程**（停摆受害者） | 守卫 spawn `--panel`；电池经 `--panel-accept` 拉起 | `app/src/main/**` | 是（本审计主角） |
| **数据面 utilityProcess** | 面板主进程 `utilityProcess.fork`（`services/dataplane.ts:74`） | `dataplane.ts` 入口 + kernel + trayhost | 是（独立进程，不直接阻塞面板主线程，但经同步跨进程调用链耦合） |
| **外层守卫** | 默认入口（无模式旗标） | `index.ts:275-332` 默认分支 | 是（icon-carry） |
| **还原守护** | 守卫 detached spawn（`ELECTRON_RUN_AS_NODE`） | `icon-restore-watch.cjs` | 是（WaitForSingleObject） |
| **电池控制器** | `electron . --accept`（独立进程） | `app/accept/battery.js` + `lib/win32.js` | 是（输入合成 + 活体探针） |

关键结论：**电池控制器与被测面板是两个进程**（`battery.js:664` `launchPanel` spawn 子进程），WM_NULL 活体探针（`battery.js:396` `SendMessageTimeoutW(hwnd, WM_NULL, SMTO_ABORTIFHUNG, 2000ms)`）是跨进程同步调用。#107 的停摆 = 面板主进程的窗口消息泵 ≥2s 不出（dwm 在 >5s 后为其立 Ghost 窗——六轮日志中 Ghost 全数在场，主人 dwm.exe）。

## 2. koffi 同步 Win32 调用点全清单

koffi 绑定声明总数约 **150 条**（`.func(` 计数），分散在 15 个模块；按「哪个进程、哪个子系统、什么节奏在跑」归并为 **6 组 41 个运行时调用点**。全部为 koffi 默认同步形态（本仓库无一处 `koffi.async`），即每一次调用都在宿主进程 JS 线程上同步执行；跨线程/跨进程语义在「阻塞面」列单独标注。

### A 组：面板主进程 · 常驻轮询（每拍都在跑，停摆时段必然在场）

| # | 调用点 | 位置 | 调用 | 节奏 | 阻塞面 |
|---|---|---|---|---|---|
| A1 | 热区轮询 | `hotzone.ts:41-69` | `screen.getCursorScreenPoint()` + `win.getBounds()` + `win.setIgnoreMouseEvents()`（Electron 原生同步） | **25ms** | 本进程原生调用；`setIgnoreMouseEvents` 翻转 WS_EX_TRANSPARENT 窗口态 |
| A2 | 桌面遮罩守望侦察 | `desktop-cover.ts:73-97` → `win32.ts` | `FindWindowW('Progman')`、`GetWindowLongW`、`zPrecedes`（GetTopWindow + ≤512 步 GetWindow/IsWindowVisible 循环）、`hasVisibleBelow`（≤512 步） | **150ms** | user32 同步 FFI 循环；Win+D 过渡期 z 序翻动时最重 |
| A3 | 遮罩守望 engage/release | `desktop-cover.ts:88-96` → `win32.ts:44,60` | `SetWindowPos(HWND_TOPMOST/NOTOPMOST/BOTTOM)` | 过渡沿触发 | 本窗 z 序重排；SWP 会向相关窗口发 WM_WINDOWPOSCHANGING |
| A4 | Win+D 防抖轮询 | `wind-restore.ts:34,50-55` | `win.isMinimized()` | 250ms | Electron 缓存读，最轻 |
| A5 | 存证事件日志 | `panel-ipc.ts:15-25` | `fs.appendFileSync`（每事件一开一写一关） | 事件驱动（电池负载下高频） | 同步磁盘 IO；**主线程停摆期间数据面仍能 2s 节拍写同文件（见 5-H5），非磁盘级卡顿** |

### B 组：面板主进程 · 事件驱动（选区/交互链路——停摆事件尾的常客）

| # | 调用点 | 位置 | 调用 | 触发 | 阻塞面 |
|---|---|---|---|---|---|
| B1 | **键盘模式进入** | `panel-ipc.ts:87-99` | `win.setFocusable(true)` + `win.focus()` + `pinToBottom`（→ SetWindowPos HWND_BOTTOM） | 渲染层选区生灭沿（`deck:host-keyboard-mode`） | **原生窗口激活/焦点/样式三连**；与系统前台语义、外部输入合成同窗竞争 |
| B2 | 键盘模式退出 | `panel-ipc.ts:95-99` | `win.setFocusable(false)` + `pinToBottom` | 同上 | 同 B1 |
| B3 | 热区离开重钉 | `index.ts:207-216` | `pinToBottom`（SetWindowPos HWND_BOTTOM，500ms 节流） | HotzoneTracker 离开沿 | 本窗 z 序重排（注释自认「触发全系统重排」） |
| B4 | 焦点兜底重钉 | `index.ts:255-257` | `pinToBottom` | `win.on('focus')` | 同 B3 |
| B5 | 唤回面板 | `index.ts:198-202` | `win.showInactive()` + `pinToBottom` | 托盘点击/second-instance/wind-restore | show = 原生窗口显示路径 |
| B6 | 托盘图标维护 | `tray.ts:36-42`（Electron Tray 内部） | `Shell_NotifyIcon`（NIM_ADD/MODIFY/DELETE） | 建/毁/改提示 | **同步跨进程 WM_COPYDATA → 当届 Shell_TrayWnd 赢家**（explorer 或本仓数据面 TrayHost，见 D1） |
| B7 | 剪贴板文件读 | `desktop/clipboard-files.ts:68-100`（主进程代答：`services/dataplane.ts:123-131`） | `OpenClipboard/GetClipboardData/GlobalLock/CloseClipboard` 等 12 绑定 | 粘贴/可贴查询（按需） | **OpenClipboard 跨进程互斥**；被占时 3 次 × 30ms 退避（`CLIPBOARD_BUSY_ATTEMPTS`） |
| B8 | 焦点工具（置前/最小化/关闭） | `focus/adapter.ts:35-49`（ShowWindow/BringWindowToTop/SetForegroundWindow 等 11 绑定） | 会话行点击（按需） | **跨线程 ShowWindow/SetForegroundWindow**（对挂死目标可无限期等——#107 电池 ShowWindow 阻塞 12 分钟同机理） |
| B9 | 图标提取链 | `desktop/icon-ffi.ts`（8 绑定） | SHDefExtractIcon/GetIconInfo/GetDIBits 等 | 新条目首显（按需） | 同步 GDI/Shell |
| B10 | lnk 目标解析 | `desktop/adapter.ts` electronShortcutTarget（shell.readShortcutLink） | 数据面每拍 resolve-shortcuts 批（约 1Hz） | 同步 Shell COM（主进程代答） |
| B11 | 自启项维护 | `autostart.ts:137` | `spawnSync('powershell', …, timeout 20000)` | 每次启动（`index.ts:74`） | 同步子进程，上限 20s |
| B12 | 文件属性读 | `desktop/adapter.ts:22-28` | `GetFileAttributesW` | 桌面条目过滤（按需） | 同步 FS |

### C 组：面板主进程 · 任务栏启用态（主电池 `taskbar.enabled=false` 时整组缺席——主电池停摆段不在场，任务栏四电池在场）

| # | 调用点 | 位置 | 调用 | 节奏 |
|---|---|---|---|---|
| C1 | 条带置顶维持 | `taskbar/window.ts:208-211` | `SetWindowPos(HWND_TOPMOST)` | **500ms** |
| C2 | 全屏让位探针 | `taskbar/window.ts:223-236` + `yield.ts:70-77` | GetForegroundWindow/GetWindowRect/GetClassNameW/GetWindowThreadProcessId | **250ms**（AppBar 生效档） |
| C3 | 左组窗口枚举 | `services/taskbar.ts:349-367` → `taskbar/windows.ts:116-140` | GetTopWindow 枚举循环 + 每窗 OpenProcess/QueryFullProcessImageNameW/GetWindowText* | **1Hz**（`panel-kernel.ts:73-78`；`refresh()` 在禁用态即返，主电池不跑） |
| C4 | AppBar 占位协商 | `taskbar/appbar.ts:40-79` | `SHAppBarMessage`（同步，与 shell 往返） | 建窗/重协商沿 |
| C5 | 原生任务栏显隐 | `taskbar/native.ts:23-83` | FindWindowW('Shell_TrayWnd')/IsWindowVisible/ShowWindow | 建销窗沿（跨线程 ShowWindow） |
| C6 | 系统键合成 | `taskbar/syskeys.ts:50-63` | `SendInput` | 用户触发（Win 键类动作） |

### D 组：数据面 utilityProcess（不直接冻结面板主线程，但与主进程经同步跨进程链耦合）

| # | 调用点 | 位置 | 调用 | 节奏 | 与主进程的同步耦合 |
|---|---|---|---|---|---|
| D1 | **托盘宿主** | `trayhost/host.ts:79-202`（25 绑定全套） | RegisterClassExW('Shell_TrayWnd') + CreateWindowExW + PeekMessage 泵 + `SendMessageW(WM_COPYDATA)` 转发真托盘 + SetWindowPos 置顶 + TaskbarCreated 广播 | 泵 **25ms** + 置顶 **2s** | **面板主进程 B6 的 Shell_NotifyIcon 同步打进本进程竞争窗**；转发 SendMessage 同步等 explorer |
| D2 | 网卡计数 | `hardware/net-counters.ts:16-17` | `GetIfTable` | 1s | 无 |
| D3 | 使用日志采集 | `usage/native.ts:25-35` | EnumProcesses + 每进程 OpenProcess/QueryFullProcessImageNameW + GetForegroundWindow | 2s | 无 |
| D4 | 桌面扫描/属性 | `desktop/scan.ts` + `desktop/adapter.ts:22-28` | fs 扫描 + `GetFileAttributesW` | 1s | 无 |
| D5 | 剪贴板文件写 | `clipboard-files.ts`（写向） | OpenClipboard/SetClipboardData 等 | 复制/剪切（按需） | 跨进程互斥同 B7 |

### E 组：守卫与还原守护进程（不在面板主进程，列作全景与方向③素材）

| # | 调用点 | 位置 | 调用 |
|---|---|---|---|
| E1 | 图标显隐翻转 | `icon-carry.ts:74-78`（6 绑定） | `SendMessageTimeoutW(DefView, WM_COMMAND 0x7402, SMTO_ABORTIFHUNG, 3000ms)` |
| E2 | 偏好查询 | `icon-carry.ts:67-71` | `spawnSync('reg', …, timeout 8000)` |
| E3 | 守卫死亡等待 | `icon-restore-watch.cjs:39-43` | `OpenProcess` + `WaitForSingleObject(INFINITE)` |

### F 组：电池控制器进程（停摆现场的第二当事方——相关性排序的对照组）

| # | 调用点 | 位置 | 调用 | 备注 |
|---|---|---|---|---|
| F1 | 输入合成 | `accept/lib/win32.js:39-62`（36 绑定） | `SendInput`/`SetCursorPos`/`ShowWindow`/`SetWindowPos`/`SetForegroundWindow`/`AttachThreadInput` 等 | 全部同步 FFI；**ShowWindow 对挂死面板阻塞 12 分钟（#107 final4 轮实证）** |
| F2 | 活体探针 | `battery.js:390-399` | `SendMessageTimeoutW(hwnd, WM_NULL, SMTO_ABORTIFHUNG, 2000ms)` | 停摆的观测器本体（跨进程同步） |
| F3 | 假死取证 | `battery.js:405-433` | `spawnSync('powershell', …, timeout 20000)` | 事件尾 + 进程树线程态 |

### sendSync 类 IPC 盘点结论

全仓（`app/src` + `app/accept`）**无一处 `ipcRenderer.sendSync`**（grep 验证，2026-10-07 @ f82b010）。preload 唯一上行是 `ipcRenderer.invoke`（异步信封，`preload/index.ts:11`）与 fire-and-forget `send`；`utilityProcess` postMessage 为异步结构化克隆。因此 **「sendSync 类 IPC」的等价物是同步跨进程 Win32 调用族**：SendMessage/SendMessageTimeoutW、Shell_NotifyIcon、SHAppBarMessage、OpenClipboard 系、跨线程 ShowWindow/SetForegroundWindow/AttachThreadInput、（代码内注释自记的）PeekMessage 泵——即上表 A-D/F 组带「阻塞面」标注的条目。哨兵若只盯 Electron IPC 通道会扑空，必须盯这批。

## 3. 与 #107 停摆多发段的相关性排序

### 3.1 现场共性（六轮日志比对，非转述）

- **停摆位置**：六轮首次 WM_NULL 超时全部落在选区/框选段族（选区-空白、选区-Ctrl 补选、重建-重选，P20/P21 段族）——与 #107 「位置多在选区/框选段」一致。
- **事件尾共性**：五轮可读事件尾全部终结于同一集群 `hotzone-enter → (desktop-selected) → keyboard-mode-on → pin(focus-fallback) → desktop-selection-toggled`（run2 05:26:43 / final 07:13:57 / final3 11:15:59 / final5 12:02:06 / baseline 05:52:08）；final4 终结于 `hotzone-enter`（11:37:07.701，穿透刚解除即冻结，未及 keyboard-mode）。**即：面板主线程最后一次干活就是热区进入 + 键盘模式三连（B1）+ 重钉（B3/B4），随后不再泵消息**（2s 节拍的 tray-competition 心跳戛然而止）。
- **双进程同窗冻结（重要修正）**：面板主进程与数据面进程的事件流在同一个 ~3-5s 窗口内先后静默，且**冻结次序不固定**——run2/final 轮主进程先停（run2 主线程最后事件 05:26:43.670，数据面 tray-competition 心跳多撑两拍至 :46.927 后也停）；final4 轮数据面先停（末拍 11:37:07.016，主进程最后事件 11:37:07.701 hotzone-enter，此后 25s 双双无声直到 heal 取证）。即：主线程冻结与数据面泵停是同一时间窗的伴生现象，「主进程先挂 → 数据面被拖死」的单向解释容纳不下 final4 的反序。事件文件磁盘本身无恙（主停后数据面仍按 2s 节拍写入，run2 :44.919/:46.927 实证）。
- **dwm Ghost 全轮在场**：Ghost#7496（pid 7496，dwm.exe）跨小时跨轮存活（run2→baseline 同 pid），final4/5 轮换为 pid 940——hung 面板的 dwm 幽灵窗残留（顶层窗景实拍：`Chrome_WidgetWin_1#11924@0,0 2560x1392`（面板本体）+ `Ghost#940@0,0 2560x1392` 并存）。
- **进程树线程态**（hungForensics dump）：五只 electron 进程全部 `Wait/UserRequest` 为主（40/68/12/10/11 条），无一 Running——冻结是「等在某个同步等待上」，不是自旋。

### 3.2 排序表（子系统 × 三类停摆多发段；★=在场且活跃，○=在场低活跃，∅=缺席）

| 子系统（调用点组） | 选区/框选段（停摆主发） | Win+D/覆盖守望过渡 | 面板重启后 |
|---|---|---|---|
| **键盘模式/重钉链（B1-B4 + A1 热区）** | ★ 六轮事件尾终点集群 | ○ | ○ |
| **托盘链（B6 面板 Tray ↔ D1 托盘宿主）** | ○ 2s 置顶心跳在场（事件尾心跳） | ○ | ★ 注册/竞争窗/TaskbarCreated 广播/双实例残留窗口 |
| **桌面遮罩守望（A2/A3）** | ○ 150ms 常驻 | ★ engage/release 唯一执行者 | ○ 常驻 |
| **渲染层选区管线**（desktop-selection-toggled 上行方） | ★ 与 B1 同相（keyboard-gate） | ∅ | ○ |
| 数据面采集（D2-D4） | ○（冻结后仍活，排除嫌疑） | ○ | ★ 扫描/首拍重建高峰 |
| 电池控制器（F1/F2） | ★ 输入合成 + 探针（第二当事方） | ★ Win+D 演练注入 | ★ 拉起/强杀/再拉起 |
| 任务栏启用态组（C1-C6） | ∅ 主电池禁用 | ∅ | ∅（任务栏四电池时 ★） |
| 守卫/还原守护（E1-E3） | ∅ | ∅ | ○（守卫链同启，杀进程段触发还原） |

**排序结论（供 #117 哨兵的标注优先级）**：
1. **键盘模式/重钉链**（B1-B4，含 A1 的 setIgnoreMouseEvents 翻转）——停摆事件尾唯一共同终点；
2. **托盘链**（B6+D1）——面板重启后段主嫌疑，#107 trayhost pump() 注释自记同款征候的所在；
3. **桌面遮罩守望**（A2/A3）——Win+D 过渡段主嫌疑，150ms×512 步枚举 + engage/release 的唯一执行者；
4. 渲染层选区管线（作为 B1 的触发源记录同相性，非独立嫌疑）；
5. 数据面采集（D1-D4，作为「排除账」与级联观测记录）；
6. 电池控制器（F 组，控制器侧对照记录——若哨兵只在面板进程标注，此项由电池侧日志承担）。

## 4. 可证伪假设（主嫌疑排序 + 证伪实验 + 预期观测信号）

每条假设给出：机理、现有证据、证伪实验（可执行）、预期观测信号（#117 哨兵字段直接取用）。判定口径：**信号出现 = 假设存活；信号缺席/反向 = 假设被证伪**。哨兵 lag 事件建议统一携带 `lagMs、liveLabels[]（冻结时未清的调用点标签）、lastEvents[]、threadWaitHint`。

### H1（主嫌疑）：键盘模式进入三连（setFocusable+focus+pinToBottom）在输入合成负载下的原生激活路径滞留

- 机理：B1 在同一同步处理器内连做样式翻转（WS_EX_NOACTIVATE 摘除）、原生焦点/激活（SetForegroundWindow 类调用，含与前台线程的输入队列交互）、SetWindowPos(HWND_BOTTOM) 重排——三者都触碰系统前台/z 序全局态。电池正以 SendInput+SetCursorPos 高频合成选区输入、并以自身窗口占据前台语义，两侧对同一前台/输入管线并发操作；任一侧进入跨线程发送等待（对侧也在等我方）即成对等死锁，主线程 >2s 不泵消息即 WM_NULL 超时。跨线程同步发送互等是 Windows 经典死锁形态，与「全部线程 Wait、无一 Running」的 dump 相容。
- 现有证据：六轮事件尾五轮终于 B1 集群；停摆只在电池负载下出现（基线 commit 同挂）；final4 反例（hotzone-enter 即冻结）说明集群内最短触发面可到 A1 穿透翻转，B1 是最高频的完整形态。约束：须容纳 3.1 节「数据面同窗冻结、次序漂移」的观测——若 H1 的机理是面板内因，数据面伴停须经由 explorer/dwm 级联解释（main hang → dwm Ghost → shell 侧挂起窗交互 → 数据面托盘泵转发阻塞），final4 反序则指向 H7 并列。
- 证伪实验：①（原地观测）#117 哨兵上线后跑主电池三轮——若 lag 事件 `liveLabels` 含 `keyboard-mode`/`pin`/`hotzone-toggle` 之一且滞后时刻与 `keyboard-mode-on` 存证时差 <2s，H1 存活；三轮全无则降级。②（隔离复现）静置面板（无电池、无注入），脚本以 50ms 周期对卡片热区进出 + 渲染层连续触发 keyboard-mode on/off 10 分钟——若能复现 WM_NULL 超时 → 与输入合成无关的纯面板内因，H1 机理修正；若静置永不复现而带注入复现 → 竞争条件成立。③（变量剔除）同电池但禁用 keyboard-mode 通道（仅日志不改行为需走诊断旗标）对照轮——停摆消失即强指向 B1。
- 预期观测信号：`lagMs≥2000` 且 `liveLabels ∩ {keyboard-mode-on, keyboard-mode-off, pin, hotzone-enter, hotzone-leave} ≠ ∅`；伴随事件尾最后一对 `keyboard-mode-on`+`pin` 时差 <10ms；renderer-stall（quietMs≈5s）紧随其后（主线程冻结 → 心跳停止的级联）。

### H2：热区穿透翻转（setIgnoreMouseEvents）与输入合成的窗口态竞争

- 机理：A1 每 25ms 判定、命中沿翻 WS_EX_TRANSPARENT（25ms 级频率触碰窗口态）；final4 事件尾止于 `hotzone-enter`（穿透解除后即冻结）。
- 现有证据：final4 一轮的直接尾巴；其余五轮穿透翻转也是集群前奏（hotzone-enter 在 keyboard-mode-on 之前 1s 内）。
- 证伪实验：同 H1-②，但只做热区进出不动 keyboard-mode（脚本注入光标沿热区边界抖动 10 分钟，静置与带注入两档）。
- 预期观测信号：`liveLabels` 仅含 `hotzone-enter/leave` 而 keyboard-mode 标签全程未置 → H2 独立成立；否则归并为 H1 前奏。

### H3：托盘链同步跨进程发送（面板 Shell_NotifyIcon ↔ 数据面 TrayHost 竞争窗/旧实例残留）

- 机理：B6 Shell_NotifyIcon 是同步 WM_COPYDATA，投递对象 = 当届 Shell_TrayWnd 竞争赢家——常态是 D1（本仓数据面子进程，25ms 泵）或 explorer；停摆面板强杀不净时（#107 双面板级联）旧实例 TrayHost 半死不泵，新面板 Tray 的 NIM_ADD 同步打进死窗 → 主线程冻结。D1 自身的 `SendMessageW(WM_COPYDATA)` 转发（`host.ts:239`）同步等 explorer，explorer 忙时数据面泵停 → 反压面板 Tray 调用。#107 trayhost pump() 注释自记「面板主线程停摆不再回消息、退出段收不到 quit 存证」即此链。
- 现有证据：#107 问题描述明指该征候未定位第一因；停摆段事件尾中 tray-competition 心跳规律在场；双面板/缓存互锁（Unable to move the cache）实证旧实例残留窗口存在。
- 证伪实验：①（重启段专项）哨兵标注下连跑 10 轮面板重启段——lag 且 `liveLabels` 含 `tray` 系标签者计数；若重启段停摆全部伴随「旧 TrayHost 存活」的 preflight 计数（#113 侧），强指向 H3 残留形态。②（隔离复现）两面板实例并存时，对旧实例数据面进程 SuspendThread 后新面板起 Tray——观察新面板主线程是否滞留。③（反证）托盘 spike 电池（tray-spike.js）长跑不复发 → 排除托盘链为选区段主因（它本就不在选区段活跃）。
- 预期观测信号：`liveLabels` 含 `tray-*`（面板侧 Tray 调用点）或 lag 时刻 D1 泵间隙 >100ms（数据面自记）；重启后首 NIM_ADD 时戳与 lag 时戳重合；preflight「双面板/旧托盘宿主」计数 >0 的轮次停摆率显著高。

### H4：覆盖守望 150ms 侦察在 Win+D 过渡的放大（z 序枚举风暴 + engage/release 连翻）

- 机理：A2 每 150ms 跑 zPrecedes/hasVisibleBelow 各 ≤512 步同步枚举；Win+D 过渡期全窗 z 序翻动 + engage/release 连发 SetWindowPos（A3）——最坏情形单拍内数百次 user32 调用，若单步遇上跨线程窗口（正在响应 shell 的他进程窗口）叠加超时，理论可积压 >2s。
- 现有证据：Win+D/覆盖守望过渡是 #107 点名多发段；但六轮首停摆均在选区段而非 Win+D 段——H4 是次发段的主嫌疑而非全场主因。
- 证伪实验：①（离线基准）真机对 `zPrecedes`/`hasVisibleBelow` 单次调用计时采样 1000 次，取 P99——若 P99 <1ms，512 步最坏 <0.5s，H4 单靠侦察不够 2s，需叠加 A3 连翻才可能成立。②（哨兵对照）Win+D 段 lag 事件的 `liveLabels` 含 `cover-*` 与否；过渡窗内 tick 实测耗时是否 >150ms（自偿积压特征）。
- 预期观测信号：lag 且 `liveLabels` 含 `cover-engage/cover-release/cover-scan`；cover 事件密度（engage/release 每秒次数）在 lag 前 1s 内显著高于常态基线。

### H5（已证伪存档）：EventLog appendFileSync / 同步磁盘 IO 卡顿

- 机理假设：主线程每事件一开一写一关（A5），磁盘卡顿即冻结。
- **证伪证据（现场已有）**：final4/run2 的主线程冻结窗口内，数据面进程仍按 2s 节拍向**同一事件文件**落 tray-competition（appendFileSync 同款）——磁盘与文件锁皆通。冻结被隔离在面板主进程，同步 IO 不是停摆介质。保留本条作哨兵反例校准：lag 时若数据面心跳仍规律，排除磁盘类成因。

### H6：dwm Ghost 残留与假死互为表里（非第一因，观测面）

- 机理：Ghost 是 dwm 对 hung 窗 >5s 的表现层替身，非成因；但 Ghost#7496 跨轮存活说明残留幽灵窗会持续在场，可能与下一轮的落点/穿透判定交互（ensurePanelHit 命中 Ghost 的分支即为其可见后果）。
- 证伪实验：preflight 计数 Ghost 类窗（类名 `Ghost`、主人 dwm.exe）与当轮停摆率的相关性；Ghost 在场但不复现停摆的轮次比例。
- 预期观测信号：preflight Ghost 计数字段；lag 轮 vs 无 lag 轮的 Ghost 在场率对照。

### H7：系统级输入/合成管线竞争（SendInput × 前台切换的全局性冻结）

- 机理：#107 方向①第三分支——电池与面板（B1 focus 路径）对前台/输入管线的并发操作在系统层竞争，冻结是系统输入子系统侧的病，面板与数据面都是受害者；能解释「只在电池负载下发生、基线同挂、代码分支无关」。
- 现有证据（本审计最强新增）：**双进程同窗冻结且次序不固定**（3.1 节）——纯面板内因（H1）难以解释数据面先停的 final4 反序；两进程唯一的共同介质是系统层（输入管线/dwm/explorer 交互）。另有全进程树线程态全部 Wait（无一 Running）。
- 证伪实验：①H1-② 静置复现轮即对照组——静置（无合成输入）永不复现而带注入复现，H7 与 H1 竞争形态同时存活。②（关键分辨）注入但禁用 keyboard-mode 通道（H1-③ 对照轮）——停摆消失 → 竞争点在 B1 本地，H7 降级；停摆仍在（含数据面同窗冻结）→ H7 升主嫌。③哨兵若在 lag 时同时记录数据面泵间隙与面板 liveLabels——两者 lag 时差 <2s 且次序跨轮漂移 = H7 特征签名。
- 预期观测信号：面板 lag 与数据面泵停同窗（时差 <5s）且次序跨轮漂移；停摆检出时刻全部落在电池注入窗口内（与 F2 探针时戳交叉）；Ghost 窗与停摆同现。

### 主嫌疑结论

**H1（键盘模式三连 × 输入合成竞争）为第一嫌疑、H7（系统级输入管线竞争）为并列第一解释**——前者是六轮事件尾唯一共同终点的直接执行体，后者是唯一能同时解释「双进程同窗冻结 + 次序漂移 + 基线同挂」的候选；两者由 H1-③/H7-② 的同一组对照轮一锤分辨。H2 是 H1 的前奏形态，H3/H4 分别主导重启后与 Win+D 段。#117 哨兵按 3.2 排序标注子系统、按上述信号字段记录，即可在一轮真机电池内让 H1/H3/H4/H7 同时进入判定（H5 已证伪在案，可作哨兵自校准）。

## 5. 给 #117 的子系统清单（哨兵标注范围，按相关性排序）

1. **键盘模式/重钉链**（panel-ipc.ts keyboard-mode 处理器、win32.ts pinToBottom/setTopmost、index.ts showPanel/focus 兜底/热区离开重钉）——标签：`keyboard-mode-on/off、pin、hotzone-enter/leave`。
2. **托盘链**（tray.ts Tray 生命周期、trayhost/host.ts 泵与转发）——标签：`tray-add/modify、tray-pump、tray-forward`。
3. **桌面遮罩守望**（desktop-cover.ts tick/engage/release、win32.ts zPrecedes/hasVisibleBelow）——标签：`cover-scan、cover-engage、cover-release`。
4. **热区轮询**（hotzone.ts poll + setIgnoreMouseEvents）——标签：`hotzone-toggle`（与 1 共用热区事件但独立标注翻转动作）。
5. **数据面采集与托盘宿主泵**（dataplane kernel 定时器、trayhost pump）——数据面自记 lag（泵间隙），供级联账与排除账。
6. **剪贴板读写**（clipboard-files OpenClipboard 系）——标签：`clipboard-read/write`（低频，但 OpenClipboard 互斥是已知阻塞面）。
7. **焦点工具**（focus/adapter、taskbar/windows nativeActivateWindow）——标签：`focus-tool`（按需触发，跨线程 ShowWindow 面）。
8. **任务栏启用态组**（taskbar/window.ts keepalive/yield、windows.ts 1Hz 枚举、appbar、syskeys）——任务栏四电池跑时才在场，哨兵常驻标注按需开。
9. **电池控制器侧对照**（F1/F2/F3）——不入面板哨兵，由电池日志承担（F2 探针时戳与 lag 交叉）。

包装器置/清纪律（spec #109「同步调用点经标签置/清包装器标注」的落地口径）：同步调用点入口 `labels.add(标签)`、finally 清除；哨兵 lag 时快照 `liveLabels`——H1-H4 的预期信号字段全部由此产生。

## 6. 本票分离出的独立方向

- 方向③（遗留进程内核级不可杀）→ 独立 issue（本票开出，needs-triage）：E3 WaitForSingleObject(INFINITE)、D1 竞争窗销毁路径（stop() 在非建窗线程调用 DestroyWindow 会失败）、F1 ShowWindow 无限阻塞 12 分钟实证——三块素材。
- 方向④（UIA 空名）→ 独立 issue（本票开出，needs-triage）：#107 P10E 段托盘导航各步窗口名返回空串，与本审计调用面无交集（UIA 走 PowerShell uia-focus.ps1，非 koffi），独立复现性未证。
