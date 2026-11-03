/**
 * 会话气泡悬停状态机（工单381，spec #369 决策 24）：fake clock 驱动的时间语义——
 * 悬停 300ms 才展开、离开 400ms 宽限、气泡内指针在场不收起、Esc 收起、宽限内移回立即复展开。
 * 另含锚点热区 id 的镜像守卫（渲染层 modeZoneId('agent') ≡ 主进程常量）。
 */
import { describe, expect, it } from 'vitest'
import {
  HOVER_GRACE_MS,
  HOVER_OPEN_MS,
  SESSION_PREVIEW_ANCHOR_ZONE,
  initialHoverState,
  reduceHover,
} from '../../src/main/session-preview/hover'
import type { HoverEvent, HoverState } from '../../src/main/session-preview/hover'
import { modeZoneId } from '../../src/renderer/taskbar-view'

function tickTo(state: HoverState, at: number): { state: HoverState; action: string } {
  return reduceHover(state, { type: 'tick' }, at)
}

describe('悬停状态机（fake clock）', () => {
  it('悬停满 300ms 才展开：299ms 不展开、300ms 展开', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 1000).state
    const before = tickTo(s, 1000 + HOVER_OPEN_MS - 1)
    expect(before.action).toBe('none')
    const at = tickTo(before.state, 1000 + HOVER_OPEN_MS)
    expect(at.action).toBe('open')
    expect(at.state.phase).toBe('open')
  })

  it('普通划过（未满 300ms 就离开）不展开', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = reduceHover(s, { type: 'leave-anchor' }, 200).state
    const r = tickTo(s, 500)
    expect(r.action).toBe('none')
    expect(r.state.phase).toBe('idle')
  })

  it('离开后 400ms 宽限：399ms 仍展开、400ms 收起', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = tickTo(s, HOVER_OPEN_MS).state
    s = reduceHover(s, { type: 'leave-anchor' }, 1000).state
    expect(s.phase).toBe('closing')
    expect(tickTo(s, 1000 + HOVER_GRACE_MS - 1).action).toBe('none')
    const r = tickTo(s, 1000 + HOVER_GRACE_MS)
    expect(r.action).toBe('close')
    expect(r.state.phase).toBe('idle')
  })

  it('指针移入气泡即取消待收起（400ms 宽限的唯一目的）', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = tickTo(s, HOVER_OPEN_MS).state
    s = reduceHover(s, { type: 'leave-anchor' }, 1000).state
    s = reduceHover(s, { type: 'enter-bubble' }, 1100).state
    expect(s.phase).toBe('open')
    expect(s.inBubble).toBe(true)
    // 气泡内指针在场时离开锚点不进入收起
    s = reduceHover(s, { type: 'leave-anchor' }, 1200).state
    expect(s.phase).toBe('open')
    expect(tickTo(s, 5000).action).toBe('none')
  })

  it('离开气泡后重新进入 400ms 宽限并收起', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = tickTo(s, HOVER_OPEN_MS).state
    s = reduceHover(s, { type: 'enter-bubble' }, 400).state
    s = reduceHover(s, { type: 'leave-bubble' }, 2000).state
    expect(s.phase).toBe('closing')
    expect(tickTo(s, 2000 + HOVER_GRACE_MS).action).toBe('close')
  })

  it('宽限内移回锚点立即复展开（不重新等 300ms）', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = tickTo(s, HOVER_OPEN_MS).state
    s = reduceHover(s, { type: 'leave-anchor' }, 1000).state
    const back = reduceHover(s, { type: 'enter-anchor' }, 1100)
    expect(back.state.phase).toBe('open')
    expect(back.action).toBe('none')
    expect(tickTo(back.state, 1200).action).toBe('none')
  })

  it('Esc 在任何展开态立即收起；待展开态不发 close', () => {
    let open = initialHoverState()
    open = reduceHover(open, { type: 'enter-anchor' }, 0).state
    open = tickTo(open, HOVER_OPEN_MS).state
    const esc = reduceHover(open, { type: 'esc' }, 500)
    expect(esc.action).toBe('close')
    expect(esc.state.phase).toBe('idle')

    let arming = reduceHover(initialHoverState(), { type: 'enter-anchor' }, 0).state
    const escArming = reduceHover(arming, { type: 'esc' }, 100)
    expect(escArming.action).toBe('none')
    expect(escArming.state.phase).toBe('idle')
  })

  it('重复 enter-anchor 不重置 300ms 计时（等距热区事件不拖住展开）', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = reduceHover(s, { type: 'enter-anchor' }, 200).state
    expect(tickTo(s, HOVER_OPEN_MS).action).toBe('open')
  })
})

