/**
 * 粘贴与解散的**接线**（工单186 = spec166 之⑨）。
 *
 * 裁决那一半在 doc-group-cards-paste.spec.ts（三态路由、临时卡生成与命名、解散回落）。本份钉的是
 * 那些裁决在 card.js 里真的落到 DOM 与宿主上了吗：
 *   - 组卡菜单多出 PASTE 与 DISSOLVE 两行，PASTE 的置灰**跟着剪贴板实况**走（查不到即置灰，
 *     绝不误使能）；DISSOLVE 在**固有扩展组卡上不出**（它没有定义可删）；
 *   - PASTE 一路：右键 → 问 desktop/clipboard-state → 落文件走**无参**的 desktop/paste →
 *     三态路由 → 落库（新建临时卡时才落）与整排重画；一个文件都没落地时**不建空卡**；
 *   - DISSOLVE 一路：右键 → 确认层（复用 #183 那块壳）→ 确认 → 只删卡定义 → 卡内文件按扩展名
 *     回落固有分组；**全程零个 desktop/* 调用**（磁盘零移动的接线面证据）；
 *   - 取消确认层 / Esc / 点层外：一张卡都不删、一个文件都不动；遮罩与样式随层同寿，卸载不留。
 *
 * DOM 桩是工单183 抽出的那一份共享桩（doc-group-cards-dom-shim.ts），不另写一份、不加新依赖。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  DISABLED_CLASS,
  KIND_BUILTIN,
  KIND_TEMP,
  PANEL_ID,
  ROW_CLASS,
} from '../../plugins/doc-group-cards/menu'
import { STORE_KEY } from '../../plugins/doc-group-cards/ownership'
import {
  CONFIRM_CANCEL_ID,
  CONFIRM_OK_ID,
  CONFIRM_OVERLAY_ID,
  CONFIRM_STYLE_ID,
  CONFIRM_TEXT_ID,
} from '../../plugins/doc-group-cards/writeops'
import { PASTE_FAILED_NOTIFY, PASTE_ROUTED_NOTIFY } from '../../plugins/doc-group-cards/pasting'
import plugin, { type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { Element, EventTarget, newDom, walk } from './doc-group-cards-dom-shim'

// ---------------------------------------------------------------------------
// 宿主桩
// ---------------------------------------------------------------------------

const ITEMS: HostDesktopItem[] = [
  { name: '方案.docx', kind: 'file', path: 'C:\\me\\方案.docx', iconKey: 'k1' },
  { name: '纪要.docx', kind: 'file', path: 'C:\\me\\纪要.docx', iconKey: 'k2' },
  { name: '预算.pdf', kind: 'file', path: 'C:\\me\\预算.pdf', iconKey: 'k3' },
]

/** 假 userData：经 plugin-config/get|set 往返（模拟内核那份合并 + 原子写的外部行为） */
let persisted: Record<string, unknown> = {}

/** 本轮 desktop/paste 要「落地」的那批文件名（内核契约的 pasted 响应 = 落盘最终名） */
let pastedNext: string[] = []
/** desktop/clipboard-state 的实况；抛错即模拟「查询失败按不可贴」 */
let clipboard: boolean | Error = false
/** 已进桌面的条目池（在装载前摆好，模拟内核下一次快照：粘贴的文件已进池子） */
let extraItems: HostDesktopItem[] = []

type Call = { method: string; payload: unknown }

let dom: ReturnType<typeof newDom>
let win: EventTarget & { innerWidth: number; innerHeight: number }
let h: {
  host: Host
  invokes: Call[]
  domChanges: number[]
  tiers: string[]
  notes: Array<{ type: string; payload?: Record<string, unknown> }>
  /** 会碰桌面文件的那几个契约（磁盘移动只可能从它们发生） */
  diskCalls: () => Call[]
  /** 把新的一份快照喂给插件（模拟内核下一次 1Hz 快照） */
  refreshItems: (extra: HostDesktopItem[]) => void
}

