// 窗口几何控制器·纯裁决层（工单376，spec #369 决策 8「窗口几何控制器」的离线半边）：
// 自身写窗回声抑制账、外部改窗识别与失败 reconciliation 决策。零 FFI 零 electron——
// FFI 动作面在 geom-write.ts（SetWindowPos + LOCATIONCHANGE hook，t372 实证路径），
// 编排在 services/agent-tiling.ts（单工作区串行落位、短批处理）。
//
// 回声抑制口径（t372 S6 实证参数）：自身写窗前登记期望矩形（回声窗 1500ms）；
// LOCATIONCHANGE 事件先过账——命中未过期期望矩形（容差 2px）= echo（消费之，不重排）；
// 其余 = external（外部改窗 → 触发一轮重排 reconciliation）。单写不循环的机制保证：
// 重排只由「外部事件 / 集合变化」驱动，echo 事件永不触发写入（乒乓无从产生）。
//
// 失败 reconciliation 口径（spec 决策 12「有限诊断、不无限重试」）：写窗失败或回读
// 核验不达标的窗按尝试计数，超过 MAX_WRITE_ATTEMPTS 即标异常（跳过后续落格、不阻塞
// 其他窗口、不反复弹窗），由异常账面报告——异常窗口的语义分类（固定尺寸/权限不足）
// 在观察层只能给出「拒绝改窗」这一事实，细分类归工单377。

import type { TileRect } from './tiling-plan'
import type { ScopeRect } from './tile-scope'
import { rectMatches } from './tile-scope'

/** 回声抑制账：hwnd → 期望矩形 + 有效期 */
export type EchoLedger = Map<number, { rect: TileRect; until: number }>

/** 默认回声窗（ms，t372 S6 同款 1500ms） */
export const ECHO_WINDOW_MS = 1500
/** 回声等值容差（物理 px，t372 同款） */
export const ECHO_TOLERANCE_PX = 2
/** 同一窗失败重试上限（达到即异常化——不无限重试，spec 决策 12） */
export const MAX_WRITE_ATTEMPTS = 2

/** 写窗前登记期望矩形（writeThrough 同款：登记先行，写入失败由调用方撤销登记） */
export function recordPending(
  ledger: EchoLedger,
  hwnd: number,
  rect: TileRect,
  now: number,
  windowMs = ECHO_WINDOW_MS,
): void {
  ledger.set(hwnd, { rect: { ...rect }, until: now + windowMs })
}

/** 写入失败：撤销登记（失败写不产生回声——窗口没动，别把后续外部事件误吞） */
export function retractPending(ledger: EchoLedger, hwnd: number): void {
  ledger.delete(hwnd)
}

/** 事件归类（工单376 核心判据）：命中未过期期望矩形 = echo（消费之）否则 external */
export function classifyGeomEvent(
  ledger: EchoLedger,
  hwnd: number,
  rect: ScopeRect,
  now: number,
  tol = ECHO_TOLERANCE_PX,
): 'echo' | 'external' {
  const pending = ledger.get(hwnd)
  if (pending && now <= pending.until && rectMatches(rect, pending.rect, tol)) {
    ledger.delete(hwnd)
    return 'echo'
  }
  return 'external'
}

/** 清过期账（编排层每拍收尾调用，防账面无界增长） */
export function pruneLedger(ledger: EchoLedger, now: number): void {
  for (const [hwnd, p] of ledger) if (now > p.until) ledger.delete(hwnd)
}

/** 失败账：hwnd → 已尝试次数 */
export type AttemptLedger = Map<number, number>

/** 异常集（拒绝改窗——MAX_WRITE_ATTEMPTS 次未达标的窗；编排层跳过并报告） */
export type AnomalySet = Set<number>

/** 写后核验决策（失败 reconciliation）：达标清账；未达标计次，达上限即异常化。
 *  返回 'ok' | 'retry' | 'anomaly'——retry/anomaly 由编排层决定是否再写与如何报告。 */
export function verifyWriteOutcome(
  attempts: AttemptLedger,
  anomalies: AnomalySet,
  hwnd: number,
  actual: ScopeRect,
  target: TileRect,
  tol = 1,
): 'ok' | 'retry' | 'anomaly' {
  if (anomalies.has(hwnd)) return 'anomaly'
  if (rectMatches(actual, target, tol)) {
    attempts.delete(hwnd)
    return 'ok'
  }
  const n = (attempts.get(hwnd) ?? 0) + 1
  attempts.set(hwnd, n)
  if (n >= MAX_WRITE_ATTEMPTS) {
    anomalies.add(hwnd)
    attempts.delete(hwnd)
    return 'anomaly'
  }
  return 'retry'
}

/** 批量落位决策（工单376）：按平铺规划逐窗比对当前矩形，产出本拍写集。
 *  异常窗跳过；最小化窗跳过几何写入（保留窗格与顺序，story 19——还原后由下一拍落位）；
 *  已达标窗不重写（无谓写窗是回声噪声源）。 */
export interface WritePlanEntry {
  hwnd: number
  target: TileRect
}

export function planWrites(
  assignments: Array<{ hwnd: number; target: TileRect; iconic: boolean; current: ScopeRect | null }>,
  anomalies: AnomalySet,
): WritePlanEntry[] {
  const out: WritePlanEntry[] = []
  for (const a of assignments) {
    if (anomalies.has(a.hwnd)) continue
    if (a.iconic) continue // 最小化：保留窗格不写几何（还原事件会触发下一拍）
    if (a.current && rectMatches(a.current, a.target)) continue
    out.push({ hwnd: a.hwnd, target: a.target })
  }
  return out
}
