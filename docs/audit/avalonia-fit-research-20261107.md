# Avalonia UI 与 AGENT DECK 独立面板的契合度调研

调研日期：2026-11-07。方法：先读仓库一手材料建立项目侧硬约束，再逐项查 Avalonia 官方文档、GitHub 仓库（issue/源码/release notes）与 NuGet。所有结论附一手来源；查不到的明说「未找到一手证据」。标注「推断」的为逻辑推演，非直接证据。

---

## 1. TL;DR

**有条件契合，综合判定「不迁移」**。桌面外壳层（透明/穿透/置底/Win32 几何）在 Avalonia 侧技术可行且 C# P/Invoke 比 koffi 更自然，但两个决定性因素否决整体迁移：**① JS 插件平台是产品核心，其 per-webContents 隔离、Node 宿主面、预算标定在 Avalonia 无等价物，等于重新发明 Electron 的一半能力；② 验收电池体系（18 电池/189 段 + CDP 探针 + 4.7 万行测试）全部架构在 Electron/CDP 语义上，重写是最大单项工程**。128k 行 TS 全量改写 C# 是「换整个技术栈」，不是「换渲染层」。

---

## 2. 项目侧硬约束清单（仓库一手证据）

### 2.1 技术栈与代码量

- Electron 44.4.3 + cordis ^3.18.1（主进程插件内核）+ koffi ^2.9.0（FFI）+ vitest；渲染层为**原生 ESM TS、无框架**（无 React/Vue）。见 `app/package.json`（dependencies/devDependencies）与 `app/src/renderer/main.ts:1-4`（「原生 ESM 模块…deck-plugin:// 协议动态 import」）。
- 代码量（`git ls-files` × `wc -l`，2026-11-07 实测）：`app/src` **42,433** 行 / 200 文件；`app/accept` **38,214** 行；`app/tests` **47,433** 行，合计约 **12.8 万行 TS**。
- 验收电池：**18 块电池、189 个验收段**（`app/accept/manifest.json`：`batteries` 数组 18 项，逐段求和 189）；vitest `it()/test()` 计数约 3,232 处。
- ADR-0004（`docs/adr/0004-electron-cordis-standalone-panel.md`）选定 Electron 的理由原文：「透明窗口、穿透 + 事件转发、托盘均为原生能力」，并明记「透明背景依赖 WebView2 透明合成」「Electron 包体与内存基线高于 pywebview，为插件生态支付的代价」。

### 2.2 八个耦合点（逐条带证据）