/** 装载后让那些异步读回 / 契约调用跑完（粘贴链路是异步的，故多冲几拍） */
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  persisted = {}
  pastedNext = []
  clipboard = false
  extraItems = []
  win = Object.assign(new EventTarget(), { innerWidth: 2560, innerHeight: 1440 })
  ;(globalThis as unknown as Record<string, unknown>).window = Object.assign(win, { deck: {} })
  plugin.unmount?.()
  dom = newDom()
  const container = new Element('div', 'deck-plugin')
  dom.body.appendChild(container)
  const invokes: Call[] = []
  const domChanges: number[] = []
  const tiers: string[] = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const view = { get desktop() { return { items: [...ITEMS, ...extraItems] } } } as HostView
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
      if (method === 'desktop/clipboard-state') {
        if (clipboard instanceof Error) return Promise.reject(clipboard)
        return Promise.resolve({ pasteable: clipboard })
      }
      if (method === 'desktop/paste') return Promise.resolve({ ok: pastedNext.length > 0, pasted: pastedNext, failed: [] })
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    holdKeyboardTier: (tier: string) => { tiers.push(`hold:${tier}`) },
    releaseKeyboardTier: (tier: string) => { tiers.push(`release:${tier}`) },
    onDomChanged: () => { domChanges.push(1) },
  }
  h = {
    invokes,
    domChanges,
    tiers,
    notes,
    diskCalls: () =>
      invokes.filter((c) => c.method.startsWith('desktop/') && c.method !== 'desktop/icon' && c.method !== 'desktop/clipboard-state' && c.method !== 'desktop/paste'),
    refreshItems: (extra) => {
      extraItems = [...extraItems, ...extra]
      plugin.update?.(h.host)
    },
    host: stub as unknown as Host,
  }
  ;(globalThis as unknown as Record<string, unknown>).document = dom.documentShim
})

// ---------------------------------------------------------------------------
// 取节点的小工具
// ---------------------------------------------------------------------------

function cards(): Element[] {
  return walk(h.host.el as unknown as Element).filter((n) => n.classList.contains('card'))
}

function cardById(id: string): Element {
  const card = cards().find((c) => c.id === id)
  if (!card) throw new Error(`没有 ${id} 这张卡，现有：${cards().map((c) => c.id).join(' / ')}`)
  return card
}

function membersOf(id: string): string[] {
  return cardById(id).children
    .filter((c) => c.classList.contains('dgc-grid'))
    .flatMap((grid) => grid.children.map((cell) => cell.children[1].textContent))
}

function labelOf(id: string): string {
  return cardById(id).children.find((c) => c.classList.contains('dgc-head'))!.children[0].textContent
}

function panel(): Element | null {
  return dom.documentShim.getElementById(PANEL_ID)
}

function menuRows(): Element[] {
  const p = panel()
  return p ? p.querySelectorAll(`.${ROW_CLASS}`) : []
}

function menuIds(): string[] {
  return menuRows().map((r) => r.dataset.row as string)
}

function rowById(id: string): Element {
  const row = menuRows().find((r) => r.dataset.row === id)
  if (!row) throw new Error(`菜单上没有 ${id} 行，现有：${menuIds().join(' / ')}`)
  return row
}

function byId(id: string): Element | null {
  return dom.documentShim.getElementById(id)
}

function confirmText(): string {
  return byId(CONFIRM_TEXT_ID)?.textContent ?? ''
}

function pressEsc(): void {
  win.dispatch('keydown', dom.body, { key: 'Escape' })
}

/** 卡片**空白处**右键 → 组卡菜单（要等一次剪贴板实况查询，故异步） */
async function openGroupMenuOn(cardId: string, x = 900, y = 700): Promise<void> {
  const card = cardById(cardId)
  card.dispatch('contextmenu', card, { clientX: x, clientY: y })
  await flush()
}

/** 点菜单里那一行（会先收层再执行动作，故异步） */
async function clickRow(id: string): Promise<void> {
  rowById(id).dispatch('click', rowById(id))
  await flush()
}

const CONTRACT_GROUP = { id: 'dgc-c1', name: '合同', exts: ['.docx'], acceptAll: false, seq: 1 }

function seedCustomGroup(groups: Array<Record<string, unknown>>, nextSeq = groups.length + 1): void {
  persisted = { [STORE_KEY]: { version: 1, nextSeq, groups, temps: [] } }
}

/** 一张已经存在的临时卡（genuine 落盘形态：带 names 名单） */
function seedTempCard(def: Record<string, unknown>, nextSeq: number): void {
  persisted = { [STORE_KEY]: { version: 1, nextSeq, groups: [], temps: [def] } }
}

const TEMP_CARD = { id: 'dgc-t2', name: '临时 10-15 21:04 02', seq: 2, createdAtMs: 1, names: ['杂.zip'] }

// ---------------------------------------------------------------------------

