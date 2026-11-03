/**
 * 会话气泡悬停状态机（工单381，spec #369 决策 24 —— 纯逻辑，时间由调用方注入）。
 *
 * 语义（GLOSSARY「Agent 会话预览」）：
 *   - 悬停 Agent 入口满 300ms 才展开（普通划过不误触）；
 *   - 指针离开锚点后有 400ms 宽限——足够移入气泡；气泡内指针在场时不收起；
 *   - Esc 立即收起；锚点重新命中时若仍在宽限内则立即复展开（不重新等 300ms）；
 *   - 时间判定一律用外部注入的 nowMs：单测以 fake clock 驱动，真机由 25ms 泵推进。
 */
export const HOVER_OPEN_MS = 300
export const HOVER_GRACE_MS = 400

/**
 * 悬停锚点热区 id：任务栏模式切换组里 Agent 入口的命中区（taskbar 渲染层按
 * `mode:<id>` 声明；主进程只认这一条光标事实）。两侧字面量由单测镜像守卫钉住
 * （app/tests/session-preview/hover.spec.ts）。
 */
export const SESSION_PREVIEW_ANCHOR_ZONE = 'mode:agent'

export type HoverPhase = 'idle' | 'arming' | 'open' | 'closing'

export interface HoverState {
  phase: HoverPhase
  /** arming / closing 的起始时刻（epoch ms）；idle/open 时无意义 */
  since: number
  /** 指针是否在气泡内（移入宽限的核心状态） */
  inBubble: boolean
  /** 标题栏拖拽暂停（工单407，spec #403 决策「拖拽期间协调会话预览」）：原生标题栏
   *  拖动在场时吞掉 enter-anchor（预览不争夺落点），drag-end 解除后恢复既有行为 */
  dragHold: boolean
}

export type HoverEvent =
  | { type: 'enter-anchor' }
  | { type: 'leave-anchor' }
  | { type: 'enter-bubble' }
  | { type: 'leave-bubble' }
  | { type: 'esc' }
  | { type: 'tick' }
  | { type: 'reset' }
  | { type: 'drag-active' }
  | { type: 'drag-end' }

/** 控制器要执行的动作（窗口显隐由控制器落地；状态机不碰 Electron） */
export type HoverAction = 'none' | 'open' | 'close'

export function initialHoverState(): HoverState {
  return { phase: 'idle', since: 0, inBubble: false, dragHold: false }
}

export function reduceHover(state: HoverState, event: HoverEvent, nowMs: number): { state: HoverState; action: HoverAction } {
  switch (event.type) {
    case 'drag-active':
      // 拖拽暂停（工单407）：展开/收起态立即收起（预览不争夺落点或焦点），暂停期吞锚点
      return { state: { phase: 'idle', since: 0, inBubble: false, dragHold: true }, action: state.phase === 'open' || state.phase === 'closing' ? 'close' : 'none' }
    case 'drag-end':
      // 解除暂停：恢复既有悬停预览行为（下次 enter-anchor 重新走 300ms 展开）
      return { state: { ...state, dragHold: false }, action: 'none' }
    case 'enter-anchor':
      if (state.dragHold) return { state, action: 'none' } // 拖拽期锚点命中被吞（story 40）
      if (state.phase === 'idle') return { state: { phase: 'arming', since: nowMs, inBubble: false, dragHold: false }, action: 'none' }
      // 宽限期内移回锚点：立即复展开（不重新计时 300ms）
      if (state.phase === 'closing') return { state: { phase: 'open', since: 0, inBubble: state.inBubble, dragHold: false }, action: 'none' }
      return { state, action: 'none' }
    case 'leave-anchor':
      if (state.phase === 'arming') return { state: initialHoverState(), action: 'none' }
      if (state.phase === 'open' && !state.inBubble) return { state: { phase: 'closing', since: nowMs, inBubble: false, dragHold: state.dragHold }, action: 'none' }
      return { state, action: 'none' }
    case 'enter-bubble': {
      // 指针移入气泡：取消待收起（宽限内进入是正常路径）
      if (state.phase === 'closing') return { state: { phase: 'open', since: 0, inBubble: true, dragHold: state.dragHold }, action: 'none' }
      if (state.phase === 'open') return { state: { phase: 'open', since: 0, inBubble: true, dragHold: state.dragHold }, action: 'none' }
      return { state: { ...state, inBubble: true }, action: 'none' }
    }
    case 'leave-bubble':
      if (state.phase === 'open') return { state: { phase: 'closing', since: nowMs, inBubble: false, dragHold: state.dragHold }, action: 'none' }
      return { state: { ...state, inBubble: false }, action: 'none' }
    case 'esc':
      if (state.phase === 'open' || state.phase === 'closing') return { state: initialHoverState(), action: 'close' }
      if (state.phase === 'arming') return { state: initialHoverState(), action: 'none' }
      return { state, action: 'none' }
    case 'reset':
      return { state: initialHoverState(), action: state.phase === 'open' || state.phase === 'closing' ? 'close' : 'none' }
    case 'tick':
      if (state.phase === 'arming' && nowMs - state.since >= HOVER_OPEN_MS) {
        return { state: { phase: 'open', since: 0, inBubble: state.inBubble, dragHold: state.dragHold }, action: 'open' }
      }
      if (state.phase === 'closing' && nowMs - state.since >= HOVER_GRACE_MS) {
        return { state: initialHoverState(), action: 'close' }
      }
      return { state, action: 'none' }
  }
}
