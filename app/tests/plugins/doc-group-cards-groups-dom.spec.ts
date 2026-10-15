/**
 * 自定义组卡的**接线**（工单185 = spec166 之⑧）。
 *
 * 前面两份钉的是裁决（ownership.spec.ts 三层归属与组定义形状、typepicker.spec.ts 勾选浮层的
 * 转移矩阵），本份钉的是那些裁决在 card.js 里真的落到 DOM 与宿主上了吗：
 *   - 组定义**只**经内核的插件私有状态通道存取（plugin-config/get|set），插件一个文件都不自己写，
 *     且卸载重挂（换代）之后组定义仍在（重启后仍在）；
 *   - 组卡菜单在自定义卡上出 NEW GROUP / EDIT TYPES；固有扩展组卡上只出 PASTE / NEW GROUP
 *     （工单187 裁决②：NEW GROUP 建的是新卡、不改脚下那张，故放出；EDIT TYPES 仍不出）；
 *   - 工单187 裁决①：空的自定义卡**留在屏上**（0 格、卡面在、菜单可开 → EDIT TYPES / DISSOLVE 回得去），
 *     而空掉的**固有**组仍不出卡；
 *   - NEW GROUP 铺出勾选浮层：名字输入 +「接受全部类型」开关 + 桌面上此刻真实存在的扩展名逐个勾；
 *   - 保存后既有文件的归属随之迁移（不手工干预），取消则一次落库动作都不发；
 *   - 浮层铺/撤都申报热区、键盘档持放平衡、样式元素随浮层同寿、卸载一点不留。
 *
 * DOM 桩是工单183 抽出的那一份共享桩（doc-group-cards-dom-shim.ts），不另写一份。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  DISABLED_CLASS,
  KIND_CUSTOM,
  PANEL_ID,
  ROW_CLASS,
} from '../../plugins/doc-group-cards/menu'
import { STORE_KEY } from '../../plugins/doc-group-cards/ownership'
import { MORE_CLASS } from '../../plugins/doc-group-cards/interaction'
import { MARQUEE_CLASS, MULTI_CLASS, MULTI_ON_CLASS } from '../../plugins/doc-group-cards/selection'
import { CONFIRM_TEXT_ID } from '../../plugins/doc-group-cards/writeops'
import {
  TYPE_ALL_CLASS,
  TYPE_ALL_ID,
  TYPE_BOX_ID,
  TYPE_CANCEL_ID,
  TYPE_LIST_ID,
  TYPE_NAME_ID,
  TYPE_OK_ID,
  TYPE_OVERLAY_ID,
  TYPE_ROW_CLASS,
  TYPE_STYLE_ID,
} from '../../plugins/doc-group-cards/typepicker'
import {
  PICKER_BTN_H,
  PICKER_FIELD_H,
  PICKER_GAP_Y,
  PICKER_MAX_ROWS,
  PICKER_PAD_Y,
  PICKER_ROW_H,
  PICKER_SWITCH_H,
} from '../../plugins/doc-group-cards/typepicker'
import plugin, { STYLE_ID, type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { Element, EventTarget, focusLog, newDom, walk } from './doc-group-cards-dom-shim'

// ---------------------------------------------------------------------------
// 宿主桩：plugin-config 那两个方法真的当存储用（读回合并后的那份），不是随手 return ok
// ---------------------------------------------------------------------------

const ITEMS: HostDesktopItem[] = [
  { name: '方案.docx', kind: 'file', path: 'C:\\me\\方案.docx', iconKey: 'k1' },
  { name: '纪要.docx', kind: 'file', path: 'C:\\me\\纪要.docx', iconKey: 'k2' },
  { name: '预算.pdf', kind: 'file', path: 'C:\\me\\预算.pdf', iconKey: 'k3' },
]

/** 假 userData：一个键值袋，经 plugin-config/get|set 往返（模拟内核那份合并+原子写的外部行为） */
let persisted: Record<string, unknown> = {}

function viewWith(items: HostDesktopItem[]): HostView {
  return { desktop: { items } }
}

type Call = { method: string; payload: unknown }

let dom: ReturnType<typeof newDom>
let win: EventTarget & { innerWidth: number; innerHeight: number }
let h: {
  host: Host
  invokes: Call[]
  domChanges: number[]
  tiers: string[]
  notes: Array<{ type: string; payload?: Record<string, unknown> }>
  configCalls: () => Call[]
}

