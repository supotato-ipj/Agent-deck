import type { BridgeService } from './services/bridge'
import type { ClockService } from './services/clock'
import type { SessionsService } from './services/sessions'
import type { HardwareService } from './services/hardware'
import type { DesktopService } from './services/desktop'
import type { UsageService } from './services/usage'
import type { SearchService } from './services/search'
import type { SettingsService } from './services/settings'
import type { FocusService } from './services/focus'
import type { PluginHostService } from './plugins/service'
import type { PluginConfigService } from './services/plugin-config'
import type { PanelDataPort } from './services/panel-data'
import type { TaskbarService } from './services/taskbar'
import type { DesktopWorkspaceService } from './services/desktop-workspace'
import type { AgentTilingService } from './services/agent-tiling'
import type { AgentFocusService } from './services/agent-focus'
import type { WindowPreviewService } from './services/window-preview'
import type { SessionPreviewService } from './session-preview/service'
import type { ConversationService } from './conversation/service'
import type { MediaService } from './media/service'
import type { NetworkService } from './network/service'
import type { CredentialService } from './credentials/service'
import type { InstallProposalView } from './plugins/install'
import type { AgentFocusState, AgentTilingState, ConversationSessionView, DesktopWorkspaceState, DroppedPackageInfo, PanelSnapshot, PluginInfo, SearchUiState, SearchResultItem, SessionPreviewState, SettingsState, TaskbarBarModeState, TaskbarState, TaskbarStatus, WindowPreviewState } from '../shared/contract'
import type { TrayWireEvent } from './trayhost/protocol'

