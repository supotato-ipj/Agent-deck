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
        notify(type: string, payload?: Record<string, unknown>): void
      }
    }
  }
}

export {}