/** 装载后让那些异步读回（plugin-config/get）跑完 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  persisted = {}
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
  const stub = {
    el: container,
    view: viewWith(ITEMS),
    util: {},
    notify: (type: string, payload?: Record<string, unknown>) => { notes.push({ type, payload }) },
    invoke: (method: string, payload: unknown) => {
      invokes.push({ method, payload })
      if (method === 'desktop/icon') return Promise.resolve({ dataUrl: null })
      if (method === 'plugin-config/get') {
        // 内核那份返回该 id 名下整份键值；没有就是空对象 + 可能的自愈记录
        return Promise.resolve({ config: { ...persisted }, warnings: [] })
      }
      if (method === 'plugin-config/set') {
        const patch = (payload as { patch?: Record<string, unknown> }).patch ?? {}
        persisted = { ...persisted, ...patch }
        return Promise.resolve({ config: { ...persisted }, warnings: [] })
      }
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
    configCalls: () => invokes.filter((c) => c.method.startsWith('plugin-config/')),
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

/** 卡 id → 卡内文件名 */
function membersOf(id: string): string[] {
  return cardById(id).children
    .filter((c) => c.classList.contains('dgc-grid'))
    .flatMap((grid) => grid.children.map((cell) => cell.children[1].textContent))
}

const labelsOf = (id: string): string =>
  cardById(id).children.find((c) => c.classList.contains('dgc-head'))!.children[0].textContent

function panel(): Element | null {
  return dom.documentShim.getElementById(PANEL_ID)
}

function menuRows(): Element[] {
  const p = panel()
  return p ? p.querySelectorAll(`.${ROW_CLASS}`) : []
}

function menuLabels(): string[] {
  return menuRows().map((r) => r.textContent)
}

function rowById(id: string): Element {
  const row = menuRows().find((r) => r.dataset.row === id)
  if (!row) throw new Error(`菜单上没有 ${id} 行，现有：${menuLabels().join(' / ')}`)
  return row
}

function typesOverlay(): Element | null {
  return dom.documentShim.getElementById(TYPE_OVERLAY_ID)
}

function typesBox(): Element | null {
  return dom.documentShim.getElementById(TYPE_BOX_ID)
}

function byId(id: string): Element | null {
  return dom.documentShim.getElementById(id)
}

function typeRows(): Element[] {
  const list = byId(TYPE_LIST_ID)
  return list ? list.querySelectorAll(`.${TYPE_ROW_CLASS}`) : []
}

/** 勾选浮层清单里逐行列出的扩展名（按出现序） */
function listedExts(): string[] {
  return typeRows().map((r) => r.dataset.ext)
}

/** 勾选浮层清单里显示为勾住的那些 */
function checkedExts(): string[] {
  return typeRows().filter((r) => r.children[0].textContent === '☑').map((r) => r.dataset.ext)
}

/**
 * 卡片**空白处**右键 → 组卡菜单。
 *
 * 工单186 起这一击是**异步**的：组卡菜单里多了 PASTE 行，它的置灰必须跟着剪贴板实况走
 * （desktop/clipboard-state 是异步契约），故开层前要先问一次。故这里等一拍再返回。
 */
async function rightClickBlank(card: Element, x = 900, y = 700): Promise<void> {
  card.dispatch('contextmenu', card, { clientX: x, clientY: y })
  await flush()
}

function pressEsc(): void {
  win.dispatch('keydown', dom.body, { key: 'Escape' })
}

/** 造一张已存在的自定义卡（全新安装时桌面上只有固有卡，见 menu.js 里登记的那个后果） */
function seedCustomGroup(groups: Array<Record<string, unknown>>, nextSeq = groups.length + 1): void {
  persisted = { [STORE_KEY]: { version: 1, nextSeq, groups, temps: [] } }
}

/** 一张「合同」卡，领走 .docx */
const CONTRACT_GROUP = { id: 'dgc-c1', name: '合同', exts: ['.docx'], acceptAll: false, seq: 1 }

// ---------------------------------------------------------------------------

