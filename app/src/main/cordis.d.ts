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
import type { ConversationService } from './conversation/service'
import type { MediaService } from './media/service'
import type { NetworkService } from './network/service'
import type { InstallProposalView } from './plugins/install'
import type { ConversationSessionView, DroppedPackageInfo, PanelSnapshot, PluginInfo, SearchUiState, SearchResultItem, SettingsState, TaskbarBarModeState, TaskbarState, TaskbarStatus } from '../shared/contract'
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
  }
}
