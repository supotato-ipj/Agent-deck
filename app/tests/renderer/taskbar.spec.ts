import { describe, expect, it } from 'vitest'
import { dispatchActivateWindow, dispatchTaskbarDragDrop, dispatchTrayClick, fetchTrayIcon, dispatchAppClick, dispatchAppMenuAction, dispatchAppNewInstance, dispatchTaskbarApp, dispatchTaskbarButton, dispatchTaskbarVisibility, splitLeftOverflow, taskbarAppMenuRows, taskbarViewModel, formatClock, formatMetric, summaryViewModel, TASKBAR_METRICS, toggleMetric } from '../../src/renderer/taskbar-view'
import { TASKBAR_METRIC_KEYS } from '../../src/shared/contract'
/**
 * 任务栏 pill 渲染/点击契约测试（工单49/52/54/55——fake bridge 驱动，Node 中直跑不碰 DOM）：
 * 渲染 = taskbar/get-state → 视图模型（左组形态映射 + 中组系统按钮显隐 + 推荐位 +
 * 整组显隐边界）；点击 = 按钮 id → taskbar/system-action；右键菜单动作 = taskbar/set-button-hidden。
 * 工单58：左组溢出拆分（容量内全留栏、超限尾部收浮层）+ 应用图标点击分发 taskbar/activate-app。
 */
import type { TaskbarBridge, TaskbarLeftViewEntry } from '../../src/renderer/taskbar-view'
import fs from 'node:fs'
import path from 'node:path'
import type { HardwareGauges, TaskbarLeftEntry, TaskbarMetric, TaskbarState } from '../../src/shared/contract'
const ALL = [...TASKBAR_METRIC_KEYS]

function state(over: Partial<TaskbarState> = {}): TaskbarState {
  return { enabled: true, hiddenButtons: [], recommendations: [], metrics: ALL, left: [], tray: [], ...over }
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
      // 工单56 托盘入栏
      if (method === 'taskbar/tray-click') return Promise.resolve({ ok: true } as never)
      if (method === 'taskbar/tray-icon') {
        const { key } = payload as { key: string }
        const hit = s.tray.find((t) => t.key === key)
        return Promise.resolve({ icon: hit?.iconKey ? { width: 16, height: 16, bgraBase64: 'AAAA' } : null } as never)
      }
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
describe('任务栏页面样式完整性（真机事故回归）', () => {
  // 55 验收失败的真根因：一次合并把 `#pill {` 与重复的 `.pill {` 拼在一起，
  // 选择器块没闭合，内联样式表后半段（中组/右组/细条的全部规则）被浏览器整段丢弃——
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
    for (const sel of ['#pill', '#pill-left', '#right-pill', '#show-desktop']) {
      const hits = ruleLines.filter((l) => l === `${sel} {` || l.startsWith(`${sel},`))
      expect(hits.length, `${sel} 规则数`).toBe(1)
    }
  })

  it('两组都挂 .pill，且 .pill 声明横排（丢了它两组就退化成块级堆叠、元素高出版带）', () => {
    expect(html).toContain('id="pill" class="pill"')
    expect(html).toContain('id="right-pill" class="pill"')
    const body = css!.slice(css!.indexOf('.pill {'))
    const block = body.slice(0, body.indexOf('}'))
    expect(block).toContain('display: flex')
    expect(block).toContain('align-items: center')
  })
})
