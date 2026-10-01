/**
 * 选区状态机语义矩阵测试（工单20，纯逻辑直测——#19 spec 三缝之三：语义矩阵穷举，
 * 每类语义的端到端代表用例归验收电池）。选区跨分区由构造保证：模型只存名字，
 * 分区根本不进输入。
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, launchListOf, nextSelection } from '../../src/renderer/selection'
import type { SelectionModel } from '../../src/renderer/selection'

function seq(...events: Parameters<typeof nextSelection>[1][]): SelectionModel {
  return events.reduce((m, e) => nextSelection(m, e), EMPTY_SELECTION)
}

describe('click 单选重置', () => {
  it('空集上单击 → 选区为该条', () => {
    const m = nextSelection(EMPTY_SELECTION, { type: 'click', name: 'A' })
    expect(m.names).toEqual(['A'])
    expect(m.swallowed).toBeNull()
  })
  it('选区多条时单击集内条 → 收束为该条，旧选区被吞下', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'C' },
      { type: 'click', name: 'B' },
    )
    expect(m.names).toEqual(['B'])
    expect(m.swallowed).toEqual(['A', 'B', 'C'])
  })
  it('单击集外条 → 重置为该条，无吞集', () => {
    const m = seq({ type: 'click', name: 'A' }, { type: 'click', name: 'D' })
    expect(m.names).toEqual(['D'])
    expect(m.swallowed).toBeNull()
  })
  it('集合已是单条时再单击该条 → 吞集作废（单选后久再双击不再整集启动）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'B' },
      { type: 'click', name: 'B' },
    )
    expect(m.names).toEqual(['B'])
    expect(m.swallowed).toBeNull()
  })
})

describe('ctrl-click 切换', () => {
  it('逐个追加（插入序保留）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'C' },
    )
    expect(m.names).toEqual(['B', 'A', 'C'])
  })
  it('再点已选条即移除（其余保序）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'C' },
      { type: 'ctrl-click', name: 'B' },
    )
    expect(m.names).toEqual(['A', 'C'])
  })
  it('切换作废吞集', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'A' },
      { type: 'ctrl-click', name: 'C' },
    )
    expect(m.swallowed).toBeNull()
  })
})

describe('blank-click 清空', () => {
  it('非空选区清为空，吞集一并作废', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'A' },
      { type: 'blank-click' },
    )
    expect(m.names).toEqual([])
    expect(m.swallowed).toBeNull()
  })
})

describe('reconcile 按名恢复与消失剔除', () => {
  it('条目全活着 → 选区原样（快照重建不丢）', () => {
    const m0 = seq({ type: 'ctrl-click', name: 'A' }, { type: 'ctrl-click', name: 'B' })
    const m = nextSelection(m0, { type: 'reconcile', liveNames: ['A', 'B', 'X'] })
    expect(m.names).toEqual(['A', 'B'])
  })
  it('部分条目消失 → 只剔除消失者，幸存者保序', () => {
    const m0 = seq({ type: 'ctrl-click', name: 'A' }, { type: 'ctrl-click', name: 'B' }, { type: 'ctrl-click', name: 'C' })
    const m = nextSelection(m0, { type: 'reconcile', liveNames: ['C', 'A'] })
    expect(m.names).toEqual(['A', 'C'])
  })
  it('选区条目全部消失 → 空集（无悬空选中）', () => {
    const m = nextSelection(
      seq({ type: 'ctrl-click', name: 'A' }),
      { type: 'reconcile', liveNames: ['X'] },
    )
    expect(m.names).toEqual([])
  })
  it('吞集同步剔除（吞集里消失的条目不再被双击全开）', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'B' },
    )
    const m = nextSelection(m0, { type: 'reconcile', liveNames: ['B'] })
    expect(launchListOf(m, 'B')).toEqual(['B'])
  })
  it('吞集部分幸存 → 整集启动按幸存者算', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'C' },
      { type: 'click', name: 'B' },
    )
    const m = nextSelection(m0, { type: 'reconcile', liveNames: ['A', 'B'] })
    expect(launchListOf(m, 'B')).toEqual(['A', 'B'])
  })
})

describe('dblclick 双击全开', () => {
  it('吞集含双击条 → 整集按插入序启动，吞集一次性消费', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'C' },
      { type: 'click', name: 'C' },
    )
    expect(launchListOf(m0, 'A')).toEqual(['A', 'B', 'C'])
    const m1 = nextSelection(m0, { type: 'dblclick', name: 'A' })
    expect(m1.names).toEqual(['C']) // 双击不改选区
    expect(launchListOf(m1, 'A')).toEqual(['A']) // 消费后不再整集
  })
  it('无吞集 → 仅该条', () => {
    expect(launchListOf(EMPTY_SELECTION, 'A')).toEqual(['A'])
  })
  it('吞集不含双击条 → 仅该条', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'A' },
    )
    expect(launchListOf(m0, 'D')).toEqual(['D'])
  })
})

describe('组合场景（真桌面双击序列）', () => {
  it('双击序列：click(d1) 收束 → 第二击不入迁移 → dblclick 整集', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'C' },
      { type: 'click', name: 'B' }, // 双击第一击（detail=1）
      { type: 'dblclick', name: 'B' }, // 第二击 detail=2 由渲染层拦下，只余 dblclick
    )
    expect(launchListOf(seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'C' },
      { type: 'click', name: 'B' },
    ), 'B')).toEqual(['A', 'B', 'C'])
    expect(m.names).toEqual(['B'])
  })
  it('单选后过双击窗口再双击同条 → 仅该条（吞集已作废）', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'B' },
      { type: 'click', name: 'B' }, // 窗口外的新一次单击（detail 重新计 1）
    )
    expect(launchListOf(m0, 'B')).toEqual(['B'])
  })
})
