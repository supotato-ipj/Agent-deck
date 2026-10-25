# 调研：Windows 11 任务栏完全隐藏（非自动隐藏）的可行路径

- 日期：2026-10-23
- 范围：Win11 23H2 / 24H2 / 25H2；官方手段、编程手段、第三方开源工具、可靠性
- 只查事实，不做产品决策。对本仓 Electron 常驻面板场景的适用性评估单列一节。

## 验证口径

- **[文档]** = Microsoft Learn / microsoft.com 官方文档。
- **[源码]** = GitHub 仓库 README / 源码 / issue，一手。
- **[实测-他人]** = 工具作者在 README/issue 中报告的行为（非本机实测）。
- **[推断]** = 由上述推出但无直接文字依据的判断，逐条标注。

未能本机实测；所有 Win11 行为论断均钉到具体来源与版本。

---

## 0. 结论速览

**没有"完美官方方案"。** 微软面向普通桌面的唯一官方开关是「自动隐藏」（边缘悬停即唤出，且触发通知时可能闪出），不满足"完全隐藏"。官方能彻底消灭任务栏的只有 **Assigned Access kiosk / Shell Launcher**（替换整个 shell），代价是失去正常桌面。普通桌面上的实际可行解是**编程手段**：`ShowWindow(SW_HIDE)` 作用于 `Shell_TrayWnd` / `Shell_SecondaryTrayWnd` 窗口——**该类名在 Win11 XAML 重写后依然是任务栏外层容器窗口的类名，至今（24H2/25H2）有效**——配合 `SHAppBarMessage(ABM_SETSTATE, ABS_AUTOHIDE)` 消除工作区占用与重唤出，再加看门狗应对 explorer 重启。

### 推荐方案矩阵