| # | 耦合点 | 仓库证据 |
|---|---|---|
| 1 | **Win32 深集成：任务栏接管** | `app/src/main/taskbar/appbar.ts:20-21`（`ABM_GETSTATE=4`/`ABM_SETSTATE=10`）、`:36`（koffi 直调 `shell32 SHAppBarMessage`，注释「Win95→Win11 未变的承重墙」）；原生栏托管（接管置位 ABS_AUTOHIDE、释放原生 48px 保留带、退出写回用户原值）见 `app/src/main/taskbar/appbar-autohide.ts:6-14` 与 `GLOSSARY.md`「原生栏托管」词条 |
| 2 | **托盘图标注入与接管** | `app/src/main/trayhost/host.ts:1-3`（注册与系统同名 `Shell_TrayWnd` **竞争窗**、WM_COPYDATA 泵、广播 `TaskbarCreated` 收编图标、解析 NIM_* 流量并提取图标像素）、`:109-172`（`RegisterClassExW`/`CreateWindowExW` + `WS_EX_TOOLWINDOW|WS_EX_NOACTIVATE` + koffi 注册原生 WndProc 回调）、`:225-235`（PeekMessage 泵 + WM_COPYDATA 分发）；自家托盘图标走 Electron `Tray`（`app/src/main/tray.ts:1,41-44`） |
| 3 | **透明分层窗 + 鼠标穿透 + 热区** | `app/src/main/panel-window.ts:24`（`transparent: true`）、`:34`（`skipTaskbar: true`）、`:52`（默认 `setIgnoreMouseEvents(true)`）；热区轮询进出热区翻转穿透，注释明记「恢复穿透一律不带 forward：低级鼠标钩子会让主线程阻塞波及全系统鼠标输入」（`app/src/main/hotzone.ts:26-27,66,114`）；`GLOSSARY.md`「独立面板」「鼠标穿透」「交互热区」词条 |
| 4 | **底部钉扎 / z 序控制** | `app/src/main/win32.ts:4-64`：koffi 绑定 `SetWindowPos/FindWindowW/GetWindowLongW`，`pinToBottom`（HWND_BOTTOM，注释「Electron 无原生档位，FFI 直调」，ADR-0004 Consequences 亦有记载）、`isTopmost`（WS_EX_TOPMOST 位）、`setTopmost`、`zPrecedes`（z 序侦察） |
| 5 | **平铺窗口管理（改他窗几何）** | `app/src/main/desktop/geom-write.ts`、`window-frame.ts`、`virtual-desktop.ts`、`title-drag.ts`；`GLOSSARY.md`「Agent 平铺」「容量溢出」（写窗受理但回读被应用最小尺寸夹取、Windows 不提供读取任意应用最小尺寸的能力） |
| 6 | **desktopCapturer 屏幕捕获** | `app/src/main/desktop/preview-window.ts:13`（`import { desktopCapturer }`）、`:256`（`getSources({types:['screen']…})`，注释「不能对第三方窗做同步跨进程绘制。取景走 desktopCapturer（GPU/合成器异步）」）——窗口预览/缩略图用 |
| 7 | **JS 插件平台** | 每投放包独立 `webContents`+session+包页渲染进程：`app/src/main/plugins/identity.ts:4-14`、`budget.ts:1-18`（**16 包 / 每包 128MB**，C10 真机实测每包边际 102-113MB 标定）；渲染层 contextIsolation+sandbox、插件文件永不由渲染层触碰（`plugins/assets.ts:9`）；`deck-plugin://` 同源动态 import（`renderer/main.ts:1`）；词汇见 `GLOSSARY.md`「插件执行上下文」「投放型插件包」 |
| 8 | **验收电池体系（CDP 依赖）** | `app/src/main/index.ts:852`（`remote-debugging-port` ← `DECK_CDP_PORT`）；电池接入表 `manifest.json` 每电池登记 `cdpPort`（全表唯一）；`GLOSSARY.md`「验收电池」（九块→现行 18 块、真机逐段断言存证）、「面板句柄」（pid+标题+可见性就绪判据、强退验证）、「事件磁带」（事件 JSONL 观测总线）、「断言失效面」（像素实拍、输入注入、系统状态五枚举） |

另：托盘/单实例/自启——`index.ts:775,843`（`requestSingleInstanceLock`）、`app/src/main/autostart.ps1` + `autostart.ts`（Startup 文件夹 `.lnk`，含自愈与旧栈清理，`GLOSSARY.md`「自启项」）；数据面采集跑 `utilityProcess` 子进程（`index.ts:546`）。壁纸链已退役（工单11），资产只读封存，不构成约束。

---

## 3. Avalonia 能力面对照（A–J）

### A. 基础面

- **版本**：当前稳定 **12.1.5**（2026-11-02 发布）；**11.x 系列最新为 11.3.22**（2026-09-11）。来源：GitHub API `repos/AvaloniaUI/Avalonia/releases`（2026-11-07 查询）。v12 破坏性变更清单：https://docs.avaloniaui.net/docs/avalonia12-breaking-changes
- **渲染引擎**：Skia（v12 升 SkiaSharp 3.0、移除 Direct2D 后端；另公告与 Flutter 团队合作引入 Impeller）。来源：12.0 release notes（https://avaloniaui.net/blog/avalonia-12 ）。
- **UI 语言**：XAML + C#/.NET；v12 起目标 **.NET 10**。同上来源。
- **平台矩阵**：Windows/macOS/Linux/iOS/Android；v12 移除 Tizen 与 Avalonia.Browser.Blazor（浏览器目标本体保留）。来源：12.0 release notes。
- **License**：MIT（GitHub API `repos/AvaloniaUI/Avalonia` → `license.spdx_id=MIT`）。
- **活跃度**：31,767 stars；贡献者按 contributors API 分页推算约 **343 人**；仓库最近 push 2026-11-06；12.1.5 距调研日仅 5 天。均为 GitHub API 实测（2026-11-07）。

### B. Win32 互操作深度

