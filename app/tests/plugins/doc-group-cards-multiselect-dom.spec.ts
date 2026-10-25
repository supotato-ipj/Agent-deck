/**
 * 卡内多选的**接线**（工单184 = spec166 之⑦）。
 *
 * 裁决那一半在 doc-group-cards-selection.spec.ts（开关、切换选中、框选命中、ENTER 启动对象）。
 * 本份钉的是那些裁决在 card.js 里真的落到 DOM 与宿主上了吗：
 *   - 每张卡一枚**独立**开关：点它只翻自己那张卡，且不顺带把整卡折叠（那道闸同 #181）；
 *   - 多选态单击图标切换选中、再次点击取消；**非多选态仍旧是单选**（#181 的语义一个字没动）；
 *   - 多选态可从**内容区空白**起笔框选：拖拽带铺出来、热区重申报、命中集合**只含本卡**；
 *   - ENTER 批量启动：**逐项** desktop/launch（走内核既有契约），键盘档随选区起落、卸载必放；
 *   - 多选态右键菜单作用于**整个选中集**；OPEN LOCATION 与 RENAME 置灰（单文件语义）；
 *   - **多选态双击仍只启动一个文件**——肌肉记忆不因进了一个模式就改掉。
 *
 * DOM 桩是工单183 抽出的那一份共享桩（doc-group-cards-dom-shim.ts），不另写一份、不加新依赖。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { CELL, CELL_GAP, COLLAPSED_COLS, CARD_PAD_X, CARD_PAD_Y, HEAD_H, rowLayoutOf } from '../../plugins/doc-group-cards/geometry'
import { DISABLED_CLASS, PANEL_ID, ROW_CLASS } from '../../plugins/doc-group-cards/menu'
import { MARQUEE_CLASS, MULTI_CLASS, MULTI_ON_CLASS, SELECT_KEYBOARD_TIER } from '../../plugins/doc-group-cards/selection'
import plugin, { type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { Element, EventTarget, newDom, walk } from './doc-group-cards-dom-shim'

// ---------------------------------------------------------------------------
// 宿主桩（与 #183/#186 的接线测试同一副骨架，不另立一套）
// ---------------------------------------------------------------------------

const ITEMS: HostDesktopItem[] = [
  { name: '方案.docx', kind: 'file', path: 'C:\\me\\方案.docx', iconKey: 'k1' },
  { name: '纪要.docx', kind: 'file', path: 'C:\\me\\纪要.docx', iconKey: 'k2' },
  { name: '预算.pdf', kind: 'file', path: 'C:\\me\\预算.pdf', iconKey: 'k3' },
]
const DOCX = 'dgc-docx'
const PDF = 'dgc-pdf'

type Call = { method: string; payload: unknown }

let dom: ReturnType<typeof newDom>
let win: EventTarget & { innerWidth: number; innerHeight: number }
let h: {
  host: Host
  invokes: Call[]
  tiers: string[]
  notes: Array<{ type: string; payload?: Record<string, unknown> }>
  launches: () => string[]
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  win = Object.assign(new EventTarget(), { innerWidth: 2560, innerHeight: 1440 })
  ;(globalThis as unknown as Record<string, unknown>).window = Object.assign(win, { deck: {} })
  plugin.unmount?.()
  dom = newDom()
  const container = new Element('div', 'deck-plugin')
  dom.body.appendChild(container)
  const invokes: Call[] = []
  const tiers: string[] = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const view = { get desktop() { return { items: [...ITEMS] } } } as HostView
  h = {
    invokes,
    tiers,
    notes,
    launches: () =>
      invokes.filter((c) => c.method === 'desktop/launch').map((c) => (c.payload as { path: string }).path),
    host: {
      el: container,
      view,
      util: {},
      notify: (type: string, payload?: Record<string, unknown>) => { notes.push({ type, payload }) },
      invoke: (method: string, payload: unknown) => {
        invokes.push({ method, payload })
        if (method === 'desktop/icon') return Promise.resolve({ dataUrl: null })
        if (method === 'plugin-config/get') return Promise.resolve({ config: {}, warnings: [] })
        return Promise.resolve({ ok: true })
      },
      on: () => () => {},
      holdKeyboardTier: (tier: string) => { tiers.push(`hold:${tier}`) },
      releaseKeyboardTier: (tier: string) => { tiers.push(`release:${tier}`) },
      onDomChanged: () => {},
    } as unknown as Host,
  }
  ;(globalThis as unknown as Record<string, unknown>).document = dom.documentShim
})

// ---------------------------------------------------------------------------
// 取节点的小工具
// ---------------------------------------------------------------------------

function cardById(id: string): Element {
  const card = walk(h.host.el as unknown as Element)
    .find((n) => n.id === id && n.classList.contains('card'))
  if (!card) throw new Error(`没有 ${id} 这张卡`)
  return card
}

function gridOf(id: string): Element {
  return cardById(id).children.find((c) => c.classList.contains('dgc-grid'))!
}

function cellsOf(id: string): Element[] {
  return gridOf(id).children
}

function multiSwitchOf(id: string): Element {
  const sw = cardById(id).children
    .flatMap((head) => head.children)
    .find((n) => n.classList.contains(MULTI_CLASS))
  if (!sw) throw new Error(`${id} 上没有多选开关`)
  return sw
}

/** 该卡上带 dgc-selected 的格子的文件名（按格序） */
function selectedOf(id: string): string[] {
  return cellsOf(id)
    .filter((c) => c.classList.contains('dgc-selected'))
    .map((c) => c.children[1].textContent)
}