| 方案 | 类型 | 完全隐藏? | Win11 23H2–25H2 现状 | 侵入性/风险 | 来源 |
|---|---|---|---|---|---|
| 设置→任务栏行为→自动隐藏 | 官方设置 | 否（悬停/Win 键唤出） | 有效 | 无 | [文档](https://learn.microsoft.com/en-us/answers/questions/1161409/taskbar-auto-hide-is-enabled) |
| 注册表 `StuckRects3` 的 `Settings` 二进制位 | 官方等效 | 否（同上，就是自动隐藏的持久化） | 有效 | 无 | [实测-他人](https://www.elevenforum.com/t/enable-or-disable-automatically-hide-taskbar-in-windows-11.414/) |
| 组策略 | 官方 | **无此策略**（只有锁定/钉选类） | — | — | [推断：GP 全集无对应项；官方功能表仅列"Taskbar pins and ordering can be controlled"](https://www.microsoft.com/en-us/windows/windows-11-specifications) |
| Tablet mode | 官方 | — | **Win11 已移除**（"Tablet Mode is removed"） | — | [文档](https://www.microsoft.com/en-us/windows/windows-11-specifications) |
| Assigned Access kiosk / Shell Launcher | 官方 | **是**（无 explorer shell 即无任务栏） | 有效，Win11 全版本（Home 除外） | 替换整个 shell，非普通桌面方案 | [文档](https://learn.microsoft.com/en-us/windows/configuration/assigned-access/overview) |
| 杀掉 explorer.exe | 土法 | 是（连桌面/托盘/Win 快捷键一起没） | 有效 | 副作用大，见 §1.4 | [推断+Q&A 佐证](https://learn.microsoft.com/en-us/answers/questions/5576492/how-can-we-enable-full-windows-desktop-access-from) |
| `ShowWindow(SW_HIDE)` on `Shell_TrayWnd` + `ABM_SETSTATE(ABS_AUTOHIDE)` | 编程 | **是**（按需，可逆） | **有效**，2026-10 仍在维护的工具同款实现 | 低；需处理 explorer 重启重挂、多显示器 | [源码](https://github.com/amnweb/thide) |
| 仅 `ABM_SETSTATE(ABS_AUTOHIDE)` | 编程 | 否（=自动隐藏） | 有效 | 无 | [文档](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shappbarmessage) |
| Windhawk mods（注入 explorer） | 第三方 | 条件隐藏（桌面无窗口时/最大化时） | 有效，活跃维护 | 注入 explorer，功能更新有打断史 | [源码](https://github.com/ramensoftware/windhawk-mods) |
| thide / HideTaskbar 等现成工具 | 第三方 | **是** | 有效，2026 年仍在更新 | 低 | [源码](https://github.com/amnweb/thide)、[源码](https://github.com/sinjs/HideTaskbar) |
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
- 但**外层 Win32 容器窗口的类名仍是 `Shell_TrayWnd`（主屏）/ `Shell_SecondaryTrayWnd`（副屏）**，XAML 内容宿主在其中。直接证据：[thide 源码（2026 年活跃）](https://github.com/amnweb/thide/blob/main/src/main.rs) 用 `FindWindowExW` 枚举这两个类名并对句柄 `ShowWindow(SW_HIDE/SW_SHOW)`，README 明写支持 Win10/11；[sinjs/HideTaskbar](https://github.com/sinjs/HideTaskbar)（2026-10 更新）同款思路；Windhawk mod [hide-taskbar-only-on-desktop v8.1.8](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/hide-taskbar-only-on-desktop.wh.cpp) 亦在 Win11 上按显示器隐藏任务栏窗口。
- 老工具失效的部分是**样式/内部子窗口类名**（Win10 的 `TrayNotifyWnd`/`ReBarWindow32` 等内部结构变了），不是外层容器窗口。凡只操作外层 HWND 可见性的手段（SW_HIDE）不受影响；凡依赖内部结构的手段（改颜色、改尺寸、找特定子控件）在重写后需要按 XAML 重做——这就是 TranslucentTB 等工具"失效又修复"的由来（[issue #1368：insider build 26340 改了任务栏 XAML 结构导致句柄探测失败，2026-10](https://github.com/TranslucentTB/TranslucentTB/issues/1368)）。

### 2.2 `ShowWindow(SW_HIDE)` —— 核心手段

对两个类名的所有句柄 `ShowWindow(SW_HIDE)`，任务栏即消失、不响应悬停。要点：

- **多显示器**：副屏任务栏是 `Shell_SecondaryTrayWnd`，且每个副屏一个实例，需枚举全部（thide 的做法：循环 `FindWindowExW` 取所有，且校验属主进程是 explorer.exe）。
- **工作区（work area）**：仅 SW_HIDE 不一定释放任务栏占用的工作区，最大化窗口可能仍空出底条 [推断]。thide 的组合是**同时** `SHAppBarMessage(ABM_SETSTATE)` 强制 `ABS_AUTOHIDE`——auto-hide 状态下工作区为全屏，窗口本体又被 SW_HIDE，悬停唤出由不可见兜底（[thide 源码 TaskbarStateManager](https://github.com/amnweb/thide/blob/main/src/main.rs)）。
- **副作用权衡**：带 `ABS_AUTOHIDE` 时按 Win 键仍会唤出（不可见的）任务栏区域行为由 explorer 管；不带则最大化窗口可能留空条。Windhawk mod hide-taskbar-only-on-desktop 的 README 列出了它处理的键盘交互（Win+T/B）、悬停唤出等边界，说明完全静默需要逐条堵。[推断：对本仓"面板取代任务栏功能"场景，Win 键唤出开始菜单时任务栏短暂闪现可接受或需看门狗再压]
- **可逆性**：退出时 `SW_SHOW` + 恢复原 AppBar state（thide 用 RAII Drop 恢复）。

### 2.3 `SHAppBarMessage` / AppBar 消息

[官方文档](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-shappbarmessage)：`ABM_SETSTATE` 只能设置 `ABS_AUTOHIDE` / `ABS_ALWAYSONTOP` 组合——即**只能达到自动隐藏**，无"完全隐藏"语义。`ABM_REMOVE` 是给自注册 appbar 注销用的，发给任务栏自身不会移除任务栏。所以 AppBar 消息单独不够，价值在于配合 SW_HIDE 调整状态与工作区（见上）。

### 2.4 注入手段（Windhawk 模式）

Windhawk（[主仓 9.5k stars，2026-10 活跃](https://github.com/ramensoftware/windhawk)）向 explorer.exe 注入 mod。与"完全隐藏"相关的 mod 都是**条件隐藏**而非彻底隐藏：[taskbar-auto-hide-when-maximized v1.2.6（m417z）](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/taskbar-auto-hide-when-maximized.wh.cpp)（有窗口最大化/相交时才自动隐藏）；[hide-taskbar-only-on-desktop v8.1.8](https://github.com/ramensoftware/windhawk-mods/blob/main/mods/hide-taskbar-only-on-desktop.wh.cpp)（显示器只剩桌面/无边框全屏时隐藏，含任务栏重建恢复、多显示器独立处理、键盘唤出处理——其 README 是研究隐藏边界条件的最佳清单）。注入路线能力强但脆：依赖 explorer 内部符号/XAML 结构，功能更新打断史明确（见 §4）。

---

## 3. 第三方开源工具核查

| 工具 | Stars | 最近维护（2026-10-23 时点） | 原理 | Win11 支持 | 判断 |
|---|---|---|---|---|---|
| [amnweb/thide](https://github.com/amnweb/thide) | 136 | 2026-07 push，release v0.1.3 | SW_HIDE + ABM_SETSTATE(ABS_AUTOHIDE)，枚举主/副屏，托盘+CLI，退出恢复 | 明写 Win10/11，x64+ARM64 | **当前最对口的现成实现**，可直接读源码借鉴 |
| [sinjs/HideTaskbar](https://github.com/sinjs/HideTaskbar) | 18 | 2026-10 更新 | 纯 SW_HIDE，每秒重挂（对抗 explorer 重建） | 是 | 极简参考实现；README 直言"no native way to hide the taskbar completely" |
| [Lonely-Atom/HideTaskbar](https://github.com/Lonely-Atom/HideTaskbar) | 69 | 2026-10 更新 | 隐藏任务栏/托盘/桌面图标，快捷键切换 | 是（中文用户向） | 可用，注意其把托盘也藏了 |
| [TranslucentTB](https://github.com/TranslucentTB/TranslucentTB) | 20.6k | 2026-10 push，release 2026.2 | 改任务栏外观为全透明 | 是 | **透明≠隐藏**：仍占位、仍可点击、悬停区仍在；只能作辅助 |
| [ExplorerPatcher](https://github.com/valinet/ExplorerPatcher) | 34.1k | 2026-06 release 26100.8457.70.3 | 替换/恢复 Win10 任务栏（ep_taskbar）等大量 shell 改动 | 是（紧跟 24H2/25H2 build 号发版） | 非隐藏工具；装上后 Win10 时代技巧复活，但对本仓是大炮打蚊子且风险高 |
| Windhawk + mods | 9.5k（主仓） | 2026-10 活跃 | 注入 explorer，条件隐藏 | 是 | 条件隐藏不满足"常驻完全隐藏"；可作为边界处理参考 |
| [PowerToys #47260](https://github.com/microsoft/PowerToys/issues/47260) | — | OPEN（2026-04） | — | — | 微软官方无此能力，佐证 §1.2 |

已废弃/不推荐：一堆 2022–2024 年停更的 `HideTaskbar` 同名小仓（hanssens、JoeWolski、qubits-us 等，gh search 结果），实现仍是 SW_HIDE 思路但无人维护；直接读 thide/sinjs 源码即可。

---

## 4. 可靠性分析

- **多显示器**：副屏任务栏为独立 `Shell_SecondaryTrayWnd` 实例，必须枚举全部（thide 已示范）；显示器热插拔会重建对应任务栏窗口，需重挂。
- **explorer 重启/崩溃**：任务栏窗口被销毁重建，SW_HIDE 状态丢失。对策：看门狗轮询重挂（sinjs：每 1s；Windhawk mod：检测 recreation 恢复）。这是此类工具的标配，不是可选。
- **焦点/全屏/其他 AppBar**：SW_HIDE 后任务栏不占输入焦点，全屏应用无冲突；`ABS_AUTOHIDE` 组合下 Win 键等键盘唤出仍由 explorer 响应（可能使任务栏短暂可见），需按场景决定是否再加键盘拦截或接受闪现。其他 appbar（如面板自身若注册 appbar）按系统工作区分配共存，无冲突。
- **系统更新打断**：SW_HIDE 只依赖外层窗口类名——该类名从 Win95 至今未变，是**最稳**的挂钩点；依赖 XAML 内部结构/XAML 岛句柄的手段会被 insider/功能更新打断（TranslucentTB #1368，build 26340，2026-10）。风险排序：SW_HIDE ≪ Windhawk 注入 ≈ TranslucentTB 样式探测 ≪ ExplorerPatcher（深度替换 shell，每次大版本都要追）。
- **权限**：操作其他进程窗口的可见性不需要提权（同完整性级别、同会话桌面即可）；explorer 与用户同级，面板进程直接可调。

---

## 5. 对本仓 Electron 常驻面板场景的适用性评估

面板目标：任务栏完全不可见，面板自绘承载桌面项、保留托盘与快捷键能力。

- **推荐主路径：面板内建任务栏隐藏模块**（不依赖第三方常驻工具）：
  1. 枚举 `Shell_TrayWnd` + 全部 `Shell_SecondaryTrayWnd`（校验属主为 explorer.exe）→ `ShowWindow(SW_HIDE)`；
  2. `SHAppBarMessage(ABM_GETSTATE)` 记录原状态 → `ABM_SETSTATE` 置 `ABS_AUTOHIDE`（释放工作区）；
  3. 1–2s 看门狗：检测任务栏窗口重建（句柄失效/可见性翻转）→ 重挂；
  4. 面板退出时 `SW_SHOW` + 恢复原 AppBar state（thide 的 RAII 模式）。
  全部 API 经 koffi 可调（本仓已有 koffi，ADR-0005 口径），无需新依赖。实现蓝本 = thide `src/main.rs`（Rust 版，逻辑可直译）。
- **辅助选项**：若嫌底缘仍有 1px/闪现，可叠加 TranslucentTB 式透明作为视觉兜底；但 TranslucentTB 单独不构成隐藏。
- **明确排除**：Assigned Access/Shell Launcher（替换 shell，面板需要正常桌面共存）；杀 explorer（丢托盘与 Win 快捷键）；ExplorerPatcher/Windhawk 注入（对本目标是过大攻击面与维护负担，只作边界条件参考——尤其 hide-taskbar-only-on-desktop README 列的唤出路径清单）。
- **遗留不确定点** [推断]：① 纯 SW_HIDE 不置 ABS_AUTOHIDE 时最大化窗口是否空出底条，需真机验证（accept 电池可加一段断言 work area）；② Win 键唤出时任务栏是否短暂闪现，同样建议真机验收确认。
