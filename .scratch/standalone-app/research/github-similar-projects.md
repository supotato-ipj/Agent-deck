# GitHub 同类项目调研 — AGENT DECK 桌面作战面板

- **调研日期**:2026-09-27(所有 star 数与活跃度均为该日从 GitHub 页面/API 读到,标"约")
- **调研范围**:在 GitHub 上寻找与本面板同类或机制相近的开源项目,评估可借鉴点与差异化
- **项目定位一句话**:独立于 Wallpaper Engine 的常驻桌面应用(Electron + cordis),浮于壁纸之上、图标层之下,以卡片呈现多 AI 工具会话/任务状态,并自绘承载桌面项(应用区 dock + 文档区)

本项目五条核心能力(下表"覆盖能力"列用编号引用):

1. 透明常驻窗体,壁纸之上、图标层之下,低 z-order 不抢焦点
2. 局部点击穿透
3. 多 AI 工具会话/任务状态卡片 + 本地数据服务
4. 桌面项承载(扫描归集、分区、dock、使用频次排位)
5. 搜索/设置浮层、插件化组件体系

---

## 结论先行(TLDR)

1. **最接近的"精神同类"是 agent 编排面板**(Vibe Kanban、Crystal、Conductor),但它们全是"普通窗口里的面板",**没有任何一家做"长在桌面上、与壁纸和图标共处"的常驻 HUD**。且 Vibe Kanban 已宣布 sunsetting、Crystal 已弃用——赛道热、形态空缺。
2. **"透明 + 穿透 + 常驻不抢焦点"这条路已被桌宠生态走熟**:BongoCat(23.6k★)、petdex(4.2k★)可作工单 01/03 的机制参照;petdex 用本地 hooks server(127.0.0.1:7777)接 agent 事件再映射状态,与本项目数据服务的会话采集**同构**,其"事件→状态"映射可借鉴为状态机设计。
3. **DeskBox(5.5k★,活跃)是与工单 05/06 重叠度最高的项目**:desktop-layer widget 挂载、等 Explorer 桌面图标宿主稳定后再附着、多显示器拓扑布局恢复、Everything IPC 搜索——全部是可抄的成熟思路。注意其 **GPL-3.0 许可**:思路可借鉴,代码不可拷。
4. **"留在 WE 生态"只有 web wallpaper + 本地 websocket 这条野路子**(CEF 容器、无 API 契约、窗口能力为零),旁证是 Rainmeter→WE 桥接讨论串与 Live-Lyrics 实例;独立引擎路线(Lively/Rainmeter/Übersicht)则证明"自绘桌面层"可行但都未做 agent 状态。**支持 ADR-0004 选独立 app。**
5. **真空白(差异化)**:"桌面层常驻 + agent 会话状态 + 桌面项承载"三者合一无人做。唯一的"桌面实体面板显示 agent 状态"是 Clawdmeter(ESP32 硬件屏,2.2k★)——说明需求真实存在,但大家都绕道硬件或浏览器,没人站上桌面层。

---

## A. 直接同类:AI coding agent 状态/任务面板

### [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)
- **定位**:看板式编排/审查 Claude Code、Codex 等 10+ 编码代理
- **技术栈**:Rust 后端 + TS/React 前端,pnpm monorepo,`npx vibe-kanban` 本地 web 应用 + Docker 自托管,Apache-2.0
- **活跃度**:约 28.2k★;README 顶部宣布 **sunsetting(停止维护)**(2026-09-27 查证)
- **重叠点**:多 agent 会话状态总览、任务看板(覆盖能力 3 的"多工具会话"理念)
- **可借鉴**:git worktree 工作区模型;每 agent 分支 + 终端 + dev server 的工作区抽象;diff 审查回传 agent 的交互设计
- **差异**:浏览器窗口形态,无桌面层能力;面向"编排 agent 干活",不做常驻 HUD

### [stravu/crystal](https://github.com/stravu/crystal)
- **定位**:Electron 桌面应用,并行运行/管理多个 Codex 与 Claude Code 会话
- **技术栈**:Electron + TypeScript,pnpm workspace
- **活跃度**:约 3.1k★;**2026-02 弃用**,更名为 Nimbalyst(2026-09-27 查证)
- **重叠点**:多会话并行管理 UI(能力 3)
- **可借鉴**:git worktree 并行会话隔离;会话状态追踪 UI
- **差异**:常规窗口应用;无桌面承载

