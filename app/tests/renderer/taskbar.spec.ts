import { describe, expect, it } from 'vitest'
import { appIconFallbackText, appsBand, appsPillLeft, appsSlotsFor, dispatchActivateWindow, dispatchTaskbarDragDrop, dispatchRecClick, dispatchRecMenuAction, dispatchRecRestore, dispatchTrayClick, dispatchTrayOverflowLimit, fetchTrayIcon, dispatchAppClick, dispatchAppMenuAction, dispatchAppNewInstance, dispatchTaskbarApp, dispatchTaskbarButton, dispatchTaskbarVisibility, splitAppsOverflow, splitTrayOverflow, taskbarAppMenuRows, taskbarRecMenuRows, taskbarViewModel, formatClock, formatMetric, summaryViewModel, TASKBAR_METRICS, TASKBAR_TRAY_ICON_PX, TRAY_OVERFLOW_TIERS, toggleMetric, trayIconPixelated, trayOverflowMenuRows, trayOverflowTierRows } from '../../src/renderer/taskbar-view'
import { TASKBAR_METRIC_KEYS } from '../../src/shared/contract'
/**
 * 任务栏 pill 渲染/点击契约测试（工单49/52/54/55——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 视图模型（应用组形态映射 + 开始组系统按钮显隐 + 推荐位 +
 * 整组显隐边界）；点击 = 按钮 id → taskbar/system-action；右键菜单动作 = taskbar/set-button-hidden。
 * 工单58：应用组溢出拆分（容量内全留栏、超限尾部收浮层）+ 应用图标点击分发 taskbar/activate-app。
 */
import type { TaskbarBridge, TaskbarAppViewEntry } from '../../src/renderer/taskbar-view'
import fs from 'node:fs'
import path from 'node:path'
import type { HardwareGauges, TaskbarAppEntry, TaskbarMetric, TaskbarState, TaskbarTrayEntry } from '../../src/shared/contract'
const ALL = [...TASKBAR_METRIC_KEYS]

function state(over: Partial<TaskbarState> = {}): TaskbarState {
  return { enabled: true, hiddenButtons: [], recommendations: [], excluded: [], metrics: ALL, apps: [], tray: [], trayOverflowLimit: 5, ...over }
}