- **HWND 可得**：`TopLevel.TryGetPlatformHandle()` 返回 `IPlatformHandle`（源码 `src/Avalonia.Controls/TopLevel.cs:433`：`public IPlatformHandle? TryGetPlatformHandle() => PlatformImpl?.Handle;`）。拿到 HWND 后一切 Win32 API 走标准 C# P/Invoke——能力上严格强于 koffi FFI（koffi 层的全部绑定在 C# 是原生语法）。
- **Win32PlatformOptions**：只有渲染/合成/DPI 面向——`RenderingMode`（WGL/DirectX）、`CompositionMode`、`UseCompositionSwapChain`、`DpiAwareness` 等（源码 `src/Windows/Avalonia.Win32/Win32PlatformOptions.cs` 公共属性清单，2026-11-07 检视）。**不含**窗口样式/穿透/托盘等窗口行为开关。
- **AppBar / Shell 托管 / 任务栏接管**：框架无任何 API。GitHub 全仓 issue/代码检索 `SHAppBarMessage`、`appbar` 均无命中（`gh api search/issues`，2026-11-07）；仓库与生态检索「avalonia taskbar/shell replacement」只有个位数 star 的玩具项目（`gh api search/repositories`）。知名 .NET shell 库 ManagedShell 是 WPF 的（生态常识，未逐条核实）。**结论：无官方或社区先例，本项目这类深集成在 Avalonia 侧是全自研**。
- **竞争窗（RegisterClassExW 同名 Shell_TrayWnd + WndProc + 消息泵）**：框架不管，但 C# 手写完全可行（专用线程 + RegisterClassExW/GetMessage，或 WinForms interop 借消息泵）——与现 `trayhost/host.ts:109-172` 等价物逐条对应。「可行」为推断（无一手示例），机制上无障碍。

### C. 窗口形态能力

