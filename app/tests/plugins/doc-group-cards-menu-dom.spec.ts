/**
 * 自绘菜单外壳的**接线**（工单182 = spec166 之⑤）。
 *
 * 上一份测试（doc-group-cards-menu.spec.ts）钉的是裁决：行表、置灰、落位钳制、效果数组的顺序。
 * 本份钉的是接线：那些裁决在 card.js 里真的落到 DOM 与宿主上了吗？——
 *   - 右键真的铺出**一张 class='card' 的全屏遮罩**（热区扫掠认的只有这个类），且真的申报了热区；
 *   - 菜单外的点击收起、面板自身的留白**不**收起、Esc 收起；
 *   - 关层后遮罩与菜单样式**一点不留**；
 *   - 键盘档开层持拿、关层与卸载必放，且**持放平衡**；
 *   - 五个只读动作各走各的内核既有契约，且全程没碰过 `window.deck.ctxMenu`（那是上下文菜单
 *     插件的非公开全局，它停用时本菜单必须照常工作）。
 *
 * DOM 桩已抽到 doc-group-cards-dom-shim.ts（工单183 抽出，与工单181 的接线测试共用同一份）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  CELL_CLASS,
  HIGHLIGHT_CLASS,
} from '../../plugins/doc-group-cards/interaction'
import {
  DISABLED_CLASS,
  MENU_STYLE_ID,
  OVERLAY_CLASS,
  OVERLAY_ID,
  PANEL_ID,
  ROW_CLASS,
} from '../../plugins/doc-group-cards/menu'
import plugin, { STYLE_ID, type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { Element, EventTarget, newDom, walk } from './doc-group-cards-dom-shim'

// ---------------------------------------------------------------------------
// 宿主桩
// ---------------------------------------------------------------------------

const ITEMS: HostDesktopItem[] = [
  { name: '方案.docx', kind: 'file', path: 'C:\\me\\方案.docx', iconKey: 'k1' },
  { name: '纪要.docx', kind: 'file', path: 'C:\\me\\纪要.docx', iconKey: 'k2' },
  { name: '预算.pdf', kind: 'file', path: 'C:\\me\\预算.pdf', iconKey: 'k3' },
]

function viewWith(items: HostDesktopItem[]): HostView {
  return { desktop: { items } }
}

type Call = { method: string; payload: unknown }

let dom: ReturnType<typeof newDom>
let win: EventTarget & { innerWidth: number; innerHeight: number }
let h: {
  host: Host
  container: Element
  domChanges: number[]
  invokes: Call[]
  tiers: string[]
  notes: Array<{ type: string; payload?: Record<string, unknown> }>
  ctxMenuTouched: () => boolean
}

beforeEach(() => {
  // window 先摆好（card.js 的 mount/unmount 都要它），然后才谈得上卸载上一代。
  win = Object.assign(new EventTarget(), { innerWidth: 2560, innerHeight: 1440 })
  let touched = false
  ;(globalThis as unknown as Record<string, unknown>).window = Object.assign(win, {
    // 上下文菜单插件的全局（它**不是**任何声明契约的一部分，且本机停用）：读它即触碰它。
    // 整条用例跑完 touched 必须仍是 false —— 证明本菜单的代码路径一次都没去问它要东西。
    deck: { get ctxMenu() { touched = true; return undefined } },
  })
  // 每条用例换一份全新的文档与宿主，但 card.js 是**同一个模块实例**（同一 URL import 一次）。
  // 宿主契约是「重挂必先卸载」，故这里先卸载把上一条留下的模块级状态清干净——顺带钉住「卸载后不留旧状态」。
  plugin.unmount?.()
  dom = newDom()
  const container = new Element('div', 'deck-plugin')
  dom.body.appendChild(container)
  const domChanges: number[] = []
  const invokes: Call[] = []
  const tiers: string[] = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const stub = {
    el: container,
    view: viewWith(ITEMS),
    util: {},
    notify: (type: string, payload?: Record<string, unknown>) => { notes.push({ type, payload }) },
    invoke: (method: string, payload: unknown) => {
      invokes.push({ method, payload })
      return Promise.resolve(method === 'desktop/icon' ? { dataUrl: null } : { ok: true })
    },
    on: () => () => {},
    holdKeyboardTier: (tier: string) => { tiers.push(`hold:${tier}`) },
    releaseKeyboardTier: (tier: string) => { tiers.push(`release:${tier}`) },
    onDomChanged: () => { domChanges.push(1) },
  }
  h = {
    container,
    domChanges,
    invokes,
    tiers,
    notes,
    ctxMenuTouched: () => touched,
    host: stub as unknown as Host,
  }
  ;(globalThis as unknown as Record<string, unknown>).document = dom.documentShim
})

// ---------------------------------------------------------------------------

function cards(): Element[] {
  return walk(dom.body).filter((n) => n.classList.contains('card'))
}

function cellsOf(card: Element): Element[] {
  return walk(card).filter((n) => n.classList.contains(CELL_CLASS))
}

function overlay(): Element | null {
  return dom.documentShim.getElementById(OVERLAY_ID)
}

function panel(): Element | null {
  return dom.documentShim.getElementById(PANEL_ID)
}

function rowsOf(): Element[] {
  const p = panel()
  return p ? p.querySelectorAll(`.${ROW_CLASS}`) : []
}

function rowById(id: string): Element {
  const row = rowsOf().find((r) => r.dataset.row === id)
  if (!row) throw new Error(`菜单上没有 ${id} 行`)
  return row
}

function classesOf(node: Element): string[] {
  return node.className.split(/\s+/).filter(Boolean)
}

/** 在一个文件格上右键（落点即菜单原点） */
function rightClick(cell: Element, x = 800, y = 600): void {
  cell.dispatch('contextmenu', cell, { clientX: x, clientY: y })
}

