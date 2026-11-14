// 分屏会话增量 diff 调度（工单475）：三态裁决的全窗枚举探针从「每拍无条件全走查」
// 改为「事件驱动 + 成员复检 + 新鲜度兜底」的增量计划纯缝（ADR-0032 新鲜度降级档——
// 会话扫描 3~5 秒）。断言面：静默复用（常驻期零枚举）、事件脏位全量、成员失格全量、
// 新鲜度兜底。悬垂面：probeSnapWindows 的 FFI 事实采集（既有 snap 探针成本口径在案）。
import { describe, expect, it } from 'vitest'
import { planSnapBeat } from '../../src/main/taskbar/snap'
import type { SnapMemberCheck } from '../../src/main/taskbar/snap'

/** 一枚仍合格成员的便宜位复检（alive+visible+arranged+非最小化） */
function ok(hwnd: number): SnapMemberCheck {
  return { hwnd, alive: true, visible: true, iconic: false, arranged: true }
}

describe('planSnapBeat 增量 diff（工单475 纯调度）', () => {
  const FRESH = { nowMs: 10_000, lastFullProbeMs: 8_000, fullProbeFreshnessMs: 5_000 }

  it('静默稳态（无会话、窗口世界无事件、新鲜度内）→ 复用缓存，不发起全量探针（常驻期零枚举的稳态）', () => {
    expect(planSnapBeat({ prevMembers: [], checks: [], worldDirty: false, ...FRESH })).toEqual({
      type: 'reuse',
      active: false,
    })
  })

  it('静默稳态（有会话、成员便宜位全部合格）→ 复用缓存 active=true，不发起全量探针', () => {
    expect(planSnapBeat({ prevMembers: [101, 102], checks: [ok(101), ok(102)], worldDirty: false, ...FRESH }))
      .toEqual({ type: 'reuse', active: true })
  })

  it('窗口世界有过事件（脏位）→ 全量探针（事件驱动的重建拍，理由 world-dirty）', () => {
    expect(planSnapBeat({ prevMembers: [101], checks: [ok(101)], worldDirty: true, ...FRESH }))
      .toEqual({ type: 'full-probe', reason: 'world-dirty' })
    expect(planSnapBeat({ prevMembers: [], checks: [], worldDirty: true, ...FRESH }))
      .toEqual({ type: 'full-probe', reason: 'world-dirty' })
  })

  it('成员便宜位失格（最小化/解除/销毁任一位翻转）且世界无事件 → 全量探针定谳结束（理由 member-lost）', () => {
    const cases: SnapMemberCheck[] = [
      { hwnd: 101, alive: true, visible: true, iconic: true, arranged: true }, // 最小化
      { hwnd: 101, alive: true, visible: true, iconic: false, arranged: false }, // 解除 Snap
      { hwnd: 101, alive: false, visible: false, iconic: false, arranged: false }, // 已关闭
    ]
    for (const check of cases) {
      expect(planSnapBeat({ prevMembers: [101], checks: [check], worldDirty: false, ...FRESH }))
        .toEqual({ type: 'full-probe', reason: 'member-lost' })
    }
  })

  it('部分成员失格即整组全量（集合生命周期：最后一枚消失才结束，多窗集合要看全貌）', () => {
    const checks = [ok(101), { hwnd: 102, alive: true, visible: true, iconic: true, arranged: true }]
    expect(planSnapBeat({ prevMembers: [101, 102], checks, worldDirty: false, ...FRESH }))
      .toEqual({ type: 'full-probe', reason: 'member-lost' })
  })

  it('新鲜度兜底：距上次全量探针超过新鲜度上限 → 全量探针（理由 freshness，事件漏投保险）', () => {
    expect(planSnapBeat({
      prevMembers: [],
      checks: [],
      worldDirty: false,
      nowMs: 13_100,
      lastFullProbeMs: 8_000,
      fullProbeFreshnessMs: 5_000,
    })).toEqual({ type: 'full-probe', reason: 'freshness' })
    // 恰在新鲜度边界内不兜底
    expect(planSnapBeat({
      prevMembers: [101],
      checks: [ok(101)],
      worldDirty: false,
      nowMs: 13_000,
      lastFullProbeMs: 8_000,
      fullProbeFreshnessMs: 5_000,
    })).toEqual({ type: 'reuse', active: true })
  })

  it('首次拍（从未全量探针）→ 全量探针（立基线）', () => {
    expect(planSnapBeat({
      prevMembers: [],
      checks: [],
      worldDirty: false,
      nowMs: 100,
      lastFullProbeMs: null,
      fullProbeFreshnessMs: 5_000,
    })).toEqual({ type: 'full-probe', reason: 'freshness' })
  })

  it('脏位压过成员失格与新鲜度（同一拍多理由并存时只报一条，优先级 world-dirty > member-lost > freshness）', () => {
    const lost = { hwnd: 101, alive: false, visible: false, iconic: false, arranged: false }
    expect(planSnapBeat({ prevMembers: [101], checks: [lost], worldDirty: true, ...FRESH }))
      .toEqual({ type: 'full-probe', reason: 'world-dirty' })
  })
})