/** 卡框的视口坐标（card.js 按 geometry.js 写在内联样式上的那两行） */
function boxOf(id: string): { left: number; top: number } {
  const s = cardById(id).style
  return { left: Number.parseFloat(s.left), top: Number.parseFloat(s.top) }
}

/**
 * 内容区（网格局部坐标系原点在网格外沿左上角）的视口原点。
 * 按 geometry.js 的常量独立算出，**不读 card.js 的内部**：卡框矩形是内联样式上的公开数字。
 */
function contentOrigin(id: string): { x: number; y: number } {
  const box = boxOf(id)
  return { x: box.left + CARD_PAD_X, y: box.top + CARD_PAD_Y + HEAD_H }
}

/** 第 i 格（网格局部坐标）的视口矩形；格序 = 折叠态 3 列一行行排开 */
function cellBox(id: string, index: number): { left: number; top: number } {
  const pitch = CELL + CELL_GAP
  const origin = contentOrigin(id)
  return { left: origin.x + (index % COLLAPSED_COLS) * pitch, top: origin.y + Math.floor(index / COLLAPSED_COLS) * pitch }
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

function clickNode(node: Element): void {
  node.dispatch('click', node)
}

/** 点卡上的多选开关 */
function toggleMultiOn(id: string): void {
  clickNode(multiSwitchOf(id))
}

function clickCell(id: string, index: number): void {
  clickNode(cellsOf(id)[index])
}

function dblclickCell(id: string, index: number): void {
  const cell = cellsOf(id)[index]
  cell.dispatch('dblclick', cell)
}

function rightClickCell(id: string, index: number): void {
  const cell = cellsOf(id)[index]
  cell.dispatch('contextmenu', cell, { clientX: 900, clientY: 700 })
}

/**
 * 从内容区空白起笔，拖到 to（视口坐标），松手。
 * `from` 默认取内容区左上角内侧 2px；**只框第二格**这类用例要自己给一个落在格间空隙里的起点。
 */
function dragOnBlank(id: string, to: { left: number; top: number }, from?: { left: number; top: number }): void {
  const origin = contentOrigin(id)
  const start = from ? { clientX: from.left, clientY: from.top } : { clientX: origin.x + 2, clientY: origin.y + 2 }
  gridOf(id).dispatch('mousedown', gridOf(id), start)
  win.dispatch('mousemove', dom.body, { clientX: to.left, clientY: to.top })
  win.dispatch('mouseup', dom.body, { clientX: to.left, clientY: to.top })
}

/** 只框住第 index 格：起笔落在它左边的格间空隙里，收笔落在它的右下角外沿 */
function dragOverOnly(id: string, index: number): void {
  const origin = contentOrigin(id)
  const cell = cellBox(id, index)
  dragOnBlank(
    id,
    { left: cell.left + CELL, top: cell.top + CELL },
    { left: origin.x + index * (CELL + CELL_GAP) - 6, top: origin.y + 2 },
  )
}

/** 点菜单里那一行 */
function clickRow(rowId: string): void {
  const panel = dom.documentShim.getElementById(PANEL_ID)!
  const row = panel.querySelectorAll(`.${ROW_CLASS}`).find((r) => r.dataset.row === rowId)!
  row.dispatch('click', row)
}

function pressEnter(): void {
  win.dispatch('keydown', dom.body, { key: 'Enter' })
}

function marqueeNodes(): Element[] {
  return walk(dom.body).filter((n) => n.classList.contains(MARQUEE_CLASS))
}

function menuIds(): string[] {
  const panel = dom.documentShim.getElementById(PANEL_ID)
  return panel ? panel.querySelectorAll(`.${ROW_CLASS}`).map((r) => r.dataset.row as string) : []
}

function rowEnabled(id: string): boolean {
  const panel = dom.documentShim.getElementById(PANEL_ID)!
  const row = panel.querySelectorAll(`.${ROW_CLASS}`).find((r) => r.dataset.row === id)!
  return !row.classList.contains(DISABLED_CLASS)
}

async function boot(): Promise<void> {
  plugin.mount(h.host)
  await flush()
}

// ---------------------------------------------------------------------------

describe('每张卡一个独立的多选开关（工单184）', () => {
  it('开关渲染在卡头上：两张卡各有一枚', async () => {
    await boot()
    expect(multiSwitchOf(DOCX)).toBeTruthy()
    expect(multiSwitchOf(PDF)).toBeTruthy()
    expect(multiSwitchOf(DOCX)).not.toBe(multiSwitchOf(PDF))
  })

  it('初始全是关的（不亮）', async () => {
    await boot()
    expect(multiSwitchOf(DOCX).classList.contains(MULTI_ON_CLASS)).toBe(false)
    expect(multiSwitchOf(PDF).classList.contains(MULTI_ON_CLASS)).toBe(false)
  })

  it('点一张卡的开关只翻那一张，另一张纹丝不动', async () => {
    await boot()
    toggleMultiOn(DOCX)
    expect(multiSwitchOf(DOCX).classList.contains(MULTI_ON_CLASS)).toBe(true)
    expect(multiSwitchOf(PDF).classList.contains(MULTI_ON_CLASS)).toBe(false)
  })

  it('两张都开着时，两张的选区互不串（卡内独立）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    toggleMultiOn(PDF)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    clickCell(PDF, 0)
    expect(selectedOf(DOCX)).toEqual(['方案.docx', '纪要.docx'])
    expect(selectedOf(PDF)).toEqual(['预算.pdf'])
  })

  it('点开关**不顺带把整卡折叠**（#181 那道闸在开关上同样成立）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    expect(cardById(DOCX).classList.contains('dgc-expanded')).toBe(false)
  })

  it('关掉开关即清空本卡的选区（留着高亮会让用户以为还选着）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    toggleMultiOn(DOCX)
    expect(selectedOf(DOCX)).toEqual([])
    // 并且立刻退回单选语义：再点一格是选中而不是并集
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    expect(selectedOf(DOCX)).toEqual(['纪要.docx'])
  })
})

