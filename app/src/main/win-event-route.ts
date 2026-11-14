// 系统窗口事件路由纯函数层（工单475，spec #472 用户故事 19「窗口增删等事件由系统通知
// 驱动，后台静默无事发生而不是每秒数千次系统调用」）：WinEventProc 收到的原始观察 →
// 「是否有窗口世界变化需要再评估」的路由裁决 + 事件突发合并（trailing 防抖 + 最小间隔
// 封顶）的调度计划。裁决与调度全在这里，FFI 钩子安装与驱动循环在 win-events.ts 效果层
// （lazy-bind 纪律：本模块零 FFI、零引用语句，离线单测不触 koffi）。
//
// 替代的旧世界：桌面遮罩守望每 150ms 全窗 z 序双走查、任务栏三态裁决每 250ms 全窗枚举
// （ADR-0032 消耗源盘点）——事件订阅后常驻期零走查，事件到达即按需再评估。
//
// 订阅集（winuser.h 口径）与语义：
// - EVENT_SYSTEM_FOREGROUND（0x0003）：前台窗变化——三态裁决的直接事实源；
// - EVENT_SYSTEM_MINIMIZESTART/END（0x0016/0x0017）：最小化起止——show desktop 起收、
//   Snap 成员最小化的会话事实；
// - EVENT_OBJECT_DESTROY/SHOW/HIDE/REORDER（0x8001-0x8004）：窗口生死与 z 序重排——
//   Progman 抬顶（show desktop）、会话成员关闭；
// - EVENT_OBJECT_STATECHANGE/LOCATIONCHANGE（0x800A/0x800B）：窗口状态与位置/尺寸——
//   Snap 贴靠（Win+方向键，矩形动但 z 序不动）、退出全屏还原（resize）的唯一探测缝；
//   热面（光标/插入符/子对象）在路由处过滤，不进脏位。

/** winuser.h 窗口事件常量（路由判定依据，钩子区间与路由共用同一份真源） */
export const WIN_EVENT = {
  SYSTEM_FOREGROUND: 0x0003,
  SYSTEM_MINIMIZESTART: 0x0016,
  SYSTEM_MINIMIZEEND: 0x0017,
  OBJECT_DESTROY: 0x8001,
  OBJECT_SHOW: 0x8002,
  OBJECT_HIDE: 0x8003,
  OBJECT_REORDER: 0x8004,
  OBJECT_STATECHANGE: 0x800A,
  OBJECT_LOCATIONCHANGE: 0x800B,
} as const

/** winuser.h 对象 id（WinEventProc 的 idObject 以 int32 有符号读回）：整窗对象与两枚
 * 热对象（光标/插入符——全局钩子下最高频噪声源）。OBJID_CURSOR=0xFFFFFFF7、
 * OBJID_CARET=0xFFFFFFF8 的有符号 int32 形态即 -9/-10。 */
export const OBJID_WINDOW = 0x00000000
export const OBJID_CURSOR = -9
export const OBJID_CARET = -10

/** 钩子订阅区间（eventMin..eventMax 闭区间；与 WIN_EVENT 同真源） */
export const SUBSCRIBED_EVENT_RANGES: ReadonlyArray<{ min: number; max: number }> = [
  { min: WIN_EVENT.SYSTEM_FOREGROUND, max: WIN_EVENT.SYSTEM_FOREGROUND },
  { min: WIN_EVENT.SYSTEM_MINIMIZESTART, max: WIN_EVENT.SYSTEM_MINIMIZEEND },
  { min: WIN_EVENT.OBJECT_DESTROY, max: WIN_EVENT.OBJECT_REORDER },
  { min: WIN_EVENT.OBJECT_STATECHANGE, max: WIN_EVENT.OBJECT_LOCATIONCHANGE },
]

/**
 * 一条 WinEventProc 观察的纯数据投影（FFI 回调参数原样搬运，裁决只认这份形状）。
 * atMs = WinEventProc 的 dwmsEventTime（OS 侧事件时刻，GetTickCount 口径）——捕获时延
 * 「OS 事件时刻 → 本方裁决落定」的度量基点。
 */
