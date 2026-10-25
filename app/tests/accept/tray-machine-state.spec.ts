// 托盘机器态判定纯函数（工单141，spec #145 唯一新 seam）：穷举探测事实矩阵，
// 断言判定/记账决定/适用断言面/定向失败语。判定是纯函数——注册表与 spans 的
// 探测合理性归电池真机轮。严口径核心断言：trayAddSpan 缺席时一切条件 allowExclude=false。
import { describe, expect, it } from 'vitest'
import { judgeTrayMachineState, DND_MARKER } from '../../accept/lib/tray-machine-state'

describe('托盘机器态判定（judgeTrayMachineState 矩阵）', () => {
  it('健康态（条目在场+已提升+识别色可见+无勿扰）→ null：照常硬失败', () => {
    expect(judgeTrayMachineState({ entryExists: true, promoted: 1, trayAddSpan: true, dndMarkerSeen: false, amberVisible: true })).toBeNull()
    expect(judgeTrayMachineState({ entryExists: true, promoted: 1, trayAddSpan: false, dndMarkerSeen: false, amberVisible: true })).toBeNull()
  })

  it.each([
    ['条目缺失+注册存证', { entryExists: false, promoted: null, trayAddSpan: true }],
  ])('%s → entry-missing-machine，三面全门禁，允许环境降责', (_name, base) => {
    const g = judgeTrayMachineState(base)!
    expect(g.condition).toBe('entry-missing-machine')
    expect(g.allowExclude).toBe(true)
    expect(g.appliesTo).toEqual(['P8-register', 'P8-visibility', 'P10-nav'])
    expect(g.reason).toContain('tray-add 存证')
    expect(g.reason).toContain('建档时序')
    expect(g.directed).toContain('机器态，非面板回归')
  })

  it.each([
    ['条目缺失', { entryExists: false, promoted: null, trayAddSpan: false }],
    ['提升位未置', { entryExists: true, promoted: 0, trayAddSpan: false, amberVisible: false }],
    ['提升已置但无识别色', { entryExists: true, promoted: 1, trayAddSpan: false, amberVisible: false }],
    ['勿扰布局', { entryExists: true, promoted: 1, trayAddSpan: false, dndMarkerSeen: true, amberVisible: true }],
  ])('%s + 无注册存证 → 严口径收紧：allowExclude=false，失败语带「不定责环境」', (_name, base) => {
    const g = judgeTrayMachineState(base)!
    expect(g.allowExclude).toBe(false)
    expect(g.condition.endsWith('-unverified')).toBe(true)
    expect(g.directed).toContain('不定责环境')
  })

  it('提升位未置+注册存证 → overflow-unpromoted，只门禁可见与导航、不门禁注册', () => {
    const g = judgeTrayMachineState({ entryExists: true, promoted: 0, trayAddSpan: true, amberVisible: false })!
    expect(g.condition).toBe('overflow-unpromoted')
    expect(g.allowExclude).toBe(true)
    expect(g.appliesTo).toEqual(['P8-visibility', 'P10-nav'])
    expect(g.appliesTo).not.toContain('P8-register')
    expect(g.directed).toContain('溢出层')
  })

  it('提升已置+识别色不可见+注册存证 → promoted-no-remount，只门禁 P8 可见面', () => {
    const g = judgeTrayMachineState({ entryExists: true, promoted: 1, trayAddSpan: true, amberVisible: false })!
    expect(g.condition).toBe('promoted-no-remount')
    expect(g.appliesTo).toEqual(['P8-visibility'])
    expect(g.reason).toContain('explorer 未重挂')
  })

  it('注册面健康+勿扰标记+注册存证 → dnd-tray-layout，只门禁 P10 导航', () => {
    const g = judgeTrayMachineState({ entryExists: true, promoted: 1, trayAddSpan: true, dndMarkerSeen: true, amberVisible: true })!
    expect(g.condition).toBe('dnd-tray-layout')
    expect(g.appliesTo).toEqual(['P10-nav'])
    expect(g.reason).toContain('勿扰')
    expect(g.reason).toContain('布局')
  })

  it('勿扰标记不解释注册断言：条目缺失时勿扰在场仍是建档时序条件（appliesTo 含 P8-register）', () => {
    const g = judgeTrayMachineState({ entryExists: false, promoted: null, trayAddSpan: true, dndMarkerSeen: true })!
    expect(g.condition).toBe('entry-missing-machine')
  })

  it('条目条件优先于勿扰条件：提升未置+勿扰在场 → 判溢出层条件（导航面双因都在场，取更结构性者）', () => {
    const g = judgeTrayMachineState({ entryExists: true, promoted: 0, trayAddSpan: true, dndMarkerSeen: true, amberVisible: false })!
    expect(g.condition).toBe('overflow-unpromoted')
  })

  it('DND_MARKER 与 #138 实测 UIA 步名形态一致', () => {
    expect('Notifications 17 new notifications (Do not disturb on)').toContain(DND_MARKER)
    expect('Notifications 3 new notifications').not.toContain(DND_MARKER)
  })

  it('空输入/undefined 不炸：按无条目无存证处理（unverified）', () => {
    const g = judgeTrayMachineState({})
    expect(g!.condition).toBe('entry-missing-unverified')
    expect(judgeTrayMachineState(undefined)!.condition).toBe('entry-missing-unverified')
  })
})
