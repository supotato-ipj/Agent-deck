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
import {
  CONFIRM_BORDER,
  CONFIRM_BTN_H,
  CONFIRM_BOX_ID,
  CONFIRM_CANCEL_ID,
  CONFIRM_GAP_Y,
  CONFIRM_LINE_H,
  CONFIRM_OK_ID,
  CONFIRM_PAD_X,
  CONFIRM_PAD_Y,
  CONFIRM_TEXT_ID,
  CONFIRM_W,
} from '../../plugins/doc-group-cards/writeops'
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

  /**
   * 内容高度（可滚动内容的全文高）与可见高度（工单362：文案区超高时「只有文案区可滚动」
   * 就是靠这两个数说的——scrollHeight > clientHeight 即文案溢出、按钮区一寸不让）。
   */
  get scrollHeight(): number {
    return scrollHeightOf(this)
  }

  get clientHeight(): number {
    return clientHeightOf(this)
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
  // 确认层子树**先**按它自己的排版算（工单362）：遮罩也是 class='card'，若落到下面那条
  // 卡片分支里，确认层的矩形会被当成卡框算——那正是当年「算式与实排不一致」的藏身处。
  const dialog = confirmDialogOf(node)
  if (dialog) return confirmRectOf(dialog, node)
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

// ---------------------------------------------------------------------------
// 桩里的布局：确认层（工单362）
//
// 确认层的排版真相只在 **DOM** 里：长文件名会**换行**、两枚按钮**各占一行**堆叠、文案区
// 超高时**只有文案区**滚动。桩按这套真实排版给 getBoundingClientRect() 的数（与卡片子树那份
// 同款理由，工单187 先例：桩不按实现的算式给数，才照得出「算式与实排不一致」）。
//
// **这份模型只认排版结构，不认实现的算式**：折行、按钮堆叠、限高后的可见高度，都是这里
// 独立算的；实现若拿「每件文件名一行」去估高度（工单362 的病灶：盒子只按一枚按钮算高、
// 文件名换行不计入），这里立刻照出第二枚按钮被裁在盒外。
//
// 数字全部取自 writeops.js（单一出处）：宽度 / 边框 / 内边距 / 间距 / 按钮高 / 行高——那几个数
// 同时也是 CONFIRM_CSS 里插值用的同一批，故桩与画法不会各说一套。
// ---------------------------------------------------------------------------

/** 桩里 11px 等宽字体的近似字宽：ASCII 半角、CJK 全角 */
const CONFIRM_ASCII_W = 6.6
const CONFIRM_CJK_W = 11

/** 一个字符的宽（像素）：CJK 视为全角，其余半角 */
function charWidthOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  return cp >= 0x2e80 ? CONFIRM_CJK_W : CONFIRM_ASCII_W
}

/**
 * 文案在给定内容宽度下折成几行（white-space: pre-wrap：硬换行 + 按宽度折行）。
 * 桩按**字符**累加宽度——中文逐字可断，英文按字断（比浏览器粗，但确定且可复现）。
 */
export function confirmLinesOfText(text: string, contentWidth: number): number {
  let lines = 0
  for (const seg of text.split('\n')) {
    lines += 1
    let w = 0
    for (const ch of seg) {
      const cw = charWidthOf(ch)
      if (w + cw > contentWidth) {
        lines += 1
        w = cw
      } else {
        w += cw
      }
    }
  }
  return lines
}

/** 对话框的内容宽度（去掉边框与左右内边距） */
function confirmContentWidth(dialogWidth: number): number {
  return dialogWidth - 2 * CONFIRM_BORDER - 2 * CONFIRM_PAD_X
}

/** 确认层对话框（id 是排版的锚，class 另有一份作用域根） */
function confirmDialogOf(node: Element): Element | null {
  let n: Element | null = node
  while (n) {
    if (n.id === CONFIRM_BOX_ID) return n
    n = n.parent
  }
  return null
}

/** 按 id 在一个节点的孩子里找（确认层的三个内件都是对话框的直接孩子） */
function childById(parent: Element, id: string): Element | null {
  return parent.children.find((c) => c.id === id) ?? null
}

