# 调研：Windows 11 任务栏完全隐藏（非自动隐藏）的可行路径

- 日期：2026-10-23；复审与本机复现：2026-10-25（§6）
- 范围：Win11 23H2 / 24H2 / 25H2；官方手段、编程手段、第三方开源工具、可靠性
- 只查事实，不做产品决策。对本仓 Electron 常驻面板场景的适用性评估单列一节。

## 验证口径

- **[文档]** = Microsoft Learn / microsoft.com 官方文档。
- **[源码]** = GitHub 仓库 README / 源码 / issue，一手。
- **[实测-他人]** = 工具作者在 README/issue 中报告的行为（非本机实测）。
- **[实测-本机]** = 2026-10-25 在本机 Win11、2560×1440、100% DPI 下经 accept-guard 运行的真实面板探针。
- **[推断]** = 由上述推出但无直接文字依据的判断，逐条标注。

2026-10-23 初稿未能本机实测。2026-10-25 复审已重搜 GitHub 一手源码，并对 spec #267 后的两个实测缺陷建立连续两轮红色复现；新旧结论冲突处以 §6 及正文更正为准。

---

## 0. 结论速览

**没有"完美官方方案"。** 微软面向普通桌面的唯一官方开关是「自动隐藏」（边缘悬停即唤出，且触发通知时可能闪出），不满足"完全隐藏"。官方能彻底消灭任务栏的只有 **Assigned Access kiosk / Shell Launcher**（替换整个 shell），代价是失去正常桌面。普通桌面可编程操作 `Shell_TrayWnd` / `Shell_SecondaryTrayWnd` 外层窗口——**该类名在 Win11 XAML 重写后依然存在**——但 `ShowWindow(SW_HIDE)` 只设置当下视图状态，`ABM_SETSTATE(ABS_AUTOHIDE)` 只管理工作区与系统自动隐藏状态；二者组合**不能保证持续完全隐藏，也不能保证我方 AppBar 不被 shell 移位**。2026-10-25 本机复现与 GitHub 复审详见 §6。

### 推荐方案矩阵