describe('组卡菜单：PASTE 恒可见且按剪贴板实况置灰，DISSOLVE 只在手改得动的卡上出现', () => {
  it('PASTE 在**每一张**卡上都出现（任何一张卡都能接粘贴），包括固有扩展组卡', async () => {
    plugin.mount(h.host)
    await flush()
    // 全新安装：桌面上只有固有扩展组卡（零自定义卡）。工单187 裁决②给 NEW GROUP 开了恒可见，
    // 于是「建不出第一张自定义卡」那条路也通了（NEW GROUP 建的是新卡，不改脚下那张）
    await openGroupMenuOn('dgc-docx')
    expect(menuIds()).toEqual(['paste', 'new-group'])
    // 固有扩展组卡仍不出 EDIT TYPES / DISSOLVE（规则生成的卡不该被手改、也没有定义可删）
    expect(menuIds()).not.toContain('dissolve')
    expect(menuIds()).not.toContain('edit-types')
  })

  it('剪贴板里有文件 → PASTE 可用；没有 → 置灰（needs:pasteable 的实况接线）', async () => {
    plugin.mount(h.host)
    await flush()

    clipboard = false
    await openGroupMenuOn('dgc-docx')
    expect(rowById('paste').classList.contains(DISABLED_CLASS)).toBe(true)

    plugin.unmount?.()
    clipboard = true
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-docx')
    expect(rowById('paste').classList.contains(DISABLED_CLASS)).toBe(false)
  })

  it('**查询失败按不可贴**（宁可置灰，绝不误使能）——且照样出菜单，不是开层失败', async () => {
    plugin.mount(h.host)
    await flush()
    clipboard = new Error('主进程问不到剪贴板')
    await openGroupMenuOn('dgc-docx')
    expect(menuIds()).toEqual(['paste', 'new-group'])
    expect(rowById('paste').classList.contains(DISABLED_CLASS)).toBe(true)
    expect(h.invokes.some((c) => c.method === 'desktop/clipboard-state')).toBe(true)
  })

  it('置灰态是**实况**：开层时不可贴，拷贝完文件再开层同一张卡就变可用', async () => {
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-docx')
    expect(rowById('paste').classList.contains(DISABLED_CLASS)).toBe(true)
    win.dispatch('click', dom.body) // 收起

    clipboard = true // 用户在资源管理器里拷了东西
    await openGroupMenuOn('dgc-docx')
    expect(rowById('paste').classList.contains(DISABLED_CLASS)).toBe(false)
  })

  it('自定义卡与临时卡上四行齐全，且 DISSOLVE 只在这两类卡上出现', async () => {
    seedCustomGroup([CONTRACT_GROUP], 4)
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-c1')
    expect(menuIds()).toEqual(['paste', 'new-group', 'edit-types', 'dissolve'])

    // 另一张卡（固有 PDF）上是 PASTE + NEW GROUP（#187 裁决②）：DISSOLVE 仍不出
    await openGroupMenuOn('dgc-pdf')
    expect(menuIds()).toEqual(['paste', 'new-group'])
  })

  it('临时卡（本次粘贴生成的那种）同样是手改得动的卡：DISSOLVE 出、PASTE 出', async () => {
    seedTempCard(TEMP_CARD, 3)
    extraItems = [{ name: '杂.zip', kind: 'file', path: 'C:\\me\\杂.zip', iconKey: 'k9' }]
    plugin.mount(h.host)
    await flush()
    expect(cards().map((c) => c.id)).toContain('dgc-t2')

    await openGroupMenuOn('dgc-t2')
    expect(menuIds()).toEqual(['paste', 'new-group', 'edit-types', 'dissolve'])
    expect(KIND_TEMP).toBe('temp')
    expect(KIND_BUILTIN).toBe('builtin')
  })
})

