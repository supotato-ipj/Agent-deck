/**
 * 任务栏 pill 渲染/点击契约测试（工单49/52/54——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 视图模型（左组形态映射 + 中组系统按钮显隐 + 推荐位 +
 * 整组显隐边界）；点击 = 按钮 id → taskbar/system-action；右键菜单动作 = taskbar/set-button-hidden。
 * 工单58：左组溢出拆分（容量内全留栏、超限尾部收浮层）+ 应用图标点击分发 taskbar/activate-app。
 */
import { describe, expect, it } from 'vitest'
import { dispatchActivateWindow, dispatchTaskbarDragDrop, dispatchAppClick, dispatchAppMenuAction, dispatchAppNewInstance, dispatchTaskbarApp, dispatchTaskbarButton, dispatchTaskbarVisibility, splitLeftOverflow, taskbarAppMenuRows, taskbarViewModel } from '../../src/renderer/taskbar-view'
import type { TaskbarBridge, TaskbarLeftViewEntry } from '../../src/renderer/taskbar-view'
import type { TaskbarLeftEntry, TaskbarState } from '../../src/shared/contract'

function state(over: Partial<TaskbarState> = {}): TaskbarState {
  return { enabled: true, hiddenButtons: [], recommendations: [], left: [], ...over }
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
// 工单53 左组交互族
      if (method === 'taskbar/app-click') {
        return Promise.resolve({
          ok: true,
          action: 'window-list',
          windows: [
            { hwnd: 101, title: '甲 - 文档1' },
            { hwnd: 102, title: '甲 - 文档2' },
          ],
        } as never)
      }
      if (method === 'taskbar/activate-window') return Promise.resolve({ ok: true } as never)
      if (method === 'taskbar/app-new-instance') return Promise.resolve({ ok: true } as never)
      if (method === 'taskbar/set-app-pinned') return Promise.resolve(s as never)
      if (method === 'taskbar/close-window') return Promise.resolve({ ok: true, closed: 1 } as never)
      if (method === 'taskbar/reveal-app') return Promise.resolve({ ok: true } as never)
      if (method === 'taskbar/drag-drop') return Promise.resolve({ ok: true } as never)
      // 工单58 左组溢出分发
      if (method === 'taskbar/activate-app') {
        const { exe } = payload as { exe: string }
        const hit = s.left.find((e) => e.exe === exe)
        if (!hit) return Promise.resolve({ ok: false, action: null, error: '栏外身份' } as never)
        return Promise.resolve({ ok: true, action: hit.running ? 'focused' : 'launched' } as never)
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

  it('禁用态渲染空壳（中组不渲染、按钮/推荐位/左组全空）', async () => {
    const { bridge } = fakeBridge(state({ enabled: false, recommendations: RECS, left: [entry('C:\\Apps\\A.exe')] }))
    const s = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(s)
    expect(vm.visible).toBe(false)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual([])
    expect(vm.left).toEqual([])
  })
})

/** 左组条目构造（工单52）：缺省仅运行、无标题、无图标键 */
function entry(exe: string, over: Partial<TaskbarLeftEntry> = {}): TaskbarLeftEntry {
  return {
    exe,
    label: over.label ?? exe.replace(/^.*[\\/]/, '').replace(/\.exe$/i, ''),
    pinned: false,
    running: true,
    title: null,
    iconKey: null,
    ...over,
  }
}

describe('任务栏左组视图模型（工单52，fake bridge 驱动）', () => {
  it('左组条目按内核编排序原样映射（手钉在前、运行态叠加）；id = exe 身份（工单53 交互挂点）', async () => {
    const { bridge } = fakeBridge(state({
      left: [
        entry('C:\\Apps\\A.exe', { label: '甲', pinned: true, running: true, title: '甲 - 编辑中', iconKey: 'C:\\Apps\\A.exe|1' }),
        entry('C:\\Apps\\B.exe', { label: '乙', pinned: true, running: false }),
        entry('C:\\Apps\\C.exe'),
      ],
    }))
    const s = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(s)
    expect(vm.left.map((e) => [e.id, e.pinned, e.running])).toEqual([
      ['C:\\Apps\\A.exe', true, true],
      ['C:\\Apps\\B.exe', true, false],
      ['C:\\Apps\\C.exe', false, true],
    ])
    expect(vm.left[0].iconKey).toBe('C:\\Apps\\A.exe|1')
  })

  it('tooltip：运行中有窗口标题取标题（区分同名应用），否则回退显示名', async () => {
    const { bridge } = fakeBridge(state({
      left: [
        entry('C:\\Apps\\A.exe', { title: '文档 1 - 甲' }),
        entry('C:\\Apps\\B.exe', { label: '乙', pinned: true, running: false }),
      ],
    }))
    const s = await bridge.invoke('taskbar/get-state', null)
    expect(taskbarViewModel(s).left.map((e) => e.tooltip)).toEqual(['文档 1 - 甲', '乙'])
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

describe('栏上拖拽落位分发（工单57，fake bridge 驱动）', () => {
  it('跨组：中→左升手钉、左→中解除手钉回推荐池，落点身份随目标条目', async () => {
    const { bridge, calls } = fakeBridge(state())
    await dispatchTaskbarDragDrop(bridge, { from: 'mid', to: 'left', id: 'Alpha.lnk', before: 'C:\Apps\B.exe' })
    await dispatchTaskbarDragDrop(bridge, { from: 'left', to: 'mid', id: 'C:\Apps\B.exe', before: null })
    expect(calls).toEqual([
      { method: 'taskbar/drag-drop', payload: { from: 'mid', to: 'left', id: 'Alpha.lnk', before: 'C:\Apps\B.exe' } },
      { method: 'taskbar/drag-drop', payload: { from: 'left', to: 'mid', id: 'C:\Apps\B.exe', before: null } },
    ])
  })

  it('组内换位：左→左换手钉序落位 before=目标身份；畸形描述子是噪声不发 invoke', async () => {
    const { bridge, calls } = fakeBridge(state())
    await dispatchTaskbarDragDrop(bridge, { from: 'left', to: 'left', id: 'C:\Apps\A.exe', before: 'C:\Apps\B.exe' })
    await expect(dispatchTaskbarDragDrop(bridge, { from: 'x' as never, to: 'left', id: 'A', before: null })).resolves.toEqual({ ok: false, error: '拖拽描述子畸形' })
    expect(calls).toEqual([
      { method: 'taskbar/drag-drop', payload: { from: 'left', to: 'left', id: 'C:\Apps\A.exe', before: 'C:\Apps\B.exe' } },
    ])
  })
})