declare module 'cordis' {
  interface Events {
    'panel/changed': (snapshot: PanelSnapshot) => void
    /**
     * 数据面快照到达（鼠标卡顿修复工单）：生产装配由 DataplaneService 每拍发出，
     * 桥接层订阅后推送 panel/changed。进程内装配不发出（tick 手动驱动同效果）。
     */
    'dataplane/snapshot': () => void
    /** 工单56 托盘入栏：子进程托盘宿主每条规范化事件发出，任务栏服务据此编排栏内名单 */
    'dataplane/tray-event': (event: TrayWireEvent) => void
    /** 工单07 搜索：派生态变化（待机/活动/引擎离线）与引擎成功响应 */
    'search/state': (payload: { state: SearchUiState }) => void
    'search/results': (payload: { total: number; items: SearchResultItem[] }) => void
    /** 工单08 设置：透明度滑杆即时回推 */
    'settings/changed': (payload: SettingsState) => void
    /** 工单101 卡片显隐：停用集变化（设置服务落盘后发出，插件宿主据此重扫清单剔除/恢复停用包） */
    'settings/cards-changed': (payload: { disabled: string[] }) => void
    /** 工单10 桌面组件：插件清单变化（放入/移除/资产变更即推） */
    'plugins/changed': (payload: PluginInfo[]) => void
    /** 工单331 投放包：dropped 档清单变化（投放/停用/迁移态变化即推；不进 PanelSnapshot） */
    'dropped-plugins/changed': (payload: DroppedPackageInfo[]) => void
    /** 工单49/52 任务栏：开关变化与应用组编排帧即时回推（窗口控制器据此建窗/销窗，渲染层据此重绘应用组） */
    'taskbar/changed': (payload: TaskbarState) => void
    /** 工单55 任务栏右组：每拍快照回推时钟 + 硬件仪表（桥接层随 panel/changed 同拍发出） */
    'taskbar/status': (payload: TaskbarStatus) => void
    /**
     * 工单241 最大化收栏编排：任务栏窗口控制器裁决三态后发出（条带渲染层据此让栏面退场/复现）。
     * 发出方是主进程控制器（不是内核服务）——档位是窗口宿主面的事实，经 ctx 事件总线转桥接层。
     */
    'taskbar/bar-mode': (payload: TaskbarBarModeState) => void
    /**
     * 工单242 唤出条指针对账：热区跟踪器（25ms 光标轮询）按光标坐标 hit-test 后报出
     * 命中的热区 id（null = 不在任何热区）。发出方是热区跟踪器所在的窗口控制器。
     */
    'taskbar/cursor-zone': (payload: { id: string | null }) => void
    /**
     * 工单242 浮层钉组：自绘浮层开合事实（family = 存证事件家族前缀）。
     * 发出方是弹窗菜单通用载体（popup.ts）——开层/收层是它的单一收口。
     */
    'taskbar/popup-state': (payload: { family: string; open: boolean }) => void
    /**
     * 工单194 托盘右键回放让位起拍：TaskbarService.trayClick 在转发回放**之前**同步
     * 发出（cordis emit 同步派发——让位先落位、菜单后诞生，z 序正确性赖此顺序），
     * 任务栏窗口控制器订阅即把条带临时降非置顶。hwnd = 图标属主窗口（十进制串，
     * 影子账缺位为 null），pid 由控制器 FFI 解析。
     */
    'taskbar/tray-replay-begin': (payload: { key: string; button: 'left' | 'right'; hwnd: string | null }) => void
    /** 工单332 对话窗：会话视图变化即推（创建/流式/工具/权限/取消/结束/失败） */
    'conversation/changed': (payload: { sessions: ConversationSessionView[] }) => void
    /** 工单334 安装管线：提案变化即推（提交/批准/拒绝/失败——批准 UI 与诊断数据面） */
    'install/changed': (payload: { proposals: InstallProposalView[] }) => void
    /** 工单336 媒体快照代次变化（桥事件收敛后发；宿主据此向获批包即时重推 media 段） */
    'media/snapshot-changed': (payload: { generation: number }) => void
    /**
     * 工单375 桌面工作区：配对/当前模式/切换在途/失败提示任一变化即推。面板、任务栏
     * 与（后续）胶囊订阅同一份——共享状态并跟随当前桌面（ADR-0028）；系统快捷键/
     * TaskView 造成的切换经 reconciliation 观察后由此回推（不抢回用户）。
     */
    'workspace/changed': (payload: DesktopWorkspaceState) => void
    /**
     * 工单407 标题栏拖拽会话投影：MOVESIZE 起止与 Agent 入口悬停任一变化即推——
     * 任务栏渲染层据此显示落点高亮、会话预览据此暂停/恢复。载荷只含布尔投影。
     */
    'workspace/drag-in-changed': (payload: { active: boolean; overAgent: boolean }) => void
    /**
     * 工单407 拖入一次性交接登记：迁移经桌面 ID 回读确认后即发一次——Agent 平铺服务
     * 订阅它把该窗按交接顺序并入待入列（下次布局拍对账并清除）。渲染层不消费。
     */
    'tiling/drag-in-registered': (payload: { hwnd: number }) => void
    /** 工单376 Agent 平铺：计数/落格/溢出/异常任一变化即推——胶囊与桥订阅同一份 */
    'tiling/changed': (payload: AgentTilingState) => void
    /**
     * 工单378 授权提示请求：首个用户几何操作已复原，等待「调整窗口/保持平铺」。
     * 只带窗口句柄与当前几何（提示窗定位用），不带标题——隐私面（spec 决策 26）。
     */
    'tiling/authorize-request': (payload: { hwnd: number; rect: { left: number; top: number; right: number; bottom: number } }) => void
    /** 工单378 授权提示关闭（确认/取消/切出撤销/恢复平铺/窗口消失）——控制器据此收窗 */
    'tiling/authorize-closed': (payload: { hwnd: number }) => void
    /** 工单383 重启恢复状态迁移（restored/paused/safe）：诊断存证用，载荷只有枚举与原因 */
    'tiling/recovery': (payload: { status: 'none' | 'restored' | 'paused' | 'safe'; reason: string | null }) => void
    /**
     * 工单379 窗口预览状态变化（展开/收起/条目更新）：预览窗控制器据此建/显/更/销窗；
     * 同一事件即桥接事件 'preview/changed'（胶囊页与预览页订阅）。
     * 载荷含标题与内存位图——只走窗内桥，不落日志。
     */
    'preview/changed': (payload: WindowPreviewState) => void
    /** 工单379 Agent 聚焦状态变化（进入/退出）——胶囊页据此切换主体点击语义 */
    'focus/changed': (payload: AgentFocusState) => void
    /** 工单379 控制器上行：某条目 DWM 实时注册失败 → 预览服务改判图标+标题回退 */
    'window-preview/live-failed': (payload: { hwnd: number }) => void
    /** 工单379 控制器上行：当前 DWM 关系数（诊断/验收「关闭即释放」） */
    'window-preview/live-registered': (payload: { count: number }) => void
    /**
     * 工单381 Agent 会话预览：展开/收起/1Hz 投影刷新即推（气泡窗控制器与气泡页订阅同一份）。
     * 同一事件即桥接事件 'session-preview/changed'。载荷只含标题/项目/短 ID/状态，
     * 不含对话正文；新增日志不记对话标题。
     */
    'session-preview/changed': (payload: SessionPreviewState) => void
  }
  interface Context {
    clock: ClockService
    sessions: SessionsService
    hardware: HardwareService
    desktop: DesktopService
    bridge: BridgeService
    /**
     * 桥接层的数据面端口：进程内装配（内核测试）为 LocalPanelDataService 直连采集服务；
     * 生产装配为 DataplaneService（utilityProcess 子进程宿主，鼠标卡顿修复工单起）。
     */
    panelData: PanelDataPort
    /** 工单06 使用日志（内核可不装：desktop 的推荐位按无分数退化） */
    usage?: UsageService
    /** 工单07 搜索（内核总装必装；离线测试注入假源） */
    search: SearchService
    /** 工单08 设置（内核总装必装；离线测试注入 tmp 桩） */
    settings: SettingsService
    /** 工单09 会话行直达（内核总装必装；离线测试注入假窗口源） */
    focus: FocusService
    /** 工单10 桌面组件宿主（内核总装必装；roots 为空时不做任何扫描） */
    plugins: PluginHostService
    /** 工单49/52 任务栏（内核总装必装；离线测试注入假源，窗口枚举手动驱动 refresh） */
    taskbar: TaskbarService
    /** 工单178 插件私有状态（内核总装必装；命名空间存储目录默认 userData/plugin-config） */
    pluginConfig: PluginConfigService
    /** 工单332 对话窗会话服务（内核总装必装；BridgeService 注入它，缺装配即静默不装载桥接层） */
    conversation: ConversationService
    /** 工单336 媒体域（可选装配：Broker/审计/桥客户端；缺装配 = 桥接层媒体方法如实不可用） */
    media?: MediaService
    /** 工单338 网络域（可选装配：Broker/审计；缺装配 = 宿主网络面如实不可用） */
    network?: NetworkService
    /** 工单339 命名凭证域（可选装配：凭证库；缺装配 = 凭证保存/注入如实不可用） */
    credentials?: CredentialService
    /** 工单375 桌面工作区（可选装配：功能开关隔离——缺装配 = 投影回退禁用态） */
    desktopWorkspace?: DesktopWorkspaceService
    /** 工单376 Agent 平铺（可选装配：随 agentDesktop 开关隔离——缺装配 = 投影回退空态） */
    agentTiling?: AgentTilingService
    /** 工单407 Agent 拖入（可选装配：随 agentDesktop 开关隔离——缺装配 = 命令如实不可用） */
    agentDragIn?: import('./services/agent-drag-in').AgentDragInService
    /** 工单379 Agent 聚焦（可选装配：随 agentDesktop 开关隔离——缺装配 = 聚焦不可用） */
    agentFocus?: AgentFocusService
    /** 工单379 窗口预览（可选装配：随 agentDesktop 开关隔离——缺装配 = 预览不可用） */
    windowPreview?: WindowPreviewService
    /** 工单381 Agent 会话预览（可选装配：随 agentDesktop 开关隔离——缺装配 = 投影回退空态） */
    sessionPreview?: SessionPreviewService
  }
}