describe('PASTE 那一行：落文件走内核无参契约，归属由三态路由决定', () => {
  it('落点固定用户桌面根：走的是**无参**的 desktop/paste（请求载荷是 null，插件不能选物理去向）', async () => {
    plugin.mount(h.host)
    await flush()
    clipboard = true
    pastedNext = ['杂.zip']
    await openGroupMenuOn('dgc-docx')
    await clickRow('paste')

    const call = h.invokes.find((c) => c.method === 'desktop/paste')
    expect(call).toBeDefined()
    expect(call?.payload).toBeNull()
  })

  it('第二态：没有卡接受 → **新建一张临时组卡**，卡面名带粘贴时刻与序号，文件归它', async () => {
    plugin.mount(h.host)
    await flush()
    clipboard = true
    pastedNext = ['杂.zip']
    await openGroupMenuOn('dgc-docx')
    await clickRow('paste')
    // 内核下一次快照：落地的文件进池子
    h.refreshItems([{ name: '杂.zip', kind: 'file', path: 'C:\\me\\杂.zip', iconKey: 'k9' }])

    expect(cards().map((c) => c.id)).toEqual(['dgc-t1', 'dgc-docx', 'dgc-pdf'])
    expect(membersOf('dgc-t1')).toEqual(['杂.zip'])
    // 卡面名 = 「临时 <粘贴时刻> <序号>」；序号即唯一性（票面 AC：命名含粘贴时间与序号）
    expect(labelOf('dgc-t1')).toMatch(/^临时 \d{2}-\d{2} \d{2}:\d{2} 01 · 1$/)
    // 落库走插件私有状态通道，名单在里面；**没有任何 desktop/* 写动作**
    const saved = (persisted[STORE_KEY] as { temps: Array<{ names: string[] }> }).temps
    expect(saved[0].names).toEqual(['杂.zip'])
    expect(h.diskCalls()).toEqual([])
  })

  it('**每次粘贴各一张卡**：第二次粘贴拿不到第一张（自动路由不再选中已生成的临时卡）', async () => {
    plugin.mount(h.host)
    await flush()
    clipboard = true
    await openGroupMenuOn('dgc-docx')
    pastedNext = ['甲.zip']
    await clickRow('paste')
    h.refreshItems([{ name: '甲.zip', kind: 'file', path: 'C:\\me\\甲.zip', iconKey: 'k9' }])

    await openGroupMenuOn('dgc-docx')
    pastedNext = ['乙.zip']
    await clickRow('paste')
    h.refreshItems([{ name: '乙.zip', kind: 'file', path: 'C:\\me\\乙.zip', iconKey: 'k10' }])

    const temps = (persisted[STORE_KEY] as { temps: Array<{ id: string; names: string[] }> }).temps
    expect(temps.map((t) => t.id)).toEqual(['dgc-t1', 'dgc-t2'])
    expect(temps.map((t) => t.names)).toEqual([['甲.zip'], ['乙.zip']])
    expect(membersOf('dgc-t1')).toEqual(['甲.zip'])
    expect(membersOf('dgc-t2')).toEqual(['乙.zip'])
  })

  it('第一态：有自定义卡接受该类型则**并入**它，一个字节都不落盘', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    clipboard = true
    pastedNext = ['补充.docx']
    // 入口换成固有卡 dgc-pdf：工单167 评审 F2 起 PASTE 在「有限清单的自定义卡」那一格置灰
    // （显式粘进去不会落在那张卡上），故这条**自动路由第一态**的用例改从一张 PASTE 仍可用的
    // 卡进来。断言一件没动——被断的仍是「自动路由把这一批并进接受该类型的自定义卡」。
    await openGroupMenuOn('dgc-pdf')
    await clickRow('paste')

    // 并入的那一批**不产生任何落库调用**（成员是定义的函数，粘进去的文件下一帧自然就在那张卡上）
    expect(h.invokes.some((c) => c.method === 'plugin-config/set')).toBe(false)
    h.refreshItems([{ name: '补充.docx', kind: 'file', path: 'C:\\me\\补充.docx', iconKey: 'k9' }])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx', '补充.docx'])
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])
    const note = h.notes.find((n) => n.type === PASTE_ROUTED_NOTIFY)
    expect(note?.payload).toMatchObject({ ok: true, kind: 'merge', merged: ['dgc-c1'], tempCard: null })
  })

  it('第三态：对临时卡显式粘贴 → **粘进那张卡**（往原卡上加一批，不是新卡）', async () => {
    seedTempCard(TEMP_CARD, 3)
    extraItems = [{ name: '杂.zip', kind: 'file', path: 'C:\\me\\杂.zip', iconKey: 'k9' }]
    plugin.mount(h.host)
    await flush()
    clipboard = true
    pastedNext = ['乙.docx']
    await openGroupMenuOn('dgc-t2')
    await clickRow('paste')
    h.refreshItems([{ name: '乙.docx', kind: 'file', path: 'C:\\me\\乙.docx', iconKey: 'k10' }])

    expect(membersOf('dgc-t2')).toEqual(['杂.zip', '乙.docx'])
    const temps = (persisted[STORE_KEY] as { temps: Array<{ id: string; names: string[] }> }).temps
    expect(temps).toHaveLength(1) // 没有第二张卡
    expect(temps[0].names).toEqual(['杂.zip', '乙.docx'])
  })

  it('一个文件都没落地：**不建空卡**、不落库，如实上报失败', async () => {
    plugin.mount(h.host)
    await flush()
    clipboard = true
    pastedNext = [] // 内核一个都没贴成功
    await openGroupMenuOn('dgc-docx')
    await clickRow('paste')

    expect(h.invokes.some((c) => c.method === 'plugin-config/set')).toBe(false)
    expect(cards().map((c) => c.id)).toEqual(['dgc-docx', 'dgc-pdf'])
    const note = h.notes.find((n) => n.type === PASTE_FAILED_NOTIFY)
    expect(note?.payload).toMatchObject({ ok: false })
  })

  it('粘贴契约抛错：如实上报，不外溢、不建卡、面板照常工作', async () => {
    plugin.mount(h.host)
    await flush()
    const failing = {
      ...h.host,
      invoke: (method: string, payload: unknown) => {
        h.invokes.push({ method, payload })
        if (method === 'desktop/paste') return Promise.reject(new Error('剪贴板读不到'))
        // 其余契约照常答（剪贴板实况必须为真，否则 PASTE 置灰、那一行根本点不动，测的就不是这条路了）
        if (method === 'desktop/clipboard-state') return Promise.resolve({ pasteable: true })
        if (method === 'desktop/icon') return Promise.resolve({ dataUrl: null })
        if (method === 'plugin-config/get') return Promise.resolve({ config: { ...persisted }, warnings: [] })
        if (method === 'plugin-config/set') {
          persisted = { ...persisted, ...((payload as { patch?: Record<string, unknown> }).patch ?? {}) }
          return Promise.resolve({ config: { ...persisted }, warnings: [] })
        }
        return Promise.resolve({ ok: true })
      },
    } as unknown as Host
    plugin.unmount?.()
    plugin.mount(failing)
    await flush()
    await openGroupMenuOn('dgc-docx')
    await clickRow('paste')
    expect(h.notes.some((n) => n.type === PASTE_FAILED_NOTIFY)).toBe(true)
    expect(cards().map((c) => c.id)).toEqual(['dgc-docx', 'dgc-pdf'])
  })
})