- **每像素透明**：`TransparencyLevelHint`（`IReadOnlyList<WindowTransparencyLevel>`：`None/Transparent/AcrylicBlur/Mica/Blur/ForceTransparent`，可写 fallback 链）+ `ActualTransparencyLevel` 读回实际档位（源码 `src/Avalonia.Controls/TopLevel.cs:61-70`）。文档：https://docs.avaloniaui.net/docs/app-development/window-management 。Win32 后端实现为 DWM：`DwmEnableBlurBehindWindow`（win8+）或 NoRedirectionBitmap（源码 `src/Windows/Avalonia.Win32/WindowImpl.cs:431,488`）——**真每像素 alpha，非窗口级整体 alpha**。
  - **风险信号**：v12 rc2 曾出回归——`ExtendClientAreaToDecorationsHint` + Transparent 变黑底（issue [#21082](https://github.com/AvaloniaUI/Avalonia/issues/21082)），由 PR [#21354](https://github.com/AvaloniaUI/Avalonia/pull/21354)（merged 2026-05-14）修复，报告者称 11.3.13 正常。结论：透明是支持的，但**锁 11.3.22 LTS 或 ≥12.1.5**，勿追 rc。
- **无框窗**：`WindowDecorations`（v12 由 `SystemDecorations` 更名）+ `ExtendClientAreaToDecorationsHint`（源码 `src/Avalonia.Controls/Window.cs:112,276`）。
- **点击穿透（WS_EX_TRANSPARENT）**：**无公共 API**。feature request issue [#6682](https://github.com/AvaloniaUI/Avalonia/issues/6682)（2021-10 开、至今 open、无官方回应）；`WS_EX_TRANSPARENT` 常量只存在于内部 P/Invoke 声明 `src/Windows/Avalonia.Win32/Interop/UnmanagedMethods.cs:514`，未暴露。→ 需自 P/Invoke `SetWindowLong` 置位；热区进出照抄现 `hotzone.ts` 的 GetCursorPos 轮询翻转样式位即可（「可行」为推断，无一手示例）。
- **置底（always-on-bottom）**：**无**。公共 API 只有 `Topmost` bool（源码 `src/Avalonia.Controls/WindowBase.cs:32-49`，impl 绑定 `SetTopmost`）；`HWND_BOTTOM` 只在内部声明。→ 与现状相同：P/Invoke `SetWindowPos(HWND_BOTTOM)`。
- **WS_EX_NOACTIVATE/TOOLWINDOW 等扩展样式**：无公共 API，P/Invoke 自设。
- **skipTaskbar 等价**：`ShowInTaskbar` 属性，impl 走 `ShowTaskbarIcon`（源码 `Window.cs:158-159,274`；Electron 同为 ITaskbarList::DeleteTab 语义，见 `panel-window.ts:29` 注释）——能力对齐。
- **分层窗更新延迟**：未找到一手数据（官方文档、issue 均无延迟/帧率承诺）。本项目现为「探针实证」文化（工单01），迁移则须同样自测。
- **全屏遮罩 + 鼠标轨迹绘制**：无现成「marquee 组件」，但全屏透明窗 + 2D 绘制是 Avalonia 普通用法（自定义绘制有 `ICustomDrawOperation`/Compositor 通路）；「可行」为推断，低延迟无官方承诺。

### D. 托盘图标

- 内置 `TrayIcon`：`Icon`（WindowIcon，可运行期换）、`ToolTipText`、`Menu`（NativeMenu）、`Clicked` 事件、`Command`、`IsVisible`（源码 `src/Avalonia.Controls/TrayIcon.cs:63-166`）。文档：https://docs.avaloniaui.net/controls/navigation/trayicon 。Win32 实现 `src/Windows/Avalonia.Win32/TrayIconImpl.cs`（Shell_NotifyIcon）。平台：Windows/macOS 全支持，Linux 需 StatusNotifierItem/AppIndicator（文档页明记）。
- 对比 Electron Tray：**常规自家托盘图标能力对齐**（tooltip/菜单/图标/点击）。差异（推断）：Avalonia 无 `displayBalloon` 等通知气泡 API，需走 Windows 通知平台。
- **本项目 trayhost（第三方托盘图标接管/收编）完全超出 TrayIcon 能力面**——那不是「托盘图标」，是 Shell_TrayWnd 竞争窗 + WM_COPYDATA 流量解析，见 B 节结论。

### E. 原生内容嵌入

- `NativeControlHost`：官方支持在 Avalonia 布局内承载原生控件（Win32 EDIT、WebView2 等），文档：https://docs.avaloniaui.net/docs/app-development/native-interop 。已知约束：airspace——原生子窗恒盖在 Avalonia 内容之上（同文档/社区讨论 [Discussion #9268](https://github.com/AvaloniaUI/Avalonia/discussions/9268)）。
- **官方 WebView**：`Avalonia.Controls.WebView` NuGet 包（Windows 底层 WebView2），12.0 起开源（此前为商业 Accelerate 特性，公告 [Discussion #20901](https://github.com/AvaloniaUI/Avalonia/discussions/20901)）；NuGet 现版 12.1.1、约 60 万下载（nuget.org API，2026-11-07）。文档：https://docs.avaloniaui.net/docs/app-development/embedding-web-content 。这是承载插件 HTML UI 的唯一官方通路。

### F. 屏幕捕获

- **Avalonia 无 desktopCapturer 等价 API**。API 与 issue 检索（`gh api search/issues` "screen capture"，2026-11-07）均无内建捕获面。`Screens` 类只给屏幕几何信息。
- 补位方案（OS 层、与框架无关）：**Windows.Graphics.Capture**（WinRT，Win10 1903+，GPU 合成器异步，与 desktopCapturer 同源机制）经 CsWinRT 调用；或 **DwmRegisterThumbnail**（DWM 活动窗口缩略图，零拷贝跟随，天然适配「窗口预览」场景）。两者皆一手 OS 文档：https://learn.microsoft.com/windows/win32/dwm/dwm-overview 。选型为推断。

### G. JS/Node 生态位

- **内嵌 JS 引擎**（.NET 生态组件，非 Avalonia 官方）：**Microsoft ClearScript**（V8，现居 ClearFoundry 组织维护，https://github.com/ClearFoundry/ClearScript ）、**Jint**（纯 .NET ECMAScript 解释器，https://github.com/sebastienros/jint ）。可承载插件纯逻辑。
- **WebView 承载插件 UI**：官方 `Avalonia.Controls.WebView`（E 节）。
- **Node API 面缺位（关键）**：本项目投放型插件的宿主面虽窄（`GLOSSARY.md`「投放窄面」），但架构依赖 Electron 三件事：per-包独立 `webContents`+session（崩溃隔离、执行上下文登记）、`deck-plugin://` 协议同源动态 import、**Node 生态复用**（ADR-0004 选 Electron 的核心理由「为插件生态支付的代价」）。Avalonia 下三者皆无等价物：WebView2 多实例共享同一浏览器进程树（按 user-data-folder 隔离，非每包独立进程语义）——隔离粒度与崩溃域都变了；fs/进程/包管理要自造沙箱层。**结论：这不是「补个库」，是插件架构重造 + 重新标定预算**（现 16 包/128MB 是按 Electron webContents 实测标定的，`budget.ts:7-18`，换底座后标定作废）。

### H. 测试与验收

- **Headless**：`Avalonia.Headless`（无头平台，内存中跑完整控件树/布局/样式/绑定）+ `Avalonia.Headless.XUnit` / `.NUnit` 集成包；可截帧（`CaptureRenderedFrame`）做像素断言。文档：https://docs.avaloniaui.net/docs/testing/headless-platform 、https://docs.avaloniaui.net/docs/testing/headless-xunit 。Avalonia 仓库自用其测试（`tests/Avalonia.Headless.*`）。
- **真机集成测试先例**：Avalonia 仓库自带 `tests/Avalonia.IntegrationTests.Win32`——拉真窗、P/Invoke Win32 断言窗口状态、xUnit Theory 覆盖多显示器×窗口状态组合（2026-11-07 检视 `StandardWindowTests.cs`，如 `Maximized_State_Fills_Screen_Working_Area`）。**与本项目验收电池同构的形态存在官方先例**。
- **CDP 级运行时探针**：**无等价物**。`Avalonia.Diagnostics`（F12 DevTools，NuGet 11.3.22、826 万下载，nuget.org API 实测）是运行期可视化诊断（视觉树/事件），非协议化远程探针——没有 Runtime.evaluate、网络拦截、事件流订阅那类通道。渲染层心跳/滞后哨兵（`render-sentinel.ts`）依赖渲染进程心跳通道，迁移后要自建 IPC。
- **结论**：真机断言可做（xUnit + P/Invoke + 截帧），但**事件磁带、面板句柄、CDP 探针三件基础设施全部重写**，189 段电池逐段移植。

### I. 工程面

- **单实例**：无框架内建；.NET 惯例命名 `Mutex`（OS 层手段，推断/常识，官方文档无内建 API——`gh api search/code` 检索无 single-instance 面）。
- **开机自启**：无内建；本项目方案本就是 Startup 文件夹 `.lnk`（`autostart.ps1`），语言无关，平移即可。
- **文件监视**：`FileSystemWatcher`（.NET 内建）；**进程看门狗**：`System.Diagnostics.Process` 自建（现实现 `icon-restore-watch.cjs`、外层守卫同样要平移）。
- **内存/启动开销 vs Electron**：**未找到可信独立 benchmark**。官方对比页 https://avaloniaui.net/electron-compare 明言「None of what follows is an estimate」，但其数字只有 Electron 运行时体积（150MB 压缩 / 374MB 解包，引自公开下载源与 Electron 文档），**对内存与启动时间无任何实测**。第三方可查到的多为 Tauri vs Electron。→ 明说：**缺证据**。本项目自有的硬数据是 Electron 侧每投放包边际 102-113MB（`budget.ts` C10 实测），迁移后该基线需在 Avalonia/WebView2 下重新实测。

### J. 迁移成本定性

- **量级**：128,080 行 TS（2.1 节实测），其中渲染层/主进程 4.2 万行、验收电池 3.8 万行、单测 4.7 万行。这不是给 Electron 换个皮肤，是**逻辑、进程模型、插件内核（cordis 3.x）、FFI 层（koffi）、验收体系五者同时换血**。
- **Electron 特有依赖**（全部无 1:1 等价）：`desktopCapturer`、CDP `remote-debugging-port`、`utilityProcess`、`webContents`/session 隔离、`Tray`/`Menu`、`requestSingleInstanceLock`、`deck-plugin://` 自定义协议。
- **平移最顺的一层**：koffi FFI → C# P/Invoke，语义逐条 1:1（`win32.ts`、`appbar.ts`、`trayhost/host.ts` 的绑定在 C# 更薄）；平铺几何控制（`geom-write.ts`）同理。
- **定性结论**：**换整个技术栈**。「换渲染层」的说法不成立——渲染层（HTML/ESM TS/DOM）只是冰山一角，项目真正的资产（插件内核、权限/护栏体系、验收电池）全部绑在 Node/CDP/Electron 进程模型上。

---

## 4. 契合度判定（逐耦合点）

| 耦合点 | 判定 | 理由 |
|---|---|---|
| 任务栏接管（SHAppBarMessage/ABS_AUTOHIDE） | ⚠️ 有代价 | P/Invoke 平移直接（koffi→C# 等价更强），但框架零支持、生态零先例（B 节）；原生栏托管的记账/重申轮询逻辑照移 |
| 托盘图标注入与接管（Shell_TrayWnd 竞争窗） | ⚠️ 有代价 | C# 手写 RegisterClassExW+消息泵可行（推断），机制无障碍，但完全自研；TrayIcon 只覆盖自家图标 |
| 透明分层自绘桌面 | ✅ 可行 | `TransparencyLevelHint=Transparent` + DWM 真每像素 alpha（WindowImpl.cs:431,488）；注意锁 11.3.22 或 ≥12.1.5（#21082 回归已修） |
| 鼠标穿透 + 交互热区 | ⚠️ 有代价 | 无公共 API（#6682 open 4 年+）；P/Invoke WS_EX_TRANSPARENT 可行，热区轮询模式可平移（推断） |
| 底部钉扎 / z 序控制 | ✅ 可行 | 与现状同构：P/Invoke SetWindowPos(HWND_BOTTOM)，比 koffi 更自然；`Topmost` 有、`Bottommost` 无但不需要 |
| 框选 marquee | ✅ 可行 | 全屏透明窗 + 2D 绘制为普通用法；低延迟无官方数据，须按本项目探针文化自测 |
| 平铺窗口管理（SetWindowPos 夹取/minSize 回读） | ✅ 可行 | P/Invoke；Avalonia 自家 `IntegrationTests.Win32` 就是真窗+Win32 断言的官方先例 |
| desktopCapturer 屏幕捕获 | ⚠️ 有代价 | 无内建 API；Windows.Graphics.Capture/DwmRegisterThumbnail 自补（OS 层，可平滑替换） |
| JS 插件平台 | ❌ 缺位 | 无 Node、无 per-webContents 隔离语义、无 deck-plugin:// 等价；WebView2 隔离粒度不同；预算标定作废。产品核心能力需架构重造 |
| 验收电池体系 | ⚠️ 有代价 | Headless+真窗集成测试存在且是官方实践；但 CDP 探针/事件磁带/面板句柄重写，189 段逐段移植 |
| 自家托盘/单实例/自启/看门狗 | ✅ 可行 | TrayIcon 能力对齐；Mutex/Startup .lnk/FileSystemWatcher 均为 OS 或 .NET 标准手段 |
| 壁纸链 | — | 已退役（工单11），不适用 |

---

## 5. 如果换：换什么、留什么

**必须另找 .NET 生态组件补位**（有明确组件）：
- JS 引擎：ClearScript（V8）或 Jint —— 承载插件逻辑脚本。
- 插件 HTML UI：官方 `Avalonia.Controls.WebView`（WebView2）。
- 屏幕捕获/窗口缩略图：Windows.Graphics.Capture（CsWinRT）或 DwmRegisterThumbnail。
- 真机 GUI 断言：xUnit + P/Invoke（照抄 Avalonia 仓库 IntegrationTests.Win32 的做法），Headless 截帧做像素断言。

**彻底缺位、需要自研/重造**（无组件可买）：
- 插件执行上下文语义：per-包独立进程/崩溃域、执行上下文登记、`deck-plugin://` 同源、16 包/128MB 预算的重新标定与执行。
- CDP 级运行时探针通道（渲染层心跳/滞后哨兵的观测面）。
- cordis 3.x 插件内核（生命周期/热插拔/依赖注入子集）——.NET 无等价框架，`.NET Generic Host`+DI 泛化可垫底，热插拔语义自建（推断）。
- 事件磁带/面板句柄等验收基础设施（现 3.8 万行 accept 的骨架）。
- 权限/护栏/审计体系（`GLOSSARY.md` 约 40 个词条的语义）需逐条重验在新运行时的成立性。

**平移成本最低**：koffi FFI 层 → C# P/Invoke（1:1）；自启 .lnk 逻辑；桌面扫描/编排纯函数（`desktop/plan.ts` 等——纯逻辑 TS→C# 机械改写，但量大）。

---

## 6. 结论与建议

**建议：不迁移。** 逐项看，Avalonia 对本项目最独特的「硬核 Win32 桌面外壳」部分反而是最容易的（P/Invoke 比 koffi 更自然，透明/穿透/置底都有路，只是要自设样式位）；真正否决迁移的是：①插件平台是产品的立项理由（ADR-0004「为插件生态支付的代价」），Avalonia 无等价物，重造等于自研半个 Electron；②12.8 万行 TS 与 189 段验收电池全量重写的人力与风险，远超「换渲染层」收益；③本次立项所要的收益面（若为内存/包体）连官方对比页都拿不出实测数字（I 节缺证据），收益侧也没有硬数据支撑。

**如果做局部试验，最小路径**（单独立一个 Avalonia spike 仓库/worktree，不碰面板代码，两周量级）：
1. **锁版本 11.3.22（LTS）或 ≥12.1.5**（避开 v12 透明回归带，#21082/#21354）。
2. 验证窗口三件套：`TransparencyLevelHint=Transparent` 无框窗 + P/Invoke WS_EX_TRANSPARENT 穿通 + HWND_BOTTOM 置底，同屏叠出「独立面板」形态，并实测分层更新延迟（对照现 Electron 探针口径）。
3. 验证竞争窗：C# 专用线程 RegisterClassExW("Shell_TrayWnd") + PeekMessage 泵 + WM_COPYDATA 收包，确认 koffi 版 trayhost 的行为等价可复现。
4. 验证测试管线：IntegrationTests.Win32 式 xUnit 真窗断言 + Headless 截帧，跑通一条「真机验收段」的等价物。
5. 验证插件假想：官方 WebView（WebView2）多实例的隔离粒度与内存边际实测（对照现 C10 段 102-113MB/包），判断预算模型是否可在新底座重建。
四件全绿再谈迁移决策；任何一件出红即写死「不迁移」。

---

### 附：主要一手来源清单

- Avalonia GitHub 仓库：https://github.com/AvaloniaUI/Avalonia （releases/源码/issues 均经 gh api 实查，2026-11-07）
  - 版本与活跃度：`/releases`（12.1.5 @ 2026-11-02；11.3.22 @ 2026-09-11）；repo 元数据（MIT，31,767 stars，pushed 2026-11-06）；contributors API（约 343 人）
  - 源码：`src/Avalonia.Controls/TopLevel.cs:433`、`src/Avalonia.Controls/WindowBase.cs:32-49`、`src/Avalonia.Controls/Window.cs:112,158-159,274-277`、`src/Avalonia.Controls/TrayIcon.cs`、`src/Windows/Avalonia.Win32/Win32PlatformOptions.cs`、`src/Windows/Avalonia.Win32/WindowImpl.cs:431,488`、`src/Windows/Avalonia.Win32/Interop/UnmanagedMethods.cs:514`、`tests/Avalonia.IntegrationTests.Win32/StandardWindowTests.cs`
  - 关键 issue/PR：#6682（点击穿透 open）、#21082（v12 透明回归，closed）→ #21354（修复，merged 2026-05-14）、Discussion #20901（WebView 开源）、Discussion #9268（原生嵌入）
- 官方文档：https://docs.avaloniaui.net/docs/app-development/window-management ；https://docs.avaloniaui.net/docs/avalonia12-breaking-changes ；https://docs.avaloniaui.net/controls/navigation/trayicon ；https://docs.avaloniaui.net/docs/app-development/native-interop ；https://docs.avaloniaui.net/docs/app-development/embedding-web-content ；https://docs.avaloniaui.net/docs/testing/headless-platform ；https://docs.avaloniaui.net/docs/testing/headless-xunit
- NuGet 实查（2026-11-07）：`Avalonia.Diagnostics` 11.3.22（8,261,532 下载）；`Avalonia.Controls.WebView` 12.1.1（600,937 下载）
- 官方博客/对比：https://avaloniaui.net/blog/avalonia-12 ；https://avaloniaui.net/electron-compare （厂商页，无内存/启动实测）
- JS 引擎：https://github.com/ClearFoundry/ClearScript ；https://github.com/sebastienros/jint
- OS API（补位方案）：https://learn.microsoft.com/windows/win32/dwm/dwm-overview