function pressEsc(): void {
  const body = dom.body
  win.dispatch('keydown', body, { key: 'Escape' })
}

/** 菜单行点击之后，遮罩上的监听**不该**再看见这次点击（行自己 stopPropagation） */
function overlaySpyClicks(): { n: number } {
  const spy = { n: 0 }
  const ov = overlay()
  if (ov) ov.addEventListener('click', () => { spy.n += 1 })
  return spy
}

const labels = () => rowsOf().map((r) => r.textContent)
const menuInvokes = () => h.invokes.filter((c) => c.method !== 'desktop/icon')

// ---------------------------------------------------------------------------

describe('右键出菜单：全屏遮罩真的铺出来了（工单182：热区接管）', () => {
  it('遮罩是 class="card" 的一张全屏元素——热区扫掠只认这个类，不挂则整屏仍穿透', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])

    const ov = overlay()
    expect(ov).not.toBeNull()
    expect(classesOf(ov!)).toContain('card')
    expect(classesOf(ov!)).toContain(OVERLAY_CLASS)
    // 渲染层的扫掠路径：document.querySelectorAll('.card') —— 遮罩必须出现在这条路径的结果里
    expect(dom.documentShim.querySelectorAll('.card').map((n) => n.id)).toContain(OVERLAY_ID)
    // id 唯一（热区扫掠对重复 id 不去重）：遮罩 id 与两张组卡的 id 互不相撞
    const ids = cards().map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('遮罩矩形铺满视口（left/top=0，尺寸 = innerWidth/innerHeight；零尺寸矩形会被热区滤掉）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    const ov = overlay()!
    expect([ov.style.left, ov.style.top]).toEqual(['0px', '0px'])
    expect([ov.style.width, ov.style.height]).toEqual([`${win.innerWidth}px`, `${win.innerHeight}px`])
  })

  it('开层申报一次热区（反例：删掉这行 host.onDomChanged() 本用例即红——铺了遮罩不申报，扫掠照旧）', () => {
    plugin.mount(h.host)
    const before = h.domChanges.length
    rightClick(cellsOf(cards()[0])[0])
    expect(h.domChanges.length).toBe(before + 1)
  })

  it('关层再申报一次（撤了遮罩不申报，全屏热区会残留到菜单关闭之后）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    const afterOpen = h.domChanges.length
    overlay()!.dispatch('click')
    expect(h.domChanges.length).toBe(afterOpen + 1)
  })

  it('右键即选中该文件（与内核单项菜单同语义，且复用 #181 的单选裁决，不另设真相）', () => {
    plugin.mount(h.host)
    const [a, b] = cellsOf(cards()[0])
    a.dispatch('click')
    expect(classesOf(a)).toContain(HIGHLIGHT_CLASS)
    rightClick(b)
    expect(classesOf(b)).toContain(HIGHLIGHT_CLASS)
    expect(classesOf(a)).not.toContain(HIGHLIGHT_CLASS)
  })

  it('面板摆在钳制后的落位上（贴右下角右键 → 整块收回视口内）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0], win.innerWidth - 10, win.innerHeight - 10)
    const p = panel()!
    const left = Number(p.style.left.replace('px', ''))
    const top = Number(p.style.top.replace('px', ''))
    const width = Number(p.style.width.replace('px', ''))
    const height = Number(p.style.height.replace('px', ''))
    expect(left + width).toBeLessThanOrEqual(win.innerWidth)
    expect(top + height).toBeLessThanOrEqual(win.innerHeight)
    expect(left).toBeGreaterThanOrEqual(0)
  })
})

