import type { BridgeService } from './services/bridge'
import type { ClockService } from './services/clock'
import type { SessionsService } from './services/sessions'
import type { HardwareService } from './services/hardware'
import type { DesktopService } from './services/desktop'
import type { UsageService } from './services/usage'
import type { SearchService } from './services/search'
import type { SettingsService } from './services/settings'
import type { FocusService } from './services/focus'
import type { PanelSnapshot, SearchUiState, SearchResultItem, SettingsState } from '../shared/contract'

declare module 'cordis' {
  interface Events {
    'panel/changed': (snapshot: PanelSnapshot) => void
    /** 工单07 搜索：派生态变化（待机/活动/引擎离线）与引擎成功响应 */
    'search/state': (payload: { state: SearchUiState }) => void
    'search/results': (payload: { total: number; items: SearchResultItem[] }) => void
    /** 工单08 设置：透明度滑杆即时回推 */
    'settings/changed': (payload: SettingsState) => void
  }
  interface Context {
    clock: ClockService
    sessions: SessionsService
    hardware: HardwareService
    desktop: DesktopService
    bridge: BridgeService
    /** 工单06 使用日志（内核可不装：desktop 的推荐位按无分数退化） */
    usage?: UsageService
    /** 工单07 搜索（内核总装必装；离线测试注入假源） */
    search: SearchService
    /** 工单08 设置（内核总装必装；离线测试注入 tmp 桩） */
    settings: SettingsService
    /** 工单09 会话块直达（内核总装必装；离线测试注入假窗口源） */
    focus: FocusService
  }
}
