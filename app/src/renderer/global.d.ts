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
  type SettingsState = import('../shared/contract').SettingsState
  /** 上下文菜单条目（工单23 contributor 形状：数组即注册位，注册机制后续工单接入）。
   * disabled = 置灰行（工单30【粘贴】）：呈现弱化 + activate 挡下（menu.ts 归约器）。 */
  type DeckCtxMenuItem = { id: string; label: string; disabled?: boolean; run(): void }

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
    /**
     * 上下文菜单 shell（工单23，context-menu 插件发布）：随插件清单热插拔，卸载即摘除。
     * 挂在 deck 之外——window.deck 经 contextBridge 暴露、渲染层侧不可扩展（首轮电池实测）。
     */
    deckCtxMenu?: {
      open(x: number, y: number, items: readonly DeckCtxMenuItem[]): void
      /** 菜单外按下收起（面板裁决后转发） */
      close(): void
      /** Esc 收起（工单31 全局定序：面板 keydown 捕获段转发，存证 reason=esc） */
      escDismiss(): void
      /** 开层判定（全窗热区换挡读它；插件未装时 undefined） */
      isOpen(): boolean
    }
  }
}

export {}