describe('组定义经插件私有状态通道存取（工单178 那对方法；插件自己一个文件都不写）', () => {
  it('装载时经 plugin-config/get 读一次，载荷就是本插件的 id', async () => {
    plugin.mount(h.host)
    expect(h.configCalls()).toEqual([{ method: 'plugin-config/get', payload: { id: 'doc-group-cards' } }])
    await flush()
  })

  it('读回来就在：存过的自定义卡，重启（卸载重挂）后仍在，归属照旧', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()

    // 两个 docx 归自定义卡，不再有固有 DOCX 卡
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx'])
    expect(labelsOf('dgc-c1')).toContain('合同')

    // 换代（热重载）= 重启的等价形态：卸载再挂载，读的还是盘上那一份
    plugin.unmount?.()
    persisted = { ...persisted } // 走一遍真实落盘物化（重新组装一次袋子）
    plugin.mount(h.host)
    await flush()

    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx'])
  })

  it('读失败不致命：照常画固有卡，并把失败如实上报（不静默当空——否则用户建过卡却不知道卡去哪了）', async () => {
    const failing = {
      ...h.host,
      invoke: (method: string, payload: unknown) => {
        h.invokes.push({ method, payload })
        if (method === 'plugin-config/get') return Promise.reject(new Error('userData 读不到'))
        return Promise.resolve({ ok: true })
      },
    } as unknown as Host
    plugin.mount(failing)
    await flush()

    expect(cards().map((c) => c.id)).toEqual(['dgc-docx', 'dgc-pdf'])
    const note = h.notes.find((n) => n.type === 'doc-group-cards-groups-loaded')
    expect(note?.payload).toMatchObject({ ok: false })
  })

  it('建卡与改类型各发一次 plugin-config/set，载荷是那一个键（一次写 = 一次原子写）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()

    await rightClickBlank(cardById('dgc-c1'))
    rowById('new-group').dispatch('click')
    byId(TYPE_NAME_ID)!.value = '票据'
    byId(TYPE_OK_ID)!.dispatch('click')
    await flush()

    const sets = h.configCalls().filter((c) => c.method === 'plugin-config/set')
    expect(sets).toHaveLength(1)
    const patch = (sets[0].payload as { id: string; patch: Record<string, unknown> })
    expect(patch.id).toBe('doc-group-cards')
    expect(Object.keys(patch.patch)).toEqual([STORE_KEY])
    const written = patch.patch[STORE_KEY] as { groups: Array<{ name: string; exts: string[] }>; nextSeq: number }
    expect(written.groups.map((g) => g.name)).toEqual(['合同', '票据'])
    // 临时卡序号与自定义卡共用同一个单调计数器，一并落盘（之⑨ 才不会重启重排）
    expect(written.nextSeq).toBe(3)
  })

  it('换代交错时不串味：上一代那次异步读回不得画进新一代的卡里', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    plugin.unmount?.() // 读回还在路上就换代
    persisted = {}
    plugin.mount(h.host)
    await flush()

    // 新一代拿到的是它自己那一次读回（此刻盘上是空的）→ 只有固有卡
    expect(cards().map((c) => c.id)).toEqual(['dgc-docx', 'dgc-pdf'])
  })
})

describe('组卡菜单：NEW GROUP / EDIT TYPES 只在手改得动的卡上出现（工单185）', () => {
  it('自定义组卡的空白处右键出这两行，且都可用', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()

    await rightClickBlank(cardById('dgc-c1'))
    // 工单186 起 PASTE 是第一行、DISSOLVE 是第四行（前者恒可见但按剪贴板实况置灰；
    // 后者只在手改得动的卡上出现——本用例是自定义卡，出）
    expect(menuLabels()).toEqual(['PASTE', 'NEW GROUP', 'EDIT TYPES', 'DISSOLVE'])
    // NEW GROUP / EDIT TYPES 两行都可用（置灰的那一格是 PASTE——本用例宿主桩没给剪贴板实况）
    expect(menuRows().filter((r) => r.dataset.row !== 'paste' && r.classList.contains(DISABLED_CLASS))).toEqual([])
  })

  it('固有扩展组卡只出 PASTE / NEW GROUP：EDIT TYPES / DISSOLVE 仍不出（规则生成的卡不该被手改、也没有定义可删）', async () => {
    plugin.mount(h.host)
    await flush()

    await rightClickBlank(cardById('dgc-pdf'))
    // 工单185 登记过的「零可见行 → 不弹菜单」先后被 PASTE（#186）与 NEW GROUP（#187 裁决②）化解：
    // 那只菜单出得来，里面是 PASTE / NEW GROUP 两行——后者建的是**新**卡，不改脚下这张。
    // 「一可见行都没有就不弹」那道规则（工单182）本身一个字没动。
    expect(menuRows().map((r) => r.dataset.row)).toEqual(['paste', 'new-group'])
    expect(panel()).not.toBeNull()
    expect(typesOverlay()).toBeNull()
  })

  it('图标格上右键不开组卡菜单（那是文件菜单；闸与折叠切换同源，在 interaction.js）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()

    const cell = cardById('dgc-c1').children.find((c) => c.classList.contains('dgc-grid'))!.children[0]
    cell.dispatch('contextmenu', cell, { clientX: 10, clientY: 10 })
    expect(menuLabels()).toEqual(['OPEN', 'OPEN LOCATION', 'COPY PATH', 'COPY', 'CUT', 'RENAME', 'DELETE'])
  })
})

