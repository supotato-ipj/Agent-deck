/**
 * 删除/解散确认层的**排版**（工单362 = spec361 之①）。
 *
 * 病灶有两处，且都不是「某个文件名太长」那么窄：
 *   1. 盒子高度只按**一枚**按钮算，实际渲染**两枚**（确认钮与 CANCEL 各占一行）；
 *   2. 文件名**换行**没计入高度（长中文名一行放不下时会折行）。
 * 于是短名与长名 alike，确认框都会把第二枚按钮裁在盒外——票面「按钮显示不全」正是这个。
 *
 * 本份钉的是**外部几何与行为**（spec361 测试决策 1）：两枚按钮的最终矩形完整落在对话框与视口内、
 * 文案区超高时**只有文案区**滚动、存证与自动点击用的按钮矩形取自最终布局、取消四路零副作用。
 * 断言的不是内部函数被调用，也不是私有字段。
 *
 * DOM 桩是共享那一份（doc-group-cards-dom-shim.ts）：它按**真实排版**给数——文案按内容宽度折行、
 * 两枚按钮各占一行堆叠、文案区限高后可见高度与自然高度分开（工单362 起）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { PANEL_ID, ROW_CLASS } from '../../plugins/doc-group-cards/menu'
import { STORE_KEY } from '../../plugins/doc-group-cards/ownership'
import { MULTI_CLASS } from '../../plugins/doc-group-cards/selection'
import {
  CONFIRM_CANCEL_ID,
  CONFIRM_LINE_H,
  CONFIRM_OK_ID,
  CONFIRM_OPENED_NOTIFY,
  CONFIRM_OVERLAY_ID,
  CONFIRM_TEXT_ID,
} from '../../plugins/doc-group-cards/writeops'
import plugin, { type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { Element, EventTarget, confirmLayoutOf, newDom, walk, type ConfirmLayout } from './doc-group-cards-dom-shim'

// ---------------------------------------------------------------------------
// 宿主桩
// ---------------------------------------------------------------------------

/** 短名 / 长中文名（放不下、要折行）/ 另一个短名——三件都是 .docx，故同落一张卡 */
const SHORT = 'a.docx'
const LONG_CN = '二零二六年第三季度项目验收报告与结算明细最终版归档文件.docx'
const OTHER = 'b.docx'

/**
 * 矮视口：面板窗真机上是主显示器全屏，但「盒子不得超出视口、两枚按钮必须完整」这条不变量
 * 得在任何视口下都成立——文案放不下时是**文案区**自己滚，不是把按钮推出屏幕。
 */
const TINY_VIEWPORT_H = 160

const BASE_ITEMS: HostDesktopItem[] = [
  { name: SHORT, kind: 'file', path: 'C:\\me\\a.docx', iconKey: 'k1' },
  { name: LONG_CN, kind: 'file', path: 'C:\\me\\long.docx', iconKey: 'k2' },
  { name: OTHER, kind: 'file', path: 'C:\\me\\b.docx', iconKey: 'k3' },
]

/** 假 userData：经 plugin-config/get|set 往返（解散用例要一张手改得动的卡） */
let persisted: Record<string, unknown> = {}
/** 此刻桌面上的条目（解散用例要往里塞一整批成员） */
let items: HostDesktopItem[] = [...BASE_ITEMS]

type Call = { method: string; payload: unknown }

