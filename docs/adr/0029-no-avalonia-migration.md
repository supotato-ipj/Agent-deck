---
Status: accepted
---

# 维持 Electron 技术栈，不迁移 Avalonia

为回答「跨平台 UI 框架 Avalonia 与本面板的契合度」，2026-11-07 以一手资料完成专项调研（Avalonia 官方文档、GitHub releases/源码/issue、NuGet，全链实查；全文见 `docs/audit/avalonia-fit-research-20261107.md`）。结论：**有条件契合，整体判定不迁移**——桌面外壳层（透明/穿透/置底/Win32 几何）在 Avalonia 技术可行，但插件平台与验收电池两个产品级资产在新底座上无等价物，全量迁移是换整个技术栈而非换渲染层。本 ADR 记录判定依据与再评估门槛，不改变 ADR-0004 的任何决定。

## 决策

- **维持 Electron + cordis + koffi 技术栈**，不启动 Avalonia 迁移，不立迁移试验工单。
- **判定的三个决定性因素**：
  1. **JS 插件平台是 ❌ 级缺位**：per-投放包独立 `webContents`+session 隔离、`deck-plugin://` 协议同源动态 import、Node 宿主面、16 包/128MB 预算标定（`budget.ts` 按 Electron 真机实测每包边际 102-113MB 标定）在 Avalonia/WebView2 下全部作废。WebView2 多实例共享浏览器进程树，隔离粒度与崩溃域语义都不同。插件平台是本项目的立项理由（ADR-0004「为插件生态支付的代价」），重造等于自研半个 Electron。
  2. **代码量与验收体系是换整个技术栈**：约 12.8 万行 TS（渲染/主进程 4.2 万 + 验收电池 3.8 万 + 单测 4.7 万）与 189 段真机电池全部架构在 Electron/CDP 语义上；CDP 级运行时探针、事件磁带、面板句柄等验收基础设施无等价物，逐段移植是最大单项工程。Avalonia 侧仅 Headless 截帧与 `IntegrationTests.Win32` 式真窗断言可对齐形态，协议化探针通道缺位。
  3. **收益侧无硬数据**：内存/启动开销 vs Electron 连 Avalonia 官方对比页（electron-compare）都无实测数字（该页明言其数字不含估计，但对内存与启动时间无任何实测）。收益没有证据，成本是确定的。
- **技术面如实记账**：Avalonia 对本项目最独特的「硬核 Win32 桌面外壳」反而是最容易平移的部分——koffi FFI → C# P/Invoke 语义 1:1 更自然；每像素透明走 DWM 真实 alpha（`WindowImpl.cs:431,488`）；任务栏接管/竞争窗虽无框架支持与生态先例，机制上可手写。**外壳不是障碍，产品资产才是**。
- **版本锚点（若未来再评估）**：锁 Avalonia 11.3.22（LTS）或 ≥12.1.5——v12 曾出透明回归（#21082，PR #21354 已修）；点击穿透 `WS_EX_TRANSPARENT` 至今无公共 API（#6682 自 2021 open），须自设样式位。
- **再评估门槛**：仅当出现①跨平台发布需求，或②局部 spike 四项全绿时重启决策。spike 内容（独立仓库、不碰面板代码）：窗口三件套（Transparent 无框窗 + P/Invoke 穿透 + HWND_BOTTOM 置底，并实测分层更新延迟）、竞争窗消息泵行为等价复现、xUnit 真窗断言测试管线跑通一条验收段等价物、官方 WebView（WebView2）多实例隔离粒度与内存边际实测（对照 C10 段 102-113MB/包）。任何一项红即写死不迁移。

## Considered Options

- **整体迁移 Avalonia**——插件平台架构重造 + 12.8 万行全量改写 + 189 段电池逐段移植，收益侧连实测数字都拿不出，拒绝。
- **先做局部 spike 再决策**——保留为再评估路径（见决策末条），但当前无跨平台需求驱动，不立项、不占用主力线。
- **顺带改选 Tauri/pywebview 等其他轻量底座**——未逐项调研；已知它们同样无 Node 宿主面与 per-webContents 隔离语义的等价物，本 ADR 的核心否决因素对它们同样成立，不因 Avalonia 调研顺带推翻 ADR-0004。
- **只把渲染层换成 Avalonia、宿主层留 Electron**——两框架各持一个渲染/合成栈，进程模型与 IPC 反而复杂化，不存在「只换皮肤」的中间态。

## Consequences

- 跨平台继续不在产品目标内；ADR-0004 选定 Electron 的理由与代价记账维持有效。
- 调研全文（逐耦合点证据表、A–J 能力对照、一手来源清单）入库于 `docs/audit/avalonia-fit-research-20261107.md`；其时效以 2026-11-07 为准，引用其中的版本号与 issue 状态前须复核是否过期。
- 未来若重启评估，先跑四项 spike 再谈决策，不做顺手重写；spike 结论与预算标定实测须补充进本 ADR 或其替代 ADR。
- koffi 层继续承担 Win32 深集成（AppBar/竞争窗/几何/穿透），其绑定在 C# 侧的 1:1 对应关系已验明，不构成未来任何迁移的技术悬念。