describe('多选态下单击切换选中（工单184）', () => {
  it('单击选中、再点一次取消', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(selectedOf(DOCX)).toEqual(['方案.docx'])
    clickCell(DOCX, 0)
    expect(selectedOf(DOCX)).toEqual([])
  })

  it('逐个挑选：两个都留着', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    expect(selectedOf(DOCX)).toEqual(['方案.docx', '纪要.docx'])
  })

  it('**非多选态仍是单选**（#181 的语义一字未动：后点顶掉先点）', async () => {
    await boot()
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    expect(selectedOf(DOCX)).toEqual(['纪要.docx'])
  })

  it('点图标仍**不折叠整卡**（多选态下 #181 那道闸照样成立）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(cardById(DOCX).classList.contains('dgc-expanded')).toBe(false)
  })
})

describe('卡内框选（工单184：命中集合只含本卡）', () => {
  it('非多选态下空白处拖不出框选（那一下仍是折叠/展开的老语义）', async () => {
    await boot()
    dragOnBlank(DOCX, { left: 900, top: 800 })
    expect(marqueeNodes()).toEqual([])
    expect(selectedOf(DOCX)).toEqual([])
  })

  // 工单187 真机轮暴露的产品缺陷：mousedown+mouseup 同元素落下时浏览器必补发一次 click，
  // 而框选落点正是内容区空白（其语义=折叠整卡+清高亮）。不吞掉那一发，每一次框选都会在
  // 选区落定的同一瞬间把卡折起来、把选区抹掉——真机上恒定表现为「拖拽带在场、松手后 0 入选」。
  it('拖拽松手后浏览器补发的那一发 click 被吞掉：卡不折、选区不丢', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickNode(cardById(DOCX)) // 展开，让这一框落在展开态内容区上
    const grid = gridOf(DOCX).getBoundingClientRect()
    const start = { clientX: grid.left + grid.width / 2, clientY: grid.top + grid.height - 20 }
    gridOf(DOCX).dispatch('mousedown', gridOf(DOCX), start)
    win.dispatch('mousemove', dom.body, { clientX: grid.left + 40, clientY: grid.top + 40 })
    win.dispatch('mouseup', dom.body, { clientX: grid.left + 40, clientY: grid.top + 40 })
    const picked = selectedOf(DOCX)
    expect(picked.length).toBeGreaterThanOrEqual(1)
    // 浏览器补发的那一发 click（真机上由 mouseup 之后、同一批事件里到达）
    clickNode(cardById(DOCX))
    expect(cardById(DOCX).classList.contains('dgc-expanded')).toBe(true)
    expect(selectedOf(DOCX)).toEqual(picked)
    // 再点一次就是用户新一笔单击了：老语义照旧（折叠整卡）
    clickNode(cardById(DOCX))
    expect(cardById(DOCX).classList.contains('dgc-expanded')).toBe(false)
  })

  it('多选态下从内容区空白起笔能拖出框选带，松手即撤', async () => {
    await boot()
    toggleMultiOn(DOCX)
    const origin = contentOrigin(DOCX)
    gridOf(DOCX).dispatch('mousedown', gridOf(DOCX), { clientX: origin.x + 2, clientY: origin.y + 2 })
    expect(marqueeNodes().length).toBe(1) // 拖拽期间在场
    win.dispatch('mousemove', dom.body, { clientX: origin.x + 200, clientY: origin.y + 60 })
    expect(marqueeNodes().length).toBe(1)
    win.dispatch('mouseup', dom.body, { clientX: origin.x + 200, clientY: origin.y + 60 })
    expect(marqueeNodes()).toEqual([]) // 松手即摘干净
  })

  it('命中集合**只含本卡图标**：拖过另一张卡也不选中它（卡内独立的硬证据）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    // 起笔在 docx 卡内容区空白，落点甩到 **pdf 卡那一格的正中间**——这一次拖拽在视口上
    // 确实横跨了两张卡。若命中判据误用视口坐标或全局格子表，pdf 那一格会被选中。
    const pdfCell = cellBox(PDF, 0)
    dragOnBlank(DOCX, { left: pdfCell.left + CELL / 2, top: pdfCell.top + CELL / 2 })
    expect(selectedOf(DOCX)).toEqual(['方案.docx', '纪要.docx'])
    expect(selectedOf(PDF)).toEqual([])
  })

  it('跨卡那一次框选**没有把别的卡的路径混进本卡的选区**（选区内容本身是卡内的，不只是高亮）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    const pdfCell = cellBox(PDF, 0)
    dragOnBlank(DOCX, { left: pdfCell.left + CELL / 2, top: pdfCell.top + CELL / 2 })
    // 高亮是**逐卡**画的，别的卡的格子画不进本卡的高亮——所以光看高亮看不出「选区里混进了
    // 别人的路径」。真正的观察口是走内核契约的那条路：ENTER 逐项启动，COPY 交整批路径。
    pressEnter()
    expect(h.launches()).toEqual(['C:\\me\\方案.docx', 'C:\\me\\纪要.docx'])
    expect(h.launches()).not.toContain('C:\\me\\预算.pdf')
  })

  it('框选整批替换选区（不是并上去）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    dragOverOnly(DOCX, 1) // 这一框只压到第 1 格
    expect(selectedOf(DOCX)).toEqual(['纪要.docx'])
  })

  // 工单187 真机轮：这条是**首轮红臂那处坐标错配的钉子**。展开态内容区比卡框内边距盒窄、
  // `margin:0 auto` 真居中，于是「卡框内联 left/top + 内边距 + 卡头」那套算式外沿与真实
  // 网格外沿差着一截常数；命中表若按算式推、拖拽带的 left/top 若也按算式写，两侧都挂在算式上，
  // 真机上恒空命中（本轮实测「拖拽带=true 入选=0」）。折叠态两者恰好相等（内容区与内边距盒同宽），
  // 所以这个缺陷对折叠态用例是隐形的——必须显式展开这张卡、并且直接量那条带子的矩形才看得见。
  it('**展开态**框选带与命中集都按实测外沿：带子的 left/top = 视口矩形 − 实测网格外沿', async () => {
    await boot()
    clickNode(cardById(DOCX)) // 点卡片空白 → 展开
    expect(cardById(DOCX).classList.contains('dgc-expanded')).toBe(true)
    toggleMultiOn(DOCX)
    // 先把前提钉住：这一态下算式外沿与实测外沿确实不等（不是 0），否则本条是空转
    const grid = gridOf(DOCX).getBoundingClientRect()
    const driftX = grid.left - contentOrigin(DOCX).x
    expect(Math.round(driftX)).not.toBe(0)
    // 起笔/收笔都按**实测**网格外沿取——真机上那正是用户看到的那一片
    const start = { clientX: grid.left + grid.width / 2, clientY: grid.top + grid.height - 20 }
    const end = { left: grid.left + 40, top: grid.top + 40 }
    gridOf(DOCX).dispatch('mousedown', gridOf(DOCX), start)
    win.dispatch('mousemove', dom.body, { clientX: end.left, clientY: end.top })
    const band = marqueeNodes()[0]
    expect(band).toBeTruthy()
    // 拖拽带的 left/top 走的是 `position:relative` 的网格外沿，故必须是「视口矩形 − 实测外沿」。
    // 挂回算式外沿（真机上的那 16px 偏移）时这条直接红——它就是那处错配的最小复现。
    expect(Math.round(Number.parseFloat(band.style.left))).toBe(Math.round(Math.min(start.clientX, end.left) - grid.left))
    expect(Math.round(Number.parseFloat(band.style.top))).toBe(Math.round(Math.min(start.clientY, end.top) - grid.top))
    win.dispatch('mouseup', dom.body, { clientX: end.left, clientY: end.top })
    expect(selectedOf(DOCX)).toEqual(['方案.docx', '纪要.docx'])
  })

  it('框空即清空本卡选区', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    // 拖到内容区右侧的空处去（远在所有格子右边，且起笔也在那儿 → 零尺寸之外仍是空框）
    const origin = contentOrigin(DOCX)
    dragOnBlank(DOCX, { left: origin.x + 1200, top: origin.y + 400 }, { left: origin.x + 1000, top: origin.y + 300 })
    expect(selectedOf(DOCX)).toEqual([])
  })

  it('框选只影响起笔的那张卡，另一张的选区原样保留', async () => {
    await boot()
    toggleMultiOn(DOCX)
    toggleMultiOn(PDF)
    clickCell(PDF, 0)
    dragOverOnly(DOCX, 1)
    expect(selectedOf(PDF)).toEqual(['预算.pdf'])
  })

  it('起笔落在**图标上**不框选（那是单击切换的活）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    const box = cellBox(DOCX, 0)
    gridOf(DOCX).dispatch('mousedown', cellsOf(DOCX)[0], { clientX: box.left + 10, clientY: box.top + 10 })
    win.dispatch('mouseup', dom.body, { clientX: box.left + 200, clientY: box.top + 60 })
    expect(marqueeNodes()).toEqual([])
  })
})

