/**
 * 组卡插件测试用的**极简 DOM 桩**（工单183 抽出）。
 *
 * 为什么自带桩而不上 jsdom：本仓库没装 jsdom/happy-dom（package.json 里没有，也不为一条测试
 * 加依赖），渲染层的既有测试一律是纯逻辑（tests/renderer/*）。这份桩只实现 doc-group-cards
 * 入口真实用到的那几个面——createElement / append / classList / closest / addEventListener +
 * **真冒泡**（沿 parent 链上溯，stopPropagation 即断链）——外加一个能派发 keydown 的 window 桩。
 *
 * 它证明的不是「DOM 怎么冒泡」（那是规范，这里只做最小近似），而是**card.js 把监听挂在哪、
 * 铺没铺遮罩、焦点落没落到位、申报没申报、卸载摘了哪些节点**。
 *
 * **为什么现在才抽出来**：工单181 与工单182 各自带了一份几乎相同的桩（约 230 行 ×2），已经
 * 是第三份出现的边缘——工单183 要再加一份。与其复制第四份，不如把两份收进这一处，让三张票
 * 共用。抽取时取的是工单182 那份的超集（多了 key / clientX / clientY / preventDefault /
 * window 的 EventTarget / document.querySelectorAll），故工单181 用到的那几个面一个不少。
 * 工单183 在此基础上补了输入框那一面（value / focus / setSelectionRange / replaceWith /
 * setAttribute），因为「焦点怎么落到输入框上」正是本票要钉的东西。
 * 工单187 真机轮再补 `getBoundingClientRect()`——见文件末尾那段「桩里的布局」。
 */
import { CARD_PAD_X, CARD_PAD_Y, HEAD_H, cardGeometryOf, cellRectOf } from '../../plugins/doc-group-cards/geometry'
export type DomEvent = {
  type: string
  target: Element
  clientX: number
  clientY: number
  key?: string
  stopped: boolean
  stopPropagation(): void
  preventDefault(): void
}

export type Listener = (ev: DomEvent) => void

/**
 * 焦点调用流水（模块级）：`focus()` 被调过几次、按什么次序、在哪个元素上。
 *
 * 本票要钉的正是**次序**——键盘档必须先持、focus 才落得到（宿主/契约里没有「聚焦某元素」的
 * API，档让窗口可聚焦是第一步）。次序只有在一份共用的流水上才看得见，故挂在桩的模块级，
 * 由 newDom() 每次清零（每条用例换一份全新文档，流水自然归零）。
 */
export const focusLog: Array<{ node: Element; tag: string }> = []

/** 只认 class 选择器的 `closest`/`querySelectorAll`（card.js 只用 `.dgc-cell` / `.dgc-menu-row` 这类） */
export function matches(node: Element, selector: string): boolean {
  return selector.startsWith('.') && node.classList.contains(selector.slice(1))
}

export class Element {
  parent: Element | null = null
  children: Element[] = []
  listeners = new Map<string, Listener[]>()
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  /** 文档根标记：document.head 与宿主容器顶层各一 */
  isRoot = false
  alt = ''
  draggable = false
  src = ''
  /** 输入框那一面（工单183）：真 DOM 上是 HTMLInputElement 的成员 */
  type = ''
  value = ''
  maxLength = 255
  spellcheck = true
  selectionStart = 0
  selectionEnd = 0
  focused = false

  constructor(public tagName: string, public id = '', public textContent = '') {}

  private _className = ''

  set className(v: string) {
    this._className = v
  }