let dom: ReturnType<typeof newDom>
let win: EventTarget & { innerWidth: number; innerHeight: number }
let h: {
  host: Host
  invokes: Call[]
  tiers: string[]
  notes: Array<{ type: string; payload?: Record<string, unknown> }>
  /** 会碰桌面文件的契约（磁盘移动只可能从它们发生） */
  diskCalls: () => Call[]
  /** 组定义那一条通道（落盘的是插件自己的私有状态） */
  configSets: () => Call[]
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  persisted = {}
  items = [...BASE_ITEMS]
  win = Object.assign(new EventTarget(), { innerWidth: 2560, innerHeight: 1440 })
  ;(globalThis as unknown as Record<string, unknown>).window = Object.assign(win, { deck: {} })
  plugin.unmount?.()
  dom = newDom()
  const container = new Element('div', 'deck-plugin')
  dom.body.appendChild(container)
  const invokes: Call[] = []
  const tiers: string[] = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const view = { get desktop() { return { items: [...items] } } } as HostView
  const stub = {
    el: container,
    view,
    util: {},
    notify: (type: string, payload?: Record<string, unknown>) => { notes.push({ type, payload }) },
    invoke: (method: string, payload: unknown) => {
      invokes.push({ method, payload })
      if (method === 'desktop/icon') return Promise.resolve({ dataUrl: null })
      if (method === 'plugin-config/get') return Promise.resolve({ config: { ...persisted }, warnings: [] })
      if (method === 'plugin-config/set') {
        persisted = { ...persisted, ...((payload as { patch?: Record<string, unknown> }).patch ?? {}) }
        return Promise.resolve({ config: { ...persisted }, warnings: [] })
      }
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    holdKeyboardTier: (tier: string) => { tiers.push(`hold:${tier}`) },
    releaseKeyboardTier: (tier: string) => { tiers.push(`release:${tier}`) },
    onDomChanged: () => {},
  }
  h = {
    invokes,
    tiers,
    notes,
    diskCalls: () => invokes.filter((c) => c.method.startsWith('desktop/')
      && c.method !== 'desktop/icon'
      && c.method !== 'desktop/clipboard-state'),
    configSets: () => invokes.filter((c) => c.method === 'plugin-config/set'),
    host: stub as unknown as Host,
  }
  ;(globalThis as unknown as Record<string, unknown>).document = dom.documentShim
})

// ---------------------------------------------------------------------------
// 取件
// ---------------------------------------------------------------------------

const viewport = () => ({ width: win.innerWidth, height: win.innerHeight })

function byId(id: string): Element | null {
  return dom.documentShim.getElementById(id)
}

function cards(): Element[] {
  return walk(h.host.el as unknown as Element).filter((n) => n.classList.contains('card'))
}

function cardById(id: string): Element {
  const card = cards().find((c) => c.id === id)
  if (!card) throw new Error(`没有 ${id} 这张卡，现有：${cards().map((c) => c.id).join(' / ')}`)
  return card
}

function gridOf(id: string): Element {
  return cardById(id).children.find((c) => c.classList.contains('dgc-grid'))!
}

function cellsOf(id: string): Element[] {
  return gridOf(id).children
}

function multiSwitchOf(id: string): Element {
  const sw = cardById(id).children.flatMap((head) => head.children).find((n) => n.classList.contains(MULTI_CLASS))
  if (!sw) throw new Error(`${id} 上没有多选开关`)
  return sw
}

function menuRows(): Element[] {
  const panel = byId(PANEL_ID)
  return panel ? panel.querySelectorAll(`.${ROW_CLASS}`) : []
}

function rowById(id: string): Element {
  const row = menuRows().find((r) => r.dataset.row === id)
  if (!row) throw new Error(`菜单上没有 ${id} 行`)
  return row
}

/** 确认层此刻的最终布局 */
function layout(): ConfirmLayout {
  const l = confirmLayoutOf(dom.documentShim)
  if (!l) throw new Error('确认层没铺出来')
  return l
}

/** 两枚按钮的最终矩形：完整落在对话框内，且完整落在视口内 */
function expectButtonsFullyVisible(l: ConfirmLayout): void {
  for (const [label, btn] of [['确认钮', l.ok], ['取消钮', l.cancel]] as const) {
    expect(btn.left, label).toBeGreaterThanOrEqual(l.dialog.left)
    expect(btn.top, label).toBeGreaterThanOrEqual(l.dialog.top)
    expect(btn.left + btn.width, label).toBeLessThanOrEqual(l.dialog.left + l.dialog.width)
    expect(btn.top + btn.height, label).toBeLessThanOrEqual(l.dialog.top + l.dialog.height)
    expect(btn.left, label).toBeGreaterThanOrEqual(0)
    expect(btn.top, label).toBeGreaterThanOrEqual(0)
    expect(btn.left + btn.width, label).toBeLessThanOrEqual(viewport().width)
    expect(btn.top + btn.height, label).toBeLessThanOrEqual(viewport().height)
  }
}