describe('DISSOLVE 那一行：先过确认层，确认后只删卡定义，磁盘零移动', () => {
  it('确认层复用 #183 那块壳：铺遮罩、持键盘档、申报热区，钮上写 DISSOLVE 不写 DELETE', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-c1')
    await clickRow('dissolve')

    expect(byId(CONFIRM_TEXT_ID)?.textContent).toContain('DISSOLVE CARD?')
    expect(byId(CONFIRM_TEXT_ID)?.textContent).toContain('合同')
    expect(byId(CONFIRM_OK_ID)?.textContent).toBe('DISSOLVE')
    expect(byId(CONFIRM_CANCEL_ID)?.textContent).toBe('CANCEL')
    // 遮罩是 class='card'（热区扫掠认的只有它），且铺了就申报
    expect(walk(dom.body).filter((n) => n.classList.contains('card')).some((n) => n.id.startsWith('dgc-confirm'))).toBe(true)
    expect(h.domChanges.length).toBeGreaterThan(0)
    expect(h.tiers).toContain('hold:delete-confirm')
  })

  it('**开层不发任何写动作**：一个 desktop/* 都没调（先问过用户是这一行的全部语义）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-c1')
    h.invokes.length = 0
    await clickRow('dissolve')
    expect(h.diskCalls()).toEqual([])
    expect(h.invokes.some((c) => c.method === 'plugin-config/set')).toBe(false)
  })

  it('确认 → 删卡定义，卡内文件按扩展名回落固有分组；**全程零个 desktop/* 调用**', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])

    await openGroupMenuOn('dgc-c1')
    h.invokes.length = 0
    await clickRow('dissolve')
    byId(CONFIRM_OK_ID)!.dispatch('click', byId(CONFIRM_OK_ID)!)
    await flush()

    // 回落：那两个 docx 回到固有 DOCX 卡；磁盘上什么都没动（**零个 desktop/* 调用**）
    expect(h.diskCalls()).toEqual([])
    expect(cards().map((c) => c.id)).toEqual(['dgc-docx', 'dgc-pdf'])
    expect(membersOf('dgc-docx')).toEqual(['方案.docx', '纪要.docx'])
    // 落库只写插件私有状态：groups 里那张卡没了
    const saved = persisted[STORE_KEY] as { groups: unknown[]; nextSeq: number }
    expect(saved.groups).toEqual([])
    expect(saved.nextSeq).toBe(2) // 序号不退：退了，重启后新卡会与盘上某张重名
  })

  it('临时卡解散 → 那一批按扩展名各回各的固有扩展组卡（跨扩展名也分得开）', async () => {
    extraItems = [
      { name: '杂.zip', kind: 'file', path: 'C:\\me\\杂.zip', iconKey: 'k9' },
      { name: '杂.zip2.png', kind: 'file', path: 'C:\\me\\杂.zip2.png', iconKey: 'k10' },
    ]
    // 一张装了两种扩展名的临时卡（跨扩展名的一批也装得下——它接受任意类型）
    seedTempCard({ ...TEMP_CARD, names: ['杂.zip', '杂.zip2.png'] }, 3)
    plugin.mount(h.host)
    await flush()
    expect(membersOf('dgc-t2')).toEqual(['杂.zip', '杂.zip2.png'])

    await openGroupMenuOn('dgc-t2')
    h.invokes.length = 0
    await clickRow('dissolve')
    byId(CONFIRM_OK_ID)!.dispatch('click', byId(CONFIRM_OK_ID)!)
    await flush()

    expect(h.diskCalls()).toEqual([])
    expect(membersOf('dgc-zip')).toEqual(['杂.zip'])
    expect(membersOf('dgc-png')).toEqual(['杂.zip2.png'])
  })

  it('取消 / Esc / 点层外：三路都是**零副作用**——一张卡都不删、一个 desktop/* 都不调', async () => {
    for (const how of ['cancel', 'esc', 'outside'] as const) {
      plugin.unmount?.()
      persisted = {}
      seedCustomGroup([CONTRACT_GROUP])
      plugin.mount(h.host)
      await flush()
      await openGroupMenuOn('dgc-c1')
      await clickRow('dissolve')

      h.invokes.length = 0
      if (how === 'cancel') byId(CONFIRM_CANCEL_ID)!.dispatch('click', byId(CONFIRM_CANCEL_ID)!)
      else if (how === 'esc') pressEsc()
      else byId(CONFIRM_OVERLAY_ID)!.dispatch('click', byId(CONFIRM_OVERLAY_ID)!) // 层外点击
      await flush()

      expect(h.diskCalls(), how).toEqual([])
      expect(h.invokes.some((c) => c.method === 'plugin-config/set'), how).toBe(false)
      expect(cards().map((c) => c.id), how).toEqual(['dgc-c1', 'dgc-pdf'])
      expect(byId(CONFIRM_TEXT_ID), how).toBeNull() // 层收了
    }
  })

  it('关层一点不留：遮罩与确认层样式元素都摘掉，键盘档放掉（关菜单那条纪律同一副壳同款）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-c1')
    await clickRow('dissolve')
    expect(byId(CONFIRM_STYLE_ID)).not.toBeNull()

    pressEsc()
    await flush()
    expect(byId(CONFIRM_STYLE_ID)).toBeNull()
    expect(byId(CONFIRM_TEXT_ID)).toBeNull()
    expect(h.tiers.filter((t) => t.startsWith('hold:')).length).toBe(h.tiers.filter((t) => t.startsWith('release:')).length)
  })

  it('对一张**不在组定义里**的卡点 DISSOLVE（兜底）：如实上报，绝不开一只没有目标的确认层', async () => {
    plugin.mount(h.host)
    await flush()
    // 绕过菜单直接驱动归约器那一路不可能，故走菜单：先在固有卡上把 cardId 换掉——用临时卡的
    // 可见性作等价证明：固有卡上根本**没有** DISSOLVE 这一行可点
    await openGroupMenuOn('dgc-docx')
    expect(menuIds()).toEqual(['paste', 'new-group'])
    expect(() => rowById('dissolve')).toThrow()
    expect(byId(CONFIRM_TEXT_ID)).toBeNull()
  })

  it('卸载时确认层静默收场：一点不留、键盘档放掉（进程被杀那条路是宿主兜底，不是常规）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await openGroupMenuOn('dgc-c1')
    await clickRow('dissolve')
    plugin.unmount?.()
    await flush()
    expect(byId(CONFIRM_STYLE_ID)).toBeNull()
    expect(byId(CONFIRM_TEXT_ID)).toBeNull()
    expect(cards()).toEqual([])
  })
})
