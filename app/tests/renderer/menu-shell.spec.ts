/**
 * 上下文菜单 shell 纯逻辑测试（工单23——#19 spec 三缝之三：开合/激活转移矩阵穷举，
 * DOM 呈现与端到端行为归验收电池）。shell 是自绘菜单的公共地基：状态只存行清单与
 * 原点，动作回调由插件侧旁路持有，不进状态。
 */
import { describe, expect, it } from 'vitest'
import { CLOSED_MENU, clampMenuOrigin, nextMenuShell } from '../../src/renderer/cards/context-menu/menu'
import type { MenuShellState } from '../../src/renderer/cards/context-menu/menu'

const ROWS = [{ id: 'select-all', label: 'SELECT ALL' }, { id: 'reset-layout', label: 'RESET LAYOUT' }]

function feed(state: MenuShellState, ...events: Parameters<typeof nextMenuShell>[1][]): MenuShellState {
  return events.reduce((s, e) => nextMenuShell(s, e).state, state)
}

describe('open 打开', () => {
  it('闭态打开 → 状态携带行清单与原点，存证一次 + show + 热区重声明', () => {
    const { state, effects } = nextMenuShell(CLOSED_MENU, { type: 'open', x: 30, y: 40, rows: ROWS })
    expect(state).toEqual({ open: true, x: 30, y: 40, rows: ROWS })
    expect(effects).toHaveLength(1)
    expect(effects[0].notify?.type).toBe('desktop-menu-opened')
    expect(effects[0].notify?.payload).toEqual({ x: 30, y: 40, items: ['select-all', 'reset-layout'] })
    expect(effects[0].dom).toBe('show')
    expect(effects[0].hotzones).toBe(true)
  })
  it('空行清单不弹空壳（无转移无存证）', () => {
    const { state, effects } = nextMenuShell(CLOSED_MENU, { type: 'open', x: 1, y: 2, rows: [] })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toEqual([])
  })
  it('开态重复 open = 换位重弹：原点更新、存证再次发出（确定性契约）', () => {
    const opened = feed(CLOSED_MENU, { type: 'open', x: 10, y: 10, rows: ROWS })
    const { state, effects } = nextMenuShell(opened, { type: 'open', x: 50, y: 60, rows: ROWS })
    expect(state.open).toBe(true)
    expect(state.x).toBe(50)
    expect(state.y).toBe(60)
    expect(effects).toHaveLength(1)
    expect(effects[0].notify?.type).toBe('desktop-menu-opened')
  })
})

describe('activate 行激活（动作执行后收起）', () => {
  it('激活已知行 → 先转交动作、后存证收起（reason=action），状态闭合', () => {
    const opened = feed(CLOSED_MENU, { type: 'open', x: 0, y: 0, rows: ROWS })
    const { state, effects } = nextMenuShell(opened, { type: 'activate', id: 'select-all' })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toHaveLength(2)
    expect(effects[0].run).toBe('select-all')
    expect(effects[0].notify).toBeUndefined()
    expect(effects[1].notify?.type).toBe('desktop-menu-closed')
    expect(effects[1].notify?.payload).toEqual({ reason: 'action' })
    expect(effects[1].dom).toBe('hide')
    expect(effects[1].hotzones).toBe(true)
  })
  it('未知行 id 是噪声：无转移无存证', () => {
    const opened = feed(CLOSED_MENU, { type: 'open', x: 0, y: 0, rows: ROWS })
    const { state, effects } = nextMenuShell(opened, { type: 'activate', id: 'ghost' })
    expect(state.open).toBe(true)
    expect(effects).toEqual([])
  })
  it('闭态激活是迟到事件：无转移无存证', () => {
    const { state, effects } = nextMenuShell(CLOSED_MENU, { type: 'activate', id: 'select-all' })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toEqual([])
  })
})

describe('dismiss 菜单外按下收起', () => {
  it('开态收起 → 存证 reason=outside + hide + 热区重声明', () => {
    const opened = feed(CLOSED_MENU, { type: 'open', x: 0, y: 0, rows: ROWS })
    const { state, effects } = nextMenuShell(opened, { type: 'dismiss' })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toHaveLength(1)
    expect(effects[0].notify?.type).toBe('desktop-menu-closed')
    expect(effects[0].notify?.payload).toEqual({ reason: 'outside' })
    expect(effects[0].dom).toBe('hide')
    expect(effects[0].hotzones).toBe(true)
  })
  it('闭态收起是噪声：无存证（开合存证严格成对）', () => {
    const { state, effects } = nextMenuShell(CLOSED_MENU, { type: 'dismiss' })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toEqual([])
  })
})

describe('unmount 插件卸载（热插拔静默收场）', () => {
  it('开态卸载 → 静默收起（不走存证——存证通道随插件消亡），只 hide + 热区重声明', () => {
    const opened = feed(CLOSED_MENU, { type: 'open', x: 0, y: 0, rows: ROWS })
    const { state, effects } = nextMenuShell(opened, { type: 'unmount' })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toHaveLength(1)
    expect(effects[0].notify).toBeUndefined()
    expect(effects[0].dom).toBe('hide')
    expect(effects[0].hotzones).toBe(true)
  })
  it('闭态卸载无动作', () => {
    const { state, effects } = nextMenuShell(CLOSED_MENU, { type: 'unmount' })
    expect(state).toEqual(CLOSED_MENU)
    expect(effects).toEqual([])
  })
})

describe('clampMenuOrigin 视口钳制', () => {
  it('视口内原样返回', () => {
    expect(clampMenuOrigin(100, 80, 170, 90, 1920, 1080)).toEqual({ x: 100, y: 80 })
  })
  it('越右/越下边缘按 8px 边距收回', () => {
    expect(clampMenuOrigin(1850, 1040, 170, 90, 1920, 1080)).toEqual({ x: 1742, y: 982 })
  })
  it('视口比菜单还小：钳到 8px 下限（不留负坐标）', () => {
    expect(clampMenuOrigin(0, 0, 500, 400, 300, 200)).toEqual({ x: 8, y: 8 })
  })
})
