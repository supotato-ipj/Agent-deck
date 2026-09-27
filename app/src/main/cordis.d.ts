import type { BridgeService } from './services/bridge'
import type { ClockService } from './services/clock'
import type { SessionsService } from './services/sessions'
import type { HardwareService } from './services/hardware'
import type { DesktopService } from './services/desktop'
import type { UsageService } from './services/usage'
import type { PanelSnapshot } from '../shared/contract'

declare module 'cordis' {
  interface Events {
    'panel/changed': (snapshot: PanelSnapshot) => void
  }
  interface Context {
    clock: ClockService
    sessions: SessionsService
    hardware: HardwareService
    desktop: DesktopService
    bridge: BridgeService
    /** 工单06 使用日志（内核可不装：desktop 的推荐位按无分数退化） */
    usage?: UsageService
  }
}