  get className(): string {
    return this._className
  }

  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean)
    return {
      contains: (c: string) => list().includes(c),
      add: (...cs: string[]) => {
        const now = list()
        for (const c of cs) if (!now.includes(c)) now.push(c)
        this.className = now.join(' ')
      },
      remove: (...cs: string[]) => {
        this.className = list().filter((c) => !cs.includes(c)).join(' ')
      },
    }
  }

  get firstChild(): Element | null {
    return this.children[0] ?? null
  }

  /**
   * 桩里的**实测**矩形（工单187 真机轮补）。
   *
   * 为什么现在才有：card.js 的框选命中表原按 geometry.js 的算式「推」格子位置，真机上那份算式
   * 与真实网格外沿差着一段常数偏移（展开态内容区 `margin:0 auto` 居中 + 溢出滚动条），框选恒空，
   * 而这份桩当时只按同一套算式伪造点击点，**照单全收同一个错**，于是缺陷对它是隐形的。
   * 故补上这个方法，并让它按**真实布局**给数：卡框读内联 left/top，卡头与内容区按内边距/卡头高摆，
   * 内容区按 `margin:0 auto` 真居中，格子按格序在内容区内排开。折叠态下居中偏移恰为 0，
   * 展开态下不为 0——缺陷在两种形态上表现不同，正是它此前看不见的原因。
   */
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return rectOf(this)
  }

  /** 在桩里「已挂载」= 能沿 parent 链走到某个文档根 */
  get isConnected(): boolean {
    let n: Element | null = this
    while (n.parent) n = n.parent
    return n?.isRoot === true
  }

  appendChild(node: Element): Element {
    node.parent = this
    this.children.push(node)
    return node
  }

  append(...nodes: Element[]): void {
    for (const n of nodes) this.appendChild(n)
  }

  replaceChild(next: Element, old: Element): Element {
    const i = this.children.indexOf(old)
    if (i < 0) throw new Error('replaceChild：旧节点不在本节点内')
    next.parent = this
    this.children[i] = next
    old.parent = null
    return old
  }

  /** 就地顶替（真 DOM 的 Node.replaceWith）：新节点接管本节点在父节点里的槽位 */
  replaceWith(...nodes: Element[]): void {
    const p = this.parent
    if (!p) return
    const i = p.children.indexOf(this)
    if (i < 0) return
    for (const n of nodes) n.parent = p
    p.children.splice(i, 1, ...nodes)
    this.parent = null
  }

  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null
  }

  /**
   * 取焦点。真 DOM 上这一步要求窗口 focusable（面板默认 focusable:false，靠键盘档打开）——
   * 桩不做这层检查，故「档先持、focus 在后」的次序由 focusLog 的记录次序来钉，不靠桩模拟。
   */
  focus(): void {
    this.focused = true
    focusLog.push({ node: this, tag: this.tagName })
  }

  select(): void {
    this.selectionStart = 0
    this.selectionEnd = this.value.length
  }

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start
    this.selectionEnd = end
  }

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? []
    set.push(fn)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type)
    if (!set) return
    const i = set.indexOf(fn)
    if (i >= 0) set.splice(i, 1)
  }

  contains(node: Element | null): boolean {
    let n: Element | null = node
    while (n) {
      if (n === this) return true
      n = n.parent
    }
    return false
  }

  closest(selector: string): Element | null {
    let n: Element | null = this
    while (n) {
      if (matches(n, selector)) return n
      n = n.parent
    }
    return null
  }

  querySelectorAll(selector: string): Element[] {
    return walk(this).filter((n) => n !== this && matches(n, selector))
  }

  /** 真冒泡：自 target 起沿 parent 链上溯，`stopPropagation()` 即断链 */
  dispatch(type: string, target: Element = this, init: Partial<DomEvent> = {}): DomEvent {
    const ev: DomEvent = {
      type,
      target,
      clientX: 0,
      clientY: 0,
      stopped: false,
      stopPropagation() {
        this.stopped = true
      },
      preventDefault() { /* 桩不实现默认行为，只记录调用不报错 */ },
      ...init,
    }
    let n: Element | null = target
    while (n) {
      for (const fn of [...(n.listeners.get(type) ?? [])]) fn(ev)
      if (ev.stopped) break
      n = n.parent
    }
    return ev
  }
}

/** 深度优先列出子元素（含自身） */
export function walk(root: Element, out: Element[] = []): Element[] {
  out.push(root)
  for (const c of root.children) walk(c, out)
  return out
}

/** 事件目标（window / document 共用一份语义）：只记监听，不冒泡到别处去 */
export class EventTarget {
  listeners = new Map<string, Listener[]>()

  addEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type) ?? []
    set.push(fn)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, fn: Listener): void {
    const set = this.listeners.get(type)
    if (!set) return
    const i = set.indexOf(fn)
    if (i >= 0) set.splice(i, 1)
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0
  }

  dispatch(type: string, target: Element, init: Partial<DomEvent> = {}): DomEvent {
    const ev: DomEvent = {
      type,
      target,
      clientX: 0,
      clientY: 0,
      stopped: false,
      stopPropagation() {
        this.stopped = true
      },
      preventDefault() { /* 同上 */ },
      ...init,
    }
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev)
    return ev
  }
}