describe('ENTER 批量启动（工单184）', () => {
  it('ENTER **逐项**走既有启动契约 desktop/launch（主进程侧扫描池护栏原样生效）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    pressEnter()
    expect(h.launches()).toEqual(['C:\\me\\方案.docx', 'C:\\me\\纪要.docx'])
  })

  it('选区非空期间持 ENTER 键盘档（窗口因此可聚焦，ENTER 才送得到插件）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(h.tiers).toContain(`hold:${SELECT_KEYBOARD_TIER}`)
  })

  it('多选开着但一个都没选时**不持档**（没有可启动的东西，别白占键盘通道）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    expect(h.tiers).not.toContain(`hold:${SELECT_KEYBOARD_TIER}`)
  })

  it('选区一空即放档（取消最后一个选中）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(h.tiers).toContain(`hold:${SELECT_KEYBOARD_TIER}`)
    clickCell(DOCX, 0) // 取消最后一个
    expect(h.tiers).toContain(`release:${SELECT_KEYBOARD_TIER}`)
  })

  it('关掉多选开关即放档（选区随开关一起清空）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(h.tiers).toContain(`hold:${SELECT_KEYBOARD_TIER}`)
    toggleMultiOn(DOCX)
    expect(h.tiers).toContain(`release:${SELECT_KEYBOARD_TIER}`)
  })

  it('**卸载必放档**：选着东西就卸载，窗口不能一直被钉成可聚焦', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(h.tiers).toContain(`hold:${SELECT_KEYBOARD_TIER}`)
    plugin.unmount?.()
    expect(h.tiers).toContain(`release:${SELECT_KEYBOARD_TIER}`)
  })

  it('框出来的选区同样能被 ENTER 一次启动（两个动作接得上）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    dragOverOnly(DOCX, 1) // 先框中第 1 格
    clickCell(DOCX, 0) // 再点选第 0 格
    pressEnter()
    // 启动次序 = **选区加入次序**（先框的那个先启动），不是格序：选区是个 Set，
    // 它的迭代序就是用户把它们选进来的顺序，如实照发，不另排一次序。
    expect(h.launches()).toEqual(['C:\\me\\纪要.docx', 'C:\\me\\方案.docx'])
  })

  it('非多选态按 ENTER **不批量启动**（双击启动是肌肉记忆，ENTER 不抢它的活）', async () => {
    await boot()
    clickCell(DOCX, 0)
    pressEnter()
    expect(h.launches()).toEqual([])
  })

  it('选区为空时按 ENTER 什么都不启动（档可能在，命中集合不在）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    pressEnter()
    expect(h.launches()).toEqual([])
  })
})