/** 开层之后的热区申报数与 keydown 监听数（供下面两条「两个方向都申报 / 都收回」比对） */
let openSnapshot = { domChanges: 0, keydown: 0 }

describe('NEW GROUP：勾选浮层铺出来的那一面（工单185）', () => {
  beforeEach(async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await rightClickBlank(cardById('dgc-c1'))
    rowById('new-group').dispatch('click')
    openSnapshot = { domChanges: h.domChanges.length, keydown: win.listenerCount('keydown') }
  })

  it('遮罩是 class="card" 的全屏元素，铺开即全屏热区（面板整屏不再穿透）', () => {
    const ov = typesOverlay()!
    expect(ov.classList.contains('card')).toBe(true)
    expect(ov.className.split(/\s+/)).toContain(TYPE_OVERLAY_ID)
    expect([ov.style.left, ov.style.top]).toEqual(['0px', '0px'])
    expect([ov.style.width, ov.style.height]).toEqual([`${win.innerWidth}px`, `${win.innerHeight}px`])
    // 渲染层的扫掠路径认它
    expect(dom.documentShim.querySelectorAll('.card').map((n) => n.id)).toContain(TYPE_OVERLAY_ID)
  })

  it('菜单先收干净再铺浮层：屏幕上不压着两层壳', () => {
    expect(panel()).toBeNull()
    expect(dom.documentShim.querySelectorAll(`.${ROW_CLASS}`)).toHaveLength(0)
  })

  it('有名字输入框，焦点经键盘档接住（档在效果数组的前一步持拿，故 focus 落得到）', () => {
    const name = byId(TYPE_NAME_ID)!
    expect(name).not.toBeNull()
    // 焦点流水里只有输入框一次 focus，且键盘档已先持
    expect(focusLog.map((f) => f.tag)).toEqual(['input'])
    expect(h.tiers).toContain('hold:types')
  })

  it('两钮都长在盒子里面，且盒子的高度装得下 CSS 内容堆叠', () => {
    // 工单187 真机轮修：算式曾按行数给盒子算高、且只给一个钮留位，于是 CREATE/CANCEL 被排到盒子
    // 外沿之下、被 overflow 裁掉——那一击穿过盒子落在遮罩上被判 outside，建卡静默取消
    // （app/accept P185 建卡红臂：types-closed reason=outside、无 groups-saved、页内无错误）。
    const box = byId(TYPE_BOX_ID)!
    expect(box.contains(byId(TYPE_OK_ID)!)).toBe(true)
    expect(box.contains(byId(TYPE_CANCEL_ID)!)).toBe(true)
    const cssStack =
      PICKER_PAD_Y * 2
      + PICKER_FIELD_H // 建卡模式的名字输入
      + PICKER_SWITCH_H
      + PICKER_MAX_ROWS * PICKER_ROW_H
      + PICKER_BTN_H * 2
      + PICKER_GAP_Y * 4
    expect(Number.parseFloat(box.style.height)).toBeGreaterThanOrEqual(cssStack)
  })

  it('顶部一个「接受全部类型」开关', () => {
    const all = byId(TYPE_ALL_ID)!
    expect(all).not.toBeNull()
    expect(all.className.split(/\s+/)).toContain(TYPE_ALL_CLASS)
    // 桩里的 textContent 不聚合子节点，故看子节点本身（勾号 + 标签）
    expect(all.children[0].textContent).toBe('☐')
    expect(all.children[1].textContent).toBe('ACCEPT ALL TYPES')
  })

  it('清单只列桌面上此刻真实存在的扩展名，逐个一个勾选框', () => {
    // 桌面上有 .docx 与 .pdf；.zip 之类不存在的类型不列（列了也没文件可放）
    expect(listedExts().sort()).toEqual(['.docx', '.pdf'])
    expect(typeRows().every((r) => r.children[0].textContent === '☐')).toBe(true)
  })

  it('勾上再提交：卡建出来，既有文件的归属随之迁移，无需手动干预', async () => {
    byId(TYPE_NAME_ID)!.value = '  票据  '
    typeRows().find((r) => r.dataset.ext === '.pdf')!.dispatch('click')
    expect(checkedExts()).toEqual(['.pdf'])
    byId(TYPE_OK_ID)!.dispatch('click')
    await flush()

    // 新卡出现，两个 pdf 落进去；被领走的 .pdf 不再生成固有卡；.docx 仍在先建的那张卡里
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-c2'])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx'])
    expect(membersOf('dgc-c2')).toEqual(['预算.pdf'])
    expect(labelsOf('dgc-c2')).toContain('票据')
    // 文件全表逐件核对：没有任何一件出现在两张卡里
    const all = cards().flatMap((c) => membersOf(c.id))
    expect(all.slice().sort()).toEqual(['方案.docx', '纪要.docx', '预算.pdf'].sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('取消与 Esc：不落库，一次 plugin-config/set 都不发', async () => {
    byId(TYPE_NAME_ID)!.value = '票据'
    byId(TYPE_CANCEL_ID)!.dispatch('click')
    await flush()
    expect(h.configCalls().filter((c) => c.method === 'plugin-config/set')).toEqual([])
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])

    await rightClickBlank(cardById('dgc-c1'))
    rowById('new-group').dispatch('click')
    pressEsc()
    await flush()
    expect(h.configCalls().filter((c) => c.method === 'plugin-config/set')).toEqual([])
    expect(typesOverlay()).toBeNull()
  })

  it('空名不建卡：层还开着，一个字节都不落盘（不替用户编一个名）', async () => {
    byId(TYPE_OK_ID)!.dispatch('click')
    await flush()
    expect(typesOverlay()).not.toBeNull()
    expect(h.configCalls().filter((c) => c.method === 'plugin-config/set')).toEqual([])
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])
  })

  it('「接受全部类型」打开时逐项一律显示为勾住，且点它不动声明（宽卡与逐项互斥）', () => {
    byId(TYPE_ALL_ID)!.dispatch('click')
    expect(checkedExts().sort()).toEqual(['.docx', '.pdf'])
    typeRows().find((r) => r.dataset.ext === '.pdf')!.dispatch('click')
    expect(checkedExts().sort()).toEqual(['.docx', '.pdf'])
    expect(byId(TYPE_ALL_ID)!.children[0].textContent).toBe('☑')
  })

  it('勾一项不抹掉已敲的名字（重画浮层本体时草稿要跟上）', () => {
    byId(TYPE_NAME_ID)!.value = '票据'
    typeRows().find((r) => r.dataset.ext === '.pdf')!.dispatch('click')
    expect(byId(TYPE_NAME_ID)!.value).toBe('票据')
    expect(checkedExts()).toEqual(['.pdf'])
  })

  it('浮层铺/撤都申报热区（两个方向都改矩形；不申报则全屏热区残留到关层之后）', () => {
    // 快照取在浮层已经铺开之后，故这里只能证明「关层那次」也申报了
    expect(openSnapshot.domChanges).toBeGreaterThan(0)
    byId(TYPE_CANCEL_ID)!.dispatch('click')
    expect(h.domChanges.length).toBe(openSnapshot.domChanges + 1)
    expect(typesOverlay()).toBeNull()
  })

  it('浮层样式随浮层同寿：开层才有、关层即摘（装载后 head 恰有一个子节点那条不受影响）', () => {
    expect(dom.head.children.filter((n) => n.id === TYPE_STYLE_ID)).toHaveLength(1)
    byId(TYPE_CANCEL_ID)!.dispatch('click')
    expect(byId(TYPE_STYLE_ID)).toBeNull()
    expect(dom.head.children).toHaveLength(1)
    expect(byId(STYLE_ID)).not.toBeNull()
  })

  it('关层后遮罩与窗口 keydown 监听一个都不剩', () => {
    expect(win.listenerCount('keydown')).toBe(openSnapshot.keydown)
    pressEsc()
    expect(win.listenerCount('keydown')).toBe(openSnapshot.keydown - 1)
    expect(typesOverlay()).toBeNull()
    expect(typesBox()).toBeNull()
  })
})

