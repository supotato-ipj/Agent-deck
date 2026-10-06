/**
 * 任务栏 pill 渲染/点击契约测试（工单49——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 按钮视图模型；点击 = 按钮 id → taskbar/system-action。
 * 工单52 起视图模型含左组（手钉+运行中合并条目）——序与运行态由内核编排查好，
 * 渲染层只做形态映射（tooltip = 窗口标题优先、回退显示名）。
 */
import { describe, expect, it } from 'vitest'
import { dispatchTaskbarButton, taskbarViewModel } from '../../src/renderer/taskbar-view'
import type { TaskbarBridge } from '../../src/renderer/taskbar-view'
import type { TaskbarLeftEntry, TaskbarState } from '../../src/shared/contract'

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

const entry = (exe: string, over: Partial<TaskbarLeftEntry> = {}): TaskbarLeftEntry => ({
  exe,
  label: over.label ?? exe.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''),
  pinned: false,
  running: true,
  title: null,
  iconKey: null,
  ...over,
})

describe('任务栏 pill 渲染（fake bridge 驱动）', () => {
  it('启用态渲染中组两按钮：开始在前、TaskView 在后（Win11 肌肉记忆位）', async () => {
    const { bridge } = fakeBridge({ enabled: true, left: [] })
    const state = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(state)
    expect(vm.buttons.map((b) => [b.id, b.action])).toEqual([
      ['start', 'start-menu'],
      ['tasks', 'task-view'],
    ])
  })

  it('禁用态渲染空壳（按钮与左组清单皆为空）', async () => {
    const { bridge } = fakeBridge({ enabled: false, left: [entry('C:\\Apps\\A.exe')] })
    const state = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(state)
    expect(vm.buttons).toEqual([])
    expect(vm.left).toEqual([])
  })
})

describe('任务栏左组视图模型（工单52，fake bridge 驱动）', () => {
  it('左组条目按内核编排序原样映射（手钉在前、运行态叠加）；id = exe 身份（工单53 交互挂点）', async () => {
    const { bridge } = fakeBridge({
      enabled: true,
      left: [
        entry('C:\\Apps\\A.exe', { label: '甲', pinned: true, running: true, title: '甲 - 编辑中', iconKey: 'C:\\Apps\\A.exe|1' }),
        entry('C:\\Apps\\B.exe', { label: '乙', pinned: true, running: false }),
        entry('C:\\Apps\\C.exe'),
      ],
    })
    const state = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(state)
    expect(vm.left.map((e) => [e.id, e.pinned, e.running])).toEqual([
      ['C:\\Apps\\A.exe', true, true],
      ['C:\\Apps\\B.exe', true, false],
      ['C:\\Apps\\C.exe', false, true],
    ])
    expect(vm.left[0].iconKey).toBe('C:\\Apps\\A.exe|1')
  })

  it('tooltip：运行中有窗口标题取标题（区分同名应用），否则回退显示名', async () => {
    const { bridge } = fakeBridge({
      enabled: true,
      left: [
        entry('C:\\Apps\\A.exe', { title: '文档 1 - 甲' }),
        entry('C:\\Apps\\B.exe', { label: '乙', pinned: true, running: false }),
      ],
    })
    const state = await bridge.invoke('taskbar/get-state', null)
    expect(taskbarViewModel(state).left.map((e) => e.tooltip)).toEqual(['文档 1 - 甲', '乙'])
  })
})

describe('任务栏按钮点击（fake bridge 驱动）', () => {
  it('点开始按钮 → taskbar/system-action start-menu 到达桥', async () => {
    const { bridge, calls } = fakeBridge({ enabled: true, left: [] })
    const r = await dispatchTaskbarButton(bridge, 'start')
    expect(r).toEqual({ ok: true, action: 'start-menu' })
    expect(calls).toEqual([{ method: 'taskbar/system-action', payload: { action: 'start-menu' } }])
  })

  it('点 TaskView 按钮 → taskbar/system-action task-view 到达桥', async () => {
    const { bridge, calls } = fakeBridge({ enabled: true, left: [] })
    const r = await dispatchTaskbarButton(bridge, 'tasks')
    expect(r).toEqual({ ok: true, action: 'task-view' })
    expect(calls).toEqual([{ method: 'taskbar/system-action', payload: { action: 'task-view' } }])
  })

  it('未知按钮 id 是噪声：不发 invoke', async () => {
    const { bridge, calls } = fakeBridge({ enabled: true, left: [] })
    const r = await dispatchTaskbarButton(bridge, 'ghost')
    expect(r).toEqual({ ok: false, action: null })
    expect(calls).toEqual([])
  })
})