describe('文件菜单七项（工单182 只读五项 + 工单183 写两项 RENAME/DELETE）', () => {
  it('七行的顺序与文案即 spec166「菜单（自绘外壳）」所列', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    expect(labels()).toEqual(['OPEN', 'OPEN LOCATION', 'COPY PATH', 'COPY', 'CUT', 'RENAME', 'DELETE'])
    expect(rowsOf().map((r) => r.dataset.row)).toEqual(['open', 'open-location', 'copy-path', 'copy', 'cut', 'rename', 'delete'])
  })

  it('七项**全部可用**：没有一行带置灰类名（单选态下本票不置灰任何一行）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    expect(rowsOf()).toHaveLength(7)
    expect(rowsOf().some((r) => classesOf(r).includes(DISABLED_CLASS))).toBe(false)
  })

  it('面板尺寸 = 钳制用的那一份（几何只有一个出处：CSS 里的行高/内边距由常量插值）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    // 7 行 × 26 + 2 × 6 = 194
    expect(panel()!.style.height).toBe('194px')
    expect(panel()!.style.width).toBe('176px')
  })

  it('菜单样式元素随菜单同寿：开层才有、关层即摘（不留在文档头里）', () => {
    plugin.mount(h.host)
    expect(dom.documentShim.getElementById(MENU_STYLE_ID)).toBeNull()
    rightClick(cellsOf(cards()[0])[0])
    expect(dom.documentShim.getElementById(MENU_STYLE_ID)).not.toBeNull()
    overlay()!.dispatch('click')
    expect(dom.documentShim.getElementById(MENU_STYLE_ID)).toBeNull()
    // 组卡自己的样式表原样留着（关菜单不许牵连它）
    expect(dom.documentShim.getElementById(STYLE_ID)).not.toBeNull()
  })
})

