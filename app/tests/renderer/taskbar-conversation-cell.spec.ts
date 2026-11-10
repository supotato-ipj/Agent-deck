import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTaskbarDomStub, type TaskbarDomStub } from './taskbar-dom-stub'
import type { ConversationSessionView, TaskbarState } from '../../src/shared/contract'

/**
 * 对话窗入口格渲染接线（工单460，spec #457 T4）：条带窗真页的最小 DOM 桩驱动（工单249
 * 同款理由），钉的是**渲染入口的接线**——格在场与插位（硬件摘要与首枚托盘图标之间）、
 * data-id 几何口径、点击分发 conversation/show、busy 假事件点亮/熄灭（conversation/changed
 * 订阅）。纯函数面（二态裁决/图标/分发本体）由 taskbar.spec.ts 同票 describe 钉。
 */
const STATE: TaskbarState = {
  enabled: true,
  hiddenButtons: [],
  recommendations: [],
  excluded: [],
  metrics: ['cpu'],
  apps: [],
  tray: [
    { key: 'probe-1', tooltip: '探针一', iconKey: null },
    { key: 'probe-2', tooltip: '探针二', iconKey: null },
  ],
  trayOverflowLimit: 5,
  trayPinned: [],
  maximizeRetract: true,
}

const session = (status: string) => ({ id: `s-${status}`, status }) as unknown as ConversationSessionView

async function bootWith(state: TaskbarState): Promise<TaskbarDomStub> {
  const stub = installTaskbarDomStub({ state })
  vi.resetModules()
  await import('../../src/renderer/taskbar')
  await stub.whenReady()
  await Promise.resolve()
  return stub
}

describe('对话窗入口格渲染接线（工单460，spec #457 T4）', () => {
  let stub: TaskbarDomStub | null = null

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stub?.cleanup()
    stub = null
    vi.useRealTimers()
  })

  it('渲染在场与插位：右组 data-id=conversation 格位于 hw-summary 之后、首枚托盘图标与 network 之前（托盘群最左端）', async () => {
    stub = await bootWith(STATE)
    const rightPill = stub.element('right-pill')
    const ids = rightPill.querySelectorAll('[data-id]').map((el) => el.dataset.id)
    expect(ids).toContain('conversation')
    expect(ids.indexOf('conversation')).toBeGreaterThan(ids.indexOf('hw-summary'))
    // 托盘图标挂 data-key 不进 [data-id] 列——用子元素 DOM 序核对「托盘群最左端」：
    // conversation 格之后紧跟的格类子元素应是 .tb-tray-icon，而非 network/volume
    const order = rightPill.children.map((c) => c.className)
    const convIdx = rightPill.children.findIndex((c) => c.dataset.id === 'conversation')
    expect(rightPill.children[convIdx + 1]?.className).toContain('tb-tray-icon')
    expect(order.filter((c) => c.includes('tb-network-cell'))[0]).toBeDefined()
    expect(ids.indexOf('conversation')).toBeLessThan(ids.indexOf('network'))
  })

  it('几何口径：格挂 data-id 进 taskbar-geometry 的 rightCells（热区/电池取坐标零特例）', async () => {
    stub = await bootWith(STATE)
    const geo = stub.notifyCalls('taskbar-geometry').at(-1) as { rightCells: Array<{ id: string }> }
    expect(geo.rightCells.map((c) => c.id)).toContain('conversation')
  })

  it('格样式与识别：title=「对话窗」、内联 SVG 图标落格（图标格族 28×28 归 taskbar.html CSS）', async () => {
    stub = await bootWith(STATE)
    const cell = stub.element('right-pill').querySelector('[data-id="conversation"]')
    expect(cell).not.toBeNull()
    expect(cell!.title).toBe('对话窗')
    expect(cell!.getAttribute('aria-label')).toBe('对话窗')
    // 桩不解析 SVG 为子节点（工单249 最小近似）——innerHTML 字符串产物即落格图标
    expect(cell!.innerHTML).toContain('<svg')
  })

  it('点击分发 conversation/show（左键调窗——show+置前语义在内核，非 toggle 隐藏）', async () => {
    stub = await bootWith(STATE)
    const cell = stub.element('right-pill').querySelector('[data-id="conversation"]')
    cell!.dispatch('click')
    await Promise.resolve()
    await Promise.resolve()
    expect(stub.invokeCalls()).toContainEqual({ method: 'conversation/show', payload: {} })
  })

  it('busy 假事件点亮：conversation/changed（任一会话 status=busy）→ data-state=busy 且点亮标记在场', async () => {
    stub = await bootWith(STATE)
    const cell = stub.element('right-pill').querySelector('[data-id="conversation"]')
    expect(cell!.dataset.state).toBe('idle') // 首态熄灭（缺会话数据不误报点亮）
    stub.emit('conversation/changed', { sessions: [session('ready'), session('busy')] })
    const lit = stub.element('right-pill').querySelector('[data-id="conversation"]')
    expect(lit!.dataset.state).toBe('busy')
    expect(lit!.innerHTML).toContain('tb-conv-dot')
    expect(lit!.innerHTML).toContain('tb-conv-bubble')
  })

  it('无 busy 假事件熄灭：conversation/changed（全非 busy）→ data-state=idle 且点亮标记退场（二态无中间态）', async () => {
    stub = await bootWith(STATE)
    stub.emit('conversation/changed', { sessions: [session('busy')] })
    expect(stub.element('right-pill').querySelector('[data-id="conversation"]')!.dataset.state).toBe('busy')
    stub.emit('conversation/changed', { sessions: [session('ready'), session('ended')] })
    const dim = stub.element('right-pill').querySelector('[data-id="conversation"]')
    expect(dim!.dataset.state).toBe('idle')
    expect(dim!.innerHTML).not.toContain('tb-conv-dot')
  })

  it('整树重渲不丢忙碌态：conversation/changed 点亮后 taskbar/changed 重渲，格仍 busy（忙碌账独立于托盘 churn）', async () => {
    stub = await bootWith(STATE)
    stub.emit('conversation/changed', { sessions: [session('busy')] })
    expect(stub.element('right-pill').querySelector('[data-id="conversation"]')!.dataset.state).toBe('busy')
    stub.emit('taskbar/changed', { ...STATE, tray: [] })
    const cell = stub.element('right-pill').querySelector('[data-id="conversation"]')
    expect(cell).not.toBeNull()
    expect(cell!.dataset.state).toBe('busy')
  })
})