/**
 * 确认层子树的矩形：文案按宽度折行、两枚按钮各占一行堆叠、文案区被限高时可见高度=限高。
 */
function confirmRectOf(dialog: Element, node: Element): { left: number; top: number; width: number; height: number } {
  const left = px(dialog.style, 'left')
  const top = px(dialog.style, 'top')
  const width = px(dialog.style, 'width') || CONFIRM_W
  const height = px(dialog.style, 'height')
  const contentWidth = confirmContentWidth(width)
  const contentLeft = left + CONFIRM_BORDER + CONFIRM_PAD_X
  const contentTop = top + CONFIRM_BORDER + CONFIRM_PAD_Y

  const text = childById(dialog, CONFIRM_TEXT_ID)
  const natural = text ? confirmLinesOfText(text.textContent, contentWidth) * CONFIRM_LINE_H : 0
  const textHeight = text ? px(text.style, 'height') || natural : 0
  const textRect = { left: contentLeft, top: contentTop, width: contentWidth, height: textHeight }
  if (node === text) return textRect

  const ok = childById(dialog, CONFIRM_OK_ID)
  const okRect = { left: contentLeft, top: contentTop + textHeight + CONFIRM_GAP_Y, width: contentWidth, height: CONFIRM_BTN_H }
  if (node === ok) return okRect

  const cancel = childById(dialog, CONFIRM_CANCEL_ID)
  const cancelRect = { left: contentLeft, top: okRect.top + CONFIRM_BTN_H + CONFIRM_GAP_Y, width: contentWidth, height: CONFIRM_BTN_H }
  if (node === cancel) return cancelRect

  return { left, top, width, height }
}

/** 文案区的自然高度（折行后的全文高；超高时可见高度被截断，自然高度不变） */
function scrollHeightOf(node: Element): number {
  const dialog = confirmDialogOf(node)
  if (!dialog || node.id !== CONFIRM_TEXT_ID) return 0
  const width = px(dialog.style, 'width') || CONFIRM_W
  return confirmLinesOfText(node.textContent, confirmContentWidth(width)) * CONFIRM_LINE_H
}

/** 文案区的可见高度（被显式限高时就是那个限高） */
function clientHeightOf(node: Element): number {
  const dialog = confirmDialogOf(node)
  if (!dialog || node.id !== CONFIRM_TEXT_ID) return 0
  return px(node.style, 'height') || scrollHeightOf(node)
}

/** 确认层此刻的**最终布局**：对话框、文案区与两枚按钮的真实矩形 + 文案折行情况 */
export type ConfirmLayout = {
  dialog: { left: number; top: number; width: number; height: number }
  text: { left: number; top: number; width: number; height: number }
  ok: { left: number; top: number; width: number; height: number }
  cancel: { left: number; top: number; width: number; height: number }
  /** 文案折成几行（桩的换行模型） */
  lines: number
  /** 文案区可见高度 / 自然高度（后者 > 前者即「文案区可滚动」） */
  clientHeight: number
  scrollHeight: number
}

/**
 * 取确认层此刻的最终布局（对话框不在场即 null）。
 * @param doc 能按 id 取节点的文档门面（桩里是 documentShim）
 */
export function confirmLayoutOf(doc: { getElementById: (id: string) => Element | null }): ConfirmLayout | null {
  const dialog = doc.getElementById(CONFIRM_BOX_ID)
  if (!dialog) return null
  const text = childById(dialog, CONFIRM_TEXT_ID)
  const ok = childById(dialog, CONFIRM_OK_ID)
  const cancel = childById(dialog, CONFIRM_CANCEL_ID)
  if (!text || !ok || !cancel) return null
  const width = px(dialog.style, 'width') || CONFIRM_W
  return {
    dialog: confirmRectOf(dialog, dialog),
    text: confirmRectOf(dialog, text),
    ok: confirmRectOf(dialog, ok),
    cancel: confirmRectOf(dialog, cancel),
    lines: confirmLinesOfText(text.textContent, confirmContentWidth(width)),
    clientHeight: clientHeightOf(text),
    scrollHeight: scrollHeightOf(text),
  }
}
