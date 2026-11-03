/**
 * 窗口几何控制器纯裁决矩阵（工单376，spec #369 决策 8/12/27）：回声抑制账、失败
 * reconciliation（有限重试 → 异常化）、批量写集决策。t372 探针实证参数（回声窗
 * 1500ms、容差 2px）离线复现——不形成改窗循环的机制保证在此钉死。
 */
import { describe, expect, it } from 'vitest'
import { anomalyDetailOf, clearAnomaly, markAnomaly } from '../../src/main/desktop/geom-control'
import {
  classifyGeomEvent,
  planWrites,
  pruneLedger,
  recordPending,
  retractPending,
  verifyWriteOutcome,
  ECHO_TOLERANCE_PX,
  ECHO_WINDOW_MS,
  MAX_WRITE_ATTEMPTS,
} from '../../src/main/desktop/geom-control'
import type { EchoLedger, AttemptLedger, AnomalySet } from '../../src/main/desktop/geom-control'

const T = { left: 0, top: 0, right: 1280, bottom: 1392 }
const T2 = { left: 1280, top: 0, right: 2560, bottom: 1392 }

describe('回声抑制账（工单376，t372 S6 同参数）', () => {
  it('写入命中期望矩形 = echo 并消费（单写不循环的机制保证）', () => {
    const ledger: EchoLedger = new Map()
    recordPending(ledger, 7, T, 1000)
    expect(classifyGeomEvent(ledger, 7, T, 1200)).toBe('echo')
    expect(ledger.has(7)).toBe(false) // echo 消费：同矩形再来事件 = external
    expect(classifyGeomEvent(ledger, 7, T, 1300)).toBe('external')
  })

  it('回声等值容差 2px（t372 口径）内算 echo', () => {
    const ledger: EchoLedger = new Map()
    recordPending(ledger, 7, T, 1000)
    const drifted = { ...T, right: T.right + ECHO_TOLERANCE_PX, bottom: T.bottom + ECHO_TOLERANCE_PX }
    expect(classifyGeomEvent(ledger, 7, drifted, 1100)).toBe('echo')
  })

  it('过期期望矩形 = external（回声窗 1500ms 外的事件不被吞）', () => {
    const ledger: EchoLedger = new Map()
    recordPending(ledger, 7, T, 1000, ECHO_WINDOW_MS)
    expect(classifyGeomEvent(ledger, 7, T, 1000 + ECHO_WINDOW_MS + 1)).toBe('external')
  })

  it('矩形不符 = external（外部改窗识别）', () => {
    const ledger: EchoLedger = new Map()
    recordPending(ledger, 7, T, 1000)
    expect(classifyGeomEvent(ledger, 7, T2, 1100)).toBe('external')
  })

  it('写失败撤账：失败写不吞后续事件', () => {
    const ledger: EchoLedger = new Map()
    recordPending(ledger, 7, T, 1000)
    retractPending(ledger, 7)
    expect(classifyGeomEvent(ledger, 7, T, 1100)).toBe('external')
  })

  it('pruneLedger 清过期账', () => {
    const ledger: EchoLedger = new Map()
    recordPending(ledger, 1, T, 0, 100)
    recordPending(ledger, 2, T2, 1000, 100)
    pruneLedger(ledger, 1050)
    expect([...ledger.keys()]).toEqual([2])
    pruneLedger(ledger, 2000)
    expect(ledger.size).toBe(0)
  })
})

