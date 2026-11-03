// 逐窗几何授权状态机·纯裁决层（工单378，spec #369 决策 9/10/11；GLOSSARY「手动几何
// 授权」「浮动窗口」「恢复平铺」）。零 IO 零 FFI 零 electron——离线 vitest 直驱；编排
// 接线在 services/agent-tiling.ts（事件 → 决策 → 复原/浮动/提示），FFI 动作在
// desktop/geom-write.ts（SetWindowPos / WM_SYSCOMMAND SC_RESTORE，t372 实证路径）。
//
// 两轴模型（三态的业务实义在此正交表达）：
// - mode：tiled（在平铺树里）| floating（手动浮动，几何保留、不参与规划、可覆盖窗格）；
// - phase：locked（未授权）| prompt（首次操作已复原、等待「调整窗口/保持平铺」）|
//   armed（已确认、等待用户重新发起操作）。
// 对外三态 = tiled+locked（锁定平铺）/ tiled+armed（已授权仍平铺）/ floating（手动浮动）。
// 两轴分开是因为「切出保留浮动几何但撤销授权」：浮动是窗口状态，授权是当次进入的许可，
// 撤销许可不会把浮动窗拉回平铺树（GLOSSARY「浮动窗口」）。
//
// 事件判据（决策 10「首次操作先复原并询问、后台自改不弹框」）：
// - echo：自身写窗的回声（期望矩形命中）——不是用户操作，零动作；
// - userGesture：事件发生时目标窗在前台（拖动/边框/最大化/键盘/Snap 都作用于前台窗）；
//   后台自改不满足——复原但**不弹框**（story 30「后台自改被锁定规则纠正」）。
//   前台判据的诚实边界：应用在前台自行改尺寸与用户操作不可区分，按用户操作处理（宁可多
//   一次确认，不静默放过）。
// - changed：当前矩形与该窗平铺目标（或浮动记忆几何）不一致（容差在编排层给）。
//
// 状态迁移（决策 10/11）：
//   tiled locked  + 用户改 → 复原 + prompt（授权请求上行）
//   tiled locked  + 后台改 → 复原（不弹框）
//   tiled prompt  + 任何改 → 复原（提示期锁在格上）
//   tiled armed   + 用户改 → 浮动（实际修改消费授权，其余窗重排）
//   tiled armed   + 后台改 → 复原（授权不因后台自改丢失）
//   floating *    + 用户改 → locked 复原+prompt / armed 接受（已消费授权后再次操作要重新确认）
//   floating *    + 后台改 → 不动作（浮动窗本就不受平铺约束）
//   confirm ≠ 几何写入（决策 9「确认本身不产生几何写入」），确认后须重新发起操作。
// 授权只在内存存续：切出撤销（revokeAuth，浮动保留）、恢复平铺清除（clearFloating +
// revokeAuth）、窗口消失即清（forget）；重启即失（无持久化）。

import type { TileRect } from './tiling-plan'

/** 授权阶段（缺省 = locked，不建条目） */
export type AuthPhase = 'locked' | 'prompt' | 'armed'

/** 几何事件决策（编排层据此复原 / 弹框 / 浮动 / 接受浮动几何） */
export type GeomAuthAction =
  | 'none' // 回声、无变化、浮动后台改：零动作
  | 'restore-silent' // 复原但不弹框（后台自改 / 提示期持续复原）
  | 'restore' // 提示期持续复原（已在 prompt）
  | 'restore-prompt' // 首次用户操作：复原并显示授权提示
  | 'float' // 已授权实际修改：脱离平铺树转浮动
  | 'accept' // 浮动窗已授权实际修改：接受新几何（仍是浮动）

/** 逐窗几何授权账（内存；进程重建即空） */
export interface GeomAuthLedger {
  /** hwnd → 授权阶段（缺省 = locked） */
  phase: Map<number, AuthPhase>
  /** 浮动窗 hwnd → 保留的浮动几何（切出撤销授权后首次操作按此复原） */
  floating: Map<number, TileRect>
}

/** 空账 */
export function createGeomAuthLedger(): GeomAuthLedger {
  return { phase: new Map(), floating: new Map() }
}

/** 当前阶段（缺省 locked） */
export function phaseOf(ledger: GeomAuthLedger, hwnd: number): AuthPhase {
  return ledger.phase.get(hwnd) ?? 'locked'
}

/** 写阶段（locked 即删条目——缺省值不占账） */
export function setPhase(ledger: GeomAuthLedger, hwnd: number, phase: AuthPhase): void {
  if (phase === 'locked') ledger.phase.delete(hwnd)
  else ledger.phase.set(hwnd, phase)
}

/** 是否浮动窗 */
export function isFloating(ledger: GeomAuthLedger, hwnd: number): boolean {
  return ledger.floating.has(hwnd)
}

/** 浮动窗集合（账序 = 进入浮动序，用于恢复平铺的确定性补入顺序） */
export function floatingIds(ledger: GeomAuthLedger): number[] {
  return [...ledger.floating.keys()]
}

