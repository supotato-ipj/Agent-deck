// 系统窗口事件路由（工单475，spec #472 用户故事 19「窗口增删等事件由系统通知驱动」）：
// WinEventProc 原始观察 → 路由裁决的纯函数缝——光标/插入符等非窗口对象过滤、
// 订阅事件集 → 消费者脏位。悬垂面：Win32 钩子投递本身（真机验收电池 P9 盖）。
import { describe, expect, it } from 'vitest'
import {
  OBJID_CARET,
  OBJID_CURSOR,
  OBJID_WINDOW,
  WIN_EVENT,
  routeWinEvent,
} from '../src/main/win-event-route'

/** 一条 WinEventProc 观察的最小构造（默认=前台窗变化：窗口对象、非子对象） */
function obs(over: { eventId?: number; hwnd?: number; idObject?: number; idChild?: number; atMs?: number } = {}) {
  return {
    eventId: WIN_EVENT.SYSTEM_FOREGROUND,
    hwnd: 0x1234,
    idObject: OBJID_WINDOW,
    idChild: 0,
    atMs: 1000,
    ...over,
  }
}

describe('routeWinEvent 订阅路由（工单475 纯裁决）', () => {
  it('订阅集内事件（前台/z 序/显隐/销毁/最小化）→ 消费者脏位置位', () => {
    const subscribed = [
      WIN_EVENT.SYSTEM_FOREGROUND,
      WIN_EVENT.SYSTEM_MINIMIZESTART,
      WIN_EVENT.SYSTEM_MINIMIZEEND,
      WIN_EVENT.OBJECT_DESTROY,
      WIN_EVENT.OBJECT_SHOW,
      WIN_EVENT.OBJECT_HIDE,
      WIN_EVENT.OBJECT_REORDER,
    ]
    for (const eventId of subscribed) {
      expect(routeWinEvent(obs({ eventId })), `eventId=0x${eventId.toString(16)}`).toMatchObject({ dirty: true })
    }
  })

  it('窗口移动/尺寸（LOCATIONCHANGE）与状态翻转（STATECHANGE）也入路由（Snap 贴靠/退出全屏的探测缝）', () => {
    expect(routeWinEvent(obs({ eventId: WIN_EVENT.OBJECT_LOCATIONCHANGE }))).toMatchObject({ dirty: true })
    expect(routeWinEvent(obs({ eventId: WIN_EVENT.OBJECT_STATECHANGE }))).toMatchObject({ dirty: true })
  })

  it('光标对象（OBJID_CURSOR，hwnd=0）不置脏——鼠标移动的热事件不得驱动再评估', () => {
    expect(routeWinEvent(obs({ eventId: WIN_EVENT.OBJECT_LOCATIONCHANGE, hwnd: 0, idObject: OBJID_CURSOR })))
      .toMatchObject({ dirty: false, cursorLike: true })
  })

  it('插入符对象（OBJID_CARET）不置脏——打字热事件同滤', () => {
    expect(routeWinEvent(obs({ eventId: WIN_EVENT.OBJECT_LOCATIONCHANGE, idObject: OBJID_CARET })))
      .toMatchObject({ dirty: false, cursorLike: true })
  })

  it('子对象事件（idChild≠0，滚动条拇指等）不置脏——只认整窗对象', () => {
    expect(routeWinEvent(obs({ eventId: WIN_EVENT.OBJECT_LOCATIONCHANGE, idChild: 1 })))
      .toMatchObject({ dirty: false })
  })

  it('订阅区间外的类型不置脏（钩子区间防御——路由独立于钩子区间可判）', () => {
    expect(routeWinEvent(obs({ eventId: 0x000E }))).toMatchObject({ dirty: false })
    expect(routeWinEvent(obs({ eventId: 0x800E }))).toMatchObject({ dirty: false })
  })
})