describe('EDIT TYPES：改接受的类型，既有文件自动改主', () => {
  beforeEach(async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
  })

  async function openEdit() {
    await rightClickBlank(cardById('dgc-c1'))
    rowById('edit-types').dispatch('click')
  }

  it('开层如实带回这张卡的名字与已声明的类型（已声明的显示为勾住）', async () => {
    await openEdit()
    expect(checkedExts()).toEqual(['.docx'])
    expect(byId(TYPE_NAME_ID)).toBeNull() // EDIT TYPES 不改卡名，故没有名字输入
    expect(byId(TYPE_OK_ID)!.textContent).toBe('SAVE')
  })

  it('把 .pdf 也勾进来：pdf 自动改主，固有 PDF 卡不再生成，docx 不动', async () => {
    await openEdit()
    typeRows().find((r) => r.dataset.ext === '.pdf')!.dispatch('click')
    byId(TYPE_OK_ID)!.dispatch('click')
    await flush()

    expect(cards().map((c) => c.id)).toEqual(['dgc-c1'])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx', '预算.pdf'])
    const written = (h.configCalls().filter((c) => c.method === 'plugin-config/set')[0]
      .payload as { patch: Record<string, { groups: Array<{ exts: string[] }> }> }).patch[STORE_KEY]
    expect(written.groups[0].exts).toEqual(['.docx', '.pdf'])
  })

  it('把 .docx 取消勾：文件落回固有组（迁移的另一头，同样无需手动干预）', async () => {
    await openEdit()
    typeRows().find((r) => r.dataset.ext === '.docx')!.dispatch('click')
    byId(TYPE_OK_ID)!.dispatch('click')
    await flush()

    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-docx', 'dgc-pdf'])
    expect(membersOf('dgc-docx')).toEqual(['方案.docx', '纪要.docx'])
    // 工单187 裁决①：这张自定义卡**留在屏上**（0 格）。它一退场，定义还在盘上、屏上却再没有
    // EDIT TYPES / DISSOLVE 能改回或解散它——面板重启它还会回来，用户界面上不可恢复
    expect(membersOf('dgc-c1')).toEqual([])
    expect(labelsOf('dgc-c1')).toBe('合同 · 0')
  })

  it('改完落盘，重启之后归属不变', async () => {
    await openEdit()
    typeRows().find((r) => r.dataset.ext === '.pdf')!.dispatch('click')
    byId(TYPE_OK_ID)!.dispatch('click')
    await flush()

    plugin.unmount?.()
    plugin.mount(h.host)
    await flush()

    expect(cards().map((c) => c.id)).toEqual(['dgc-c1'])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx', '预算.pdf'])
  })

  it('取消：一次落库动作都不发，原定义原样', async () => {
    await openEdit()
    typeRows().find((r) => r.dataset.ext === '.pdf')!.dispatch('click')
    pressEsc()
    await flush()
    expect(h.configCalls().filter((c) => c.method === 'plugin-config/set')).toEqual([])
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])
  })
})