export interface WinEventObservation {
  eventId: number
  hwnd: number
  idObject: number
  idChild: number
  atMs: number
}

/** 路由裁决：dirty = 有窗口世界变化，消费者应再评估；cursorLike = 热对象事件（已滤） */
export interface WinEventRoute {
  dirty: boolean
  cursorLike: boolean
}

/**
 * 订阅路由（纯函数）：订阅区间内的**整窗对象**事件置脏；光标/插入符对象与子对象事件
 * 不置脏（全局钩子下 LOCATIONCHANGE 的热面——鼠标每采样一次一条、打字逐条，置脏即把
 * 「事件驱动」退化回「准轮询」）。窗口对象取 OBJID_WINDOW 且 idChild=0；光标/插入符
 * 事件 hwnd=0（光标无宿主窗）或自带 OBJID_CURSOR/OBJID_CARET，两形都滤。
 */
export function routeWinEvent(o: WinEventObservation): WinEventRoute {
  if (o.idObject === OBJID_CURSOR || o.idObject === OBJID_CARET) return { dirty: false, cursorLike: true }
  if (o.idObject !== OBJID_WINDOW || o.idChild !== 0) return { dirty: false, cursorLike: false }
  const dirty = SUBSCRIBED_EVENT_RANGES.some((r) => o.eventId >= r.min && o.eventId <= r.max)
  return { dirty, cursorLike: false }
}

/* ================================================================
 * 事件突发合并（trailing 防抖 + 最小间隔封顶）的调度计划（纯函数）
 * ================================================================ */

/** 事件泵账本：pendingSinceMs = 最老未冲刷事件的本方到达时刻（null=无悬挂）；lastFireMs = 上次冲刷时刻 */
export interface EventPumpState {
  pendingSinceMs: number | null
  lastFireMs: number | null
}

export const EMPTY_PUMP_STATE: EventPumpState = { pendingSinceMs: null, lastFireMs: null }

/** 冲刷配置：quietMs=静默判定窗（trailing 防抖）；minIntervalMs=两次冲刷的最小间隔（突发封顶） */
export interface PumpFlushConfig {
  quietMs: number
  minIntervalMs: number
}

/** 一次调度尝试的产出：fire=是否触发消费者再评估；recheckInMs=距下次应尝试的毫秒数（null=无悬挂可停表） */
export interface PumpFlushPlan {
  fire: boolean
  state: EventPumpState
  recheckInMs: number | null
}

/** 到达一条脏事件：账本记「最老未冲刷」时刻（同批突发取首条——捕获时延按它度量） */
export function markEventPending(state: EventPumpState, nowMs: number): EventPumpState {
  return state.pendingSinceMs === null ? { ...state, pendingSinceMs: nowMs } : state
}

/**
 * 冲刷调度（纯函数，驱动循环每拍询问）：
 * - 无悬挂 → 不触发、可停表；
 * - 悬挂未满静默窗 → 等到静默满（pendingSince + quietMs）；
 * - 静默已满但距上次冲刷不足最小间隔 → 等到间隔满（防突发风暴把再评估打到超频——
 *   封顶后最坏频率与旧 250ms 轮询同量级，风暴期不劣化、静默期零成本）；
 * - 两条件齐 → 触发并清悬挂；lastFireMs 恒记触发时刻。
 */
export function planEventFlush(state: EventPumpState, nowMs: number, cfg: PumpFlushConfig): PumpFlushPlan {
  if (state.pendingSinceMs === null) return { fire: false, state, recheckInMs: null }
  const quietOk = nowMs - state.pendingSinceMs >= cfg.quietMs
  const intervalOk = state.lastFireMs === null || nowMs - state.lastFireMs >= cfg.minIntervalMs
  if (quietOk && intervalOk) {
    return { fire: true, state: { pendingSinceMs: null, lastFireMs: nowMs }, recheckInMs: null }
  }
  if (!intervalOk) {
    return { fire: false, state, recheckInMs: state.lastFireMs! + cfg.minIntervalMs - nowMs }
  }
  return { fire: false, state, recheckInMs: state.pendingSinceMs + cfg.quietMs - nowMs }
}
