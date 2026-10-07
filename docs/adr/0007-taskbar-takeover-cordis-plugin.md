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

## 补记（工单59 底部 dock 与硬件卡退役落地，2026-10-06）

「底部 dock 与硬件桌面组件退役、应用区概念并入任务栏」一条落地。删净：`src/renderer/cards/hardware/`（插件包 + 卡片）与 `PLUGIN_CAPABILITIES` 的 `hardware`、`DesktopZone` 的 `app`、`DesktopPlan.dock` / `DesktopDockEntry` / `DockSource`、`layout.json` 的 `pinned`/`dock` 两段与 `desktop/pin`、`desktop/unpin` 两条桥契约、`config` 的 `dockMaxWidth`；单项菜单去掉手钉管理两行（定格七行），批量拖拽的「手钉跳过」语义随之退场（`skipped` 只剩池外名字的竞态一途）。

三条落地时定下的语义边界：

- **应用条目（.lnk/.url）留在扫描池**——任务栏据此取手钉/推荐位元数据；但桌面不编排、不渲染它们。`desktop/move(name,'app',null)` 语义变为「撤掉显式摆位」，.lnk 因此离开文档区，.docx 因无第二区可去仍留在文档区归类段。
- **文档区编排**：组序 `GROUP_ORDER` 优先于显式摆位（跨组锚点无确定含义，只在同组内有效）；组内「显式段在前 + 其余 mtime 降序、同值按名」。`moveItem` 对非 doc 分区直接出名单、不重排。
- **迁移无损**：旧 `layout.json` 的手钉名单由一次性迁移读入任务栏自己的存储后原文件留档（变量随之改名 `legacyLayoutFile` / `parseLegacyPinnedNames` / `migrateLegacyPinned`，避免退役标识符继续活在代码里）；文档区的 `docs` 名单语义与形状不变，用户已有的显式摆位、删除同拍清除、重命名同拍原位迁移都原样续用。

## 补记（工单59 真机首跑挖出的两个既有缺陷，2026-10-06）

#59 的电池首跑 52 fail，形态是「面板中途失能 → 后续几十段连锁判死」。逐层剥下来是两个与 #59 无关的既有缺陷，都在真机上复现过：

- **遮挡后台化把常驻桌面件判成看不见**（根因级）。Chromium 默认把被普通窗盖住的渲染层后台化：停帧、掐表。面板被记事本一类普通窗盖住数秒后即失能——热区不再解除穿透（点击穿透到桌面，电池报「落点命中桌面层 Progman」）、数据面新快照不再上屏（新建文件永不入池）、电池后续的步进拖拽落在原生桌面 ListView 上，被 shell 当成图标拖拽拉起 OLE 会话，光标底下从此盖着一层撤不掉的 `Ghost` 幽灵窗。隔离探针实证：同一份构建，零输入时桌面通道活 70s 无恙；记事本盖住后探针文件即入不了池。修法是三处同向——面板窗 `backgroundThrottling: false`，加 `disable-backgrounding-occluded-windows` 与 `disable-renderer-backgrounding` 两个 ready 前开关。**「被盖住」对常驻桌面件是常态而非隐身后的副产品**——面板本体永不顶起、恒在普通窗之下（ADR-0004 的「永不顶起」语义），也就是说它长期处于被遮挡状态，这条修复是那条语义的必要补丁而非可选项。
- **cordis 的 ctx 是代理，未注册属性的读取会抛而不是返回 undefined**。`TaskbarService` 的 `resolveShortcutTarget` 兜底用 `this.ctx.desktop?.` 探桌面服务在场否；采集搬进数据面子进程后主进程本就无此服务，cordis 代理照样抛 `property desktop is not registered`，于是中组推荐位每拍解析每个 .lnk 都抛一次（1Hz 刷屏、推荐名单整轮算不出来）。`?.` 兜不住代理的抛，必须 `try` 住再落 Electron 兜底。同族规矩：**跨服务取用一律走 `inject` 或事件解耦**（`dataplane/snapshot` 那条注释已是正解），别拿属性探针当存在性判断。

## 补记（工单59 复跑：前一条结论的更正与新挖出的三条，2026-10-06）

首跑那条「电池拖拽落在原生桌面 ListView 上、shell 拉起 OLE 会话、光标底下从此盖着 `Ghost` 幽灵窗」的后半段**是错的，已作废**。加装取证后查清：`Ghost` 类顶层窗的主人不是面板、不是 explorer、也不是任何拖拽工具进程，而是 **`dwm.exe`（pid 5756，父 winlogon）**，矩形恰好等于面板客户区（0,0 2560x1392）——DWM 为这扇窗造的替身面，不是谁拉起的 OLE 会话；面板进程一死它即消失（三轮跑完复扫均为 0）。面板的浏览器主线程也没死：进程快照里 60 余线程绝大多数 `Wait/UserRequest`（正常空转消息泵），CPU 累计 3s 量级。首跑之所以读成「主线程假死」，是探针本身错了——`SendMessageTimeoutW` 的结果指针传了 `null`，user32 可以不解引用而直接判失败，一台活着的面板被误报成假死。探针已改为传真缓冲。