describe('失败 reconciliation verifyWriteOutcome（工单376，spec 决策 12 不无限重试）', () => {
  it('达标清账 = ok', () => {
    const attempts: AttemptLedger = new Map([[9, 1]])
    const anomalies: AnomalySet = new Set()
    expect(verifyWriteOutcome(attempts, anomalies, 9, T, T)).toBe('ok')
    expect(attempts.has(9)).toBe(false)
  })

  it('未达标计次 = retry；达上限异常化并不再计次', () => {
    const attempts: AttemptLedger = new Map()
    const anomalies: AnomalySet = new Set()
    expect(verifyWriteOutcome(attempts, anomalies, 9, T2, T)).toBe('retry')
    expect(verifyWriteOutcome(attempts, anomalies, 9, T2, T)).toBe('anomaly')
    expect(anomalies.has(9)).toBe(true)
    // 异常窗恒 anomaly（不重试、不阻塞其他窗）
    expect(verifyWriteOutcome(attempts, anomalies, 9, T2, T)).toBe('anomaly')
    expect(MAX_WRITE_ATTEMPTS).toBe(2)
  })

  it('异常窗恢复达标也保持 anomaly（异常态不自动翻身——诊断面稳定）', () => {
    const attempts: AttemptLedger = new Map()
    const anomalies: AnomalySet = new Set()
    verifyWriteOutcome(attempts, anomalies, 9, T2, T)
    verifyWriteOutcome(attempts, anomalies, 9, T2, T)
    expect(verifyWriteOutcome(attempts, anomalies, 9, T, T)).toBe('anomaly')
  })
})

describe('批量写集 planWrites（工单376）', () => {
  it('已达标窗不重写（无谓写窗是回声噪声源）', () => {
    const out = planWrites([{ hwnd: 1, target: T, iconic: false, current: T }], new Set())
    expect(out).toEqual([])
  })

  it('未达标窗进写集（容差内视为达标）', () => {
    const near = { ...T, right: T.right + 1 }
    const out = planWrites([{ hwnd: 1, target: T, iconic: false, current: near }], new Set())
    expect(out).toEqual([]) // tol 1 内不写
    const far = { ...T, right: T.right + 50 }
    expect(planWrites([{ hwnd: 1, target: T, iconic: false, current: far }], new Set()))
      .toEqual([{ hwnd: 1, target: T }])
  })

  it('当前矩形缺位（null）= 写（激活首轮对齐）', () => {
    expect(planWrites([{ hwnd: 2, target: T, iconic: false, current: null }], new Set()))
      .toEqual([{ hwnd: 2, target: T }])
  })

  it('最小化窗跳过几何写入（保留窗格，story 19）', () => {
    expect(planWrites([{ hwnd: 3, target: T, iconic: true, current: T2 }], new Set())).toEqual([])
  })

  it('异常窗跳过（不阻塞其他窗——spec 决策 12）', () => {
    const anomalies: AnomalySet = new Set([3])
    expect(planWrites(
      [
        { hwnd: 3, target: T, iconic: false, current: T2 },
        { hwnd: 4, target: T2, iconic: false, current: T },
      ],
      anomalies,
    )).toEqual([{ hwnd: 4, target: T2 }])
  })
})

describe('异常分类账（工单377，spec 决策 12 细分类）', () => {
  it('markAnomaly 同进出：AnomalySet 与分类账一致', () => {
    const anomalies = new Set<number>()
    const kinds = new Map<number, 'fixed-size' | 'write-denied' | 'refused'>()
    markAnomaly(anomalies, kinds, 7, 'fixed-size')
    expect([...anomalies]).toEqual([7])
    expect(kinds.get(7)).toBe('fixed-size')
  })

  it('anomalyDetailOf 按三类计数（合计 = 异常数）', () => {
    const anomalies = new Set<number>()
    const kinds = new Map<number, 'fixed-size' | 'write-denied' | 'refused'>()
    markAnomaly(anomalies, kinds, 1, 'fixed-size')
    markAnomaly(anomalies, kinds, 2, 'write-denied')
    markAnomaly(anomalies, kinds, 3, 'write-denied')
    markAnomaly(anomalies, kinds, 4, 'refused')
    const d = anomalyDetailOf(kinds)
    expect(d).toEqual({ fixedSize: 1, denied: 2, refused: 1 })
    expect(d.fixedSize + d.denied + d.refused).toBe(anomalies.size)
  })

  it('clearAnomaly 同进出：两侧同时消失（hwnd 复用不继承旧异常）', () => {
    const anomalies = new Set<number>()
    const kinds = new Map<number, 'fixed-size' | 'write-denied' | 'refused'>()
    markAnomaly(anomalies, kinds, 9, 'refused')
    clearAnomaly(anomalies, kinds, 9)
    expect(anomalies.size).toBe(0)
    expect(kinds.size).toBe(0)
  })
})