describe('五项各走内核既有桥接契约（不碰 shell、不碰剪贴板）', () => {
  const CASES: Array<[string, string, Record<string, unknown>]> = [
    ['open', 'desktop/launch', { path: 'C:\\me\\方案.docx' }],
    ['open-location', 'desktop/reveal', { path: 'C:\\me\\方案.docx' }],
    ['copy-path', 'desktop/copy-path', { path: 'C:\\me\\方案.docx' }],
    ['copy', 'desktop/clipboard-copy', { paths: ['C:\\me\\方案.docx'] }],
    ['cut', 'desktop/clipboard-cut', { paths: ['C:\\me\\方案.docx'] }],
  ]

  for (const [id, method, payload] of CASES) {
    it(`${id} → ${method}（载荷是开层时冻结的那份选区）`, () => {
      plugin.mount(h.host)
      rightClick(cellsOf(cards()[0])[0])
      rowById(id).dispatch('click')
      expect(menuInvokes()).toEqual([{ method, payload }])
    })
  }

  it('行点击不外溢到遮罩的「菜单外点击」（否则刚执行完动作又被收起一次，收起存证成双份）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    const spy = overlaySpyClicks()
    rowById('copy').dispatch('click')
    expect(spy.n).toBe(0)
    // 且只发一次收层存证
    expect(h.notes.filter((n) => n.type === 'doc-group-cards-menu-closed')).toHaveLength(1)
  })

  it('动作存证带上行 id 与选区（电池分源用）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    rowById('cut').dispatch('click')
    const note = h.notes.find((n) => n.type === 'doc-group-cards-menu-action')
    expect(note?.payload).toMatchObject({ row: 'cut', paths: ['C:\\me\\方案.docx'] })
  })

  it('第二张卡的第二个文件同样能出菜单（菜单作用于那一次点中的文件，不是第一格）', () => {
    plugin.mount(h.host)
    const pdfCard = cards()[1]
    rightClick(cellsOf(pdfCard)[0])
    rowById('copy').dispatch('click')
    expect(menuInvokes()).toEqual([{ method: 'desktop/clipboard-copy', payload: { paths: ['C:\\me\\预算.pdf'] } }])
  })
})

describe('收起的三条路（外击 / Esc / 动作），关层一点不留', () => {
  it('菜单外点击收起（落在遮罩本体上），且不产生任何动作', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    overlay()!.dispatch('click')
    expect(overlay()).toBeNull()
    expect(menuInvokes()).toEqual([])
    expect(h.notes.find((n) => n.type === 'doc-group-cards-menu-closed')?.payload)
      .toMatchObject({ reason: 'outside' })
  })

  it('面板自身的留白**不**收起：那一击不是「菜单外」，收起只会让用户瞄行时手一抖就丢了菜单', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    panel()!.dispatch('click')
    expect(overlay()).not.toBeNull()
  })

  it('Esc 收起（键盘档持拿 → 窗口可聚焦 → Esc 送得到插件自己的 keydown 监听）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    pressEsc()
    expect(overlay()).toBeNull()
    expect(h.notes.find((n) => n.type === 'doc-group-cards-menu-closed')?.payload)
      .toMatchObject({ reason: 'esc' })
  })

  it('别的键不收（只有 Esc 归菜单；内核的 Esc 定序把「插件档在持」判为浮层在即，故内核那段放行）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    win.dispatch('keydown', dom.body, { key: 'a' })
    expect(overlay()).not.toBeNull()
  })

  it('关层后：遮罩、菜单样式、窗口 keydown 监听，一个都不剩', () => {
    plugin.mount(h.host)
    const keydownBefore = win.listenerCount('keydown')
    rightClick(cellsOf(cards()[0])[0])
    expect(win.listenerCount('keydown')).toBe(keydownBefore + 1)

    pressEsc()

    expect(overlay()).toBeNull()
    expect(panel()).toBeNull()
    expect(dom.documentShim.getElementById(MENU_STYLE_ID)).toBeNull()
    expect(win.listenerCount('keydown')).toBe(keydownBefore)
    // 屏幕上只剩两张组卡 + 组卡样式表（菜单那一层连一个节点都没留下）
    expect(dom.head.children).toHaveLength(1)
    expect(dom.documentShim.getElementById(STYLE_ID)).not.toBeNull()
  })

  it('重开不留两层遮罩（开着时再右键一次，上一层的遮罩与样式先收干净）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    rightClick(cellsOf(cards()[0])[1])
    const overlays = dom.documentShim.querySelectorAll('.card').filter((n) => n.id === OVERLAY_ID)
    expect(overlays).toHaveLength(1)
    expect(dom.documentShim.querySelectorAll(`.${ROW_CLASS}`)).toHaveLength(7)
    expect(dom.head.children.filter((n) => n.id === MENU_STYLE_ID)).toHaveLength(1)
  })
})

