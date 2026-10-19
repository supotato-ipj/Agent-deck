// stall-duel 离线分析（工单132 第一阶段）：探针账合并、耦合统计、次序分类、预登记判读
// 规则的纯函数直测。判读规则在 docs/audit/2026-10-09-t132-stall-duel-experiment.md §4
// 预登记——这里测的是「规则按登记执行」，不是「规则对不对」。
import { describe, expect, it } from 'vitest'
import {
  dedupeProbeStalls,
  nearestDeltaMs,
  couplingStats,
  classifyOrder,
  labelDistribution,
  duelVerdict,
} from '../../accept/experiments/stall-duel-analyze'

describe('dedupeProbeStalls：连续超时段合并为停摆事件', () => {
  it('连续超时拍合并为一个事件，间隔超 mergeGapMs 断开', () => {
    const ev = dedupeProbeStalls([
      { t: 1000, ok: true },
      { t: 1500, ok: false },
      { t: 2000, ok: false },
      { t: 2500, ok: false },
      { t: 3000, ok: true },
      // 6s 空档后的第二段
      { t: 9000, ok: false },
      { t: 9500, ok: false },
      { t: 10000, ok: true },
    ])
    expect(ev).toHaveLength(2)
    expect(ev[0].onsetMs).toBe(1500)
    expect(ev[1].onsetMs).toBe(9000)
  })

  it('单拍超时即成事件（WM_NULL 2s 口径与电池一致：时长含首拍自身超时）', () => {
    const ev = dedupeProbeStalls([
      { t: 1000, ok: false },
      { t: 1500, ok: true },
    ])
    expect(ev).toHaveLength(1)
    expect(ev[0].durationMs).toBe(2000)
  })

  it('自定义 timeoutMs 下不足 minDurationMs 的段不成事件', () => {
    const ev = dedupeProbeStalls([
      { t: 1000, ok: false },
      { t: 1300, ok: true },
    ], { timeoutMs: 1500, minDurationMs: 2000 })
    expect(ev).toHaveLength(0)
  })

  it('事件时长 = onset 到末拍发起 + 其自身超时（恢复时刻的上界）', () => {
    const ev = dedupeProbeStalls([
      { t: 1000, ok: false },
      { t: 1500, ok: false },
      { t: 2000, ok: true },
    ], { timeoutMs: 2000 })
    // 末次超时拍发起于 1500，吃满 2000ms 超时后完成；时长 = 1500-1000+2000 = 2500
    expect(ev[0].durationMs).toBe(2500)
    expect(ev[0].endMs).toBe(3500)
  })

  it('终末不恢复的尾段也是事件（endMs = 末拍完成时刻）', () => {
    const ev = dedupeProbeStalls([
      { t: 5000, ok: false },
      { t: 5500, ok: false },
    ])
    expect(ev).toHaveLength(1)
    expect(ev[0].endMs).toBe(7500)
    expect(ev[0].terminal).toBe(true)
  })
})

describe('nearestDeltaMs / couplingStats：停摆与触发点的耦合', () => {
  it('无触发点时返回 null', () => {
    expect(nearestDeltaMs(1000, [])).toBeNull()
  })

  it('取最近触发的绝对时差', () => {
    expect(nearestDeltaMs(1000, [990, 1300, 400])).toBe(10)
    expect(nearestDeltaMs(1000, [1300])).toBe(300)
  })

  it('couplingStats 按 ≤windowMs 计在窗占比', () => {
    const s = couplingStats([1000, 5000, 90000], [980, 8000, 200], { windowMs: 2000 })
    expect(s.total).toBe(3)
    expect(s.withinWindow).toBe(1) // 仅 1000↔980 在窗
    expect(s.fraction).toBeCloseTo(1 / 3)
  })
})