### [Conductor](https://conductor.build/)(非开源)
- **定位**:Mac 上并行运行 Claude Code/Codex/Cursor,隔离工作区 + 进度总览 + 审查合并
- **技术栈**:macOS 原生应用;官网无源码链接,未见开源声明(2026-09-27 查证)
- **重叠点**:多 agent 进度总览(能力 3)
- **可借鉴**:产品形态参照(它证明了"一眼看多 agent 进度"是刚需)
- **差异**:仅 macOS、闭源、窗口应用

### [xiufengsun/TokenTracker](https://github.com/xiufengsun/TokenTracker)
- **定位**:本地优先的 AI token 用量/成本追踪,支持 31 种编码工具(Claude Code、Codex、Cursor 等),不读提示词
- **技术栈**:JavaScript,本地应用
- **活跃度**:约 1.7k★,最近推送 2026-09-26(2026-09-27 查证)
- **重叠点**:多工具统一会话/用量数据模型(对应仓库 ADR-0003"多工具统一会话模型"的同类实践)
- **可借鉴**:31 种工具的统一采集面;"不读提示词"的隐私边界设定(与我们"使用日志只存进程路径+时间戳、不含窗口标题"同款思路)
- **差异**:纯用量统计,无桌面层、无任务状态

### [HermannBjorgvin/Clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter)
- **定位**:ESP32 硬件桌面小屏,显示 Claude Code 用量
- **技术栈**:C(ESP32 固件)
- **活跃度**:约 2.2k★,最近推送 2026-09-25(2026-09-27 查证)
- **重叠点**:把 agent 状态放到"桌面实体"上——与本面板"放到桌面层上"动机同源
- **可借鉴**:佐证需求真实存在;硬件驱动刷新的状态口径设计
- **差异**:硬件方案,软件面无参考价值

