/**
 * 选区状态机语义矩阵测试（工单20，纯逻辑直测——#19 spec 三缝之三：语义矩阵穷举，
 * 每类语义的端到端代表用例归验收电池）。选区跨分区由构造保证：模型只存名字，
 * 分区根本不进输入。
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, itemMenuPlan, launchListOf, nextSelection } from '../../src/renderer/selection'
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

describe('band 框选替换（工单21）', () => {
  it('空集上框选 → 命中名单即选区（命中序 = 渲染层 DOM 序）', () => {
    const m = nextSelection(EMPTY_SELECTION, { type: 'band', names: ['B', 'A'] })
    expect(m.names).toEqual(['B', 'A'])
    expect(m.swallowed).toBeNull()
  })
  it('框选替换现选区（跨笔重选）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'band', names: ['C', 'D'] },
    )
    expect(m.names).toEqual(['C', 'D'])
  })
  it('框选作废吞集（此后双击不再整集启动）', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'B' },
    )
    const m = nextSelection(m0, { type: 'band', names: ['C'] })
    expect(m.swallowed).toBeNull()
    expect(launchListOf(m, 'B')).toEqual(['B'])
  })
  it('命中空名单 → 清空（框到纯空白处）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'band', names: [] },
    )
    expect(m.names).toEqual([])
  })
  it('替换后再 reconcile 仍按名存续', () => {
    const m = seq(
      { type: 'band', names: ['A', 'B'] },
      { type: 'reconcile', liveNames: ['B', 'X'] },
    )
    expect(m.names).toEqual(['B'])
  })
})

describe('ctrl-band 框选并集（工单21）', () => {
  it('与现选区求并集：旧选区保序在前、新命中依序追加', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-band', names: ['C', 'D'] },
    )
    expect(m.names).toEqual(['B', 'A', 'C', 'D'])
  })
  it('命中已选条目不重复（按名去重）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-band', names: ['B', 'C', 'A'] },
    )
    expect(m.names).toEqual(['A', 'B', 'C'])
  })
  it('命中空名单 → 选区原样保留（Ctrl 框到纯空白处不清空）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'ctrl-band', names: [] },
    )
    expect(m.names).toEqual(['A', 'B'])
  })
  it('空集上 ctrl-band = 命中名单', () => {
    const m = nextSelection(EMPTY_SELECTION, { type: 'ctrl-band', names: ['A', 'B'] })
    expect(m.names).toEqual(['A', 'B'])
  })
  it('并集作废吞集', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'B' },
    )
    const m = nextSelection(m0, { type: 'ctrl-band', names: ['C'] })
    expect(m.swallowed).toBeNull()
  })
  it('跨笔累积：band 重选后再 ctrl-band 追加（真桌面分几笔圈选）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'X' },
      { type: 'band', names: ['C', 'D'] },
      { type: 'ctrl-band', names: ['D', 'E'] },
    )
    expect(m.names).toEqual(['C', 'D', 'E'])
  })
})

describe('select-all 全选（工单23 菜单）', () => {
  it('空集上全选 → 名单即选区（live 序）', () => {
    const m = nextSelection(EMPTY_SELECTION, { type: 'select-all', names: ['A', 'B', 'C'] })
    expect(m.names).toEqual(['A', 'B', 'C'])
    expect(m.swallowed).toBeNull()
  })
  it('全选替换现选区（旧选区不保序混入）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'X' },
      { type: 'ctrl-click', name: 'Y' },
      { type: 'select-all', names: ['A', 'B'] },
    )
    expect(m.names).toEqual(['A', 'B'])
  })
  it('全选作废吞集（此后双击不再整集启动）', () => {
    const m0 = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
      { type: 'click', name: 'B' },
    )
    const m = nextSelection(m0, { type: 'select-all', names: ['A', 'B', 'C'] })
    expect(m.swallowed).toBeNull()
    expect(launchListOf(m, 'B')).toEqual(['B'])
  })
  it('全选后再 reconcile 按名存续（消失条目剔除）', () => {
    const m = seq(
      { type: 'select-all', names: ['A', 'B', 'C'] },
      { type: 'reconcile', liveNames: ['A', 'C'] },
    )
    expect(m.names).toEqual(['A', 'C'])
  })
})

describe('itemMenuPlan 条目上下文菜单裁决（工单24 单项 / 工单26 多选）', () => {
  it('该条即全部选区（单选态）→ 弹单项菜单，选区不动', () => {
    const m = nextSelection(EMPTY_SELECTION, { type: 'click', name: 'A' })
    expect(itemMenuPlan(m, 'A')).toEqual({ kind: 'single', switchTo: null })
  })
  it('空选区右键条目 → 单项菜单，先切该条', () => {
    expect(itemMenuPlan(EMPTY_SELECTION, 'A')).toEqual({ kind: 'single', switchTo: 'A' })
  })
  it('选区在别条（单选）右键集外条 → 单项菜单，先切该条', () => {
    const m = nextSelection(EMPTY_SELECTION, { type: 'click', name: 'X' })
    expect(itemMenuPlan(m, 'A')).toEqual({ kind: 'single', switchTo: 'A' })
  })
  it('选中集内条目（选区多于一条）→ 弹多选菜单，动作作用于整集（无选区副作用）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
    )
    expect(itemMenuPlan(m, 'A')).toEqual({ kind: 'multi' })
    expect(itemMenuPlan(m, 'B')).toEqual({ kind: 'multi' })
  })
  it('选中集右键集外条 → 仍单项菜单先切该条（切换语义归 click 事件）', () => {
    const m = seq(
      { type: 'ctrl-click', name: 'A' },
      { type: 'ctrl-click', name: 'B' },
    )
    expect(itemMenuPlan(m, 'C')).toEqual({ kind: 'single', switchTo: 'C' })
    expect(nextSelection(m, { type: 'click', name: 'C' }).names).toEqual(['C'])
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
