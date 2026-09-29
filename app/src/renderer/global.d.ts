import type {
  BridgeEventName,
  BridgeEvents,
  BridgeMethod,
  BridgeMethods,
  HotzoneRect,
} from '../shared/contract'

declare global {
  // 渲染层是经典脚本（无模块语法），经全局别名引用契约类型
  type PanelSnapshot = import('../shared/contract').PanelSnapshot
  type SessionInfo = import('../shared/contract').SessionInfo
  type DesktopItem = import('../shared/contract').DesktopItem
  type DesktopState = import('../shared/contract').DesktopState
  type DesktopPlan = import('../shared/contract').DesktopPlan
  type HotzoneRect = import('../shared/contract').HotzoneRect
  type SearchResultItem = import('../shared/contract').SearchResultItem
  type SearchUiState = import('../shared/contract').SearchUiState
  type SettingsState = import('../shared/contract').SettingsState

  interface Window {
    deck: {
      bridge: {
        invoke<M extends BridgeMethod>(
          method: M,
          payload: BridgeMethods[M]['request'],
        ): Promise<BridgeMethods[M]['response']>
        on<K extends BridgeEventName>(
          event: K,
          listener: (payload: BridgeEvents[K]) => void,
        ): () => void
      }
      host: {
        setHotZones(rects: HotzoneRect[]): void
        /** 键盘模式开关（工单02）：开 = 面板临时可聚焦+聚焦+钉底；关 = 恢复不可聚焦+钉底 */
        setKeyboardMode(on: boolean): void
        notify(type: string, payload?: Record<string, unknown>): void
      }
    }
  }
}

export {}