| 方案 | 类型 | 完全隐藏? | Win11 23H2–25H2 现状 | 侵入性/风险 | 来源 |
|---|---|---|---|---|---|
| 设置→任务栏行为→自动隐藏 | 官方设置 | 否（悬停/Win 键唤出） | 有效 | 无 | [文档](https://learn.microsoft.com/en-us/answers/questions/1161409/taskbar-auto-hide-is-enabled) |
| 注册表 `StuckRects3` 的 `Settings` 二进制位 | 官方等效 | 否（同上，就是自动隐藏的持久化） | 有效 | 无 | [实测-他人](https://www.elevenforum.com/t/enable-or-disable-automatically-hide-taskbar-in-windows-11.414/) |
| 组策略 | 官方 | **无此策略**（只有锁定/钉选类） | — | — | [推断：GP 全集无对应项；官方功能表仅列"Taskbar pins and ordering can be controlled"](https://www.microsoft.com/en-us/windows/windows-11-specifications) |
| Tablet mode | 官方 | — | **Win11 已移除**（"Tablet Mode is removed"） | — | [文档](https://www.microsoft.com/en-us/windows/windows-11-specifications) |
| Assigned Access kiosk / Shell Launcher | 官方 | **是**（无 explorer shell 即无任务栏） | 有效，Win11 全版本（Home 除外） | 替换整个 shell，非普通桌面方案 | [文档](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview) |
| 杀掉 explorer.exe | 土法 | 是（连桌面/托盘/Win 快捷键一起没） | 有效 | 副作用大，见 §1.4 | [推断+Q&A 佐证](https://learn.microsoft.com/en-us/answers/questions/5576492/how-can-we-enable-full-windows-desktop-access-from) |
| `ShowWindow(SW_HIDE)` on `Shell_TrayWnd` + `ABM_SETSTATE(ABS_AUTOHIDE)` | 编程 | **不保证**（本机已复现底边滑入） | 可释放工作区；持续隐藏需另处理 explorer 唤出路径 | 重申有首帧与时延；需处理 AppBar 相互移位 | [源码](https://github.com/amnweb/thide)、[实测-本机 §6](#6-2026-10-25-复审spec-267-后双缺陷与方案重审) |
| 仅 `ABM_SETSTATE(ABS_AUTOHIDE)` | 编程 | 否（=自动隐藏） | 有效 | 无 | [文档](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shappbarmessage) |
| Windhawk mods（注入 explorer） | 第三方 | 条件隐藏（桌面无窗口时/最大化时） | 有效，活跃维护 | 注入 explorer，功能更新有打断史 | [源码](https://github.com/ramensoftware/windhawk-mods) |
| thide / HideTaskbar 等现成工具 | 第三方 | **不作普遍保证** | thide 以 100ms 重申对抗复活；sinjs 当前走透明路线 | 重申/透明各有边界，见 §6.2 | [源码](https://github.com/amnweb/thide)、[源码](https://github.com/sinjs/HideTaskbar) |
| TranslucentTB | 第三方 | 否（透明≠隐藏，仍占位可点） | 有效，2026.2（2026-08-31） | 低；insider 构建曾打断 XAML 探测 | [源码](https://github.com/TranslucentTB/TranslucentTB/issues/1368) |
| ExplorerPatcher | 第三方 | 间接（换回 Win10 任务栏，非为隐藏） | 活跃，26100.8457.70.3（2026-06） | 高（大改 shell 体验） | [源码](https://github.com/valinet/ExplorerPatcher) |

---

## 1. 官方/系统手段

### 1.1 设置项与注册表：只有「自动隐藏」

设置 → 个性化 → 任务栏 → 任务栏行为 →「自动隐藏任务栏」。持久化在 `HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\StuckRects3` 的 `Settings` 二进制值中（第 9 字节含 auto-hide 位；多显示器对应 `SettingsMM`）——命令行改写该值再重启 explorer 与勾选设置项**完全等效**，仍是悬停唤出式自动隐藏，不是完全隐藏。[来源：Microsoft Q&A 确认 ABM_SETSTATE/该注册表路径即自动隐藏](https://learn.microsoft.com/en-us/answers/questions/1161409/taskbar-auto-hide-is-enabled)、[elevenforum 教程（线索级）](https://www.elevenforum.com/t/enable-or-disable-automatically-hide-taskbar-in-windows-11.414/)

自动隐藏的不满足点：鼠标触到底缘即唤出；Win 键、Win+T/B 唤出；任务栏图标请求注意（通知闪烁/badge）时会弹出——这正是要避开的行为。

### 1.2 组策略：不存在「完全隐藏任务栏」策略

任务栏相关 GP 只有锁定、钉选布局、隐藏特定托盘图标之类。[微软官方 Win11 规格页](https://www.microsoft.com/en-us/windows/windows-11-specifications)列出的组织可控范围仅 "Taskbar pins and ordering can be controlled by organizations"。PowerToys 有[公开 feature request #47260「Fully Hide/Show Windows Taskbar」（2026-04 提出，至今 OPEN）](https://github.com/microsoft/PowerToys/issues/47260)，佐证微软侧没有现成能力。[推断：微软无意向普通桌面提供此开关]

### 1.3 Tablet mode 历史沿革

Win10 的 Tablet mode 可整体隐藏任务栏；**Win11 已移除 Tablet mode**（官方："Tablet Mode is removed and new functionality and capability is included for keyboard attach and detach postures"，[microsoft.com Windows 11 specifications](https://www.microsoft.com/en-us/windows/windows-11-specifications)）。此路在 Win11 不存在。

### 1.4 杀掉 explorer.exe

explorer 是任务栏/桌面/托盘的宿主进程，杀掉即全没。副作用：桌面图标与壁纸消失；Win 键及 Win+E/R 等由 explorer 处理的快捷键失效；托盘图标消失；依赖 shell 的功能（文件关联弹窗、通知中心入口）受损。[佐证：Shell Launcher 场景下再启动 explorer.exe 只打开文件管理器窗口而非桌面 shell，说明任务栏完全由 explorer 提供 — Microsoft Q&A](https://learn.microsoft.com/en-us/answers/questions/5576492/how-can-we-enable-full-windows-desktop-access-from)。对常驻面板场景不可接受（面板还需要托盘和 Win 快捷键）。

### 1.5 Assigned Access / Shell Launcher（唯一官方"彻底"方案）

[Assigned Access](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview)（2024-10-31 更新，明确适用于 Win11，Pro/Education/Enterprise/LTSC/IoT）：kiosk experience 全屏跑单个 UWP/Edge，无任务栏；[Shell Launcher](https://learn.microsoft.com/en-us/windows/iot/iot-enterprise/commercialization/iot-ent-shell-launcher-app-launcher) 把任意 exe 设为 shell 替换 explorer，任务栏随之不存在。这是微软支持的"无任务栏"形态，但它替换的是整个登录会话的 shell——适合专用机/kiosk，不适合普通桌面上面板与正常应用并存。[推断：对本仓场景过度杀伤]

---

## 2. 编程手段

### 2.1 Win11 任务栏重写后 `Shell_TrayWnd` 还在吗？——在

- Win11 任务栏**内容**被重写为 XAML/WinUI（2021 年起）：[Windows Latest 2021-07](https://www.windowslatest.com/2021/07/06/windows-11-taskbar-is-a-downgrade-but-itll-eventually-get-better/)（线索级）；更硬的证据是 Windhawk 生态：[m417z 的 Windows 11 Taskbar Styler 及其 styling guide](https://github.com/ramensoftware/windows-11-taskbar-styling-guide) 直接以 XAML 元素树（`Taskbar.TaskbarFrame` 等）为目标注入 explorer.exe，说明 24H2/25H2 上任务栏 UI 本体仍是 explorer 进程内的 XAML 岛。
- 但**外层 Win32 容器窗口的类名仍是 `Shell_TrayWnd`（主屏）/ `Shell_SecondaryTrayWnd`（副屏）**，XAML 内容宿主在其中。直接证据：[thide 源码（2026 年活跃）](https://github.com/amnweb/thide/blob/main/src/main.rs) 用 `FindWindowExW` 枚举这两个类名并对句柄 `ShowWindow(SW_HIDE/SW_SHOW)`，README 明写支持 Win10/11；Windhawk mod [hide-taskbar-only-on-desktop v8.1.8](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/hide-taskbar-only-on-desktop.wh.cpp) 亦在 Win11 上按显示器处理任务栏窗口。2026-10-25 更正：sinjs 当前源码不是 SW_HIDE 同款，而是透明路线，见 §6.2。
- 老工具失效的部分是**样式/内部子窗口类名**（Win10 的 `TrayNotifyWnd`/`ReBarWindow32` 等内部结构变了），不是外层容器窗口。外层 HWND 类名仍可找到，不等于一次 `SW_HIDE` 就能持续压制 explorer 的唤出行为；凡依赖内部结构的手段（改颜色、改尺寸、找特定子控件）在重写后需要按 XAML 重做——这就是 TranslucentTB 等工具"失效又修复"的由来（[issue #1368：insider build 26340 改了任务栏 XAML 结构导致句柄探测失败，2026-10](https://github.com/TranslucentTB/TranslucentTB/issues/1368)）。

### 2.2 `ShowWindow(SW_HIDE)` —— 瞬时视图手段，不是持续唤出抑制

`ShowWindow` [官方文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-showwindow)只承诺设置指定窗口当下的 show state，不承诺另一个进程以后不再把它显示。对本机普通窗口场景的底边悬停，2026-10-25 已直接证伪初稿“隐藏后不响应悬停”的无条件断言（§6.1）。要点：

- **多显示器**：副屏任务栏是 `Shell_SecondaryTrayWnd`，且每个副屏一个实例，需枚举全部（thide 的做法：循环 `FindWindowExW` 取所有，且校验属主进程是 explorer.exe）。
- **工作区（work area）**：仅 SW_HIDE 不释放本机原生任务栏保留带（工单250 已实测）；`ABM_SETSTATE(ABS_AUTOHIDE)` 可释放该保留带，但 auto-hide 自身具有边缘唤出语义。thide 也不是一次调用后静止：其当前源码在隐藏期间持续强制 auto-hide，并以 100ms 周期检查可见性、重新 SW_HIDE（§6.2）。
- **副作用权衡**：带 `ABS_AUTOHIDE` 时，指针与键盘唤出仍由 explorer 管。Windhawk 的键盘专用自动隐藏实现分别拦截指针/屏幕边缘原因与 `TrayUI::Unhide`，说明“工作区释放”与“禁止任何唤出”是两层问题。是否允许 Win 键等主动唤出是产品边界，不在本文默认。
- **可逆性**：退出时 `SW_SHOW` + 恢复原 AppBar state（thide 用 RAII Drop 恢复）。

### 2.3 `SHAppBarMessage` / AppBar 消息

[官方文档](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shappbarmessage)：`ABM_SETSTATE` 只能设置 `ABS_AUTOHIDE` / `ABS_ALWAYSONTOP` 组合——即**只能达到自动隐藏**，无"完全隐藏"语义。`ABM_REMOVE` 是给自注册 appbar 注销用的，发给任务栏自身不会移除任务栏。所以 AppBar 消息单独不够，价值在于配合 SW_HIDE 调整状态与工作区（见上）。

### 2.4 注入手段（Windhawk 模式）

Windhawk（[主仓 9.5k stars，2026-10 活跃](https://github.com/ramensoftware/windhawk)）向 explorer.exe 注入 mod。与"完全隐藏"相关的 mod 都是**条件隐藏**而非彻底隐藏：[taskbar-auto-hide-when-maximized v1.2.6（m417z）](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/taskbar-auto-hide-when-maximized.wh.cpp)（有窗口最大化/相交时才自动隐藏）；[hide-taskbar-only-on-desktop v8.1.8](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/hide-taskbar-only-on-desktop.wh.cpp)（显示器只剩桌面/无边框全屏时隐藏，含任务栏重建恢复、多显示器独立处理、键盘唤出处理——其 README 是研究隐藏边界条件的最佳清单）。注入路线能力强但脆：依赖 explorer 内部符号/XAML 结构，功能更新打断史明确（见 §4）。

---

## 3. 第三方开源工具核查

| 工具 | Stars（初稿时点） | 最近维护（2026-10-23 时点） | 原理（2026-10-25 复核） | Win11 支持 | 判断 |
|---|---|---|---|---|---|
| [amnweb/thide](https://github.com/amnweb/thide) | 136 | 2026-07 push，release v0.1.3 | SW_HIDE + 持续 ABS_AUTOHIDE + 100ms 可见性重申，枚举主/副屏，退出恢复 | 明写 Win10/11，x64+ARM64 | 对口蓝本，但证明的是持续对抗，不是一次调用后完全抑制 |
| [sinjs/HideTaskbar](https://github.com/sinjs/HideTaskbar) | 18 | 2026-10 更新 | `WS_EX_LAYERED` + `SetLayeredWindowAttributes(alpha=0)`，每秒重设透明度 | 是 | 初稿“纯 SW_HIDE”描述撤回；透明不等于消除输入与工作区行为 |
| [Lonely-Atom/HideTaskbar](https://github.com/Lonely-Atom/HideTaskbar) | 69 | 2026-10 更新 | 隐藏任务栏/托盘/桌面图标，快捷键切换 | 是（中文用户向） | 可用，注意其把托盘也藏了 |
| [TranslucentTB](https://github.com/TranslucentTB/TranslucentTB) | 20.6k | 2026-10 push，release 2026.2 | 改任务栏外观为全透明 | 是 | **透明≠隐藏**：仍占位、仍可点击、悬停区仍在；只能作辅助 |
| [ExplorerPatcher](https://github.com/valinet/ExplorerPatcher) | 34.1k | 2026-06 release 26100.8457.70.3 | 替换/恢复 Win10 任务栏（ep_taskbar）等大量 shell 改动 | 是（紧跟 24H2/25H2 build 号发版） | 非隐藏工具；对本仓是大炮打蚊子且风险高 |
| Windhawk + mods | 9.5k（主仓） | 2026-10 活跃 | 注入 explorer，条件隐藏/唤出原因拦截 | 是 | 能解释唤出边界；注入风险与维护成本另计 |
| [PowerToys #47260](https://github.com/microsoft/PowerToys/issues/47260) | — | OPEN（2026-04） | — | — | 微软官方无此能力，佐证 §1.2 |

已废弃/不推荐：一堆 2022–2024 年停更的 `HideTaskbar` 同名小仓（hanssens、JoeWolski、qubits-us 等，gh search 结果）。同名仓库不能互相佐证机制；应读当前具体源码与提交。

---

## 4. 可靠性分析

- **多显示器**：副屏任务栏为独立 `Shell_SecondaryTrayWnd` 实例，必须枚举全部（thide 已示范）；显示器热插拔会重建对应任务栏窗口，需重挂。
- **explorer 重启/崩溃与视图翻转**：任务栏窗口可被销毁重建，也可被 explorer 重新显示。轮询重申只能缩短复活时间，不能推出“零帧弹出”；thide 的 100ms 重申与本仓收栏态 1s 重申都是持续对抗机制。
- **焦点/全屏/其他 AppBar**：`ABS_AUTOHIDE` 下键盘与指针唤出仍由 explorer 响应。其他 AppBar 并非笼统“无冲突”：[官方 AppBar 指南](https://learn.microsoft.com/en-us/windows/win32/shell/application-desktop-toolbars)规定同边任务栏位于最外缘，任务栏可见性变化会触发 `ABN_POSCHANGED`，AppBar 需重新协商；本机已观察到我方条带整窗上移 48px（§6.1）。
- **系统更新打断**：只找外层窗口类名的挂钩点比依赖 XAML 内部结构稳定，但“找得到 HWND”不等于行为语义稳定。依赖 XAML 内部结构/XAML 岛句柄的手段会被 insider/功能更新打断（TranslucentTB #1368，build 26340，2026-10）。
- **权限**：操作其他进程窗口的可见性不需要提权（同完整性级别、同会话桌面即可）；explorer 与用户同级，面板进程直接可调。

---

## 5. 对本仓 Electron 常驻面板场景的适用性评估

面板目标：原生任务栏不可见，面板自绘承载桌面项、保留托盘与快捷键能力。

- **当前实现不是初稿推荐的常驻组合**：`app/src/main/taskbar/native.ts` 在接管时 SW_HIDE；`appbar-autohide.ts` 只在收栏账存续时置 ABS_AUTOHIDE；`native-watch.ts` 的可见性重申也只在收栏账存续时运行。普通窗口态因此没有持续压住系统自动隐藏唤出的机制。
- **旧“推荐主路径”降级为待验证候选**：枚举原生 HWND、记录并恢复 appbar 状态、释放工作区、处理 shell 重建仍是必要部件，但“SW_HIDE + ABS_AUTOHIDE + 低频重申 = 完全隐藏”已由本机实测证伪。是否把原生栏托管扩大到普通窗口态，是产品状态所有权决策，不能由本文替用户默认。
- **几何必须单独验收**：原生栏、我方 AppBar 与 shell 工作区是三件相互影响的事实。即使唤出条 DOM 以 `window.innerHeight` 正确贴客户区底边，宿主条带窗被上移后，所有唤出条仍会一起漂移。
- **透明只可作对照实验**：透明不等于隐藏，不能修复工作区、AppBar 协商或窗口矩形问题；若同时处理输入穿透，还需记录并恢复扩展样式与 alpha（§6.2）。
- **明确排除**：Assigned Access/Shell Launcher（替换 shell）；杀 explorer（丢托盘与 Win 快捷键）；ExplorerPatcher/Windhawk 注入（对本目标是过大攻击面与维护负担，只作边界条件参考）。
- **已关闭的旧不确定点**：纯 SW_HIDE 不置 ABS_AUTOHIDE 时本机保留带不释放，工单250 已实测；收栏置位后工作区释放，工单259 已实测。**仍待验证**：普通窗口态不同原 auto-hide 偏好下的各唤出路径，以及原生栏复活与我方条带首次移动的精确因果时序。

---

## 6. 2026-10-25 复审：spec #267 后双缺陷与方案重审

### 6.1 本机反馈环与复现事实

**[实测-本机]** 临时探针 `.scratch/taskbar-hover-repro.cjs` 复用真实面板、Win32 探针和事件磁带，不改正式验收段。命令：

```bash
npm run build --prefix app
node D:/test-folder/.accept-guard/guard.mjs hold --as kimicode --purpose selftest -- node .scratch/taskbar-hover-repro.cjs
```

探针流程：普通 WinForms 前台窗 → 指针离开底缘并确认原生栏 `visible=false` 或屏内至多 2px → 移到屏幕最底像素 → 原生栏屏内至少 40px 且与自绘条带相交 → 最大化同一窗口 → 检查五组唤出条视觉底边。判据结合 visible 与物理矩形，因为 auto-hide 滑出屏时 visible 也可为 true，而 SW_HIDE 后旧矩形仍可留在屏内坐标。

初轮同一探针连续红色复现；最终把普通态门槛收紧到 40px 后仍为红。后续 auto-hide-off 对照改变了 shell 状态，基线复跑曾转绿，故本缺陷是**状态依赖的可复现缺陷，不是每次启动必现**；详见 §6.4：

| 观测 | 结果 |
|---|---|
| 普通态底边唤醒 | 265ms 后原生栏 `rect={0,1395,2560,1443}`，屏内 45px；自绘条带 `{0,1392,2560,1440}`，二者相交 |
| 最大化后工作区 | `SPI_GETWORKAREA.bottom=1440`，已到屏底 |
| 最大化后自绘条带宿主 | 从 `{0,1392,2560,1440}` 变为 `{0,1344,2560,1392}`，整窗上移 48px |
| 五组唤出条 | `start/recs/apps/right/showdesk` 的视觉底边全为 1392，而非 1440 |
| 收栏重申 | 随后出现 `taskbar-native-reassert reason=visible` 与再次 `taskbar-hidden`；是弹出后的纠正，不是首帧预防 |
| 用户原偏好 | 事件账为 `taskbar-autohide-set previous=1 state=1`：本机原已开启系统自动隐藏，置位前后值相同 |

**已排除的解释**：不是单纯渲染层 y 坐标或 DPI 计算错误——Win32 `GetWindowRect` 已证明整个条带宿主窗上移；渲染层只是以该窗客户区底边为基准。漂移当拍事件流没有新的 `taskbar-appbar-setpos reason=abn-poschanged`，因此也不能直接归因成“我方重协商代码写错了矩形”。

后续读取本机系统注册表为 **DisplayVersion=26H2、build 26300.9711、x64**。结论只声称该构建可复现，不外推 23H2–25H2 或其他架构；原调研范围需把 26H2 纳入后续注入兼容性验证。

### 6.2 GitHub 一手源码复审

- [KWWDCoding/windows11-app-specific-taskbar-hider，commit `4479042`](https://github.com/KWWDCoding/windows11-app-specific-taskbar-hider/blob/4479042be4fcbdea8447f675cc0185d781a7207c/windows11-taskbar-hider.cpp)：作者 README 直接描述“单纯定时隐藏仍会在 hover 时弹出”，实现因而在 explorer 内拦截 `ShowWindow`、`SetWindowPos`、`SetForegroundWindow` 的重新显示路径。它是机制线索，不是成熟度或本机有效性的证明。
- [amnweb/thide，commit `8d652ab`](https://github.com/amnweb/thide/blob/8d652ab37d83d4402e20860470c716f842b3d6ed/src/main.rs)：隐藏期间一直强制 ABS_AUTOHIDE，并以 100ms 周期检查可见性、重新 SW_HIDE；不是“一次调用后稳定不响应”。
- [taskbar-auto-hide-keyboard-only，commit `9f6a018`](https://github.com/ramensoftware/windhawk-mods/blob/9f6a018d93adf561e55dc5318babf4428073c11c/mods/taskbar-auto-hide-keyboard-only.wh.cpp)：要求系统 auto-hide 已开启，再分别拦截指针悬停/屏幕边缘原因、`TrayUI::Unhide` 与副栏 `_Unhide`；“Never”还阻止所有 expansion。原生 auto-hide 与“禁止任何唤出”是两层问题。[issue #1657](https://github.com/ramensoftware/windhawk-mods/issues/1657)、[issue #2328](https://github.com/ramensoftware/windhawk-mods/issues/2328)亦区分细线、点击/悬停唤出与完全隐藏。
- [taskbar-auto-hide-when-maximized，commit `2a73049`](https://github.com/ramensoftware/windhawk-mods/blob/2a7304911a79819683903696a3a7a34a1bb59633/mods/taskbar-auto-hide-when-maximized.wh.cpp)：保持原生 auto-hide，通过 explorer 内部 `Unhide`/hide timer 控制呈现，而非把 SW_HIDE 当工作区开关；[issue #3716 作者说明](https://github.com/ramensoftware/windhawk-mods/issues/3716#issuecomment-4195550363)亦区分工作区状态与视觉呈现。
- [sinjs/HideTaskbar，commit `064b6a0`](https://github.com/sinjs/HideTaskbar/blob/064b6a059c658aacc4b4cbdbdea3994144279a6c/HideTaskbar.cpp)：当前为 `WS_EX_LAYERED` + alpha=0，不是纯 SW_HIDE。
- [hide-taskbar-only-on-desktop，commit `9690c99`](https://github.com/ramensoftware/windhawk-mods/blob/9690c990f8bcb9dc98bf5f19dee944138d20d9a5/mods/hide-taskbar-only-on-desktop.wh.cpp)：透明路线同时处理 `WS_EX_TRANSPARENT`、原样式/alpha 恢复，并在原生 auto-hide 开启时退出自己的隐藏路径；不能简化成“加透明即可”。

### 6.3 候选机制与可证伪预测（未裁决）

1. **auto-hide 与 `WS_VISIBLE` 屏外态共同构成底边复活条件（当前首选）**。本机红轮 `previous=1` 且原生栏 `visible=true, top=1438`；只写 auto-hide=on 不足以解释所有轮次。预测：在 auto-hide=on 时注入 `SW_SHOWNOACTIVATE` 重建屏外可见态可提高复现率；auto-hide=off 或 `visible=false` 时底边不滑入。
2. **原生栏在场时，shell 在收栏过渡中直接移动我方条带（当前首选）**。预测：最大化前先把原生栏稳定压回并保持隐藏，条带不漂移；只延后几何回正而不处理原生栏，漂移会再次出现。
3. **1 秒重申与几何回正之间存在持久窗口期**。预测：收栏过渡先隐藏原生栏、再注销我方 AppBar、最后重申条带矩形，可消除 48px 偏移；仅把轮询改快只能缩短偏移持续时间，不能保证零帧。
4. **原生栏可见性变化先触发 ABN_POSCHANGED，旧工作区协商留下偏移（次选）**。[ABM_QUERYPOS 官方文档](https://learn.microsoft.com/en-us/windows/win32/shell/abm-querypos)要求按系统调整后的矩形继续 SETPOS；若此链路成立，wire 级记录应见 ABN 通知、协商 `rc.top` 增加约 48px、实际矩形随动。当前漂移当拍没有 setpos 存证，故不能列为已定根因。
5. **已登记的 QUERYPOS/SETPOS 数值互换缺陷 #251 放大时序问题（次选）**。本仓 `appbar.ts` 本地别名与官方数值相反；探针必须记录真实 wire 数值、调用前后 rc，不能只按本地函数名判读。现有证据不足以把 #251 定为本次根因。

### 6.4 Q1/Q2 裁决与受控对照结果

**产品边界已由用户在 2026-10-25 确认**：Q1=A——面板接管期间，即使用户原已开启系统自动隐藏，原生栏在底边、Win 键、通知等所有路径下均不得出现；Q2=A——普通栏态临时清 auto-hide，收栏态置位，禁用/退出后恢复用户接管前原偏好。两处裁决已写入 `GLOSSARY.md` 与 ADR-0016。已知触发应由状态托管预防；外部重建/翻转是否需要允许纠偏窗口，是下一边界问题。

| 轮次 | 改变量/触发 | 普通态原生栏 | 最大化后唤出条 | 判读 |
|---|---|---|---|---|
| 初轮基线 | auto-hide=on；原生栏曾被 explorer 置为屏外 `visible=true`；底边 | 红：屏内 45px | 红：整体上移 48px | 缺陷成立 |
| auto-hide-off 对照 | 面板启动前临时 1→0；底边 | 绿：3.5 秒未滑入 | 绿：底边 1440 | 支持普通态清位 |
| prehide 预定对照 | 计划只在最大化前 SW_HIDE | 未出现复活 | 绿 | 前提未成立，不能用作证据 |
| off 后基线复跑 | 恢复 auto-hide=1，但原生栏已为 `visible=false` | 绿 | 绿 | on 不是充分条件，红绿依赖 WS_VISIBLE/历史状态 |
| Win 基线 | auto-hide=on、屏外 visible=true；Win 键 | 红：215ms 后屏内 48px | 绿 | Win 是有效阳性触发；漂移另有状态条件 |
| Win off 对照 | 普通态清位；Win 键 | 绿：3.5 秒未出现 | 绿 | 清位阻断该已知主动唤出 |
| Flash 基线 | auto-hide=on、屏外 visible=true；`FlashWindowEx` | 绿：未完整弹出 | 红：底边 1392 | 本机构不成通知阳性；漂移不要求原生栏完整弹出，屏外 visible=true 已足够 |
| Flash off 对照 | 普通态清位；`FlashWindowEx` | 绿 | 绿 | 不能视作通知路径证明，只作阴性记录 |
| V1 装夹基线 | 注入 `SW_SHOWNOACTIVATE` 重建屏外 visible=true；底边 | 红：253ms 后屏内 41px | 红：底边 1392 | 可重复装夹缺陷前提 |
| V1 + 预隐藏 | 同装夹并先弹出；最大化前仅额外 SW_HIDE | 红：264ms 后屏内 45px（预期保留） | **绿：五组底边全为 1440** | 有效证明预隐藏阻断本次 48px 漂移 |

off 对照结束后读回 `restoredAutoHideState=1`，用户原偏好已恢复。探针开发中曾把 x64 `APPBARDATA.lParam` 错写到偏移 32（写 0 恰好有效、写 1 无效）；发现后立即用生产 FFI 对应的偏移 40 恢复并读回 1，再修正探针。该事故不计作产品结果，只保留为探针纪律：**所有 SETSTATE 必须读回，复原也必须读回**。

通知/badge 的真实阳性路径、Win+T/B、DPI、多屏与 shell 重建仍未验证；FlashWindowEx 阴性不得写成“所有通知已覆盖”。

### 6.5 下一轮探针矩阵

| 场景 | 原 auto-hide | 起始原生栏 | 操作 | 核心判据 |
|---|---|---|---|---|
| V1 状态装夹 | on | 注入 `SW_SHOWNOACTIVATE` 重建屏外 visible=true | 普通窗，指针到最底缘 | 提高红轮复现率；visible、rect、截图同步 |
| A0 对照 | off | 稳定隐藏 | 普通窗，不碰底边 | 不应自发复活 |
| A1 对照 | off | 稳定隐藏 | 普通窗，指针到最底缘 | visible、物理矩形、截图三者同步 |
| A2 复现 | on | V1 屏外可见态 | 同 A1 | 区分 WS_VISIBLE、屏外态与真实滑入 |
| K1 主动唤出 | on/off 各一档 | 稳定隐藏 | Win 键、Win+T/B | Q1 要求所有路径均禁现 |
| N1 通知唤出 | on/off 各一档 | 稳定隐藏 | 可控通知/badge | Q1 要求所有路径均禁现 |
| A3 重申 | on/off 各一档 | 先唤出 | 停留 2–3 秒 | 首帧到压回时延，不以最终隐藏代替首帧 |
| B0 对照 | 收栏时置位 | 始终隐藏 | 普通→真最大化 | 唤出条贴屏底 |
| B1 复现 | on | 先按 A2 唤出 | 普通→真最大化 | ABN/setpos/实际矩形/events 全时间线 |
| B2 预隐藏 | on | 先按 A2 唤出，再仅 SW_HIDE | 立即最大化 | 前提必须是原生栏已弹出；验证预隐藏是否防漂移 |
| B3 逆序/恢复 | on | 已最大化收栏或经历 B1 | 再碰底缘/退出最大化 | 区分偏移发生时点与恢复行为 |
| D1/D2 | 同 A2、B1 | 同 A2、B1 | 100% 与非 100% DPI | 区分 48 DIP 与原生栏物理高度 |

每拍至少采集：原生栏 HWND/属主/visible/rect/截图；我方条带 `GetWindowRect`、Electron `getBounds()`、协商账；AppBar 真实 wire 数值、调用前 want、调用后 rc、reason；`ABM_GETSTATE`、`ABM_GETTASKBARPOS`、`SPI_GETWORKAREA`、`GetMonitorInfo`；前台窗 `IsZoomed` 与实际矩形。[WM_GETMINMAXINFO 官方文档](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-getminmaxinfo)允许应用覆盖默认最大化尺寸，不能只由 work area 反推窗口矩形。

### 6.6 复审结论

当前可以定论的是：**旧方案保证过宽；缺陷可用 WS_VISIBLE 装夹重复；普通态清位已阻断本机底边与 Win 键阳性路径；最大化前预隐藏已阻断本次 48px 漂移**。Q1/Q2 已分别确认全路径禁现与全接管期托管。首次移动的更底层 shell 内部原因仍不必作为实施前提，但宿主矩形必须在过渡后复核。通知/badge 真实阳性、Win+T/B、DPI、多屏和 shell 重建仍待验证；非注入方案对外部强制翻可见能否允许有界纠偏窗口，需用户明确，不可静默把 Q1 改成“最终隐藏即可”。

---

## 7. 2026-10-25 注入复审：Q3 零帧目标与启动期证据边界

### 7.1 总结论

用户在 Q3 选择**软件唤出路径绝对零帧**，推翻此前不注入边界。对 Windhawk 引擎、相关 mods、KWWDCoding 实现、自研 DLL 注入方式及微软文档重审后：**没有找到任何候选能证明“explorer 每次重启后，原生任务栏首帧之前已禁现”**。注入后同步 hook 只能证明“hook 已安装时，被拦截调用不再继续”，不能反推启动期、首次创建和 DWM 合成均零帧。

因此必须把两个目标分开：

- **稳态零帧**：explorer 与注入层均已就绪后，各唤出调用在呈现前被拦截。
- **启动期零帧**：explorer 每次创建/重启时，在首个原生栏像素合成前完成加载、初始化和全部 hooks。

现有证据只支持继续评估前者；后者没有可证明路线，不能拿“已注入”冒充达标。

### 7.2 Windhawk 的快路径与明确反例

- Windhawk 引擎包含 32/64 位 DLL，mod 是注入目标进程的 C++ DLL：[引擎 README，commit `0cfc358`](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/README.md)、[mod 生命周期](https://github.com/ramensoftware/windhawk/wiki/Creating-a-new-mod)。
- 快路径在已注入进程内 hook `CreateProcessInternalW`，强制 `CREATE_SUSPENDED`，向新进程主线程排 APC 后再恢复：[new_process_injector.cpp](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/src/windhawk/engine/new_process_injector.cpp)。之后 `ModsManager` 匹配并加载 mod、调用初始化、应用 hooks：[mods_manager.cpp](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/src/windhawk/engine/mods_manager.cpp)。
- **异步补偿路径**会枚举所有进程；未开始者走 APC，已运行者直接远程线程，服务循环超时为 1000ms：[all_processes_injector.cpp](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/src/windhawk/engine/all_processes_injector.cpp)、[service.cpp](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/src/windhawk/app/service.cpp)。
- 作者明确写到：不可访问父进程创建目标时，补偿注入可能在新进程已开始运行后发生，**“might be too late”**：[Implementing Global Injection and Hooking in Windows](https://m417z.com/Implementing-Global-Injection-and-Hooking-in-Windows/)。只包含 explorer.exe 也可能损失早注入：[issue #222 作者回复](https://github.com/ramensoftware/windhawk/issues/222)。
- 目标 mod 自己在 `Wh_ModAfterInit` 补发 `WM_NCCREATE`，因为该消息可能早于 mod 加载：[taskbar-auto-hide-keyboard-only 源码](https://github.com/ramensoftware/windhawk-mods/blob/9f6a018d93adf561e55dc5318babf4428073c11c/mods/taskbar-auto-hide-keyboard-only.wh.cpp)。这直接否定“mod 必在窗口创建前就绪”的无条件说法。

### 7.3 现有 mods 的覆盖不等于全路径覆盖

[taskbar-auto-hide-keyboard-only v2.3，commit `9f6a018`](https://github.com/ramensoftware/windhawk-mods/blob/9f6a018d93adf561e55dc5318babf4428073c11c/mods/taskbar-auto-hide-keyboard-only.wh.cpp)：

- 内部 hooks：`TrayUI::SlideWindow/_Hide/Unhide/WndProc`、`CSecondaryTray::_AutoHide/_Unhide/v_WndProc`、`CTaskBand::v_WndProc`。
- Win11 XAML：`ViewCoordinator::IsExpanded`、指针变化、`ShouldTaskbarBeExpanded`、`UpdateIsExpanded`、`TaskbarFrame::OnPointerPressed`。
- 公共 hooks：`LoadLibraryExW`、`SetTimer`、`DwmSetWindowAttribute`；可选 `XamlLauncher::ShowStartView`。
- 底边、Win 键和通知可经中央 Unhide/展开路径拦截，但**没有 hook SetWindowPos、ShowWindow、ShowWindowAsync，不能声称覆盖这些显示路径**；首次创建、直接内部状态改变和其他渲染路径也未枚举。
- 符号缺失会使 `HookSymbols` 失败；微软曾临时下架 explorer/taskbar 符号导致多 mod 失效：[官方符号故障说明](https://ramensoftware.com/windhawk-and-symbol-download-errors)。该提交还修复过 Never 模式系统启动崩溃：[提交说明](https://github.com/ramensoftware/windhawk-mods/commit/9f6a018d93adf561e55dc5318babf4428073c11c)。本机 26H2 build 26300.9711 必须单独验证。

[KWWDCoding/windows11-app-specific-taskbar-hider，commit `4479042`](https://github.com/KWWDCoding/windows11-app-specific-taskbar-hider/blob/4479042be4fcbdea8447f675cc0185d781a7207c/windows11-taskbar-hider.cpp)不是自研注入器，仍是 Windhawk mod。它只 hook `ShowWindow`、`SetWindowPos`、`SetForegroundWindow`，且每 300ms 更新条件、只缓存主栏 HWND、未检查所有 hook 安装返回值；`ShowWindow` 的其他显示命令、`ShowWindowAsync`、副栏和 explorer 内部直接路径均不完整，不能作为零帧证明。

### 7.4 自研 DLL 路线也没有启动屏障

| 路线 | 一手事实 | 对启动期零帧的结论 |
|---|---|---|
| 远程线程 | [CreateRemoteThread](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createremotethread) 在目标进程创建线程 | 对已运行 explorer 是事后注入，无首帧顺序保证 |
| Detours 挂起创建 | [DetourCreateProcessWithDllEx 源码](https://github.com/microsoft/Detours/blob/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7/src/creatwth.cpp) 强制挂起、写入 DLL 后恢复 | 只覆盖“由我创建的这一次”；winlogon、任务管理器、崩溃重启等外部创建不受控 |
| 全局 SetWindowsHookEx | [官方文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowshookexw)：同 desktop、跨进程 DLL、位数和 Store/UIAccess 限制 | 是事件机制，不是 explorer 创建屏障 |
| AppInit_DLLs | [微软说明](https://learn.microsoft.com/en-us/windows/win32/dlls/secure-boot-and-appinit-dlls)：Secure Boot 开启即禁用，且不推荐 | 不能作为 Win11 通用方案，也无零帧保证 |
| Shell 扩展 | [官方 handler 文档](https://learn.microsoft.com/en-us/windows/win32/shell/handlers)：按相应 Shell 操作查询/调用 | 不是 explorer 启动即加载的通用扩展点 |
| Detours / MinHook | [Detours](https://github.com/microsoft/Detours/tree/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7)、[MinHook](https://github.com/TsudaKageyu/minhook/tree/8af6b4acae5a9388fd742b56fa79ece89d96f823) | 解决已加载后的插桩，不解决及时加载；MinHook 上游无 ARM64 |

DLL 初始化还受 loader-lock 约束；微软建议 `DllMain` 尽量为空、延迟复杂初始化：[DLL Best Practices](https://learn.microsoft.com/en-us/windows/win32/dlls/dynamic-link-library-best-practices)。

### 7.5 部署与本机约束

- 本机未检测到 Windhawk，亦无 `clang++`、`cl`、`g++`、`cmake`；当前 x64，26H2 build 26300.9711。现有应用只有 Electron/cordis/koffi，没有原生注入构建链。
- **Windhawk + mod**：多一个常驻引擎/服务与三层升级兼容（引擎、mod、Windows 符号）；有 safe mode 和恢复设施，但也有真实安全软件兼容问题：[SentinelOne issue](https://github.com/ramensoftware/windhawk/issues/222)。
- **自研注入器 + DLL**：单一产品外观，但需自建编译、签名、权限、注入、崩溃循环抑制、安全卸载和升级设施；内部符号风险并不减少。签名可经 [SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)，但签名不等于所有 AV/EDR 或 App Control 自动放行。
- ARM64 不能用“mod 元数据 x86-64”简单判定必不可用；Windhawk 1.6 有[架构映射规则](https://ramensoftware.com/windhawk-v1-6-arm64-support-better-compatibility)，但具体任务栏符号和行为仍需 ARM64 真机验证。自研 MinHook 路线则需另补 ARM64 hook 库。

**决策含义与后续选择**：若 Q3 是不可例外的“所有启动与唤出路径绝对零帧”，普通桌面上的这些用户态候选均未达到可证明门槛。用户在知晓后仍于 Q4 选择 **B：自研注入器 + DLL**，不依赖用户安装 Windhawk；这只确定自研方向，不把启动期缺口写成已解决。后续复用评估须分别审查注入、hook、符号加载与任务栏拦截代码。Detours 仓库标记 MIT，Windhawk 主仓为 GPL-3.0，本仓当前未声明许可证，直接复用 GPL 组件可能产生整个衍生作品的源码开放义务，不能默认混用。

---

## 8. 2026-10-25 可复用组件复审（Q4=B）

### 8.1 结论

**有可复用组件，没有可直接搬来的完整方案。** 宽松许可的首选工程基线是：Microsoft Detours 负责“我方主动创建 explorer”的挂起注入，KNSoft.SlimDetours 负责 DLL 内 inline hook；任务栏符号、全部唤出 hooks、Electron IPC、恢复事务和 safe mode 仍需自研。未找到许可宽松、独立、现成覆盖 TrayUI/ViewCoordinator 禁现 hooks 的非 Windhawk DLL。

以下维护时间与许可证来自本次 GitHub 查询；未在本机编译或做 26H2 真机验证。

### 8.2 候选清单

| 组件 | 可复用部分 | 架构/维护 | 许可证与边界 |
|---|---|---|---|
| [Microsoft Detours `creatwth.cpp`](https://github.com/microsoft/Detours/blob/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7/src/creatwth.cpp) / [`withdll.cpp`](https://github.com/microsoft/Detours/blob/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7/samples/withdll/withdll.cpp) | `DetourCreateProcessWithDllExW` 强制 CREATE_SUSPENDED、改导入表后按原 flags 决定恢复；DLL 导出 ordinal #1；失败终止新建进程 | x86/x64/ARM/ARM64/ARM64EC；主分支 2026-09-29 | [MIT](https://github.com/microsoft/Detours/blob/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7/LICENSE.md)；只覆盖我方创建，不含非我方启动补偿 |
| [KNSoft.SlimDetours](https://github.com/KNSoft/KNSoft.SlimDetours/tree/0255fac24b12781e0f0c35e0ae71bd7fc45411ee) | [`InlineHook.c`](https://github.com/KNSoft/KNSoft.SlimDetours/blob/0255fac24b12781e0f0c35e0ae71bd7fc45411ee/Source/KNSoft.SlimDetours/InlineHook.c)、事务、[`Thread.c`](https://github.com/KNSoft/KNSoft.SlimDetours/blob/0255fac24b12781e0f0c35e0ae71bd7fc45411ee/Source/KNSoft.SlimDetours/Thread.c) 的 PC 修正；Detach 遇第三方改写不强行回写 | x86/x64/ARM64/ARM64EC；主分支 2026-09-15；README 仍标 beta | [MIT](https://github.com/KNSoft/KNSoft.SlimDetours/blob/0255fac24b12781e0f0c35e0ae71bd7fc45411ee/LICENSE)；不负责注入、符号、loader-lock 调度或完整卸载等待 |
| [Microsoft Detours hook](https://github.com/microsoft/Detours/tree/1dbd4ea281d73d478aa8d09a8b83fbd265f715f7) | Transaction/Attach/Detach/Commit/Abort；与创建注入同依赖 | 同 Detours | MIT；卸载增强少于 SlimDetours，官方 DllMain 样例不能照搬到复杂初始化 |
| [TsudaKageyu/MinHook `hook.c`](https://github.com/TsudaKageyu/minhook/blob/8af6b4acae5a9388fd742b56fa79ece89d96f823/src/hook.c) | 小型 hook、queue/apply、uninitialize | x86/x64；主分支 2026-09-07；**无 ARM64** | [BSD 2-Clause 风格原文](https://github.com/TsudaKageyu/minhook/blob/8af6b4acae5a9388fd742b56fa79ece89d96f823/LICENSE.txt)；架构与卸载健壮性不如 SlimDetours 对口 |
| [Windhawk 注入器](https://github.com/ramensoftware/windhawk/tree/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13) | `CreateProcessInternalW` 挂起、APC、重复注入互斥、扫描补偿 | x64 有直接参考，含 ARM64X/EC 辅助；主分支 2026-10-10 | [GPL-3.0-or-later](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/LICENSE)；深度耦合引擎，复制会产生 copyleft 义务，且仍无全启动屏障 |
| [BlackBone `RemoteExec.cpp`](https://github.com/DarthTon/Blackbone/blob/5ede6ce50cd8ad34178bfa6cae05768ff6b3859b/src/BlackBone/Process/RPC/RemoteExec.cpp) | APC/RPC/manual-map | 主要 x86/x64；最近 master 2023-07-17 | [MIT](https://github.com/DarthTon/Blackbone/blob/5ede6ce50cd8ad34178bfa6cae05768ff6b3859b/LICENSE)；没有本任务创建屏障，引入复杂度过大，不推荐 |
| [ExplorerPatcher `symbols.c`](https://github.com/valinet/ExplorerPatcher/blob/0a88a6e0ef6b1752fea36e581cffff1097e862b0/ExplorerPatcher/symbols.c) | 文件 hash 绑定 offset cache、失败/失效处理、SlimDetours 薄封装 | 主分支 2026-07-06；ARM64 仍有 TODO | [GPL-2.0](https://github.com/valinet/ExplorerPatcher/blob/0a88a6e0ef6b1752fea36e581cffff1097e862b0/LICENSE)；不是独立小型禁现 DLL |

### 8.3 任务栏逻辑与符号层为什么不能直接搬

- 目标 [`taskbar-auto-hide-keyboard-only.wh.cpp`](https://github.com/ramensoftware/windhawk-mods/blob/9f6a018d93adf561e55dc5318babf4428073c11c/mods/taskbar-auto-hide-keyboard-only.wh.cpp) 文件头明确 **GPLv3**。其 TrayUI、CSecondaryTray、ViewCoordinator hooks、`Wh_ModUninit` 清理最贴近需求，但不接受 GPL 就不能复制函数体、状态机或清理实现。
- Windhawk [`symbol_enum.cpp`](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/src/windhawk/engine/symbol_enum.cpp) 和 [`LoadedMod::HookSymbols`](https://github.com/ramensoftware/windhawk/blob/0cfc358d26fcbfcc24097d6b66e84848ea6b8c13/src/windhawk/engine/mod.cpp#L2400) 有 DIA、PDB GUID/age、缓存与失败节流，但同为 GPL 且深度耦合引擎。`msdia140`、`symsrv` 的分发授权不能由 Windhawk LICENSE 推定。
- 若走宽松许可组合，需自研：DIA/DbgHelp 解析、PDB 身份缓存与启动前离线下载、Wh_* 替代（日志、配置、hooks、初始化/反初始化）、任务栏全部显示路径和恢复事务。缓存不匹配时必须明确降级，不能声称仍零帧。

### 8.4 三种现实组合

**组合 1：Detours 创建 + SlimDetours hook + 全自研任务栏/符号层（宽松许可基线）**

- 复用：创建屏障、inline hook 事务、线程修正、卸载原语。
- 自研：x64 注入器/DLL、Electron IPC、非我方 explorer 启动补偿、PDB 缓存、全部任务栏 hooks、恢复事务、safe mode、首帧验收。
- 优点：MIT 组合，无 copyleft；创建与 hook 职责清楚。
- 成本：任务栏与符号层是主体工作；当前还需补 MSVC/Windows SDK。只对我方创建提供受控挂起。

**组合 2：独立重写 Windhawk 式 APC + SlimDetours**

- 复用：SlimDetours；Detours 保留我方启动的简单路径；Windhawk 只作算法与边界参考，不复制 GPL 实现。
- 自研：`CreateProcessInternalW` 拦截、APC loader、互斥、`RtlUserThreadStart` 判定、父进程覆盖和扫描补偿，以及组合 1 的全部任务栏层。
- 优点：可削减 Windhawk 的会话/存储/WIL 依赖。
- 成本：三种中工程量最大，且仍不能证明所有 explorer 启动首帧零帧。

**组合 3：接受 GPLv3，提取 Windhawk 注入/符号/恢复 + 移植目标 mod**

- 复用最多：APC、扫描补偿、符号缓存、目标任务栏 hooks、safe-mode、崩溃监控、调用栈等待。
- 仍需：裁掉市场与通用 mod 托管、Electron 控制协议、产品 APPBARDATA 恢复、26H2 验证、DIA/symsrv 合法分发。
- 代价：衍生/组合作品需按 GPLv3 提供对应源码；不能把 GPL 组件藏进闭源 DLL，也仍无全启动零帧证明。

### 8.5 卸载与恢复的可复用边界

SlimDetours 可提供 Attach/Detach/Abort 和部分第三方 hook 冲突处理；Windhawk 的 safe-mode、Event Viewer crash monitor、调用栈等待只能作 GPL 参考。以下没有现成完整实现，必须自研：恢复每屏 APPBARDATA 原状态、cloak/expanded/auto-hide/位置/timer、UI 线程停止新事件后恢复并 unhook、等待回调退出再 FreeLibrary、注入器崩溃后的 next-start safe mode、连续崩溃禁用重注入、部分 hook 成功的逆序回滚。

---

## 9. 直接改造 explorer.exe 是否能解决

**结论：理论上能改变更多启动期行为，但不能把它当成已证明方案；直接修改磁盘上的 explorer.exe 不适合作为可维护产品路径。** 三种“改造”必须分开：

| 改造方式 | 能解决什么 | 不能解决/新增代价 |
|---|---|---|
| 运行时内存 patch | 与注入 hook 相同，可在已加载后拦截内部路径 | 不解决 DLL 未及时加载；仍有 26H2 符号和首帧初始化顺序问题 |
| 修改磁盘上的 explorer.exe / taskbar.dll 等 | 若逐构建找对初始化和全部显示路径，可能比我方启动挂起注入更早、更持久 | 需逆向所有路径并逐构建维护；系统文件保护、原签名/更新完整性、Windows 更新覆盖、故障恢复与分发均成为产品责任 |
| 替换整个 shell | 可以不创建原生任务栏，从结构上消除其首帧 | 正常桌面、托盘、文件管理与 Shell 功能被替换，违背本仓面板与正常应用并存的目标 |

Win11 不能只盯 `explorer.exe`：现有 mod 的任务栏实现分布于 `taskbar.dll`、`Taskbar.View.dll` 或 `ExplorerExtensions.dll`、`twinui.pcshell.dll`，只 patch explorer.exe 并不能推出覆盖全部显示路径。

[微软 WRP 文档](https://learn.microsoft.com/en-us/windows/win32/wfp/detecting-file-replacement)说明受保护资源只能经 Windows Modules Installer 支持的替换机制修改，完整修改权限限 TrustedInstaller；普通应用直接修改会被拒绝。2026-10-25 本机经 `SfcIsFileProtected` 直读：

```text
C:/Windows/explorer.exe             protected=true
C:/Windows/System32/Taskbar.dll     protected=true
```

绕过保护、修改系统二进制还会使原始签名与更新完整性不再成立；不能假设 Windows 会长期接受，也不能把 SFC/功能更新恢复原文件视为意外。即使在一台机器上验证成功，也仍需证明所有创建与显示路径、DWM 首帧顺序、更新后兼容及可恢复性。它不是 Q4=B 所指的“自研注入器 + DLL”的简化替代，而是风险更高的另一条系统改造路线。

---

## 10. 替代 Shell 的 GitHub 先例与官方边界

### 10.1 确有完整替代先例，但“替换 UI”不等于“替换 shell”

| 项目 | 真替代 Explorer? | 当前证据、许可证与主要意义 |
|---|---|---|
| [Cairo Desktop](https://github.com/cairoshell/cairoshell) / [`daf6d7c`](https://github.com/cairoshell/cairoshell/commit/daf6d7c6addb6e00a6ad20dea2808cd44ee2b4ff) | **是，亦可并存** | C#/WPF，Apache-2.0，Win10/11；有任务栏、托盘、桌面、热键。最佳完整职责参考，但维护者称 shell mode 仍“janky”，当前更推荐保留 Explorer：[维护者说明](https://github.com/cairoshell/cairoshell/issues/936#issuecomment-3765720140) |
| [ManagedShell](https://github.com/cairoshell/ManagedShell) / [`8552220`](https://github.com/cairoshell/ManagedShell/commit/855222035e927910ca53fd3215caef056337a048) | 原生服务层，不是完整 UI | Apache-2.0；拆分 WindowsTasks、WindowsTray、AppBar、ShellFolders、UWPInterop。可独立初始化任务与托盘服务，是最值得复用/精读的原生侧参考 |
| [Nickel](https://github.com/shortontech/nickel) / [`298f87a`](https://github.com/shortontech/nickel/commit/298f87a74e656889ee1931440727b0afcd14f339) | **是，实验性** | Rust 原生宿主 + JSX/TSX，MIT/Apache-2.0；[`nickel-uwu`](https://github.com/shortontech/nickel/tree/298f87a74e656889ee1931440727b0afcd14f339/crates/nickel-uwu)研究无 Explorer 的 UWP shell contract，但依赖私有 COM、对象布局和 PDB 符号，resize/close 等仍不完整 |
| [GyroShell](https://github.com/Pdawg-bytes/GyroShell) / [`ee3c766`](https://github.com/Pdawg-bytes/GyroShell/commit/ee3c766f194ca6227194e0bdb3c19c37aa10b9bc) | 是，重度开发中 | C#/WinUI 3，BSD-3-Clause；作者明确可能不稳定，完整托盘/AltTab 证据不足 |
| [Shelled](https://github.com/YaddyVirus/shelledCustom) / [`0977840`](https://github.com/YaddyVirus/shelledCustom/commit/097784024fbd48498302b7b995a494b71ae1a5e2) | 实验性 | .NET 8 + WebView2 + HTML/CSS/JS，分层与 AGENT DECK 接近；**无许可证，只能读设计不能默认复制** |
| LiteStep / SharpEnviro / Emerge Desktop / bbLean | **是，历史完整 shell** | 证明任务栏、托盘、桌面、热键可自承担；现代 Win10/11、UWP、通知和系统 flyout 兼容证据不足，不作为新底座推荐 |

[Seelen UI](https://github.com/eythaann/Seelen-UI)不算真正 shell replacement：虽然覆盖任务栏、dock、AltTab、窗口管理和通知，其托盘仍直接寻找并 hook Explorer 的 `Shell_TrayWnd` 线程：[固定源码](https://github.com/eythaann/Seelen-UI/blob/ee71b9665507c41393dc4d95e452deb4581ac080/src/background/modules/system_tray/application/tray_hook_loader.rs)。[RetroBar](https://github.com/dremin/RetroBar)与 Open-Shell 也只是任务栏/开始菜单层；ExplorerPatcher/Windhawk 是 patch/hook，不是独立 shell。

### 10.2 替换原生栏首帧来源 ≠ 获得完整 Windows 桌面

只有真正 shell mode、Explorer 不再作为登录 shell 启动时，才直接消除“Explorer 原生任务栏先画一帧”的来源；Cairo/Seelen 与 Explorer 并存的模式没有这个效果。新 shell 仍需自己承担：

- 任务列表、托盘与通知；
- 桌面、启动器、AltTab/Task View 与热键；
- UWP、Settings、快速设置、输入切换和现代系统 flyout；
- 自己的启动时序与首帧，以及异常恢复。

因此“没有原生任务栏”与“正常桌面应用 + 完整托盘 + UWP/Settings + 零异常首帧”仍是不同验收目标。

### 10.3 官方 Shell Launcher：本机 Pro 不支持

[微软 Shell Launcher 版本矩阵](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/shell-launcher/)明确：Enterprise/Enterprise LTSC、Education、IoT Enterprise 支持，**Pro / Pro Education 不支持**。本机注册表 EditionID=Professional，故不能走微软官方支持的 Shell Launcher，无论 DisplayVersion 为 26H2 与否。

Shell Launcher 本身允许 desktop app 或 UWP 替代 Explorer，并允许启动其他桌面应用；但任务栏、托盘、AltTab、通知等仍由自定义 shell 负责。[Assigned Access](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/)在 Pro 上可用，但它是单应用 kiosk 或受限用户体验，不是任意 Win32/Electron shell replacement 的等价官方通道。`Winlogon\Shell` 能选择登录 shell，不代表 Pro 获得 Shell Launcher 的受支持能力、退出监控或多用户配置。

### 10.4 对 AGENT DECK 的实际参考价值

1. **保留 Explorer、复用知识**：精读 Cairo/RetroBar/ManagedShell 的任务、托盘、AppBar、多显示器与 shell folder 实现；这不能解决 Explorer 原生栏启动帧，但能补强现有面板。
2. **原生侧服务层参考**：ManagedShell 是 Apache-2.0 的 C#/.NET 组件，不是可直接嵌入 Electron renderer 的 JS 库；若采用需另设原生侧车或重写等价逻辑。
3. **隔离研究完整 shell**：Cairo 提供成熟职责清单，Nickel 提供无 Explorer UWP 实验，Shelled 提供相近 Web 分层；当前 Pro 无官方 Shell Launcher，完整替换只能先当技术预研，不能当已验证产品路线。

**用户于 2026-10-25 选择第 3 条作为隔离预研方向**：不改当前系统 shell、不承诺生产转向；预研范围与成功判据另行确认。

---

## 11. 隔离 shell 预研：环境与职责验收矩阵（草案）

### 11.1 已核实的环境约束

- Hyper-V 的 `vmcompute` / `vmms` 服务在运行，但当前账户执行 `Get-VM` 被拒，尚不能枚举或保证可用隔离 VM。
- 本机有 .NET 8.0.32 与 WindowsDesktop 6/7 运行时，**没有 .NET SDK**；Cairo/ManagedShell 构建环境需另备。
- 预研不得修改主系统的 `Winlogon\Shell`、explorer 启动项或系统二进制；Cairo 并存实验自身产生的设置与视图状态须前后记录并恢复，不得用主桌面“试一下 shell mode”代替隔离。
- 原型问题是原生 shell 可行性，不是状态机或视觉稿，因此不生成通用 HTML 原型；任何可执行预研都应是可丢弃、可回滚的隔离环境实验。

### 11.2 职责矩阵

| 验收面 | 必须观测的行为 | 主要参照 |
|---|---|---|
| shell 启动 | Explorer 未作为 shell 启动；无原生栏首帧；新 shell 就绪与异常退出行为 | Cairo shell mode、Nickel |
| 普通桌面应用 | Win32 应用启动、激活、最小化/恢复、关闭、最大化与 Snap | Cairo WindowsTasks、AGENT DECK 现有能力 |
| 窗口切换 | AltTab/Task View 是否存在、是否完整；没有则明确缺口 | Cairo、Nickel、Seelen（仅 UI 参考） |
| 托盘 | 第三方图标注册、左右键、溢出、气球/通知；不得只显示自建探针 | ManagedShell.WindowsTray |
| 桌面与文件 | 壁纸、图标、上下文菜单、文件操作、快捷方式 | Cairo DynamicDesktop、ManagedShell.ShellFolders |
| 系统 UI | Start、Settings/UWP、快速设置、通知中心、输入切换、Win 键族 | Cairo 已知缺口、Nickel UWU |
| 工作区与显示 | AppBar、最大化、Snap、多显示器、DPI、虚拟桌面 | ManagedShell.AppBar、AGENT DECK spec #267 |
| 恢复与逃生 | 退出/崩溃后的 shell 恢复、禁止自动重启循环、回到 Explorer 的路径 | Cairo/Shell Launcher 职责对照 |
| 架构适配 | Electron 现有 UI 与 .NET/Rust 原生服务如何通信；哪些代码真能复用 | ManagedShell、Nickel、Shelled |

预研输出应是逐项证据与缺口，不以“Cairo/Nickel 能启动”作为成功；也不把某个第三方项目的功能声明直接写成 AGENT DECK 已具备。

---

## 12. 第一阶段源码审查：Cairo 与 ManagedShell

审查对象：Cairo [`daf6d7c`](https://github.com/cairoshell/cairoshell/tree/daf6d7c6addb6e00a6ad20dea2808cd44ee2b4ff) 与 ManagedShell [`8552220`](https://github.com/cairoshell/ManagedShell/tree/855222035e927910ca53fd3215caef056337a048)。Cairo 该提交实际引用 NuGet `ManagedShell 0.0.358`，并未锁定上述 ManagedShell commit；以下是两份指定源码的组合分析，不断言二者是同一构建产物。未运行、未验证 26H2 的部分单独标记。

### 12.1 并存与 shell mode 的判定、配置和退出

- Cairo 在创建自有窗口前调用 `SetIsCairoRunningAsShell()`：无现存 shell window 且未指定 NoShell，或显式 Shell 时才认为是 shell；Explorer 已运行时默认并存。[初始化源码](https://github.com/cairoshell/cairoshell/blob/daf6d7c6addb6e00a6ad20dea2808cd44ee2b4ff/Cairo%20Desktop/Cairo%20Desktop/CairoApplicationInitializationService.InitializationRoutines.cs#L33-L50)。第一阶段运行加 `/noshell=true` 防止误判。
- 并存检测本身不写 Winlogon，也不自动设置开机替换。Winlogon setter 只在设置页显式操作；Run at log on 是独立设置。[EnvironmentHelper](https://github.com/cairoshell/ManagedShell/blob/855222035e927910ca53fd3215caef056337a048/src/ManagedShell.Common/Helpers/EnvironmentHelper.cs#L189-L245)、[SettingsUI](https://github.com/cairoshell/cairoshell/blob/daf6d7c6addb6e00a6ad20dea2808cd44ee2b4ff/Cairo%20Desktop/Cairo%20Desktop/SettingsUI.xaml.cs#L851-L894)。
- 安装器的 Run at startup 与 Disable Explorer 都是可选段，后者才写 Winlogon Shell；第一阶段不运行安装器、不进入这两个分支。[CairoShell.nsi](https://github.com/cairoshell/cairoshell/blob/daf6d7c6addb6e00a6ad20dea2808cd44ee2b4ff/Installer/CairoShell.nsi)。
- **并存不等于无接管**：默认 EnableTaskbar 会隐藏 Explorer 任务栏，EnableSysTray 会创建第二个 Shell_TrayWnd 并广播，EnableDesktop 会隐藏 Explorer 桌面图标，EnableMenuBar 会占 AppBar。故第一阶段是“受控接管实验”，且不与 AGENT DECK TrayHost 同时运行。[TaskbarWindowService](https://github.com/cairoshell/cairoshell/blob/daf6d7c6addb6e00a6ad20dea2808cd44ee2b4ff/Cairo%20Desktop/CairoDesktop.Taskbar/Services/TaskbarWindowService.cs#L36-L43)。
- 正常 ExitCairo 会恢复 HideExplorerTaskbar、保存的 ABState、主副栏可见性、AppBar、托盘广播与桌面图标；强杀不保证这些恢复。[ExplorerHelper](https://github.com/cairoshell/ManagedShell/blob/855222035e927910ca53fd3215caef056337a048/src/ManagedShell.AppBar/ExplorerHelper.cs#L125-L153)、[TrayService](https://github.com/cairoshell/ManagedShell/blob/855222035e927910ca53fd3215caef056337a048/src/ManagedShell.WindowsTray/TrayService.cs#L145-L152)。

### 12.2 初始化职责与真实托盘流量

- Tasks 在 TaskbarWindowService 启用时启动；TasksService 创建 ShellHook 消息窗、注册窗口事件、枚举窗口并处理 cloak、显示器和部分 ITaskbarList 消息。[TasksService](https://github.com/cairoshell/ManagedShell/blob/855222035e927910ca53fd3215caef056337a048/src/ManagedShell.WindowsTasks/TasksService.cs#L80-L154)。
- Tray 在 WPF SystemTray 控件首次创建时初始化：导入 Explorer 存量图标、创建 Cairo Shell_TrayWnd/TrayNotifyWnd、广播 TaskbarCreated。[NotificationArea](https://github.com/cairoshell/ManagedShell/blob/855222035e927910ca53fd3215caef056337a048/src/ManagedShell.WindowsTray/NotificationArea.cs#L145-L165)。
- 它确实接收第三方 Shell_NotifyIcon：TrayService 接收 `WM_COPYDATA dwData=1` 并回调；NotificationArea 处理 NIM_ADD/MODIFY/DELETE/SETVERSION、图标、提示、回调与 balloon。[TrayService](https://github.com/cairoshell/ManagedShell/blob/855222035e927910ca53fd3215caef056337a048/src/ManagedShell.WindowsTray/TrayService.cs#L154-L216)。
- AppBar 仍由具体 AppBarWindow 注册；ShellFolders 与 UWPInterop 是按需创建的组件，不是 ShellManager 统一启动的一套无界面服务。

### 12.3 对 AGENT DECK 的适配结论

| 组件 | 可借鉴/复用 | 不应直接复用或仍需自研 |
|---|---|---|
| ManagedShell.Interop | P/Invoke、COM 声明，最适合独立参考 | Electron 仍需 Koffi/原生 addon/DTO 桥 |
| ShellFolders / UWPInterop | Shell 命名空间、AUMID、上下文菜单、虚拟文件夹能力 | 程序集仍启用 WPF，ImageSource 需转像素；COM/STA 生命周期需侧车承接 |
| TrayService + NotificationArea | Explorer 存量导入、真实 NIM、位置查询和转发分工 | Dispatcher/WPF 依赖；现有 JS TrayHost 已处理 NIM，不整包替换 |
| TasksService | 窗口过滤、cloak、任务进度与覆盖图标 | 不是无副作用观察器：SetTaskmanWindow、TaskbandHWND 属性、SetMinimizedMetrics 都改系统状态 |
| AppBar | 多屏、模式与工作区算法 | AppBarWindow 是 WPF Window，不能进 Electron；保留现有状态账 |
| Cairo UI | 数据服务—窗口服务—视图分层 | XAML/WPF/ImageSource 不可进入 Electron renderer |

AGENT DECK 的手钉/推荐/统一应用序列、最大化与分屏会话、唤出条、原生栏恢复账均没有现成 Cairo 等价物，必须保留。若引入 C# 侧车，需要版本化 IPC、窗口句柄标识、图标像素序列化、退出恢复和副作用所有权协议，而不是把 ManagedShell 当成可直接嵌入 renderer 的 JS 库。

---

## 13. 第一阶段主机实测：Cairo 与 Explorer 并存

### 13.1 实验边界

- 使用 GitHub release `v0.4.434` 的 `CairoSetup_64bit.exe`，SHA-256 为 `dc22970c3b80af4298aab1a664f0785fcef906adb0eb897a14d814916d0625c5`，与发布资产公布值一致。
- 安装器只在 `.scratch` 解包，未执行安装器、未选择 Run at startup 或 Disable Explorer；启动参数为 `CairoDesktop.exe /noshell=true`。
- 探针 `.scratch/shell-lab/cairo-coexist-probe.cjs` 经 accept-guard 运行，避免与 AGENT DECK TrayHost 竞争。记录窗口、进程、截图、Explorer、原生任务栏和 `Winlogon\Shell` / `Run\CairoShell` 前后值。
- 实验前本机没有 `Cairo Desktop\settings.json`；实验后该文件与 Logs 已移入 `.scratch/shell-lab/` 留档，未把测试配置留在正常 Cairo 配置位置。

### 13.2 结果

| 检查 | 结果 |
|---|---|
| Cairo 窗口出现 | 通过，并存模式可启动，未改登录 shell |
| Winlogon Shell / Cairo Run | 运行中与退出后均和实验前一致（均不存在） |
| Explorer 进程 | 退出后仍在 |
| 原生任务栏 | 终止 Cairo 后恢复到实验前可见状态，after 截图无 Cairo 窗口 |
| Cairo 进程与窗口 | 第二轮按进程组检查全部消失 |
| AGENT DECK | 实验结束后已从主检出重新拉起 |

**探针纠偏**：首轮只跟踪启动 PID，曾出现“该 PID 已退出但第二 Cairo 进程仍持窗”的假恢复；第二轮改为按 CairoDesktop 进程组与全部窗口判定。第二轮仍记录 `forcedStop=true`——向所有 Cairo 顶层窗发 WM_CLOSE 后未能在 8 秒内退出，最终结束实验进程。故本轮证明的是**终止进程后的恢复**，不是 Cairo 正常 ExitCairo 命令路径的恢复保证。

### 13.3 第一阶段结论

1. **Cairo 可在本机 26H2 与 Explorer 并存运行**，且本次未改变登录 shell 或自启配置；这只是一次受控启动，不扩写为长期兼容。
2. **默认并存也有接管副作用**，与源码一致：Cairo 任务栏、顶部菜单和桌面会替代相应 Explorer 呈现。不能把“并存”理解为只读观察或无影响叠加。
3. **AGENT DECK 不应与 Cairo 同时接管同名任务栏/托盘/AppBar**。若做原生侧车，应复用组件而不是同时启动两个完整 shell UI。
4. **ManagedShell 的主要价值是原生职责与协议参考**，不是替代现有 Electron 产品层的捷径。可复用程度最高的是 Interop、ShellFolders 与部分任务/托盘逻辑；TasksService 和 AppBar 的系统副作用必须另建所有权与恢复账。
5. 第一阶段不回答完整 shell 的 UWP/Settings/AltTab 完整性，也不回答启动首帧。后续若进入该问题，再使用隔离 VM；当前无需为了第一阶段改主系统 shell。

**后续路线选择**：用户明确不把 Windhawk 作为产品依赖，先做 Cairo/ManagedShell 的独立原生服务层预研。下一步验证限定为 C# 侧车 + Electron 的 ShellFolder、图标与原生菜单，不以该选择否定此前零帧问题的未决性。

---

## 14. 最小复制验证：C# 侧车 + Electron（已通过）

### 14.1 原型与构建

原型位于 `.scratch/shell-lab/managed-shell-sidecar.prototype/`，明确为 throwaway，不进入产品代码：

- `Program.cs`：STA 侧车，ManagedShell `0.0.358`，支持 `list`、`menu`、`shutdown` JSONL 命令。
- `main.cjs` / `preload.cjs` / `index.html`：Electron 文件列表、原生窗口句柄与命令转发。
- 隔离工具链：`.scratch/shell-lab/dotnet-sdk` 的 .NET SDK 8.0.426 与独立 NuGet 缓存；未改系统 PATH。
- `dotnet build`：**0 warning / 0 error**；`node --check` 通过。
- 无 GUI JSONL 冒烟：桌面 **40 项、40 张有效 PNG**。

`ShellItemContextMenu` 在 Electron 提供的原生窗口句柄上显示真实 Windows 菜单；WPF 图标经 `PngBitmapEncoder` 转 Base64 PNG，而不是把 ImageSource 跨进程传递。

### 14.2 真机端到端结果

经 accept-guard 运行 `.scratch/shell-lab/run-sidecar-e2e.cjs`：

| 检查 | 结果 |
|---|---|
| Electron 显示 ShellFolder 枚举与 PNG | 通过 |
| Win32 右键出现 `#32768` 原生菜单 | 通过 |
| 点击 Properties 后回传 `menu-invoked` | 通过，`command=properties` |
| 正常 shutdown | 通过，事件完整 |
| 侧车退出 | `code=0` |
| 错误列表、原生菜单残留、侧车进程残留 | 均为空 |

证据：`.scratch/shell-lab/sidecar-e2e-report.json`、`sidecar-prototype-result.json`、`sidecar-list.png`、`sidecar-native-menu.png`、`sidecar-after-command.png`。

**证据边界复核（2026-10-25）**：`menu-invoked command=properties` 只证明进入了菜单命令回调，不证明属性页实际出现或命令执行成功。原型把回调第三参输出为 `isInteractive`，但该版本委托第三参实际是 `allFolders`，故留档中的 `isInteractive:false` 也不能作为交互性证据。上述通过项不包括属性页执行结果。

探针修正不属于产品缺陷：初次用窗口外框计算 DOM 落点，后改 `ClientToScreen`；键盘 End/Enter 未驱动菜单，后改按真实菜单矩形点击 Properties。最终全绿，不放宽判据。

### 14.3 路线结论与未验证项

**独立原生服务层的最小技术路线成立**：C# STA 侧车可以复用 ManagedShell 的 Shell 命名空间与原生菜单，Electron 只接收 DTO、事件与像素，符合“数据服务—原生侧车—Electron UI”的独立产品形态，不依赖 Windhawk。

建议后续仍按能力逐个推进：先扩大 ShellFolders 的只读取数与原生 Shell 菜单的受限命令验证；若进入托盘，必须单宿主交接现有 JS TrayHost，不能让两套托盘同时广播和收编。ManagedShell 为 Apache-2.0，实际复用时需保留版权与许可声明。

本轮未验证托盘、TasksService、AppBar、UWP/Settings、AltTab、登录 shell、启动首帧和长期恢复，也不构成完整 shell 或零帧证明。原型只留 `.scratch`，未改 `app/src`、正式测试或 Git 历史；生产面板已重新拉起。

---

## 15. 第二阶段：ManagedShell 侧车 v2 设计裁决与验证（2026-10-25）

### 15.1 已确认的路线边界

用户经 Q1–Q26 复审确认：暂停自研注入器实施，保留 Explorer 与现有 Electron 任务栏，以 ManagedShell 0.0.358 侧车逐能力验证 Shell 集成；不运行第二套 Cairo 任务栏。稳态与启动期零帧目标均不降低，但仍是独立未决问题，侧车成果不得充抵。

本轮范围是 Desktop、This PC、Recycle Bin、Control Panel 的枚举、图标、原生 Shell 菜单、变更通知、故障恢复与性能对照。AppsFolder/UWP、托盘、TasksService、AppBar、AltTab、完整 shell、生产打包与自启均不在本轮。任何单能力失败按 no-go 记录并保留现有实现，不靠放宽约束换取整线成功。

### 15.2 原型协议与交互契约

- 每个面板实例由 Electron 主进程持有 C# 子进程，采用带版本、请求 id、大小限制与唯一终态的 JSONL stdio；响应与异步事件分离，超时不遗留失控操作。
- 元数据分页，图标按不透明 `shellId` 独立请求；Electron 不解析 `::{GUID}` 或 PIDL，不接收进程内 COM 指针。
- 「原生 Shell 菜单」与现有自绘「上下文菜单」「任务栏弹窗菜单」不混称。本轮不替换现有菜单，不直接 `window.focus()` 抢焦点；如确需临时前台，必须保存、恢复并实测。
- 仅允许显式用户手势触发 `open` / `properties`，其他动词由侧车拒绝。分别记录选择、尝试与可观测结果；无法观测即为 UNKNOWN，不能凭菜单回调记 PASS。
- 受控 scratch 文件夹验证新增、删除、重命名和通知异常；故障矩阵覆盖对象消失、图标失败、崩溃、超时与退出清理。原型唤出的菜单和属性页退出前全部关闭。
- 图标核验实际尺寸、非空像素与 alpha；性能只对同一文件系统对象比较现有 JS/Koffi 与侧车，虚拟对象标 N/A。GUI 一律经 accept-guard，结论仅限本机 26H2 x64。

### 15.3 一手 API 复核

NuGet 官方 catalog 与包内 nuspec 均把 ManagedShell 0.0.358 对应到 commit `b4521b2cbc94a71f74a17ebdf86cd58ba145a331`；包大小与 SHA512 亦和官方目录一致（[NuGet catalog](https://api.nuget.org/v3/catalog0/data/2026.07.30.10.51.55/managedshell.0.0.358.json)、[官方 nuspec](https://api.nuget.org/v3-flatcontainer/managedshell/0.0.358/managedshell.nuspec)）。以下结论固定阅读该上游快照，未做 DLL 反编译等价证明。

- `ShellItem.Path` 是 `SIGDN_DESKTOPABSOLUTEPARSING` 缓存名，`new ShellItem(path)` 可经 `SHCreateItemFromParsingName` 尝试重新解析，但不保证跨重命名/会话永久稳定。v2 的不透明 `shellId` 只在侧车登记身份与解析名之间映射，不传 COM 指针或 PIDL 数值（[ShellItem.cs](https://github.com/cairoshell/ManagedShell/blob/b4521b2cbc94a71f74a17ebdf86cd58ba145a331/src/ManagedShell.ShellFolders/ShellItem.cs)、[SHCreateItemFromParsingName](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-shcreateitemfromparsingname)）。
- `ShellFolder(watchChanges:true)` 在文件系统路径上使用 `FileSystemWatcher`，不是通用 `SHChangeNotifyRegister`；虚拟命名空间不因此获得监听。`Files.CollectionChanged` 不等于有序、无损日志，且库未接 `Error`、没有公开 rescan。v2 只在受控 fixture 上验证，并以独立 overflow/重同步兜底；其他根明确不宣称监听能力（[ShellFolder.cs](https://github.com/cairoshell/ManagedShell/blob/b4521b2cbc94a71f74a17ebdf86cd58ba145a331/src/ManagedShell.ShellFolders/ShellFolder.cs)、[FileSystemWatcher.Error](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher.error?view=net-8.0)）。
- `AllowAsync=false` 是同步图标提取；`ExtraLargeIcon` 对应 48 点乘进程 DPI 缓存，不是每窗口/每显示器动态 DPI。位图实际尺寸仍须逐个核验（[ShellItem.cs](https://github.com/cairoshell/ManagedShell/blob/b4521b2cbc94a71f74a17ebdf86cd58ba145a331/src/ManagedShell.ShellFolders/ShellItem.cs)、[IconHelper.cs](https://github.com/cairoshell/ManagedShell/blob/b4521b2cbc94a71f74a17ebdf86cd58ba145a331/src/ManagedShell.Common/Helpers/IconHelper.cs)）。
- 菜单回调第三参是 `allFolders`；返回 `true` 抑制库的 `InvokeCommand`，`false` 继续执行。包装丢弃原生 `InvokeCommand` 的 HRESULT，故 v2 在回调前拦截非白名单动词，同时要求独立可观测效果，不拿 `menu-invoked` 当成功（[ShellItemContextMenu.cs](https://github.com/cairoshell/ManagedShell/blob/b4521b2cbc94a71f74a17ebdf86cd58ba145a331/src/ManagedShell.ShellFolders/ShellItemContextMenu.cs)、[IContextMenu.InvokeCommand](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-icontextmenu-invokecommand)）。
- 所查枚举、图标、监听和菜单 API 均无请求级取消。超时终止专用侧车并建立新代次只是隔离兜底，不撤销已经发生的 `open/properties` 副作用，也不保证外部窗口同步消失；必须另查进程与窗口事实（[ComTaskScheduler.cs](https://github.com/cairoshell/ManagedShell/blob/b4521b2cbc94a71f74a17ebdf86cd58ba145a331/src/ManagedShell.Interop/ComTaskScheduler.cs)、[TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)）。

### 15.4 v2 核心矩阵实测

新原型位于 `.scratch/shell-lab/managed-shell-sidecar.prototype-v2/`，驱动为 `run-sidecar-v2.cjs --core`。最新一轮 `.scratch/shell-lab/sidecar-v2-core-report.json` 为 **PASS**，全部经真实 C# STA 侧车与受控 fixture，不启动 Cairo、托盘或 AppBar：

- 协议：版本/畸形 JSON/超 1 MiB/未知命令/重复 id 均按预期拒绝；ping 与唯一终态正常。
- 分页与身份：当轮 Desktop 40 项、This PC 5 项、Recycle Bin 665 项、Control Panel 9 项均遍历至末页；未登记 id 与列取后消失的对象均被拒绝。页数与条目数随实时快照变化，报告只作当轮事实。
- 图标：四个根各取首项，均为 48×48 PNG，当前 `dpiScale=1`；像素级对照另属 GUI/性能段。
- 监听：受控新增、删除、重命名与 40 项事件风暴后快照收敛，记录 76 条本地序号事件；显式重同步和退订通过。该轮未观察到 overflow，不能据此宣称溢出注入已覆盖。
- 恢复：忙时 kill 后重启、超时后终止并重启均通过；连续两次重启后触发上限，最终 pending=0。

### 15.5 GUI、交互与性能实测

最终总轮 `run-sidecar-v2.cjs` 为主机 26H2 x64 上的 **PASS**：C# 构建 0 warning/0 error；core 报告 protocol/enumeration/icons/watch/recovery 全 PASS；GUI 报告 menu/recovery/performance 全 PASS。证据：`.scratch/shell-lab/sidecar-v2-core-report.json`、`sidecar-v2-gui-report.json`、`sidecar-v2-summary.json`、`sidecar-v2-*.png`。

已验证的用户可见行为：

- 原生 Shell 菜单可打开；owner 临时激活并读回成功，取消后原前台 HWND 恢复，原型主窗随后恢复不可聚焦。直接激活菜单窗、`window.focus()` 前置焦点、菜单外点击/Esc 都不是可靠取消路径；本轮取消由主进程发 `close-native-ui` 控制命令、侧车 STA 同线程 `EndMenu()` 完成。**用户自行按 Esc/点菜单外取消仍是未通过/未宣称项**，不能把控制关闭冒充该交互。
- `open` 通过真实菜单首项执行受控 `.cmd`，产生独立 marker 文件；新应用随后取得前台被记为预期启动效果，不算菜单焦点泄漏。`properties` 观察到真实 `#32770` 属性窗并关闭。拒绝项在菜单尾部定位真实 `Delete`，侧车回调阻断，文件保留。
- 菜单打开时杀侧车：菜单消失，下一次 list 建新代次并返回 fixture 项，渲染层清空旧 DOM 后重渲染成功。菜单打开时关闭 Electron 两扇窗：应用、菜单与侧车均退出，无原型进程/菜单/已跟踪对话框残留。

性能与像素边界：

- 侧车列取当轮 40 项，现有 JS 基线只扫用户/公共桌面 18 项；**对象集不相等，枚举耗时不是同口径性能结论**。侧车列取 median 41.3ms / p95 264.8ms；基线 median 9.5ms / p95 29.7ms，仅作原始参考。
- 图标抽查 16 个文件系统对象：5 个双方均为 48×48，可逐像素比较（1 个全等，其余平均通道差 ≤0.11、变化像素 ≤7.3%）；11 个基线返回 32×32 而侧车为 48×48，标为不可比。所有侧车图标均为非空、有 alpha 像素。
- 工作集/私有内存：Electron 主进程约 146.5MB / 62.7MB，侧车约 84.8MB / 25.0MB；共享宿主下不是隔离基线进程对照。本轮不设毫秒阈值，不据此宣称性能优劣。
- 清理事实：`electronRunning=false`、原型菜单残留 0、已跟踪对话框残留 0；生产面板实验后从主检出恢复。未改 `app/src`、正式验收电池或 Git 历史。
- 仍保持 UNKNOWN/未验证：用户 Esc/点外取消、菜单辅助键盘导航、非 100% DPI、多屏、ARM64、其他 Windows 版本、登录 shell、启动首帧与长期恢复。结论只限本机本轮原型。