/** 记录浮动窗当前几何（每拍观察；切出撤销授权后首次操作按此复原） */
export function rememberFloating(ledger: GeomAuthLedger, hwnd: number, rect: TileRect): void {
  if (!ledger.floating.has(hwnd)) return
  ledger.floating.set(hwnd, { ...rect })
}

/** 浮动窗当前记忆几何（非浮动 = null） */
export function floatingRectOf(ledger: GeomAuthLedger, hwnd: number): TileRect | null {
  const r = ledger.floating.get(hwnd)
  return r ? { ...r } : null
}

/** 进入 prompt（首次用户操作已复原） */
export function beginPrompt(ledger: GeomAuthLedger, hwnd: number): void {
  setPhase(ledger, hwnd, 'prompt')
}

/** 确认「调整窗口」：prompt → armed（不写几何——确认本身不重排，决策 9） */
export function confirmAuth(ledger: GeomAuthLedger, hwnd: number): boolean {
  if (phaseOf(ledger, hwnd) !== 'prompt') return false
  setPhase(ledger, hwnd, 'armed')
  return true
}

/** 「保持平铺」/ Esc：prompt → locked（窗口已在格上，不另写） */
export function cancelAuth(ledger: GeomAuthLedger, hwnd: number): boolean {
  if (phaseOf(ledger, hwnd) !== 'prompt') return false
  setPhase(ledger, hwnd, 'locked')
  return true
}

/**
 * 平铺窗首次实际修改：tiled → floating，记忆当前几何。
 * **授权不在此消费**——一次持续授权覆盖整个拖动：进入浮动的同一次操作还会继续产生几何
 * 变化，此时消费会让后续每个事件都重新弹框。编排层在几何静止（settle）后调 consumeAuth。
 */
export function enterFloating(ledger: GeomAuthLedger, hwnd: number, rect: TileRect): void {
  ledger.floating.set(hwnd, { ...rect })
}

/** 浮动窗已授权实际修改：更新记忆几何（授权同样留到本次操作静止后消费） */
export function acceptFloating(ledger: GeomAuthLedger, hwnd: number, rect: TileRect): void {
  if (!ledger.floating.has(hwnd)) return
  ledger.floating.set(hwnd, { ...rect })
}

/** 一次持续授权结束（操作静止后）：armed → locked——下次操作需重新确认 */
export function consumeAuth(ledger: GeomAuthLedger, hwnd: number): boolean {
  if (phaseOf(ledger, hwnd) !== 'armed') return false
  setPhase(ledger, hwnd, 'locked')
  return true
}

/** 撤销未消费授权（切出 Agent 桌面）：prompt/armed → locked；浮动窗保留（几何不丢）。
 *  返回被撤销的 hwnd（编排层据此关闭提示窗）。 */
export function revokeAuth(ledger: GeomAuthLedger): number[] {
  const changed: number[] = []
  for (const [hwnd, phase] of [...ledger.phase]) {
    if (phase !== 'locked') changed.push(hwnd)
  }
  ledger.phase.clear()
  return changed
}

/** 恢复平铺：收回全部浮动（返回被收回的 hwnd，按进入浮动序）——几何交由编排层重排 */
export function clearFloating(ledger: GeomAuthLedger): number[] {
  const ids = floatingIds(ledger)
  ledger.floating.clear()
  return ids
}

/** 窗口消失：授权与浮动账一并清除（同一 hwnd 复用是新窗身份，不继承旧状态） */
export function forget(ledger: GeomAuthLedger, hwnd: number): boolean {
  const had = ledger.phase.delete(hwnd)
  const wasFloating = ledger.floating.delete(hwnd)
  return had || wasFloating
}

/** 投影计数（胶囊/桥只读面与真机断言用） */
export function authCounts(ledger: GeomAuthLedger): { floating: number; prompting: number; authorized: number } {
  let prompting = 0
  let authorized = 0
  for (const phase of ledger.phase.values()) {
    if (phase === 'prompt') prompting++
    else if (phase === 'armed') authorized++
  }
  return { floating: ledger.floating.size, prompting, authorized }
}

/** 几何事件决策（决策矩阵见模块头注） */
export function decideGeomEvent(input: {
  phase: AuthPhase
  floating: boolean
  /** 自身写窗回声（期望矩形命中）——不是用户操作 */
  echo: boolean
  /** 当前几何与该窗目标/记忆几何不一致 */
  changed: boolean
  /** 事件发生时目标窗在前台（用户主动操作） */
  userGesture: boolean
}): GeomAuthAction {
  if (input.echo || !input.changed) return 'none'
  if (input.floating) {
    // 浮动窗不受平铺约束：后台自改不纠正；未授权/已授权的用户操作分别复原+询问 / 接受
    if (input.phase === 'prompt') return 'restore'
    if (input.phase === 'armed') return 'accept'
    return input.userGesture ? 'restore-prompt' : 'none'
  }
  if (input.phase === 'prompt') return 'restore'
  if (input.phase === 'armed') return input.userGesture ? 'float' : 'restore-silent'
  return input.userGesture ? 'restore-prompt' : 'restore-silent'
}