describe('多选态双击仍只启动单个文件（工单184：肌肉记忆不被打断）', () => {
  it('选着两个文件时双击其中一个，只启动那一个', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    dblclickCell(DOCX, 1)
    expect(h.launches()).toEqual(['C:\\me\\纪要.docx'])
  })

  it('双击的落点是**被双击的那一格**，与选区里有没有它无关', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0) // 只选中了第 0 格
    dblclickCell(DOCX, 1) // 双击的是没选中的第 1 格
    expect(h.launches()).toEqual(['C:\\me\\纪要.docx'])
  })

  it('双击不改动选区（启动不是选择）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    dblclickCell(DOCX, 0)
    expect(selectedOf(DOCX)).toEqual(['方案.docx', '纪要.docx'])
  })
})

describe('多选态右键菜单作用于整个选中集（工单184）', () => {
  it('在**已选中**的格子上右键：菜单作用于整个选中集（COPY 拿到的是全批路径）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    rightClickCell(DOCX, 0)
    expect(menuIds()).toEqual(['open', 'open-location', 'copy-path', 'copy', 'cut', 'rename', 'delete'])
    clickRow('copy')
    const copy = h.invokes.filter((c) => c.method === 'desktop/clipboard-copy').at(-1)
    expect((copy?.payload as { paths: string[] }).paths).toEqual(['C:\\me\\方案.docx', 'C:\\me\\纪要.docx'])
  })

  it('右键那一击**不改动选区**（菜单开着时选区仍是他以为的那一批）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    rightClickCell(DOCX, 0)
    expect(selectedOf(DOCX)).toEqual(['方案.docx', '纪要.docx'])
  })

  it('OPEN LOCATION 与 RENAME 在多选下**置灰**（它们需要单选）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    rightClickCell(DOCX, 0)
    expect(rowEnabled('open-location')).toBe(false)
    expect(rowEnabled('rename')).toBe(false)
    // 批量语义的行一行不动：COPY / CUT / DELETE 仍然可用
    expect(rowEnabled('copy')).toBe(true)
    expect(rowEnabled('cut')).toBe(true)
    expect(rowEnabled('delete')).toBe(true)
  })

  it('单选时两行照旧可用（#182/#183 的单文件语义没被本票改坏）', async () => {
    await boot()
    rightClickCell(DOCX, 0)
    expect(rowEnabled('open-location')).toBe(true)
    expect(rowEnabled('rename')).toBe(true)
  })

  it('在**未选中**的格子上右键：单独选中它（菜单不作用于一个用户没选的集合）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    rightClickCell(DOCX, 1)
    expect(selectedOf(DOCX)).toEqual(['纪要.docx'])
  })

  it('多选的 OPEN 行同样作用于整个选中集（逐项启动，仍走既有契约）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    clickCell(DOCX, 1)
    rightClickCell(DOCX, 0)
    clickRow('open')
    expect(h.launches()).toEqual(['C:\\me\\方案.docx', 'C:\\me\\纪要.docx'])
  })

  it('单选的 OPEN 行仍然只启动一个（#182 的单文件语义没被本票改坏）', async () => {
    await boot()
    rightClickCell(DOCX, 0)
    clickRow('open')
    expect(h.launches()).toEqual(['C:\\me\\方案.docx'])
  })
})

