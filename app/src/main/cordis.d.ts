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
import type { PanelDataPort } from './services/panel-data'
import type { TaskbarService } from './services/taskbar'
import type { PanelSnapshot, PluginInfo, SearchUiState, SearchResultItem, SettingsState, TaskbarState, TaskbarStatus } from '../shared/contract'
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
    /** 工单10 桌面组件：插件清单变化（放入/移除/资产变更即推） */
    'plugins/changed': (payload: PluginInfo[]) => void
    /** 工单49/52 任务栏：开关变化与左组编排帧即时回推（窗口控制器据此建窗/销窗，渲染层据此重绘左组） */
    'taskbar/changed': (payload: TaskbarState) => void
    /** 工单55 任务栏右组：每拍快照回推时钟 + 硬件仪表（桥接层随 panel/changed 同拍发出） */
    'taskbar/status': (payload: TaskbarStatus) => void
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
  }
}
