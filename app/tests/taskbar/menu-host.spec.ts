/**
 * 五菜单浮层宿主锚测试（spec188 评审修复轮）：宿主装配参数（窗 title/存证事件族/
 * diagPrefix/bridge 通道）与开层 URL query 逐字钉住——验收锚点敏感面。收口重构
 * （startMenuHost 工厂）前后本文件必须同绿：事件存证名族与浮层窗 title/query 逐字
 * 不变是重构的硬约束（spec154 requireNonEmptyId 收口先例：消息/参数逐字保持）。
 * 载体（popup.ts）mock 成记录器：装配参数原样入档，open/close/dispose 调用入账。
 * Electron 只 mock screen（视口帽惰性取工作区：1040 → maxH = max(320, 1040-80) = 960）；
 * taskbarMenuUrl 用真实现（协议寻址不在重构面）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** 载体记录器：每个 startMenuHost 调用入档一实例（装配 options + open/close/dispose 账） */
const recorder = vi.hoisted(() => {
  const instances: Array<{
    options: Record<string, unknown>
    open: Array<{ url: string } | undefined>
    close: unknown[]
    disposed: number
  }> = []
  return instances
})

vi.mock('electron', () => ({
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }) },
  protocol: {},
}))

vi.mock('../../src/main/taskbar/popup', () => ({
  startPopupMenuCarrier: (options: Record<string, unknown>) => {
    const inst = { options, open: [] as Array<{ url: string } | undefined>, close: [] as unknown[], disposed: 0 }
    recorder.push(inst)
    return {
      open: (req?: { url: string }) => { inst.open.push(req) },
      close: (reason: unknown) => { inst.close.push(reason) },
      isVisible: () => false,
      dispose: () => { inst.disposed++ },
    }
  },
}))

import { startAppMenuHost, TASKBAR_MENU_TITLE } from '../../src/main/taskbar/app-menu'
import { startRecMenuHost, REC_MENU_TITLE } from '../../src/main/taskbar/rec-menu'
import { startBlankMenuHost, BLANK_MENU_TITLE } from '../../src/main/taskbar/blank-menu'
import { startTierMenuHost, TIER_MENU_TITLE } from '../../src/main/taskbar/tier-menu'
import { startWinsMenuHost, WINS_MENU_TITLE } from '../../src/main/taskbar/wins-menu'
import { taskbarMenuUrl } from '../../src/main/plugins/protocol'
import type { Context } from 'cordis'

/** 视口帽期望值：max(320, 工作区高 1040 - 80) */
const MAXH = 960
const CTX = {} as Context

/** 五面装配参数逐字期望（title/事件族/diagPrefix/bridge 通道） */
const FACES = [
  {
    name: 'app-menu（工单193 应用组右键）',
    title: 'DECK-TASKBAR-MENU',
    family: 'taskbar-app-menu',
    diagPrefix: 'app-menu',
    start: () => startAppMenuHost({ ctx: CTX, log: null }),
  },
  {
    name: 'rec-menu（工单196 推荐条目三行）',
    title: 'DECK-TASKBAR-REC-MENU',
    family: 'taskbar-rec-menu',
    diagPrefix: 'rec-menu',
    start: () => startRecMenuHost({ ctx: CTX, log: null }),
  },
  {
    name: 'blank-menu（工单196 空白右键）',
    title: 'DECK-TASKBAR-BLANK-MENU',
    family: 'taskbar-blank-menu',
    diagPrefix: 'blank-menu',
    start: () => startBlankMenuHost({ ctx: CTX, log: null }),
  },
  {
    name: 'tier-menu（工单196 托盘档位）',
    title: 'DECK-TASKBAR-TIER-MENU',
    family: 'taskbar-tier-menu',
    diagPrefix: 'tier-menu',
    start: () => startTierMenuHost({ ctx: CTX, log: null }),
  },
  {
    name: 'wins-menu（工单196 多窗选窗列表）',
    title: 'DECK-TASKBAR-WINS-MENU',
    family: 'taskbar-wins-menu',
    diagPrefix: 'wins-menu',
    start: () => startWinsMenuHost({ ctx: CTX, log: null }),
  },
] as const

describe('五菜单宿主装配参数逐字锚（title/事件族/diagPrefix/bridge）', () => {
  beforeEach(() => { recorder.length = 0 })

  for (const face of FACES) {
    it(`${face.name}：title 常量与载体装配逐字一致`, () => {
      face.start()
      expect(recorder.length).toBe(1)
      const opt = recorder[0].options
      expect(opt.title).toBe(face.title)
      expect(opt.events).toEqual({
        opened: `${face.family}-opened`,
        resized: `${face.family}-resized`,
        closed: `${face.family}-closed`,
      })
      expect(opt.readyEvent).toBe(`${face.family}-ready`)
      expect(opt.closeEvent).toBe(`${face.family}-close`)
      expect(opt.diagPrefix).toBe(face.diagPrefix)
      expect(opt.bridgeChannels).toEqual(['taskbar/changed'])
    })
  }

  it('五面标题互异（窗常驻同 title 多扇寻窗歧义防线）', () => {
    const titles = [TASKBAR_MENU_TITLE, REC_MENU_TITLE, BLANK_MENU_TITLE, TIER_MENU_TITLE, WINS_MENU_TITLE]
    expect(new Set(titles).size).toBe(5)
  })
})