describe('生命周期纪律：键盘档、热区、遮罩、样式一个都不漏（工单181/182/183 的既有规矩）', () => {
  it('持放成对：开层持、关层放（档不放窗口就一直可聚焦，面板再也点不动）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()

    await rightClickBlank(cardById('dgc-c1'))
    rowById('new-group').dispatch('click')
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:types'])
    byId(TYPE_CANCEL_ID)!.dispatch('click')
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:types', 'release:types'])
  })

  it('卸载时浮层开着：静默收场——遮罩/样式/热区/键盘档一样不漏', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await rightClickBlank(cardById('dgc-c1'))
    rowById('new-group').dispatch('click')
    expect(typesOverlay()).not.toBeNull()

    plugin.unmount?.()

    expect(typesOverlay()).toBeNull()
    expect(typesBox()).toBeNull()
    expect(byId(TYPE_STYLE_ID)).toBeNull()
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:types', 'release:types'])
    expect(cards()).toEqual([])
    expect(dom.head.children).toEqual([])
  })

  it('热重载后不留旧状态：新一代从头收起，旧代的浮层一个不留', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await rightClickBlank(cardById('dgc-c1'))
    rowById('new-group').dispatch('click')
    expect(typesOverlay()).not.toBeNull()

    plugin.unmount?.()
    plugin.mount(h.host)
    await flush()

    expect(typesOverlay()).toBeNull()
    expect(byId(TYPE_STYLE_ID)).toBeNull()
    expect(dom.head.children).toHaveLength(1)
    expect(h.tiers.filter((t) => t === 'hold:types').length).toBe(h.tiers.filter((t) => t === 'release:types').length)
  })

  it('卡 id 全表唯一：自定义卡与固有组撞上也由唯一化兜住（扫热区不去重）', async () => {
    // `.c1` 这个扩展名净化后正是 dgc-c1，与自定义卡的 id 正面相撞；自定义卡领走的是 .zzz，
    // 故 .c1 那一组仍要成卡——两张卡抢同一个 id
    seedCustomGroup([{ id: 'dgc-c1', name: '杂项', exts: ['.zzz'], acceptAll: false, seq: 1 }])
    h.host.view = viewWith([
      { name: '甲.c1', kind: 'file', path: 'C:\\me\\甲.c1', iconKey: 'a' },
      { name: '乙.c1', kind: 'file', path: 'C:\\me\\乙.c1', iconKey: 'b' },
      { name: '丙.docx', kind: 'file', path: 'C:\\me\\丙.docx', iconKey: 'c' },
      { name: '丁.zzz', kind: 'file', path: 'C:\\me\\丁.zzz', iconKey: 'd' },
    ])
    plugin.mount(h.host)
    await flush()

    const ids = cards().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['dgc-c1', 'dgc-c1-2', 'dgc-docx'])
    expect(membersOf('dgc-c1')).toEqual(['丁.zzz'])
    expect(membersOf('dgc-c1-2')).toEqual(['甲.c1', '乙.c1'])
  })

  it('自定义卡的卡面标题用的是用户起的名，固有卡才是扩展名大写（两者不混）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    expect(labelsOf('dgc-c1')).toContain('合同')
    expect(labelsOf('dgc-pdf')).toContain('PDF')
  })

  it('归属层只由三层归属算出来，菜单可见性据此判（kind 常量与 ownership 同名同值）', async () => {
    seedCustomGroup([CONTRACT_GROUP])
    plugin.mount(h.host)
    await flush()
    await rightClickBlank(cardById('dgc-c1'))
    const note = h.notes.find((n) => n.type === 'doc-group-cards-menu-opened')
    expect(note?.payload).toMatchObject({ cardId: 'dgc-c1' })
    expect(KIND_CUSTOM).toBe('custom')
  })
})