describe('结构不变式（#181/#183 钉死的，本票不得破）', () => {
  it('1Hz 快照结构没变时整排不重画：选区与多选开关都还在', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    plugin.update?.(h.host)
    plugin.update?.(h.host)
    expect(selectedOf(DOCX)).toEqual(['方案.docx'])
    expect(multiSwitchOf(DOCX).classList.contains(MULTI_ON_CLASS)).toBe(true)
  })

  it('整排重画后卡片回到初始态（格节点换了，旧选区没有可依附的实体）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    clickCell(DOCX, 0)
    expect(h.tiers).toContain(`hold:${SELECT_KEYBOARD_TIER}`)
    // 文件增删 → 结构指纹变 → 整排重画 → 选区连同档一起收场，不留悬空的持档
    const view = { desktop: { items: [...ITEMS, { name: '新增.txt', kind: 'file', path: 'C:\\me\\新增.txt', iconKey: 'k9' }] } }
    ;(h.host as unknown as { view: unknown }).view = view
    plugin.update?.(h.host)
    expect(selectedOf(DOCX)).toEqual([])
    expect(multiSwitchOf(DOCX).classList.contains(MULTI_ON_CLASS)).toBe(false)
    expect(h.tiers).toContain(`release:${SELECT_KEYBOARD_TIER}`)
  })

  it('卸载后不留任何框选带（自建节点随容器一并摘除）', async () => {
    await boot()
    toggleMultiOn(DOCX)
    const origin = contentOrigin(DOCX)
    gridOf(DOCX).dispatch('mousedown', gridOf(DOCX), { clientX: origin.x + 2, clientY: origin.y + 2 })
    expect(marqueeNodes().length).toBe(1)
    plugin.unmount?.()
    expect(marqueeNodes()).toEqual([])
  })

  it('卡间布局仍是居中整行（SETTLED 裁决不被本票动摇）', async () => {
    await boot()
    const boxes = rowLayoutOf([DOCX, PDF], { width: 2560, height: 1440 }, '')
    expect(boxOf(DOCX).left).toBe(boxes[0].left)
    expect(boxOf(PDF).left).toBe(boxes[1].left)
  })
})