describe('五菜单宿主开层 URL query 逐字锚', () => {
  beforeEach(() => { recorder.length = 0 })

  it('app 面：?menu=app&exe=<enc>&maxH（无 title 参数——193 形态缺省保持）', () => {
    const host = startAppMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-app-menu-open', { exe: 'deck probe.exe' })
    expect(recorder[0].open).toEqual([
      { url: `${taskbarMenuUrl()}?menu=app&exe=deck%20probe.exe&maxH=${MAXH}` },
    ])
  })

  it('app 面：空 exe 不开层（噪声请求）', () => {
    const host = startAppMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-app-menu-open', {})
    host.onStripNotify('taskbar-app-menu-open', undefined)
    expect(recorder[0].open).toEqual([])
  })

  it('rec 面：?menu=rec&exe=&name=&title=&maxH（exe/name/title 次序逐字）', () => {
    const host = startRecMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-rec-menu-open', { exe: 'a.exe', name: '应用 X' })
    expect(recorder[0].open).toEqual([
      { url: `${taskbarMenuUrl()}?menu=rec&exe=a.exe&name=${encodeURIComponent('应用 X')}&title=DECK-TASKBAR-REC-MENU&maxH=${MAXH}` },
    ])
  })

  it('rec 面：空 exe 不开层（name 缺席不拦——name 只随动作事件原样回传）', () => {
    const host = startRecMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-rec-menu-open', {})
    expect(recorder[0].open).toEqual([])
    host.onStripNotify('taskbar-rec-menu-open', { exe: 'a.exe' })
    expect(recorder[0].open).toHaveLength(1)
  })

  it('blank 面：?menu=blank&title=&maxH（无域参数——两组宿主同一菜单面）', () => {
    const host = startBlankMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-blank-menu-open', {})
    host.onStripNotify('taskbar-blank-menu-open', undefined)
    expect(recorder[0].open).toEqual([
      { url: `${taskbarMenuUrl()}?menu=blank&title=DECK-TASKBAR-BLANK-MENU&maxH=${MAXH}` },
      { url: `${taskbarMenuUrl()}?menu=blank&title=DECK-TASKBAR-BLANK-MENU&maxH=${MAXH}` },
    ])
  })

  it('tier 面：?menu=tier&title=&maxH', () => {
    const host = startTierMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-tier-menu-open', {})
    expect(recorder[0].open).toEqual([
      { url: `${taskbarMenuUrl()}?menu=tier&title=DECK-TASKBAR-TIER-MENU&maxH=${MAXH}` },
    ])
  })

  it('wins 面：?menu=wins&exe=&title=&maxH', () => {
    const host = startWinsMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-wins-menu-open', { exe: 'w.exe' })
    expect(recorder[0].open).toEqual([
      { url: `${taskbarMenuUrl()}?menu=wins&exe=w.exe&title=DECK-TASKBAR-WINS-MENU&maxH=${MAXH}` },
    ])
  })

  it('wins 面：空 exe 不开层', () => {
    const host = startWinsMenuHost({ ctx: CTX, log: null })
    host.onStripNotify('taskbar-wins-menu-open', { exe: '' })
    expect(recorder[0].open).toEqual([])
  })
})

describe('五菜单宿主请求路由与转发锚', () => {
  beforeEach(() => { recorder.length = 0 })

  it('开层请求只认自家家族名（域外 notify 静默跳过）', () => {
    const app = startAppMenuHost({ ctx: CTX, log: null })
    app.onStripNotify('taskbar-tier-menu-open', {})
    app.onStripNotify('taskbar-wins-menu-open', { exe: 'w.exe' })
    app.onStripNotify('taskbar-tray-overflow-open', {})
    expect(recorder[0].open).toEqual([])
    app.onStripNotify('taskbar-app-menu-open', { exe: 'a.exe' })
    expect(recorder[0].open).toHaveLength(1)
  })

  it('收层请求转发：payload.reason 落底；缺席落 request', () => {
    const tier = startTierMenuHost({ ctx: CTX, log: null })
    tier.onStripNotify('taskbar-tier-menu-close', { reason: 'strip-click' })
    tier.onStripNotify('taskbar-tier-menu-close', undefined)
    tier.onStripNotify('taskbar-tier-menu-close', {})
    expect(recorder[0].close).toEqual(['strip-click', 'request', 'request'])
  })

  it('显式 close 与 dispose 直转载体', () => {
    const wins = startWinsMenuHost({ ctx: CTX, log: null })
    wins.close('yield')
    wins.dispose()
    expect(recorder[0].close).toEqual(['yield'])
    expect(recorder[0].disposed).toBe(1)
  })
})