describe('classifyOrder：renderer 先静默 vs main 先停', () => {
  it('±windowMs 内有 renderer 静默起点则按先后分类（delta 带符号），无则 isolated', () => {
    const cls = classifyOrder(
      [10_000, 50_000],
      [9_000, 60_000],
      { windowMs: 20_000 },
    )
    expect(cls[0]).toMatchObject({ onset: 10_000, order: 'renderer-first', deltaMs: -1000 })
    expect(cls[1]).toMatchObject({ onset: 50_000, order: 'main-first', deltaMs: 10_000 })
  })

  it('跨轮次序漂移检测：两类都在场即 drift', () => {
    const drift = classifyOrder(
      [10_000, 50_000],
      [9_000, 55_000],
      { windowMs: 20_000 },
    )
    expect(drift.map((c) => c.order)).toContain('renderer-first')
    expect(drift.map((c) => c.order)).toContain('main-first')
  })
})

describe('labelDistribution：main-lag liveLabels 聚合', () => {
  it('展平计数，按出现次数降序', () => {
    const dist = labelDistribution([
      { liveLabels: ['pin', 'keyboard-mode-on'] },
      { liveLabels: ['pin'] },
      { liveLabels: [] },
    ])
    expect(dist).toEqual([
      { label: 'pin', count: 2 },
      { label: 'keyboard-mode-on', count: 1 },
    ])
  })
})

describe('duelVerdict：预登记判读规则（spec §4）', () => {
  const arm = (over: Partial<Parameters<typeof duelVerdict>[0]['a']> = {}) => ({
    stallCount: 3,
    activeMinutes: 12,
    couplingWithin: 0,
    couplingTotal: 3,
    labels: ['pin'],
    ...over,
  })

  it('A 臂耦合过半 + B 臂率减半 → H1', () => {
    const v = duelVerdict({
      a: arm({ stallCount: 5, couplingWithin: 4, couplingTotal: 5, labels: ['keyboard-mode-on', 'pin'] }),
      b: arm({ stallCount: 1, activeMinutes: 12 }),
      orderClasses: ['main-first'],
    })
    expect(v.verdict).toBe('H1')
    expect(v.reasons.some((r) => r.includes('耦合'))).toBe(true)
  })

  it('两臂率相当 + 耦合均低 + 次序漂移 → H7', () => {
    const v = duelVerdict({
      a: arm({ couplingWithin: 0, couplingTotal: 4, labels: ['pin'] }),
      b: arm({ stallCount: 4, couplingWithin: 0, couplingTotal: 4, labels: ['cover-scan'] }),
      orderClasses: ['renderer-first', 'main-first'],
    })
    expect(v.verdict).toBe('H7')
  })

  it('两臂率相当但次序不漂移 → H7 判据不满，ambiguous', () => {
    const v = duelVerdict({
      a: arm({ couplingWithin: 0, couplingTotal: 4 }),
      b: arm({ stallCount: 4, couplingWithin: 0, couplingTotal: 4 }),
      orderClasses: ['main-first', 'main-first'],
    })
    expect(v.verdict).toBe('ambiguous')
  })

  it('两臂合计停摆 <3 → inconclusive（样本不足）', () => {
    const v = duelVerdict({
      a: arm({ stallCount: 1, couplingWithin: 1, couplingTotal: 1 }),
      b: arm({ stallCount: 0 }),
      orderClasses: ['renderer-first'],
    })
    expect(v.verdict).toBe('inconclusive')
  })

  it('B 臂 0 停摆且 A 臂耦合不达标 → ambiguous（不冒充 H1）', () => {
    const v = duelVerdict({
      a: arm({ stallCount: 4, couplingWithin: 1, couplingTotal: 4 }),
      b: arm({ stallCount: 0 }),
      orderClasses: ['main-first'],
    })
    expect(v.verdict).toBe('ambiguous')
  })

  it('phase-1b：两臂 Win+D 耦合过半 + 终末 span 在 cover-* → H4（修正版）', () => {
    const v = duelVerdict({
      a: arm({ stallCount: 4, windCouplingWithin: 3, windCouplingTotal: 4 }),
      b: arm({ stallCount: 4, windCouplingWithin: 3, windCouplingTotal: 4 }),
      orderClasses: ['main-first'],
      terminalSpanLabels: ['cover-engage', 'cover-engage'],
      wind: true,
    })
    expect(v.verdict).toBe('H4')
  })
})