describe('标题栏拖拽期间的会话预览暂停（工单407，spec #403 决策「拖拽期间协调会话预览」）', () => {
  it('展开态遇到 drag-active：立即收起并进入暂停（拖拽期预览不争夺落点，story 40）', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'enter-anchor' }, 0).state
    s = tickTo(s, HOVER_OPEN_MS).state
    expect(s.phase).toBe('open')
    const r = reduceHover(s, { type: 'drag-active' }, 2000)
    expect(r.action).toBe('close')
    expect(r.state.phase).toBe('idle')
    expect(r.state.dragHold).toBe(true)
  })

  it('暂停期 enter-anchor 被吞：拖动划过 Agent 入口不展开、不计时', () => {
    let s = initialHoverState()
    s = reduceHover(s, { type: 'drag-active' }, 0).state
    expect(s.dragHold).toBe(true)
    const r = reduceHover(s, { type: 'enter-anchor' }, 100)
    expect(r.action).toBe('none')
    expect(r.state.phase).toBe('idle')
    expect(tickTo(r.state, 100 + HOVER_OPEN_MS).action).toBe('none')
  })

  it('暂停期待展开态（arming）也被取消', () => {
    let s = reduceHover(initialHoverState(), { type: 'enter-anchor' }, 0).state
    s = reduceHover(s, { type: 'drag-active' }, 100).state
    expect(s.phase).toBe('idle')
    expect(s.dragHold).toBe(true)
  })

  it('drag-end 解除暂停：恢复既有预览行为（重新悬停 300ms 后照常展开）', () => {
    let s = reduceHover(initialHoverState(), { type: 'drag-active' }, 0).state
    s = reduceHover(s, { type: 'drag-end' }, 3000).state
    expect(s.dragHold).toBe(false)
    expect(s.phase).toBe('idle')
    s = reduceHover(s, { type: 'enter-anchor' }, 3100).state
    const r = tickTo(s, 3100 + HOVER_OPEN_MS)
    expect(r.action).toBe('open')
  })

  it('drag-end 在未暂停态是幂等空转', () => {
    const r = reduceHover(initialHoverState(), { type: 'drag-end' }, 0)
    expect(r.action).toBe('none')
    expect(r.state.dragHold).toBe(false)
  })
})

describe('锚点热区 id 镜像守卫', () => {
  it('渲染层 modeZoneId(agent) 与主进程悬停锚点常量逐字一致', () => {
    expect(modeZoneId('agent')).toBe(SESSION_PREVIEW_ANCHOR_ZONE)
    expect(modeZoneId('normal')).toBe('mode:normal')
  })

  it('事件对象可穷举（状态机不吞未知事件形态——新增事件必须同步 reducer）', () => {
    const events: HoverEvent[] = [
      { type: 'enter-anchor' }, { type: 'leave-anchor' }, { type: 'enter-bubble' },
      { type: 'leave-bubble' }, { type: 'esc' }, { type: 'tick' }, { type: 'reset' },
      { type: 'drag-active' }, { type: 'drag-end' },
    ]
    for (const e of events) expect(() => reduceHover(initialHoverState(), e, 0)).not.toThrow()
  })
})