/** 整只确认框不超出视口 */
function expectBoxInsideViewport(l: ConfirmLayout): void {
  expect(l.dialog.left).toBeGreaterThanOrEqual(0)
  expect(l.dialog.top).toBeGreaterThanOrEqual(0)
  expect(l.dialog.left + l.dialog.width).toBeLessThanOrEqual(viewport().width)
  expect(l.dialog.top + l.dialog.height).toBeLessThanOrEqual(viewport().height)
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 右键一个格子 → 文件菜单 → DELETE 行 → 确认层 */
function openDeleteConfirm(cellIndex: number): void {
  const cell = cellsOf('dgc-docx')[cellIndex]
  cell.dispatch('contextmenu', cell, { clientX: 900, clientY: 700 })
  rowById('delete').dispatch('click', rowById('delete'))
}

/** 多选两格再右键 → 文件菜单（DELETE ALL）→ 确认层 */
function openMultiDeleteConfirm(): void {
  const sw = multiSwitchOf('dgc-docx')
  sw.dispatch('click', sw)
  cellsOf('dgc-docx')[0].dispatch('click', cellsOf('dgc-docx')[0])
  cellsOf('dgc-docx')[1].dispatch('click', cellsOf('dgc-docx')[1])
  const cell = cellsOf('dgc-docx')[0]
  cell.dispatch('contextmenu', cell, { clientX: 900, clientY: 700 })
  rowById('delete').dispatch('click', rowById('delete'))
}

/** 一张手改得动的临时卡（解散那一行只在它上面出）→ 解散确认层 */
async function openDissolveConfirm(memberNames: string[]): Promise<void> {
  persisted = {
    [STORE_KEY]: {
      version: 1,
      nextSeq: 2,
      groups: [],
      temps: [{ id: 'dgc-t2', name: '临时 10-15 21:04 02', seq: 1, createdAtMs: 1, names: memberNames }],
    },
  }
  items = [
    ...BASE_ITEMS,
    ...memberNames.map((n, i) => ({
      name: n, kind: 'file' as const, path: `C:\\me\\${n}`, iconKey: `m${i}`,
    })),
  ]
  // 组定义是装载时读回来的，故这张卡得在**读得到定义**的那一代里画出来
  plugin.unmount?.()
  plugin.mount(h.host)
  await flush()
  const card = cardById('dgc-t2')
  card.dispatch('contextmenu', card, { clientX: 900, clientY: 700 })
  await flush()
  rowById('dissolve').dispatch('click', rowById('dissolve'))
  await flush()
}

function pressEsc(): void {
  win.dispatch('keydown', dom.body, { key: 'Escape' })
}

// ---------------------------------------------------------------------------

describe('确认层排版（工单362）：按 DOM 真实排版算尺寸与位置，两枚按钮始终完整', () => {
  it('短文件名：两枚按钮完整落在框内与视口内', () => {
    plugin.mount(h.host)
    openDeleteConfirm(0)
    const l = layout()
    expect(l.dialog.width).toBeGreaterThan(0)
    expectButtonsFullyVisible(l)
    expectBoxInsideViewport(l)
  })

  it('长中文文件名：**换行后的高度**计入盒子（不再按「每件一行」估），按钮仍完整', () => {
    plugin.mount(h.host)
    openDeleteConfirm(1)
    const l = layout()
    // 自证：那个名字**确实**折行了（否则本用例是空的）
    expect(l.lines).toBeGreaterThan(2)
    expect(l.text.height).toBe(l.lines * CONFIRM_LINE_H)
    // 反例锚点：旧算法（每件一行 + 只算一枚按钮）算出的高度——按它画，CANCEL 会被裁在盒外
    const naive = 2 * 12 + 2 * CONFIRM_LINE_H + 10 + 26
    expect(l.dialog.height).toBeGreaterThan(naive)
    expectButtonsFullyVisible(l)
    expectBoxInsideViewport(l)
  })

  it('多文件清单：清单逐件列出，两枚按钮完整', () => {
    plugin.mount(h.host)
    openMultiDeleteConfirm()
    const l = layout()
    expect(byId(CONFIRM_TEXT_ID)!.textContent).toContain('DELETE 2 ITEMS?')
    expectButtonsFullyVisible(l)
    expectBoxInsideViewport(l)
  })

  it('存证与自动点击用的按钮矩形取自**最终布局**（不是排版前的估算框）', () => {
    plugin.mount(h.host)
    openDeleteConfirm(1)
    const l = layout()
    const payload = h.notes.find((n) => n.type === CONFIRM_OPENED_NOTIFY)?.payload as
      | { ok?: unknown; cancel?: unknown; box?: unknown }
      | undefined
    expect(payload).toBeTruthy()
    expect(payload!.ok).toEqual(l.ok)
    expect(payload!.cancel).toEqual(l.cancel)
    expect(payload!.box).toEqual(l.dialog)
  })
})

describe('确认层排版（工单362）：文案超高时**只有文案区滚动**，两枚按钮一寸不让', () => {
  it('矮视口 + 多文件：文案区自己滚，整只框仍在视口内，两枚按钮完整', () => {
    win.innerHeight = TINY_VIEWPORT_H
    plugin.mount(h.host)
    openMultiDeleteConfirm()
    const l = layout()
    // 文案溢出、文案区自己滚
    expect(l.scrollHeight).toBeGreaterThan(l.clientHeight)
    expectButtonsFullyVisible(l)
    expectBoxInsideViewport(l)
  })

  it('超高清单（解散那张卡装着一百多件）：同样只有文案区滚动', async () => {
    plugin.mount(h.host)
    const many = Array.from({ length: 120 }, (_, i) => `文件${i}.txt`)
    await openDissolveConfirm(many)
    const l = layout()
    expect(l.scrollHeight).toBeGreaterThan(l.clientHeight)
    expectButtonsFullyVisible(l)
    expectBoxInsideViewport(l)
  })
})

describe('确认层排版（工单362）：解散这一路与删除同款（两种用途都覆盖）', () => {
  it('解散确认层：文案与钮字是解散的措辞', async () => {
    plugin.mount(h.host)
    await openDissolveConfirm(['杂.zip'])
    expect(byId(CONFIRM_TEXT_ID)!.textContent).toContain('DISSOLVE CARD?')
    expect(byId(CONFIRM_OK_ID)!.textContent).toBe('DISSOLVE')
    expect(byId(CONFIRM_CANCEL_ID)!.textContent).toBe('CANCEL')
  })

  it('解散确认层：两枚按钮完整落在框内与视口内', async () => {
    plugin.mount(h.host)
    await openDissolveConfirm(['杂.zip'])
    const l = layout()
    expectButtonsFullyVisible(l)
    expectBoxInsideViewport(l)
  })

  it('确认解散：只改组定义，**零个 desktop/* 调用**（磁盘零移动）', async () => {
    plugin.mount(h.host)
    await openDissolveConfirm(['杂.zip'])
    byId(CONFIRM_OK_ID)!.dispatch('click', byId(CONFIRM_OK_ID)!)
    await flush()
    expect(h.diskCalls()).toEqual([])
    expect(h.configSets().length).toBe(1)
  })
})

describe('确认层排版（工单362）：取消四路零副作用（排版修复不动删除安全边界）', () => {
  const CANCELS: Array<[string, () => void]> = [
    ['取消钮', () => byId(CONFIRM_CANCEL_ID)!.dispatch('click', byId(CONFIRM_CANCEL_ID)!)],
    ['Esc', () => pressEsc()],
    ['点层外', () => byId(CONFIRM_OVERLAY_ID)!.dispatch('click', byId(CONFIRM_OVERLAY_ID)!)],
  ]

  for (const [label, cancel] of CANCELS) {
    it(`${label}：不落盘、不留节点、档放掉`, () => {
      plugin.mount(h.host)
      openDeleteConfirm(0)
      cancel()
      expect(h.diskCalls()).toEqual([])
      expect(byId(CONFIRM_OK_ID)).toBeNull()
      expect(byId(CONFIRM_OVERLAY_ID)).toBeNull()
      expect(h.tiers.filter((t) => t === 'release:delete-confirm')).toHaveLength(1)
    })
  }
})
