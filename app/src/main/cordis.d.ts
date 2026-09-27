import type { BridgeService } from './services/bridge'
import type { ClockService } from './services/clock'
import type { PanelSnapshot } from '../shared/contract'

declare module 'cordis' {
  interface Events {
    'panel/changed': (snapshot: PanelSnapshot) => void
  }
  interface Context {
    clock: ClockService
    bridge: BridgeService
  }
}