> 另见:[phuryn/claude-usage](https://github.com/phuryn/claude-usage)(约 2.2k★,本地 token 仪表盘,2026-07 后放缓)、[realiti4/claude-swap](https://github.com/realiti4/claude-swap)(约 2.8k★,多账号切换 + 用量面板 + 并行会话)、[Leanmcp/superview.sh](https://github.com/Leanmcp/superview.sh)(约 2.1k★,Claude Code 日志仪表盘)。均为浏览器/终端形态,不展开。

## B. 机制同类:透明 + 穿透 + 常驻覆盖层 / 桌宠

### [ayangweb/BongoCat](https://github.com/ayangweb/BongoCat)
- **定位**:跨平台互动桌宠(按键联动猫爪),覆盖层常驻
- **技术栈**:Tauri + Vue,Windows/macOS/Linux
- **活跃度**:约 23.6k★,最近推送 2026-09-27 当日(2026-09-27 查证)
- **重叠点**:能力 1 + 2 的完整实践(透明无边框、置顶、穿透)
- **可借鉴**:透明窗口 + `setIgnoreMouseEvents(true, {forward:true})` 局部穿透的成熟配置;托盘常驻、开机自启的产品化处理
- **差异**:装饰性桌宠,无信息面板

### [crafter-station/petdex](https://github.com/crafter-station/petdex)
- **定位**:面向 Codex/Claude Code/Hermes/OpenCode 等工具的动画桌宠画廊 + 桌面浮宠 app,**宠物实时反应编码 agent 状态**
- **技术栈**:TypeScript;桌面端为 Native SDK app + 进程内 Zig hooks server(监听 `127.0.0.1:7777`),当前 release 路径无 WebView/Node sidecar(legacy 有 Tauri Windows 实现);MIT
- **活跃度**:约 4.2k★,最近推送 2026-09-21(2026-09-27 查证)
- **重叠点**:能力 3 的数据接法与"agent 事件 → 桌面可视化"理念完全同构
- **可借鉴**:本地 hooks server 接各工具事件的采集架构(与本项目数据服务对照);agent 事件映射到 9 个动画状态(idle/running/waiting/failed/review 等)——可直接借鉴为**会话状态机**口径
- **差异**:宠物动画表达,无信息密度、无桌面承载

### [MingfengHong/petpack](https://github.com/MingfengHong/petpack)
- **定位**:把 Codex/Petdex 宠物包变成不依赖 Codex 的独立桌宠应用
- **技术栈**:Rust
- **活跃度**:约 64★,2026-07 前后(2026-09-27 查证)
- **参考价值**:低量级但思路对口——"把挂在别家宿主上的东西抽成独立 app",与本项目"退役 WE 壁纸、转独立应用"是同一动作
- **差异**:功能单一

> 机制通用参照:Electron 官方 [BrowserWindow 文档](https://www.electronjs.org/docs/latest/api/browser-window)(`transparent`/`alwaysOnTop`/`focusable`/`setIgnoreMouseEvents`);社区已知坑:Wayland 下穿透与 z 序支持残缺(本项目仅目标 Windows,风险隔离)。另 [devnomad-byte/petdex-cc](https://github.com/devnomad-byte/petdex-cc)(18★)为 petdex 生态里单做 Claude Code 的早期件,量级小不展开。

## C. 平台同类:桌面 widget 平台与数据驱动壁纸

### [rocksdanister/lively](https://github.com/rocksdanister/lively)
- **定位**:免费开源动态壁纸/屏保引擎(WE 的开源替代)
- **技术栈**:C# / WinUI 3,Windows
- **活跃度**:约 19.7k★,最近推送 2026-09-26(2026-09-27 查证)
- **重叠点**:壁纸层绘制 + 向壁纸脚本暴露本地 API(硬件遥测、音频、系统事件)
- **可借鉴**:其壁纸进程隔离与"壁纸脚本拿系统数据"的 API 面设计
- **差异**:壁纸只读不可交互,不能承载卡片/桌面项——恰是本项目的出发点

### [rainmeter/rainmeter](https://github.com/rainmeter/rainmeter)
- **定位**:Windows 桌面定制平台(皮肤化 widget)
- **技术栈**:C++,Windows
- **活跃度**:约 6.0k★,最近推送 2026-09-25(2026-09-27 查证)
- **重叠点**:桌面常驻信息皮肤(时钟/监控/会话类皮肤大量存在)
- **可借鉴**:皮肤与数据源解耦的 measure/skin 模型(对应本项目插件体系,能力 5)
- **差异**:专有皮肤格式(非 web 技术)、无 agent 生态、自绘桌面项能力缺失

### [felixhageloh/uebersicht](https://github.com/felixhageloh/uebersicht)
- **定位**:macOS 桌面 HTML5 widget 平台(widget 直接长在桌面层)
- **技术栈**:Objective-C + WebKit,macOS
- **活跃度**:约 5.0k★,最近推送 2025-06(半停滞,2026-09-27 查证)
- **重叠点**:**形态上最接近本项目**(HTML widget 直接渲染在桌面层,不吃窗口层级)
- **可借鉴**:widget 加载/热插拔模型;桌面层注入实现
- **差异**:仅 macOS;无 Windows 实现,需自行解决 Windows 的 z 序与穿透(即本项目 spike01 探过的问题)

### [am1dreaming/Live-Lyrics-for-Wallpaper-Engine](https://github.com/am1dreaming/Live-Lyrics-for-Wallpaper-Engine)
- **定位**:Spotify 逐词歌词同步到 Wallpaper Engine 网页壁纸
- **技术栈**:JavaScript(WE web 类型壁纸)
- **活跃度**:约 20★,最近推送 2026-09-16(2026-09-27 查证)
- **重叠点**:外部数据 → WE 网页壁纸的"野路子"实例(本地程序喂数据,壁纸内连 websocket)
- **可借鉴**:佐证"留在 WE 生态"技术路径存在但天花板明显:CEF 容器、无交互、无窗口控制、无 API 契约
- **差异**:单功能玩具级;参见 [WE 官方 web 壁纸文档](https://docs.wallpaperengine.io/en/web/web.html)(`window.wallpaperPropertyListener`)与 [Rainmeter→WE websocket 桥讨论串](https://steamcommunity.com/app/431960/discussions/1/2741975115072757676)

## D. 承载同类:桌面图标整理 / 分区 / dock

### [Tianyu199509/DeskBox](https://github.com/Tianyu199509/DeskBox) ⭐ 重点参照
- **定位**:免费开源 Windows 桌面整理器,WinUI 3 质感的桌面 widget
- **技术栈**:C# / WinUI 3 + .NET 10 Native AOT + Rust 原生外壳层,Windows 10/11,GPL-3.0
- **活跃度**:约 5.5k★,1.4.9 稳定 / 1.5.0 进行中,最近推送 2026-09-26;单人开发、不收 PR(2026-09-27 查证)
- **机制要点**:widget 覆盖在既有桌面之上、以真实文件夹为后盾;**不接管 Explorer、不移动真实桌面图标**,可先按类别预览再落盘;启动时**等待 Explorer 桌面图标宿主稳定后再挂载 desktop-layer widget**;Quick Reveal 临时抬高被遮挡 widget;多显示器按拓扑恢复布局;搜索走 Everything IPC;规则整理 + 拖放 + QuickLook + 胶囊/堆叠模式
- **重叠点**:能力 4(桌面项承载)+ 能力 1(桌面层挂载)大面积重叠;其"宿主稳定后附着""多显示器拓扑恢复"与本项目 wind-restore(窗口恢复)直接同题
- **可借鉴**:Explorer 宿主稳定等待策略;显示器拓扑/DPI 变化下的布局恢复;Everything IPC 搜索桥(工单 07 可参考);按类别规则整理(工单 06 的"归类")
- **差异**:无 agent/会话概念;不做使用频次推荐排位;**GPL-3.0——只能借鉴思路,禁止拷代码**

### [Ross-Patterson/Portals-Desktop-Organization](https://github.com/Ross-Patterson/Portals-Desktop-Organization)
- **定位**:免费轻量的 Windows 桌面整理工具(Fences 替代),"portal"= 桌面上显示文件夹内容的窗口
- **技术栈**:仓库约 321KB、无主语言——**主要托管 issues/讨论/更新清单,应用本体未开源**(2026-09-27 查证)
- **活跃度**:约 445★,最近推送 2026-08
- **重叠点**:能力 4 的"文件夹为后盾的分区"
- **可借鉴**:portal 可放磁盘任意位置(不限于桌面)的路径抽象;已知坑:多 portal 时启动慢、偶发闪烁(其 issue 区)——本项目自绘桌面项时要防同款问题
- **差异**:闭源,仅能看 issue 学坑

### [Xstoudi/Palisades](https://github.com/Xstoudi/Palisades)
- **定位**:开源免费的 Stardock Fences 替代
- **技术栈**:C#,Windows
- **活跃度**:约 74★,**2022-07 后归档停更**(2026-09-27 查证)
- **参考价值**:作为"开源 Fences 替代鲜有善终"的旁证——该赛道独自做全功能整理器投入大;本项目只做"承载自己要展示的东西 + 现有桌面项归位",范围更收敛,是合理差异化

---

## 对照总表

| 项目 | 平台 | 技术栈 | 覆盖能力 | 活跃度(2026-09-27 查证) | 借鉴价值 |
|---|---|---|---|---|---|
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban) | Web/自托管 | Rust + TS/React | 3 | 28.2k★,sunsetting | 中(交互模型) |
| [crystal](https://github.com/stravu/crystal) | Win/Mac | Electron | 3 | 3.1k★,已弃用 | 中(worktree 会话) |
| [Conductor](https://conductor.build/) | macOS | 闭源 | 3 | 活跃(闭源) | 低(仅产品参照) |
| [TokenTracker](https://github.com/xiufengsun/TokenTracker) | 桌面 | JS | 3 | 1.7k★,活跃 | 中(多工具采集/隐私边界) |
| [Clawdmeter](https://github.com/HermannBjorgvin/Clawdmeter) | ESP32 硬件 | C | 3(实体形态) | 2.2k★,活跃 | 低(需求旁证) |
| [BongoCat](https://github.com/ayangweb/BongoCat) | Win/Mac/Linux | Tauri + Vue | 1、2 | 23.6k★,极活跃 | **高**(穿透/置顶配置) |
| [petdex](https://github.com/crafter-station/petdex) | Win/Mac/Linux | TS + Zig hooks | 3(采集架构) | 4.2k★,活跃 | **高**(hooks 采集、状态映射) |
| [petpack](https://github.com/MingfengHong/petpack) | 桌面 | Rust | — | 64★ | 低(思路同构) |
| [lively](https://github.com/rocksdanister/lively) | Windows | C#/WinUI3 | 1(壁纸层) | 19.7k★,活跃 | 中(壁纸 API 面) |
| [rainmeter](https://github.com/rainmeter/rainmeter) | Windows | C++ | 5(皮肤模型) | 6.0k★,活跃 | 中(measure/skin 解耦) |
| [uebersicht](https://github.com/felixhageloh/uebersicht) | macOS | ObjC + WebKit | 1、5 | 5.0k★,半停滞 | **高**(桌面层 HTML widget) |
| [Live-Lyrics-WE](https://github.com/am1dreaming/Live-Lyrics-for-Wallpaper-Engine) | WE 壁纸 | JS | — | 20★ | 低(WE 路线旁证) |
| [DeskBox](https://github.com/Tianyu199509/DeskBox) | Windows | C#/WinUI3 + Rust(GPL-3.0) | 1、4 | 5.5k★,活跃 | **高**(宿主稳定/多屏恢复/搜索) |
| [Portals](https://github.com/Ross-Patterson/Portals-Desktop-Organization) | Windows | 闭源 | 4 | 445★,活跃 | 低(学坑) |
| [Palisades](https://github.com/Xstoudi/Palisades) | Windows | C# | 4 | 74★,归档 | 低(赛道旁证) |

覆盖能力 1=透明常驻窗体 / 2=点击穿透 / 3=多工具会话卡片+数据服务 / 4=桌面项承载 / 5=浮层与插件体系

## 对工单的启示

- **工单 01(透明/穿透 spike)+ 03(宿主常驻)**:机制已非独家——BongoCat 与 Electron 官方 `setIgnoreMouseEvents(true, {forward:true})` 是成熟配置;spike01 已真机全绿,本仓库证据优先。Wayland 破缺与我们无关(仅 Windows)。
- **工单 04(数据卡片)**:采集面参考 petdex 的本地 hooks server(事件 → 状态映射,9 态口径可借为会话状态机)与 TokenTracker 的"不读内容、只取元数据"隐私边界;多工具统一模型可对照 ADR-0003 自证设计。Qoder 类工具无公开 API,同类项目全部走"hooks / 本地文件"路线,印证自建数据服务是必选项。
- **工单 05(桌面承载)/ 06(分区编排)**:**DeskBox 是头号参照**——Explorer 宿主稳定后再挂载、显示器拓扑/DPI 变化布局恢复(与进行中的 wind-restore 同题)、按类别规则归类、Quick Reveal 抬升被遮挡层;Portals 的"folder-backed、任意路径"与"多 portal 启动慢/闪烁"教训同样要吸收。注意 DeskBox 为 GPL-3.0,只学思路不碰代码。
- **工单 07(搜索浮层)**:DeskBox 的 Everything IPC 桥是现成路子,Windows 上搜索体验可平价对齐。
- **工单 02(面板 tracer)/ 08–11(设置/聚焦/插件/退役)**:无直接同类,均为本项目自证范围。
- **战略层**:C 类项目佐证 ADR-0004——WE web 壁纸路线无交互、无窗口能力、无契约;桌面层 HTML widget 路线(Übersicht)在 macOS 已验证但 Windows 无人补位。**"桌面层常驻 + agent 会话状态 + 桌面项承载"三者合一是当前 GitHub 空白,是本项目核心差异化。**

## 来源清单

- https://github.com/BloopAI/vibe-kanban
- https://github.com/stravu/crystal
- https://conductor.build/
- https://github.com/xiufengsun/TokenTracker
- https://github.com/HermannBjorgvin/Clawdmeter
- https://github.com/phuryn/claude-usage
- https://github.com/realiti4/claude-swap
- https://github.com/Leanmcp/superview.sh
- https://github.com/ayangweb/BongoCat
- https://github.com/crafter-station/petdex
- https://github.com/MingfengHong/petpack
- https://github.com/devnomad-byte/petdex-cc
- https://www.electronjs.org/docs/latest/api/browser-window
- https://github.com/rocksdanister/lively
- https://github.com/rainmeter/rainmeter
- https://github.com/felixhageloh/uebersicht
- https://github.com/am1dreaming/Live-Lyrics-for-Wallpaper-Engine
- https://docs.wallpaperengine.io/en/web/web.html
- https://steamcommunity.com/app/431960/discussions/1/2741975115072757676
- https://github.com/Tianyu199509/DeskBox
- https://github.com/Ross-Patterson/Portals-Desktop-Organization
- https://portals-app.com/
- https://github.com/Xstoudi/Palisades
