/**
/**
 * 任务栏 pill 渲染/点击契约测试（工单49/54/55——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 中组视图模型（系统按钮显隐 + 推荐位 + 整组显隐边界）；
 * 点击 = 按钮 id → taskbar/system-action；右键菜单动作 = taskbar/set-button-hidden。
 * 工单55 右组：硬件摘要勾选子集、时钟/音量格与显示桌面细条的点击分发、数值格式化
 * （口径与硬件卡一致：百分比 Math.round、速率 toFixed(2) KB/s）。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { dispatchTaskbarButton, dispatchTaskbarVisibility, formatClock, formatMetric, summaryViewModel, TASKBAR_METRICS, taskbarViewModel, toggleMetric } from '../../src/renderer/taskbar-view'
import type { TaskbarBridge } from '../../src/renderer/taskbar-view'
import type { HardwareGauges, TaskbarMetric, TaskbarState } from '../../src/shared/contract'
import { TASKBAR_METRIC_KEYS } from '../../src/shared/contract'

const ALL = [...TASKBAR_METRIC_KEYS]

function state(over: Partial<TaskbarState> = {}): TaskbarState {
  return { enabled: true, hiddenButtons: [], recommendations: [], metrics: ALL, ...over }
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

describe('任务栏右组（工单55，fake bridge 驱动）', () => {
  it('渲染层指标序与契约 TASKBAR_METRIC_KEYS 同序（镜像守卫——渲染层不得运行时 import 契约值）', () => {
    expect(TASKBAR_METRICS.map((s) => s.id)).toEqual([...TASKBAR_METRIC_KEYS])
  })

  it('右组动作格：音量格 Win+A、时钟格 Win+N、显示桌面细条 Win+D 到达桥', async () => {
    const { bridge, calls } = fakeBridge(state())
    expect(await dispatchTaskbarButton(bridge, 'volume')).toEqual({ ok: true, action: 'quick-settings' })
    expect(await dispatchTaskbarButton(bridge, 'clock')).toEqual({ ok: true, action: 'notification-center' })
    expect(await dispatchTaskbarButton(bridge, 'show-desktop')).toEqual({ ok: true, action: 'toggle-desktop' })
    expect(calls).toEqual([
      { method: 'taskbar/system-action', payload: { action: 'quick-settings' } },
      { method: 'taskbar/system-action', payload: { action: 'notification-center' } },
      { method: 'taskbar/system-action', payload: { action: 'toggle-desktop' } },
    ])
  })

  it('视图模型携带勾选子集（组内序 = 规范序）；禁用态摘要同样空壳', async () => {
    const { bridge } = fakeBridge(state({ metrics: ['cpu', 'ram'] }))
    const s = await bridge.invoke('taskbar/get-state', null)
    expect(taskbarViewModel(s).metrics).toEqual(['cpu', 'ram'])
    expect(taskbarViewModel(state({ enabled: false })).metrics).toEqual([])
  })

  it('硬件摘要数值口径与硬件卡一致：百分比 Math.round、速率 toFixed(2) KB/s；源缺位落占位符', () => {
    const gauges: HardwareGauges = {
      cpu: 12.4, memory: 45.6, memory_gb: '14.5 GB/31.9 GB',
      gpu_usage: 78.5, download_speed: 1.234, upload_speed: 0,
    }
    expect(formatMetric('cpu', gauges)).toBe('CPU 12%')
    expect(formatMetric('gpu', gauges)).toBe('GPU 79%')
    expect(formatMetric('ram', gauges)).toBe('RAM 46%')
    expect(formatMetric('net-down', gauges)).toBe('DL 1.23KB/s')
    expect(formatMetric('net-up', gauges)).toBe('UP 0.00KB/s')
    // GPU/网络源不可用（字段缺位）→ 占位符而非 0（硬件卡同款纪律）
    const bare: HardwareGauges = { cpu: 0, memory: 0, memory_gb: '-- GB/-- GB' }
    expect(formatMetric('gpu', bare)).toBe('GPU ---')
    expect(formatMetric('net-down', bare)).toBe('DL --')
    expect(formatMetric('net-up', bare)).toBe('UP --')
  })

  it('时钟格文本：ClockState → 本地 HH:MM（两位补零）', () => {
    const epochMs = new Date(2026, 9, 6, 8, 5).getTime()
    expect(formatClock({ iso: new Date(epochMs).toISOString(), epochMs })).toBe('08:05')
    const pm = new Date(2026, 9, 6, 23, 59).getTime()
    expect(formatClock({ iso: new Date(pm).toISOString(), epochMs: pm })).toBe('23:59')
  })

  it('勾选切换：取消即移出、勾回按规范序归位；全不勾选合法（摘要整格隐藏）', () => {
    const off = toggleMetric(ALL, 'gpu')
    expect(off).toEqual(['cpu', 'ram', 'net-down', 'net-up'])
    expect(toggleMetric(['cpu', 'ram'], 'gpu')).toEqual(['cpu', 'gpu', 'ram'])
    let cur: TaskbarMetric[] = ALL
    for (const k of ALL) cur = toggleMetric(cur, k)
    expect(cur).toEqual([])
  })

  it('摘要编辑态呈现全部五项（含未勾选项，供勾回）；常态只呈现勾选子集', () => {
    const editing = summaryViewModel(['cpu', 'ram'], true)
    expect(editing.map((s) => [s.id, s.visible, s.on])).toEqual([
      ['cpu', true, true], ['gpu', true, false], ['ram', true, true], ['net-down', true, false], ['net-up', true, false],
    ])
    const normal = summaryViewModel(['cpu', 'ram'], false)
    expect(normal.filter((s) => s.visible).map((s) => s.id)).toEqual(['cpu', 'ram'])
    expect(summaryViewModel([], false).some((s) => s.visible)).toBe(false)
  })

  it('源码级守卫：任务栏渲染层只做类型级 import（协议资产根只有 dist/renderer，运行时值导入会 404）', () => {
    for (const rel of ['src/renderer/taskbar.ts', 'src/renderer/taskbar-view.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
      const runtime = src.split('\n').filter((l) => /^import\s+\{/.test(l) && l.includes('shared/contract'))
      expect(runtime, `${rel} 不得运行时 import shared/contract`).toEqual([])
    }
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
