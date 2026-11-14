// 启动反馈状态机（工单483，ADR-0032 点击 SLO ③「≤1 秒图标视觉反馈且启动命令已发出」）：
// 工具图标点击后的「启动中」可视态是渲染层会话态——点击未运行条目 → launching（同一拍
// 呈现，不跨任何 await）；目标应用窗口上栏（running）→ 收敛回常态；启动命令失败回执 →
// 即收（失败文案由条带 toast 承担，不占图标态）；有界超时 → 静默收敛——重型工具自身
// 冷启不记账（SLO 口径），图标不无限转。
//
// 纯函数、零 DOM、零桥（taskbar-view.ts 同域纪律）：状态是不可变投影，渲染层
// taskbar.ts 持有并落位（.tb-app.launching），键 = exe 的归一形（小写 + 斜杠向统一，
// 内核 normalizeExe 同款口径）——推荐条目 exe（lnk 富化）与运行条目 exe（窗口枚举）
// 来源不同，大小写/斜杠形差不归一会让「窗口上栏」的收敛永不命中（工单483 第七轮
// 真机实锤的运行条目缺席即同类来源形差家族）。

/** 反馈窗上界（毫秒）：覆盖已知重型工具冷启（#478 实测 MiniMax ~8.8s、launcher 中介形态
 * 更长），到点静默收敛——命令已发过，工具何时就绪不在面板账上。 */
export const LAUNCH_FEEDBACK_TIMEOUT_MS = 60_000

/** exe 身份键归一（内核 normalizeExe 同款口径）：斜杠向统一 + 小写。同一路径经
 * lnk 富化（推荐条目）与窗口枚举（运行条目）两条来源，形差不归一即收敛失配。 */
function keyOf(exe: string): string {
  return exe.replace(/\//g, '\\').toLowerCase()
}

/** 状态：exe（归一键）→ 首次点击时刻（毫秒）。不可变纪律：转移函数返回新表，不改入参。 */
export type LaunchFeedbackState = ReadonlyMap<string, number>

/**
 * 点击（未运行条目）进入「启动中」。已在册 = 连点：原样返回（起拍时刻保持首次点击，
 * 不被连点无限续期——反馈窗从首次点击起算、有界收敛）。
 */
export function beginLaunchFeedback(state: LaunchFeedbackState, exe: string, now: number): LaunchFeedbackState {
  const key = keyOf(exe)
  if (state.has(key)) return state
  const next = new Map(state)
  next.set(key, now)
  return next
}

/** 目标应用窗口上栏（running 名单）→ 收敛回常态。名单外条目原位保留。 */
export function convergeLaunchFeedback(state: LaunchFeedbackState, runningExes: readonly string[]): LaunchFeedbackState {
  const keys = new Set(runningExes.map(keyOf))
  let next: Map<string, number> | null = null
  for (const exe of keys) {
    if (!state.has(exe)) continue
    next ??= new Map(state)
    next.delete(exe)
  }
  return next ?? state
}

/** 启动命令失败回执 → 即收（图标回常态；未在册 = 空操作，不凭空造出反馈态）。 */
export function settleLaunchFeedback(state: LaunchFeedbackState, exe: string): LaunchFeedbackState {
  const key = keyOf(exe)
  if (!state.has(key)) return state
  const next = new Map(state)
  next.delete(key)
  return next
}

/** 超时收敛：达到上限（now - since ≥ timeoutMs）的键静默移除并回名单（存证用）；未到期原位。 */
export function expireLaunchFeedback(
  state: LaunchFeedbackState,
  now: number,
  timeoutMs: number = LAUNCH_FEEDBACK_TIMEOUT_MS,
): { state: LaunchFeedbackState; expired: string[] } {
  let next: Map<string, number> | null = null
  const expired: string[] = []
  for (const [exe, since] of state) {
    if (now - since < timeoutMs) continue
    next ??= new Map(state)
    next.delete(exe)
    expired.push(exe)
  }
  return { state: next ?? state, expired }
}

/** 渲染投影：该条目此刻是否呈「启动中」（在册且未达上限）。 */
export function launchFeedbackOf(
  state: LaunchFeedbackState,
  exe: string,
  now: number,
  timeoutMs: number = LAUNCH_FEEDBACK_TIMEOUT_MS,
): 'launching' | null {
  const since = state.get(keyOf(exe))
  if (since === undefined) return null
  return now - since < timeoutMs ? 'launching' : null
}