describe('键盘档（工单182：Esc 靠它才送得到；关层与卸载必放）', () => {
  it('开层持拿、关层放回，且用的是同一个档名（宿主按插件 id 加命名空间）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    expect(h.tiers).toEqual(['hold:menu'])
    overlay()!.dispatch('click')
    expect(h.tiers).toEqual(['hold:menu', 'release:menu'])
  })

  it('持放始终成对：连开连关若干回，档不多持也不少放（泄漏会让窗口一直可聚焦）', () => {
    plugin.mount(h.host)
    const cell = cellsOf(cards()[0])[0]
    for (let i = 0; i < 3; i += 1) {
      rightClick(cell)
      overlay()!.dispatch('click')
    }
    rightClick(cell)
    pressEsc()
    const holds = h.tiers.filter((t) => t === 'hold:menu').length
    const releases = h.tiers.filter((t) => t === 'release:menu').length
    expect(holds).toBe(releases)
  })

  it('卸载时菜单开着：静默收场——遮罩/样式/热区/键盘档一样不漏', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])

    plugin.unmount?.()

    expect(overlay()).toBeNull()
    expect(panel()).toBeNull()
    expect(dom.documentShim.getElementById(MENU_STYLE_ID)).toBeNull()
    expect(h.tiers).toEqual(['hold:menu', 'release:menu'])
    // 热区重申报过了：卸载末尾那次 onDomChanged 仍会走到
    expect(h.domChanges.length).toBeGreaterThan(0)
    expect(cards()).toEqual([])
    expect(dom.head.children).toEqual([])
  })

  it('卸载时菜单没开：不发多余的放档噪声（没持就放是噪声）', () => {
    plugin.mount(h.host)
    plugin.unmount?.()
    expect(h.tiers).toEqual([])
  })
})

describe('零依赖运行期证明（验收标准：上下文菜单插件停用时菜单照常工作）', () => {
  it('整条用例跑完，一次都没读过 window.deck.ctxMenu（它不是任何声明契约的一部分）', () => {
    expect(h.ctxMenuTouched()).toBe(false)
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    expect(labels()).toHaveLength(7)
    rowById('copy').dispatch('click')
    pressEsc()
    rightClick(cellsOf(cards()[0])[0])
    overlay()!.dispatch('click')
    expect(h.ctxMenuTouched()).toBe(false)
  })

  it('开层存证带全：光标原点、钳制后的盒子、行 id 清单（真机目视与电池按这三样定位）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0], 1234, 567)
    const note = h.notes.find((n) => n.type === 'doc-group-cards-menu-opened')
    expect(note?.payload).toMatchObject({
      x: 1234,
      y: 567,
      rows: ['open', 'open-location', 'copy-path', 'copy', 'cut', 'rename', 'delete'],
    })
    expect((note?.payload as { box: { left: number; top: number } }).box).toMatchObject({ left: 1234, top: 567 })
  })
})

describe('换代纪律（热重载后不留旧状态）', () => {
  it('开着菜单换一代：旧代的遮罩与样式一个不留，新代从头收起', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])
    expect(overlay()).not.toBeNull()

    plugin.unmount?.()
    plugin.mount(h.host)

    expect(overlay()).toBeNull()
    expect(dom.documentShim.getElementById(MENU_STYLE_ID)).toBeNull()
    expect(dom.head.children).toHaveLength(1)
    // 新代仍能开：新旧两代不共享任何节点
    rightClick(cellsOf(cards()[0])[0])
    expect(overlay()).not.toBeNull()
  })

  it('整排重画（文件变了）时开着菜单：菜单收掉，不留着指向已摘格子的壳', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(cards()[0])[0])

    h.host.view = viewWith([ITEMS[0]])
    plugin.update?.(h.host)

    // 重画后壳仍在场（菜单是插件级的状态，不随整排重画而丢），但它指向的旧格已摘——
    // 故点它仍走内核契约（载荷是冻结的绝对路径），不指向任何已不存在的节点
    expect(overlay()).not.toBeNull()
    rowById('open').dispatch('click')
    expect(menuInvokes()).toEqual([{ method: 'desktop/launch', payload: { path: 'C:\\me\\方案.docx' } }])
    expect(overlay()).toBeNull()
  })
})