// ---------------------------------------------------------------------------
// 工单187 两条裁决的接线。裁决本身在 ownership.spec.ts / writeops.spec.ts，这里钉的是
// 它们在 card.js 里真的落到 DOM 上了吗（卡出不出屏、卡面写什么、菜单回不回得去、0 格卡
// 上那几处交互读几何会不会炸）。
// ---------------------------------------------------------------------------

/** 一张**空**的自定义卡：领 .zip，而这份桌面上一个 .zip 都没有 → 这张卡此刻 0 格 */
const EMPTY_GROUP = { id: 'dgc-c1', name: '空卡', exts: ['.zip'], acceptAll: false, seq: 1 }

function gridOf(id: string): Element {
  return cardById(id).children.find((c) => c.classList.contains('dgc-grid'))!
}

function multiSwitchOf(id: string): Element {
  const head = cardById(id).children.find((c) => c.classList.contains('dgc-head'))!
  const sw = head.children.find((n) => n.classList.contains(MULTI_CLASS))
  if (!sw) throw new Error(`${id} 上没有多选开关`)
  return sw
}

/** 卡 id → 该卡里的格子节点 */
const cellsOf = (id: string): Element[] => gridOf(id).children

describe('工单187 裁决①：空的自定义卡留在屏上（可编辑、可解散），空掉的固有组仍不出卡', () => {
  it('0 格的自定义卡照样出卡：卡面是用户起的名 + 「· 0」，且**没有**「+0」徽标', async () => {
    seedCustomGroup([EMPTY_GROUP])
    plugin.mount(h.host)
    await flush()

    // 桌面（docx ×2 + pdf）上没有任何 .zip → dgc-c1 是张 0 格卡，但它在屏上
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-docx', 'dgc-pdf'])
    expect(membersOf('dgc-c1')).toEqual([])
    expect(labelsOf('dgc-c1')).toBe('空卡 · 0') // 卡面写的是用户起的名，计数如实是 0
    // 「+N」徽标只在确有溢出时渲染：0 格卡上一个徽标都不该有（更不许出现「+0」）
    expect(walk(cardById('dgc-c1')).filter((n) => n.classList.contains(MORE_CLASS))).toEqual([])
  })

  it('同一个纪律的另一半：被自定义卡领空的那个**固有**组不出卡（空组不占卡只对固有组成立）', async () => {
    seedCustomGroup([{ id: 'dgc-c1', name: '文档', exts: ['.docx'], acceptAll: false, seq: 1 }])
    plugin.mount(h.host)
    await flush()

    // 两份 .docx 全被领走 → 固有 DOCX 组空了，它**退场**（规则生成的卡不占屏）
    expect(cards().map((c) => c.id)).toEqual(['dgc-c1', 'dgc-pdf'])
    expect(membersOf('dgc-c1')).toEqual(['方案.docx', '纪要.docx'])
    expect(cards().every((c) => c.id === 'dgc-c1' || membersOf(c.id).length > 0)).toBe(true)
  })

  it('0 格卡上那几处**要读几何**的交互一个都不炸：多选开关、框选拖拽、ENTER（它们有几何可读）', async () => {
    seedCustomGroup([EMPTY_GROUP])
    plugin.mount(h.host)
    await flush()
    const card = cardById('dgc-c1')

    // 多选开关：点得动，且翻的是自己那张卡（0 格卡照样能进多选态）
    expect(() => multiSwitchOf('dgc-c1').dispatch('click', multiSwitchOf('dgc-c1'))).not.toThrow()
    expect(multiSwitchOf('dgc-c1').classList.contains(MULTI_ON_CLASS)).toBe(true)

    // 框选：从内容区空白起笔拖到别处再松手（0 格卡上拖得起来、拖完即撤，且一格都选不中）
    const origin = gridOf('dgc-c1').getBoundingClientRect()
    expect(() => {
      gridOf('dgc-c1').dispatch('mousedown', gridOf('dgc-c1'), { clientX: origin.left + 2, clientY: origin.top + 2 })
      win.dispatch('mousemove', dom.body, { clientX: origin.left + 120, clientY: origin.top + 60 })
    }).not.toThrow()
    expect(walk(dom.body).filter((n) => n.classList.contains(MARQUEE_CLASS))).toHaveLength(1)
    win.dispatch('mouseup', dom.body, { clientX: origin.left + 120, clientY: origin.top + 60 })
    expect(walk(dom.body).filter((n) => n.classList.contains(MARQUEE_CLASS))).toEqual([])
    expect(cellsOf('dgc-c1').filter((c) => c.classList.contains('dgc-selected'))).toEqual([])

    // ENTER：选区恒空 → 什么都不启动，也不抛
    expect(() => win.dispatch('keydown', dom.body, { key: 'Enter' })).not.toThrow()
    expect(h.invokes.filter((c) => c.method === 'desktop/launch')).toEqual([])
  })

  it('裁决①要救回来的正是那条路：空卡上仍能 EDIT TYPES（勾回类型）与 DISSOLVE（解散）', async () => {
    seedCustomGroup([EMPTY_GROUP])
    plugin.mount(h.host)
    await flush()

    // 菜单开在 0 格卡上，四行齐全——EDIT TYPES / DISSOLVE 这两条出路没有被裁决拿走
    await rightClickBlank(cardById('dgc-c1'))
    expect(menuRows().map((r) => r.dataset.row)).toEqual(['paste', 'new-group', 'edit-types', 'dissolve'])

    // 走 EDIT TYPES：浮层开、钮是 SAVE，清单里列的是桌面上此刻真实存在的扩展名——
    // 这张空卡一个都没勾，故「勾回一个类型」的路就在眼前（EDIT TYPES 不改卡名，故无名字输入框）
    rowById('edit-types').dispatch('click')
    await flush()
    expect(typesOverlay()).not.toBeNull()
    expect(byId(TYPE_OK_ID)!.textContent).toBe('SAVE')
    expect(checkedExts()).toEqual([])
    expect(listedExts().sort()).toEqual(['.docx', '.pdf'])

    // 走 DISSOLVE：确认层开、文案指名道姓（这是那张卡的唯一退场方式，故必须可达）
    await rightClickBlank(cardById('dgc-c1'))
    rowById('dissolve').dispatch('click')
    await flush()
    expect(byId(CONFIRM_TEXT_ID)!.textContent).toContain('空卡')
  })
})

