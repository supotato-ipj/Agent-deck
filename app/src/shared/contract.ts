/**
 * 桥接契约：内核对渲染层的唯一 API 形态（spec「内核契约」缝）。
 * 后续工单只扩展这里的 methods / events 映射，不另开通道。
 *
 * 窗口宿主机制（热区声明、点击存证）不属于内核契约，走 host 面，
 * 但与 bridge 共用同一对 IPC 通道与同一个 window.deck 命名空间。
 */

/** 时钟状态：ISO 字符串 + 纪元毫秒（渲染层以 epochMs 走时） */
export interface ClockState {
  iso: string
  epochMs: number
}

/** 面板快照：02 只有时钟；后续工单扩展会话/硬件/桌面项/曲线等字段 */
export interface PanelSnapshot {
  clock: ClockState
}

/** 内核桥接方法表：method → [请求体, 响应体] */
export interface BridgeMethods {
  'panel/snapshot': { request: null; response: PanelSnapshot }
}

/** 内核桥接事件表：event → 推送载荷 */
export interface BridgeEvents {
  'panel/changed': PanelSnapshot
}

export type BridgeMethod = keyof BridgeMethods & string
export type BridgeEventName = keyof BridgeEvents & string

/** 交互热区矩形：相对窗口客户区左上角，CSS px（= DIP） */
export interface HotzoneRect {
  id: string
  x: number
  y: number
  w: number
  h: number
}
