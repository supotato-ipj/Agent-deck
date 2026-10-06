/**
 * 任务栏 pill 渲染/点击契约测试（工单49/54——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 中组视图模型（系统按钮显隐 + 推荐位 + 整组显隐边界）；
 * 点击 = 按钮 id → taskbar/system-action；右键菜单动作 = taskbar/set-button-hidden。
 */
import { describe, expect, it } from 'vitest'
import { dispatchTaskbarButton, dispatchTaskbarVisibility, taskbarViewModel } from '../../src/renderer/taskbar-view'
import type { TaskbarBridge } from '../../src/renderer/taskbar-view'
import type { TaskbarState } from '../../src/shared/contract'

function state(over: Partial<TaskbarState> = {}): TaskbarState {
  return { enabled: true, hiddenButtons: [], recommendations: [], ...over }
}

const RECS = [
  { name: 'Alpha.lnk', display: 'Alpha', path: 'C:\\Desktop\\Alpha.lnk' },
  { name: 'Beta.lnk', display: 'Beta', path: 'C:\\Desktop\\Beta.lnk' },
]

/** fake bridge：get-state 返回给定状态；invoke 逐笔记录（方法 + 载荷） */
function fakeBridge(s: TaskbarState) {
  const calls: Array<{ method: string; payload: unknown }> = []
  const bridge: TaskbarBridge = {
    invoke: (method, payload) => {
      calls.push({ method, payload })
      if (method === 'taskbar/get-state') return Promise.resolve(s as never)
      if (method === 'taskbar/system-action') return Promise.resolve({ ok: true } as never)
      if (method === 'taskbar/set-button-hidden') {
        const { id, hidden } = payload as { id: 'start' | 'tasks'; hidden: boolean }
        const hiddenButtons = hidden
          ? [...s.hiddenButtons, id]
          : s.hiddenButtons.filter((b) => b !== id)
        return Promise.resolve({ ...s, hiddenButtons } as never)
      }
      throw new Error(`fake bridge 未知方法: ${method}`)
    },
    on: () => () => {},
  }
  return { bridge, calls }
}

describe('任务栏 pill 渲染（fake bridge 驱动）', () => {
  it('启用态渲染中组两按钮：开始在前、TaskView 在后（Win11 肌肉记忆位）', async () => {
    const { bridge } = fakeBridge(state())
    const s = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(s)
    expect(vm.visible).toBe(true)
    expect(vm.buttons.map((b) => [b.id, b.action])).toEqual([
      ['start', 'start-menu'],
      ['tasks', 'task-view'],
    ])
  })

  it('推荐位随状态透出（排序与名单内核已定，视图模型原样承接）', () => {
    const vm = taskbarViewModel(state({ recommendations: RECS }))
    expect(vm.visible).toBe(true)
    expect(vm.recommendations).toEqual(RECS)
  })

  it('隐藏开始按钮：按钮清单只剩 TaskView；菜单给出「显示开始按钮」恢复项', () => {
    const vm = taskbarViewModel(state({ hiddenButtons: ['start'] }))
    expect(vm.visible).toBe(true)
    expect(vm.buttons.map((b) => b.id)).toEqual(['tasks'])
    expect(vm.menu).toEqual([
      { id: 'start', label: '显示开始按钮', hidden: true },
      { id: 'tasks', label: '隐藏任务视图按钮', hidden: false },
    ])
  })

  it('两按钮都隐藏 + 有推荐位：中组仍渲染（只余推荐位）', () => {
    const vm = taskbarViewModel(state({ hiddenButtons: ['start', 'tasks'], recommendations: RECS }))
    expect(vm.visible).toBe(true)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual(RECS)
  })

  it('两按钮都隐藏 + 推荐位为空：中组整个不渲染（只剩左右两组的边界）', () => {
    const vm = taskbarViewModel(state({ hiddenButtons: ['start', 'tasks'] }))
    expect(vm.visible).toBe(false)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual([])
  })

  it('禁用态渲染空壳（中组不渲染、按钮与推荐位全空）', async () => {
    const { bridge } = fakeBridge(state({ enabled: false, recommendations: RECS }))
    const s = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(s)
    expect(vm.visible).toBe(false)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual([])
  })
})

describe('任务栏按钮点击（fake bridge 驱动）', () => {
  it('点开始按钮 → taskbar/system-action start-menu 到达桥', async () => {
    const { bridge, calls } = fakeBridge(state())
    const r = await dispatchTaskbarButton(bridge, 'start')
    expect(r).toEqual({ ok: true, action: 'start-menu' })
    expect(calls).toEqual([{ method: 'taskbar/system-action', payload: { action: 'start-menu' } }])
  })

  it('点 TaskView 按钮 → taskbar/system-action task-view 到达桥', async () => {
    const { bridge, calls } = fakeBridge(state())
    const r = await dispatchTaskbarButton(bridge, 'tasks')
    expect(r).toEqual({ ok: true, action: 'task-view' })
    expect(calls).toEqual([{ method: 'taskbar/system-action', payload: { action: 'task-view' } }])
  })

  it('未知按钮 id 是噪声：不发 invoke', async () => {
    const { bridge, calls } = fakeBridge(state())
    const r = await dispatchTaskbarButton(bridge, 'ghost')
    expect(r).toEqual({ ok: false, action: null })
    expect(calls).toEqual([])
  })
})

describe('系统按钮显隐菜单动作（工单54，fake bridge 驱动）', () => {
  it('隐藏开始按钮 → taskbar/set-button-hidden 到达桥，回执含新名单', async () => {
    const { bridge, calls } = fakeBridge(state())
    const r = await dispatchTaskbarVisibility(bridge, 'start', true)
    expect(r).toEqual(state({ hiddenButtons: ['start'] }))
    expect(calls).toEqual([{ method: 'taskbar/set-button-hidden', payload: { id: 'start', hidden: true } }])
  })

  it('恢复已隐藏按钮 → taskbar/set-button-hidden hidden:false 到达桥', async () => {
    const { bridge, calls } = fakeBridge(state({ hiddenButtons: ['tasks'] }))
    const r = await dispatchTaskbarVisibility(bridge, 'tasks', false)
    expect(r).toEqual(state({ hiddenButtons: [] }))
    expect(calls).toEqual([{ method: 'taskbar/set-button-hidden', payload: { id: 'tasks', hidden: false } }])
  })

  it('未知按钮 id 是噪声：不发 invoke（返回 null）', async () => {
    const { bridge, calls } = fakeBridge(state())
    const r = await dispatchTaskbarVisibility(bridge, 'ghost' as never, true)
    expect(r).toBeNull()
    expect(calls).toEqual([])
  })
})