据此更正与新增：

- **失能发生在渲染层进程，不在主进程**。新增渲染层看门狗（`panel-ipc.ts` 的 `wireRendererWatchdog`）：靠渲染层上行（`ipc-message`）计时，>5s 静默即落一条 `renderer-stall` 存证（附 `isCrashed()` 与渲染进程 pid），并挂 `unresponsive` / `render-process-gone` 两个 Electron 事件。真机三跑三次命中，形态一致：`crashed=false`、静默至死不再恢复、该进程 CPU 与线程态均无异常（不是忙等、不是崩溃）。**常驻件不重启，失能就是永久失去交互**——这条存证是该形态唯一可观测信号，故留在产品里而非留在调试代码里。
- **失能稳定跟在 `keyboard-mode-on` 之后**。三轮的存证尾都是同一形状：`desktop-selection-toggled` → `keyboard-mode-on` → `pin` → 静默。那一路是 `setFocusable(true)` + `focus()` + 钉底，即**让这扇永不顶起的窗真的去当一次前台窗**（`panel-ipc.ts` 的注释写明这是有意为之：「面板永不激活，需要键盘的场景经此临时取得键盘焦点」）。当前证据只到「失能紧跟这一动作」，成因未定，单独开票跟进（#91），不在本工单里猜着改。
- **托盘宿主的消息泵在抢 Electron 自己的消息**。`trayhost/host.ts` 的 25ms 泵以 `hWnd=0` 调 `PeekMessage`——那不是「抽干本窗队列」，而是**连 Chromium 同线程的整条队列一起抽干**：面板的窗口消息、线程消息乃至 `WM_QUIT` 都会被这个 koffi 调用从 Electron 的泵里抢走再转发。已改为按本窗 hWnd 收（托盘窗是本进程唯一需要自己泵的窗），与该函数原注释的意图一致。
- **验收侧的纪律：落点必须临点现取**。文档区名序随后台使用频次落定会重排（工单05，~1s 内动），电池「settle 抓一份 `desktop-rendered` 快照、隔几秒到几十秒再按旧矩形点击」是首跑大面积「无存证」假败的第二个独立根因（P5 全段重写为按名现取矩形后再点，`desktop-rendered` 只作 settle 屏障与几何门禁）。同批还修了电池自身的脆弱点：面板中途退出即带取证中止（不再把「面板没了」说成遮挡）、`capture` 加重试、若干空指针解引用，以及**失能自愈**——主线程假死时取证 + 重启面板继续跑，而不是让后续几十段连锁判死（首跑那种形态本身就是取证失败放大成判决失败）。

## 补记（工单94 观测机制更名：渲染层看门狗 → 渲染层哨兵，2026-10-07）

只改名字与存证字段，不改结论。上一条补记里的「渲染层看门狗」改称**渲染层哨兵**（`GLOSSARY.md` 已入库该词条，连带**静默**、**失能**两级）：GLOSSARY 中「看门狗」已是工单11 退役词条，「守卫」「守护」各被既有机制占用，再造第三个近义词只会让三者更难分辨。

- 代码标识随之更名：`panel-ipc.ts` 的 `wireRendererWatchdog` → `wireRenderSentinel`；采数与接线落到新模块 `render-sentinel-sampler.ts` 的 `RenderSentinelSampler`，级别裁决仍在纯函数 `render-sentinel.ts` 的 `silenceVerdict`（工单93）。
- 存证 `renderer-stall` 的事件名与落盘口径未动，只多一个字段 `recovered`：一条静默存证从此自证「这一轮之前渲染层是否活过来过」，不必翻上下文分辨级别。5 秒阈值、2 秒采样拍、存证条数与落点均与改前一致，面板运行时行为零影响。升级失能档在裁决里是命中的（连续静默的每一拍都判成 escalate），本轮只是不把它落成存证——发射判据属 #91 验收口径。
- 本 ADR 正文与 `GLOSSARY.md`「任务栏」词条里那条 `guard + watchdog` 指的是任务栏隐藏/还原链，与本机制无关，故不在本次更名范围内；词表侧已按「看门狗」退役词条的 `_Avoid_` 改用「外层守卫与还原守护」表述。
- 「失能稳定跟在 `keyboard-mode-on` 之后」这条结论本轮不动，其更正与降级由 #95 的补记处理。
