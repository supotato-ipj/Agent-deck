---
Status: accepted
---

# 任务栏插件接管原生任务栏，合并 dock 为自绘常驻栏

用户要求将底部 dock 与 Win11 原生任务栏合并为按栏分组、可自定义的自绘任务栏（分组漂浮 pill 形态）。为此推翻 ADR-0004「Explorer 与任务栏不动」的边界：隐藏原生任务栏并完全接管其职能（开始按钮、TaskView、运行中窗口、托盘、时钟、显示桌面），以 cordis 主进程插件承载，禁用插件即还原原生任务栏。托盘托管选 TS 重写——竞争窗口（同名 `Shell_TrayWnd` 窗口类置顶赢下 `WM_COPYDATA` 投递）托管于 dataplane 子进程、PeekMessage 非阻塞泵，与 ADR-0005「不用输入钩子、数据采集入 dataplane」一脉相承；以 1–2 天 spike 闸门定生死，失败退回 C# 随行进程（ManagedShell 移植，Apache-2.0）。窗口标题对 ADR-0002 开显式书面口子：仅内存即时显示，永不持久化。

## Considered Options

- **保留原生任务栏、自绘栏仅作视觉装饰** — 双栏并存职能割裂，「合并」名不副实。
- **C# 随行进程托管托盘**（ManagedShell 移植）— 风险最低、工期最短，但引入第二运行时与第二个待签名 exe，违背单语言运行时哲学；保留为 spike 失败的回退路线，规范化托盘事件契约届时直接作为管道协议。
- **Hook-DLL 注入 explorer 线程**（Seelen 式）— DLL 注入是杀软/EDR 启发式头号触发点，且宿主崩溃发生在 explorer 进程内。
- **纯 koffi 重写但托管于面板主进程** — 消息泵与原生崩溃都落在主线程，违反 ADR-0005 的实测教训；改由 dataplane 托管后路线成立。
- **ExplorerPatcher/Windhawk 式补丁** — 注入并挂钩 explorer 内部实现，逐版本破碎的永久跑步机；消息边界已能给出图标、点击、菜单全部所需。

## Consequences

- **ADR-0002 注记修订**：窗口标题仅内存中即时读取用于栏上显示（tooltip、同应用多窗口列表），永不写入使用日志或任何持久化——运行中应用上栏的必要口子。
- 底部 dock 与硬件桌面组件退役，应用区概念并入任务栏；`GLOSSARY.md` 入库「任务栏 / 栏分组 / 通知区域 / 硬件摘要」四词条。
- 体系内出现**第一个置顶窗口**（任务栏窗口）；面板本体维持 HWND_BOTTOM 钉扎不变；pill 缝隙复用交互热区机制实现点击穿透，落到下方窗口。
- 注册 AppBar 占住工作区底边，最大化窗口停在栏上方；检测到前台全屏应用时栏自动让位。
- 原生任务栏的隐藏/还原复用桌面图标隐藏的 guard + watchdog 模式，崩溃还原兜底；设置里留切换开关作逃生通道。
- 托盘宿主**永不提权运行**（UIPI 会静默丢弃中等完整性级应用的消息与回放）；与 RetroBar/Seelen/Zebar 等同类托盘托管互斥，检测到第二个置顶 `Shell_TrayWnd` 时告警。
- 音量/网络/电源系统图标在 Win11 上非 `Shell_NotifyIcon` 可达（explorer 内部 XAML）：音量格自绘（点击合成 Win+A 弹原生快速设置），网络由硬件摘要覆盖，电源格 v1 不做。
- 已知残余风险：协议未文档化（但 Win95→Win11 25H2 未变，且是承重墙——改它即砸所有 `Shell_NotifyIcon` 调用方）；Z 序竞争需定时维持置顶；少数应用不响应 `TaskbarCreated` 重注册，需重启该应用才入栏。

## 补记（工单49 tracer bullet 真机实证，2026-10-05）

「Z 序竞争需定时维持置顶」一条的实测结论比预期更硬：Shell_TrayWnd 位于普通 WS_EX_TOPMOST **之上**的窗口层级，且 explorer 会主动重申防守。49 验收期的收复阶梯探针实证：我方窗口 `topmost=true`、非穿透状态下命中仍归 Shell_TrayWnd；SetWindowPos(TOPMOST) 刷新、BringWindowToTop、AttachThreadInput 后顶起、乃至把 tray 压到 HWND_BOTTOM（400ms 内被 explorer 重申还原）全阶梯无效。竞态表现为「谁先占住谁赢，输了收不回」，验收三轮间随机翻转。**结论：与可见的原生任务栏同矩形重叠没有文档化稳定解**（RetroBar/Zebar/ExplorerPatcher 均走隐藏原生任务栏路线，与此互证）。因此 49 的条带几何暂为「主屏底部通栏、底边坐原生任务栏上沿」（净空 = 原生任务栏高，`TASKBAR_BOTTOM_CLEARANCE`）；原生任务栏隐藏（本 ADR 主线，后续票）落地后净空归零、条带落回屏底。

## 补记（工单50 原生任务栏隐藏/还原落地，2026-10-05）

「原生任务栏隐藏（本 ADR 主线，后续票）落地后净空归零、条带落回屏底」已兑现：隐藏手段为 `ShowWindow(Shell_TrayWnd, SW_HIDE/SW_SHOW)` 纯视图态切换，不写注册表——用户既有任务栏偏好（自动隐藏等 StuckRects 设置）全程原样（50 验收以 StuckRects3 Settings 字节级前后比对把关）。职责划分：隐藏/随开关还原由面板侧任务栏窗控制器持有（条带窗生 = 原生隐、灭 = 原生现，单点生效）；守卫与还原守护只做死路径兜底，以视图事实为唯一判据（隐藏态才翻回）——还原是安全方向，宁可把别人藏起来的任务栏显出来，绝不给用户留无系统入口的桌面。逃生开关落在设置浮层（TASKBAR toggle），经既有 `taskbar/set-enabled` 桥契约即时生效。`TASKBAR_BOTTOM_CLEARANCE` 从常态几何退为隐藏失败的降级档。还原守护（icon-restore-watch）随之改为常驻拉起（原生任务栏的隐藏可由设置在运行期随时打开，守卫在拉起时点无法预知还原义务）。

## 补记（工单51 AppBar 工作区占位 + 全屏让位落地，2026-10-06）

「注册 AppBar 占住工作区底边、全屏让位」兑现为 `taskbar/appbar.ts`（SHAppBarMessage 薄壳）+ `taskbar/yield.ts`（纯谓词 + FFI 探针）+ 窗口控制器接线。真机实证（51 电池 P1–P5 全绿）：**SHAppBarMessage 不依赖 Shell_TrayWnd 窗口可见性**——原生任务栏已被 50 隐藏，ABM_NEW/SETPOS 照常生效（消息由 explorer 的 AppBar 服务处理，与托盘窗视图态无关），ticket-map 标注的 spike 级风险点证伪。全屏让位只在 AppBar 生效档启用：降级档（注册失败）下最大化窗覆盖全屏会使「覆盖判定」误闪，宁可不让位。死路径残余风险探针实证：面板被强杀后系统**不会**主动摘除死窗的 AppBar 占位（20s 不落），但**还原原生任务栏（SW_SHOW）的动作本身会让 explorer 重校验 AppBar 清单并摘掉死账**——50 的三条死路径（守卫/守护/自救通道）终点都是还原原生任务栏，死占位随之摘除、不叠加（探针：还原后工作区回基线而非再缩一档），故无需自建的 hwnd 死账清理机制。