const RECS = [
  { name: 'Alpha.lnk', display: 'Alpha', path: 'C:\\Desktop\\Alpha.lnk', iconKey: 'Alpha.lnk|0', exe: 'C:\\Apps\\Alpha.exe' },
  { name: 'Beta.lnk', display: 'Beta', path: 'C:\\Desktop\\Beta.lnk', iconKey: 'Beta.lnk|0', exe: 'C:\\Desktop\\Beta.lnk' },
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
// 工单53 应用组交互族
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
      // 工单160 推荐组交互
      if (method === 'taskbar/rec-click') return Promise.resolve({ ok: true } as never)
      if (method === 'taskbar/rec-pin') return Promise.resolve(s as never)
      // 工单161 移除名单
      if (method === 'taskbar/rec-remove') return Promise.resolve(s as never)
      if (method === 'taskbar/rec-restore') return Promise.resolve(s as never)
      if (method === 'taskbar/rec-reveal') return Promise.resolve({ ok: true } as never)
      // 工单56 托盘入栏
      if (method === 'taskbar/tray-click') return Promise.resolve({ ok: true } as never)
      // 工单162 托盘溢出档位
      if (method === 'taskbar/set-tray-overflow-limit') return Promise.resolve(s as never)
      if (method === 'taskbar/tray-icon') {
        const { key } = payload as { key: string }
        const hit = s.tray.find((t) => t.key === key)
        return Promise.resolve({ icon: hit?.iconKey ? { width: 16, height: 16, bgraBase64: 'AAAA' } : null } as never)
      }
      // 工单58 应用组溢出分发
      if (method === 'taskbar/activate-app') {
        const { exe } = payload as { exe: string }
        const hit = s.apps.find((e) => e.exe === exe)
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
  it('启用态渲染开始组两按钮：开始在前、TaskView 在后（Win11 肌肉记忆位）', async () => {
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

  it('两按钮都隐藏 + 有推荐位：开始组 pill 仍渲染（只余推荐位）', () => {
    const vm = taskbarViewModel(state({ hiddenButtons: ['start', 'tasks'], recommendations: RECS }))
    expect(vm.visible).toBe(true)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual(RECS)
  })

  it('两按钮都隐藏 + 推荐位为空：开始组整个不渲染（只剩应用组与右组的边界）', () => {
    const vm = taskbarViewModel(state({ hiddenButtons: ['start', 'tasks'] }))
    expect(vm.visible).toBe(false)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual([])
  })

  it('禁用态渲染空壳（开始组不渲染、按钮/推荐位/应用组全空）', async () => {
    const { bridge } = fakeBridge(state({ enabled: false, recommendations: RECS, apps: [entry('C:\\Apps\\A.exe')] }))
    const s = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(s)
    expect(vm.visible).toBe(false)
    expect(vm.buttons).toEqual([])
    expect(vm.recommendations).toEqual([])
    expect(vm.apps).toEqual([])
  })
})

/** 应用组条目构造（工单52）：缺省仅运行、无标题、无图标键 */
function entry(exe: string, over: Partial<TaskbarAppEntry> = {}): TaskbarAppEntry {
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

describe('任务栏应用组视图模型（工单52，fake bridge 驱动）', () => {
  it('应用组条目按内核编排序原样映射（手钉在前、运行态叠加）；id = exe 身份（工单53 交互挂点）', async () => {
    const { bridge } = fakeBridge(state({
      apps: [
        entry('C:\\Apps\\A.exe', { label: '甲', pinned: true, running: true, title: '甲 - 编辑中', iconKey: 'C:\\Apps\\A.exe|1' }),
        entry('C:\\Apps\\B.exe', { label: '乙', pinned: true, running: false }),
        entry('C:\\Apps\\C.exe'),
      ],
    }))
    const s = await bridge.invoke('taskbar/get-state', null)
    const vm = taskbarViewModel(s)
    expect(vm.apps.map((e) => [e.id, e.pinned, e.running])).toEqual([
      ['C:\\Apps\\A.exe', true, true],
      ['C:\\Apps\\B.exe', true, false],
      ['C:\\Apps\\C.exe', false, true],
    ])
    expect(vm.apps[0].iconKey).toBe('C:\\Apps\\A.exe|1')
  })

  it('tooltip：运行中有窗口标题取标题（区分同名应用），否则回退显示名', async () => {
    const { bridge } = fakeBridge(state({
      apps: [
        entry('C:\\Apps\\A.exe', { title: '文档 1 - 甲' }),
        entry('C:\\Apps\\B.exe', { label: '乙', pinned: true, running: false }),
      ],
    }))
    const s = await bridge.invoke('taskbar/get-state', null)
    expect(taskbarViewModel(s).apps.map((e) => e.tooltip)).toEqual(['文档 1 - 甲', '乙'])
  })
})

describe('应用组图标首字母占位（工单156）：无图标键条目不出空白格', () => {
  it('占位取显示名首字符（ASCII 字母大写化，非字母原样）', () => {
    expect(appIconFallbackText({ label: 'wechat', exe: 'C:\\Apps\\WeChat.exe' })).toBe('W')
    expect(appIconFallbackText({ label: '微信', exe: 'C:\\Apps\\WeChat.exe' })).toBe('微')
    expect(appIconFallbackText({ label: '7-Zip', exe: 'C:\\Apps\\7z.exe' })).toBe('7')
  })

  it('显示名空回退 exe 基名首字符（去扩展）；再取不到回退 ?', () => {
    expect(appIconFallbackText({ label: '', exe: 'C:\\Apps\\Fallback.exe' })).toBe('F')
    expect(appIconFallbackText({ label: '', exe: '' })).toBe('?')
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

describe('栏上拖拽落位分发（工单57，fake bridge 驱动）', () => {
  it('跨组：中→左升手钉、左→中解除手钉回推荐池，落点身份随目标条目', async () => {
    const { bridge, calls } = fakeBridge(state())
    await dispatchTaskbarDragDrop(bridge, { from: 'recs', to: 'apps', id: 'Alpha.lnk', before: 'C:\Apps\B.exe' })
    await dispatchTaskbarDragDrop(bridge, { from: 'apps', to: 'recs', id: 'C:\Apps\B.exe', before: null })
    expect(calls).toEqual([
      { method: 'taskbar/drag-drop', payload: { from: 'recs', to: 'apps', id: 'Alpha.lnk', before: 'C:\Apps\B.exe' } },
      { method: 'taskbar/drag-drop', payload: { from: 'apps', to: 'recs', id: 'C:\Apps\B.exe', before: null } },
    ])
  })

  it('组内换位：左→左换手钉序落位 before=目标身份；畸形描述子是噪声不发 invoke', async () => {
    const { bridge, calls } = fakeBridge(state())
    await dispatchTaskbarDragDrop(bridge, { from: 'apps', to: 'apps', id: 'C:\Apps\A.exe', before: 'C:\Apps\B.exe' })
    await expect(dispatchTaskbarDragDrop(bridge, { from: 'x' as never, to: 'apps', id: 'A', before: null })).resolves.toEqual({ ok: false, error: '拖拽描述子畸形' })
    expect(calls).toEqual([
      { method: 'taskbar/drag-drop', payload: { from: 'apps', to: 'apps', id: 'C:\Apps\A.exe', before: 'C:\Apps\B.exe' } },
    ])
  })
})

describe('任务栏托盘入栏（工单56）', () => {
  const TRAY = [
    { key: '100:1', tooltip: '滴答清单', iconKey: '100:1|16x16:1' },
    { key: 'guid:abc', tooltip: 'OneDrive', iconKey: null },
  ]

  it('视图模型原样透出托盘名单；禁用态收敛为空', () => {
    expect(taskbarViewModel(state({ tray: TRAY })).tray).toEqual(TRAY)
    expect(taskbarViewModel(state({ enabled: false, tray: TRAY })).tray).toEqual([])
    // 旧快照无 tray 字段（持久化面从不存它）不炸
    expect(taskbarViewModel({ ...state(), tray: undefined as never }).tray).toEqual([])
  })

  it('点击回放分发：左/右键各发一次 taskbar/tray-click', async () => {
    const b = fakeBridge(state({ tray: TRAY }))
    await expect(dispatchTrayClick(b.bridge, '100:1', 'left')).resolves.toEqual({ ok: true })
    await expect(dispatchTrayClick(b.bridge, 'guid:abc', 'right')).resolves.toEqual({ ok: true })
    expect(b.calls.filter((c) => c.method === 'taskbar/tray-click')).toEqual([
      { method: 'taskbar/tray-click', payload: { key: '100:1', button: 'left' } },
      { method: 'taskbar/tray-click', payload: { key: 'guid:abc', button: 'right' } },
    ])
  })

  it('空身份不发 invoke（噪声不占桥接往返）', async () => {
    const b = fakeBridge(state({ tray: TRAY }))
    await expect(dispatchTrayClick(b.bridge, '', 'left')).resolves.toEqual({ ok: false, error: '空托盘身份' })
    expect(b.calls.some((c) => c.method === 'taskbar/tray-click')).toBe(false)
  })

  it('回放失败按失败上抛（ok:false + error，不抛异常）', async () => {
    const bridge: TaskbarBridge = {
      invoke: () => Promise.resolve({ ok: false, error: '托盘图标不在栏内名单' } as never),
      on: () => () => undefined,
    }
    await expect(dispatchTrayClick(bridge, '100:1', 'left')).resolves
      .toEqual({ ok: false, error: '托盘图标不在栏内名单' })
  })

  it('像素按身份取字节；无像素条目回 null', async () => {
    const b = fakeBridge(state({ tray: TRAY }))
    await expect(fetchTrayIcon(b.bridge, '100:1')).resolves.toEqual({ width: 16, height: 16, bgraBase64: 'AAAA' })
    await expect(fetchTrayIcon(b.bridge, 'guid:abc')).resolves.toBeNull()
  })
})

describe('托盘溢出菜单（工单162，fake bridge 驱动）', () => {
  const SEVEN: TaskbarTrayEntry[] = Array.from({ length: 7 }, (_, i) => ({ key: `${100 + i}:1`, tooltip: `图标${i}`, iconKey: `k${i}` }))

  it('视图模型透出档位（缺省 5；旧快照无字段不炸）', () => {
    expect(taskbarViewModel(state({ trayOverflowLimit: 8 })).trayOverflowLimit).toBe(8)
    expect(taskbarViewModel(state()).trayOverflowLimit).toBe(5)
    expect(taskbarViewModel({ ...state(), trayOverflowLimit: undefined as never }).trayOverflowLimit).toBe(5)
  })

  it('溢出拆分接视图条目：档位内全可见、超量尾部入溢出、「⋯」渲染判据 = overflow 非空', () => {
    const bar5 = splitTrayOverflow(SEVEN, 5)
    expect(bar5.bar.map((e) => e.key)).toEqual(['100:1', '101:1', '102:1', '103:1', '104:1'])
    expect(bar5.overflow.map((e) => e.key)).toEqual(['105:1', '106:1'])
    // 「⋯」不吃名额：档位 3 就是 3 枚可见
    expect(splitTrayOverflow(SEVEN, 3).bar).toHaveLength(3)
    // 全部档：永不溢出
    expect(splitTrayOverflow(SEVEN, 'all')).toEqual({ bar: SEVEN, overflow: [] })
  })

  it('菜单行生成：每行 key+名称（tooltip 优先，空 tooltip 回退身份键）、序 = 名单序', () => {
    const rows = trayOverflowMenuRows([
      { key: 'a:1', tooltip: '滴答清单', iconKey: 'k1' },
      { key: 'guid:abc', tooltip: '', iconKey: null },
    ])
    expect(rows).toEqual([
      { key: 'a:1', label: '滴答清单' },
      { key: 'guid:abc', label: 'guid:abc' },
    ])
    expect(trayOverflowMenuRows([])).toEqual([])
  })

  it('档位菜单行：3/5/8/全部四档、序固定、current 标记当前档', () => {
    expect(TRAY_OVERFLOW_TIERS.map((t) => [t.limit, t.label])).toEqual([
      [3, '3 枚'], [5, '5 枚'], [8, '8 枚'], ['all', '全部'],
    ])
    expect(trayOverflowTierRows(5).map((r) => [r.limit, r.current])).toEqual([
      [3, false], [5, true], [8, false], ['all', false],
    ])
    expect(trayOverflowTierRows('all').every((r) => r.current === (r.limit === 'all'))).toBe(true)
  })

  it('档位选择分发：合法档位经 taskbar/set-tray-overflow-limit 到桥；档位外是噪声不发 invoke', async () => {
    const b = fakeBridge(state())
    await expect(dispatchTrayOverflowLimit(b.bridge, 3)).resolves.toEqual(state())
    await expect(dispatchTrayOverflowLimit(b.bridge, 'all')).resolves.toEqual(state())
    expect(b.calls.filter((c) => c.method === 'taskbar/set-tray-overflow-limit')).toEqual([
      { method: 'taskbar/set-tray-overflow-limit', payload: { limit: 3 } },
      { method: 'taskbar/set-tray-overflow-limit', payload: { limit: 'all' } },
    ])
    for (const bad of [4, 0, 'x', 26]) {
      await expect(dispatchTrayOverflowLimit(b.bridge, bad as never)).resolves.toBeNull()
    }
    expect(b.calls.filter((c) => c.method === 'taskbar/set-tray-overflow-limit')).toHaveLength(2)
  })
})
describe('任务栏页面样式完整性（真机事故回归）', () => {
  // 55 验收失败的真根因：一次合并把 `#pill {` 与重复的 `.pill {` 拼在一起，
  // 选择器块没闭合，内联样式表后半段（开始组/右组/细条的全部规则）被浏览器整段丢弃——
  // 页面照样执行、事件照发，只是没人上样式：现象是「格子都在，位置全是块级堆叠」。
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/taskbar.html'), 'utf8')
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]

  it('内联样式表的花括号逐个闭合、块内无嵌套开括号', () => {
    expect(css).toBeTruthy()
    let depth = 0
    for (const ch of css!) {
      if (ch === '{') {
        expect(depth, '样式表出现嵌套 {：前一个块没闭合').toBe(0)
        depth = 1
      } else if (ch === '}') {
        depth -= 1
        expect(depth, '样式表出现多余的 }').toBe(0)
      }
    }
    expect(depth, '样式表结尾仍有未闭合的块').toBe(0)
  })

  it('关键选择器各有且仅有一条规则（防合并残留的重复定义）', () => {
    const ruleLines = css!.split(/\r?\n/).map((l) => l.trim())
    for (const sel of ['#pill-start', '#pill-apps', '#right-pill', '#show-desktop']) {
      const hits = ruleLines.filter((l) => l === `${sel} {` || l.startsWith(`${sel},`))
      expect(hits.length, `${sel} 规则数`).toBe(1)
    }
  })

  it('开始组与右组都挂 .pill，且 .pill 声明横排（丢了它两组就退化成块级堆叠、元素高出版带）', () => {
    expect(html).toContain('id="pill-start" class="pill"')
    expect(html).toContain('id="right-pill" class="pill"')
    const body = css!.slice(css!.indexOf('.pill {'))
    const block = body.slice(0, body.indexOf('}'))
    expect(block).toContain('display: flex')
    expect(block).toContain('align-items: center')
  })
})

describe('栏高与图标尺寸（工单158：48→64、应用图标 32px、托盘 24px）', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/taskbar.html'), 'utf8')
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]

  /** 取选择器块的规则体（`sel {` 起到配对 `}`；块内无嵌套括号——样式完整性守卫保证。
   * 匹配串带 ` {`：注释里出现的裸类名（如 .tb-tray-px）不得被误认成规则。 */
  function ruleOf(sel: string): string {
    const i = css!.indexOf(`${sel} {`)
    if (i < 0) return ''
    const body = css!.slice(i)
    return body.slice(0, body.indexOf('}'))
  }

  it('应用组图标格位 44px、图标 32px（CSS 落位——观感不小于原生任务栏）', () => {
    const cell = ruleOf('.tb-app')
    expect(cell).toContain('width: 44px')
    expect(cell).toContain('height: 44px')
    const icon = ruleOf('.tb-app img')
    expect(icon).toContain('width: 32px')
    expect(icon).toContain('height: 32px')
  })

  it('托盘图标 24px：16px 原生源走最近邻放大档（.tb-tray-px），32px 源按 24 平滑显示', () => {
    const base = ruleOf('.tb-tray-icon img')
    expect(base).toContain('width: 24px')
    expect(base).toContain('height: 24px')
    expect(base, '基础档不得带 pixelated（32px 源缩到 24 需平滑插值）').not.toContain('image-rendering')
    const px = ruleOf('.tb-tray-px')
    expect(px, '最近邻放大档必须存在且只挂 image-rendering: pixelated').toContain('image-rendering: pixelated')
  })

  it('托盘放大判据（纯函数）：源小于 24px 需最近邻放大档；≥24px 不需要', () => {
    expect(TASKBAR_TRAY_ICON_PX).toBe(24)
    expect(trayIconPixelated(16)).toBe(true) // 16px 原生源放大到 24：最近邻保持锐利
    expect(trayIconPixelated(20)).toBe(true) // 非常用尺寸但小于显示档同规则
    expect(trayIconPixelated(24)).toBe(false) // 原生匹配：1:1 无缩放
    expect(trayIconPixelated(32)).toBe(false) // 32px 源降采样到 24：平滑插值
  })

  it('挤撞回正守卫（49 电池 P5 真机红回归钉）：开始组可收窄裁推荐位、系统钮永不裁切', () => {
    // 事故：托盘 24px/字号升档后右组左侵屏幕居中的开始组，DOM 后绘盖死任务视图钮
    // （点击落到硬件摘要上、无 taskbar-action 存证）。守卫三件套缺一不可：
    const pillRule = ruleOf('#pill-start')
    expect(pillRule, '开始组可收窄（clampStartPillWidth 拥挤时设 maxWidth）').toContain('min-width: 0')
    expect(pillRule).toContain('overflow: hidden')
    expect(ruleOf('.tb-btn'), '系统钮 flex:none——收窄时永不裁切（被裁即 P5 重演）').toContain('flex: none')
    // 工单160 图标化后推荐位不再吃文字收缩档（.tb-rec 定宽图标格）：极端拥挤的让位面
    // 收敛为 pill maxWidth 收窄整体裁剪（overflow hidden），系统钮 flex:none 优先权不变
    expect(ruleOf('.tb-rec'), '推荐位图标格定宽（不吃收缩）').toContain('width: 44px')
  })
})

describe('栏分组布局重排（工单159：开始组钉左、应用组空带居中）', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/taskbar.html'), 'utf8')
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1]

  function ruleOf(sel: string): string {
    const i = css!.indexOf(`${sel} {`)
    if (i < 0) return ''
    const body = css!.slice(i)
    return body.slice(0, body.indexOf('}'))
  }

  it('开始组 pill 钉条带左缘（CSS 落位）：left 8px + 仅纵向居中变换，居中时代的横向位移退役', () => {
    const rule = ruleOf('#pill-start')
    expect(rule).toContain('left: 8px')
    expect(rule).toContain('transform: translateY(-50%)')
    expect(rule, '不得残留屏幕居中横向位移（工单159 反转布局）').not.toContain('translate(-50%')
  })

  it('应用组 pill 落位归渲染层（绝对定位 + JS 居中），CSS 不携带横向居中形态', () => {
    const rule = ruleOf('#pill-apps')
    expect(rule).toContain('position: absolute')
    expect(rule, 'CSS 不得自行居中（居中裁决 = appsPillLeft 纯函数）').not.toContain('left: 50%')
    expect(rule).not.toContain('translate(-50%')
  })

  it('空带两侧边界（纯函数）：左=开始组右缘+组间距（整组不渲染=条带左内衬）、右=右组左缘−组间距', () => {
    // 常态：开始组在左、右组在右
    expect(appsBand(320, 2000)).toEqual({ lo: 328, hi: 1992 })
    // 开始组整组不渲染（两按钮全隐藏且无推荐）：左界退到条带左缘内衬
    expect(appsBand(null, 2000)).toEqual({ lo: 8, hi: 1992 })
    // 异常态（右组自身越界左侵）：零宽带，等下一拍——不产出负带宽
    expect(appsBand(2400, 2200)).toEqual({ lo: 2408, hi: 2408 })
  })

  it('应用组容量两侧化（纯函数）：带宽 − pill 内衬 → 图标格数（含 ⋯ 钮位）；窄带/零宽带 0 格', () => {
    // 常态宽带：1992−8=1984 内容宽，−16 内衬 = 1968 → 42 格（1968/46=42.78 保守取整）
    expect(appsSlotsFor({ lo: 8, hi: 1992 })).toBe(42)
    // 窄带容不下一格：0
    expect(appsSlotsFor({ lo: 8, hi: 50 })).toBe(0)
    // 零宽带（异常态）：0
    expect(appsSlotsFor({ lo: 2408, hi: 2408 })).toBe(0)
  })

  it('居中位夹取（纯函数）：带宽足够取带中点；恰满/超带宽钉带左缘（溢出展开病态档）', () => {
    // 常态：200px pill 居中于 [100,500] 带 → 带中点 300 − 半宽 100 = 200
    expect(appsPillLeft({ lo: 100, hi: 500 }, 200)).toBe(200)
    // 非整除带宽：取整后两侧余隙差 ≤1px（带 460 宽、pill 200：中点 300−100=200，两侧 100/160）
    expect(appsPillLeft({ lo: 100, hi: 500 }, 201)).toBe(200) // 中点 300−100.5=199.5 → 200（右侧余 99，左侧 100）
    // 恰占满带宽：贴带左缘
    expect(appsPillLeft({ lo: 100, hi: 500 }, 400)).toBe(100)
    // 超带宽（溢出展开等病态档）：钉带左缘（右溢不反演到开始组一侧）
    expect(appsPillLeft({ lo: 100, hi: 500 }, 450)).toBe(100)
    // 负宽防御：按 0 宽居中带中点（不炸、不越界）
    expect(appsPillLeft({ lo: 100, hi: 500 }, -1)).toBe(300)
  })
})

// —— 工单160 推荐组交互主体（渲染层视图：图标化条目 + 右键两行菜单 + 左键启动分发）——

describe('推荐组交互（工单160，fake bridge 驱动）', () => {
  const html160 = fs.readFileSync(path.join(__dirname, '../../src/renderer/taskbar.html'), 'utf8')
  const css160 = /<style>([\s\S]*?)<\/style>/.exec(html160)?.[1] ?? ''
  function ruleOf160(sel: string): string {
    const i = css160.indexOf(`${sel} {`)
    if (i < 0) return ''
    return css160.slice(i, css160.indexOf('}', i))
  }
  it('推荐位条目携带 exe 身份与图标键透出（启动/手钉/定位的统一寻址原样进渲染层）', () => {
    const vm = taskbarViewModel(state({ recommendations: RECS }))
    expect(vm.recommendations[0].exe).toBe('C:\\Apps\\Alpha.exe')
    expect(vm.recommendations[0].iconKey).toBe('Alpha.lnk|0')
    expect(vm.recommendations[1].exe).toBe('C:\\Desktop\\Beta.lnk')
  })

  it('右键菜单三行（工单161 扩第三行）：手钉到任务栏、从推荐栏移除、打开文件位置', () => {
    expect(taskbarRecMenuRows()).toEqual([
      { action: 'pin', label: '手钉到任务栏' },
      { action: 'remove', label: '从推荐栏移除' },
      { action: 'reveal', label: '打开文件位置' },
    ])
  })

  it('左键启动分发：exe 身份经 taskbar/rec-click；空 exe 是噪声不发 invoke', async () => {
    const { bridge, calls } = fakeBridge(state())
    await dispatchRecClick(bridge, 'C:\\Apps\\Alpha.exe')
    expect(calls).toEqual([{ method: 'taskbar/rec-click', payload: { exe: 'C:\\Apps\\Alpha.exe' } }])
    const { bridge: b2, calls: c2 } = fakeBridge(state())
    await dispatchRecClick(b2, '')
    expect(c2).toEqual([])
  })

  it('右键菜单动作分发：pin→taskbar/rec-pin（回执最新状态）、reveal→taskbar/rec-reveal；未知动作/空 exe 是噪声不发 invoke', async () => {
    const { bridge, calls } = fakeBridge(state())
    const pinned = await dispatchRecMenuAction(bridge, 'C:\\Apps\\Alpha.exe', 'pin')
    expect(pinned).toEqual(state())
    const revealed = await dispatchRecMenuAction(bridge, 'C:\\Apps\\Alpha.exe', 'reveal')
    expect(revealed).toEqual({ ok: true })
    expect(calls).toEqual([
      { method: 'taskbar/rec-pin', payload: { exe: 'C:\\Apps\\Alpha.exe' } },
      { method: 'taskbar/rec-reveal', payload: { exe: 'C:\\Apps\\Alpha.exe' } },
    ])
    expect(await dispatchRecMenuAction(bridge, 'C:\\Apps\\Alpha.exe', 'close' as never)).toBeNull()
    expect(await dispatchRecMenuAction(bridge, '', 'pin')).toBeNull()
  })

  it('右键菜单动作分发（工单161 扩 remove）：remove→taskbar/rec-remove（回执最新状态）', async () => {
    const { bridge, calls } = fakeBridge(state())
    const removed = await dispatchRecMenuAction(bridge, 'C:\\Apps\\Alpha.exe', 'remove')
    expect(removed).toEqual(state())
    expect(calls).toEqual([{ method: 'taskbar/rec-remove', payload: { exe: 'C:\\Apps\\Alpha.exe' } }])
  })

  it('移除名单透出（工单161）：视图模型原样透出 state.excluded（恢复菜单行的来源）；禁用态空壳', () => {
    const excluded = [{ exe: 'C:\\Apps\\Gone.exe', label: '移除过的', iconKey: null }]
    const vm = taskbarViewModel(state({ excluded }))
    expect(vm.excluded).toEqual(excluded)
    expect(taskbarViewModel(state({ enabled: false })).excluded).toEqual([])
  })

  it('恢复分发（工单161）：exe 经 taskbar/rec-restore（回执最新状态）；空 exe 是噪声不发 invoke', async () => {
    const { bridge, calls } = fakeBridge(state())
    const restored = await dispatchRecRestore(bridge, 'C:\\Apps\\Gone.exe')
    expect(restored).toEqual(state())
    expect(calls).toEqual([{ method: 'taskbar/rec-restore', payload: { exe: 'C:\\Apps\\Gone.exe' } }])
    const { bridge: b2, calls: c2 } = fakeBridge(state())
    await dispatchRecRestore(b2, '')
    expect(c2).toEqual([])
  })

  it('首字母占位复用（工单156 appIconFallbackText）：推荐条目按显示名/exe 出占位文本', () => {
    expect(appIconFallbackText({ label: 'Alpha', exe: 'C:\\Apps\\Alpha.exe' })).toBe('A')
    expect(appIconFallbackText({ label: '', exe: 'C:\\Apps\\Beta.exe' })).toBe('B')
  })

  it('推荐位图标格 CSS（图标化形态）：格位 44px/图标 32px 与应用组同观感，无文字截断形态残留', () => {
    const rec = ruleOf160('.tb-rec')
    expect(rec).toContain('width: 44px')
    expect(rec).toContain('height: 44px')
    expect(rec, '图标格不再收缩让位（文字 ellipsis 形态随图标化退役）').not.toContain('text-overflow')
    const img = ruleOf160('.tb-rec img')
    expect(img).toContain('width: 32px')
    expect(img).toContain('height: 32px')
    expect(ruleOf160('.tb-rec-letter'), '无图标键条目首字母占位不出空白格').toContain('font-size')
  })
})