/** 一份全新的文档：head / body（含内核文档区）/ document 门面；顺带把焦点流水清零 */
export function newDom() {
  focusLog.length = 0
  const head = new Element('head')
  const body = new Element('body')
  head.isRoot = true
  body.isRoot = true
  const docZone = new Element('div', 'doc-zone')
  docZone.style.display = 'flex'
  body.appendChild(docZone)
  const documentShim = {
    head,
    body,
    createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => {
      if (!id) return null
      for (const r of [head, body]) for (const n of walk(r)) if (n.id === id) return n
      return null
    },
    /** 渲染层热区扫掠的**同一条**路径：document.querySelectorAll('.card') */
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  }
  return { documentShim, head, body, docZone }
}

// ---------------------------------------------------------------------------
// 桩里的布局：按**真实布局**给 getBoundingClientRect() 的数（工单187 真机轮补）
//
// 只有卡片子树需要——card.js 只有框选那一处在运行时量矩形，且量的都是卡框/内容区/格子。
// 数字全部取自 geometry.js（单一出处）：卡框两行读内联样式（card.js 按 rowLayoutOf 写的），
// 其余按内边距、卡头高、列数、格边长与间距摆。**内容区按 `margin:0 auto` 真居中**：
// 折叠态内容区与内边距盒等宽（偏移 0），展开态窄一截（偏移非 0）——这正是真机上
// 「算式外沿 ≠ 实测外沿」的那个常数，也正是这份桩当年照抄同一套算式而看不见缺陷的原因。
// ---------------------------------------------------------------------------

function px(style: Record<string, string>, key: string): number {
  const v = Number.parseFloat(style[key] ?? '')
  return Number.isFinite(v) ? v : 0
}

function rectOf(node: Element): { left: number; top: number; width: number; height: number } {
  const card = cardAncestorOf(node)
  if (!card) return { left: 0, top: 0, width: 0, height: 0 }
  const box = { left: px(card.style, 'left'), top: px(card.style, 'top') }
  const expanded = card.classList.contains('dgc-expanded')
  const geo = cardGeometryOf(expanded)
  // 淡出态卡框塌成 0×0（card.js 的 `.dgc-faded` 规则）——照抄那份 !important 的效果：
  // 内联的 width/height 仍在，但被样式表压成 0。热区那侧滤掉的就是这个零尺寸
  // （src/renderer/main.ts:1575 那条 r.w > 0 && r.h > 0），故淡出的卡不进热区。
  const faded = card.classList.contains('dgc-faded')
  const width = faded ? 0 : px(card.style, 'width') || geo.width
  const height = faded ? 0 : px(card.style, 'height') || geo.height
  if (node === card) return { left: box.left, top: box.top, width, height }
  // 内容区（网格外沿）：卡框内边距盒减去卡头一行；宽度按真布局居中。
  // 淡出态卡框已是 0×0，内容区改由 `.dgc-faded .dgc-grid` 的 position:absolute 摆位
  // （left=CARD_PAD_X / top=CARD_PAD_Y+HEAD_H，居中偏移归零）——与上面那两个偏移一致。
  const innerWidth = faded ? geo.contentWidth : width - 2 * CARD_PAD_X
  const gridWidth = geo.contentWidth
  const grid = { left: box.left + CARD_PAD_X + (innerWidth - gridWidth) / 2, top: box.top + CARD_PAD_Y + HEAD_H, width: gridWidth, height: geo.contentHeight }
  if (node === gridElementOf(card)) return grid
  // 格子：在内容区里按格序（只数 .dgc-cell，拖拽带不是格子）
  const cells = gridElementOf(card)!.children.filter((c) => c.classList.contains('dgc-cell'))
  const i = cells.indexOf(node)
  if (i < 0) return { left: grid.left, top: grid.top, width: 0, height: 0 }
  const cell = cellRectOf(i, expanded)
  return { left: grid.left + cell.x, top: grid.top + cell.y, width: cell.width, height: cell.height }
}

function cardAncestorOf(node: Element): Element | null {
  let n: Element | null = node
  while (n) {
    if (n.classList.contains('card')) return n
    n = n.parent
  }
  return null
}

function gridElementOf(card: Element): Element | null {
  return card.children.find((c) => c.classList.contains('dgc-grid')) ?? null
}
