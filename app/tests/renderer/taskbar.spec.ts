/**
 * 任务栏 pill 渲染/点击契约测试（工单49——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 按钮视图模型；点击 = 按钮 id → taskbar/system-action。
 */
import { describe, expect, it } from 'vitest'
import { dispatchTaskbarButton, taskbarViewModel } from '../../src/renderer/taskbar-view'
import type { TaskbarBridge } from '../../src/renderer/taskbar-view'
import type { TaskbarState } from '../../src/shared/contract'

/** fake bridge：get-state 返回给定状态；invoke 逐笔记录（方法 + 载荷） */
function fakeBridge(state: TaskbarState) {
  const calls: Array<{ method: string; payload: unknown }> = []
  const bridge: TaskbarBridge = {
    invoke: (method, payload) => {
      calls.push({ method, payload })
      if (method === 'taskbar/get-state') return Promise.resolve(state as never)
      if (method === 'taskbar/system-action') return Promise.resolve({ ok: true } as never)
      throw new Error(`fake bridge 未知方法: ${method}`)
    },
    on: () => () => {},
  }
  return { bridge, calls }
}

describe('任务栏 pill 渲染（fake bridge 驱动）', () => {
  it('启用态渲染中组两按钮：开始在前、TaskView 在后（Win11 肌肉记忆位）', async () => {
    const { bridge } = fakeBridge({ enabled: true })
    const state = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(state)
    expect(vm.buttons.map((b) => [b.id, b.action])).toEqual([
      ['start', 'start-menu'],
      ['tasks', 'task-view'],
    ])
  })

  it('禁用态渲染空壳（按钮清单为空）', async () => {
    const { bridge } = fakeBridge({ enabled: false })
    const state = await bridge.invoke('taskbar/get-state', null)
    expect(taskbarViewModel(state).buttons).toEqual([])
  })
})

describe('任务栏按钮点击（fake bridge 驱动）', () => {
  it('点开始按钮 → taskbar/system-action start-menu 到达桥', async () => {
    const { bridge, calls } = fakeBridge({ enabled: true })
    const r = await dispatchTaskbarButton(bridge, 'start')
    expect(r).toEqual({ ok: true, action: 'start-menu' })
    expect(calls).toEqual([{ method: 'taskbar/system-action', payload: { action: 'start-menu' } }])
  })

  it('点 TaskView 按钮 → taskbar/system-action task-view 到达桥', async () => {
    const { bridge, calls } = fakeBridge({ enabled: true })
    const r = await dispatchTaskbarButton(bridge, 'tasks')
    expect(r).toEqual({ ok: true, action: 'task-view' })
    expect(calls).toEqual([{ method: 'taskbar/system-action', payload: { action: 'task-view' } }])
  })

  it('未知按钮 id 是噪声：不发 invoke', async () => {
    const { bridge, calls } = fakeBridge({ enabled: true })
    const r = await dispatchTaskbarButton(bridge, 'ghost')
    expect(r).toEqual({ ok: false, action: null })
    expect(calls).toEqual([])
  })
})
