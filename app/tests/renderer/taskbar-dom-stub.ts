/**
 * 条带渲染入口的**最小 DOM 桩**（工单249）。
 *
 * 为什么自带桩而不上 jsdom：本仓库没装 jsdom/happy-dom（package.json 里没有，也不为
 * 一条测试加依赖）——与 tests/plugins/doc-group-cards-dom-shim.ts 同款理由。
 *
 * 这份桩只实现 app/src/renderer/taskbar.ts 真正用到的那几个面：getElementById /
 * createElement / classList / style / dataset / querySelector(All) / appendChild /
 * textContent / getBoundingClientRect / offsetWidth / animate / addEventListener。
 * 它证明的不是「DOM 怎么工作」（那是规范，这里只做最小近似），而是**渲染入口的接线**：
 * 档位循环后 .summon-popped 残态是否被抹掉、唤出条几何存证帧是否再发一帧。
 *
 * 桩里的矩形按**真实布局**给数（组 pill 的横向区间与 taskbar-view 的口径同形）：
 * 收栏前缓存的 pill 矩形是唤出条几何的来源，桩给不出数就整条唤出条链路无从测。
 */
import type { TaskbarState } from '../../src/shared/contract'

export type StubEvent = {
  type: string
  target: StubElement
  clientX: number
  clientY: number
  stopPropagation(): void
  preventDefault(): void
}

export type Listener = (ev: StubEvent) => void

/**
 * 桩里的实测矩形（DOMRect 同款：x/y/width/height + left/right/top/bottom）。
 * 挤撞守卫读的是 .left/.right（工单158 口径）——只给 x/width 会让守卫算成 NaN、
 * 整道守卫静默失效，故两套字段同源给出。
 */
export interface StubRect {
  x: number
  y: number
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

/** 组 pill 的桩内矩形（x/宽 与 taskbar.html 的落位口径同形；条带窗通栏 1920×48） */
const RECTS: Record<string, { x: number; y: number; w: number; h: number }> = {
  'pill-start': { x: 8, y: 0, w: 120, h: 48 },
  'pill-recs': { x: 136, y: 0, w: 200, h: 48 },
  'pill-apps': { x: 344, y: 0, w: 300, h: 48 },
  'right-pill': { x: 1600, y: 0, w: 280, h: 48 },
  'show-desktop': { x: 1912, y: 0, w: 8, h: 48 },
  'summon-strips': { x: 0, y: 39, w: 1920, h: 9 },
}

/** 组 pill 的宿主 id（收栏态栏面退场的就是这五个——taskbar.html 的 CSS 口径） */
const GROUP_PILL_IDS = new Set(['pill-start', 'pill-recs', 'pill-apps', 'right-pill', 'show-desktop'])

/** 只认本仓实际用到的选择器形态：tag / .class / #id / [attr] / [attr="v"] / 组合与后代 */
function readAttr(el: StubElement, name: string): string | undefined {
  // 真 DOM 的 dataset 是属性面的一个视图：dataset.group ⇔ 属性 data-group
  if (name in el.attrs) return el.attrs[name]
  if (name in el.dataset) return el.dataset[name]
  if (name.startsWith('data-')) {
    const key = name.slice(5)
    if (key in el.dataset) return el.dataset[key]
  }
  return undefined
}

function hasAttr(el: StubElement, name: string): boolean {
  return readAttr(el, name) !== undefined
}

function matchesCompound(el: StubElement, compound: string): boolean {
  const re = /(\[[^\]]+\])|([.#]?[\w-]+)/g
  let m: RegExpExecArray | null
  let matched = false
  while ((m = re.exec(compound)) !== null) {
    matched = true
    const attr = m[1]
    if (attr) {
      const body = attr.slice(1, -1)
      const eq = body.indexOf('=')
      if (eq < 0) {
        if (!hasAttr(el, body)) return false
      } else {
        const name = body.slice(0, eq)
        const want = body.slice(eq + 1).replace(/^["']|["']$/g, '')
        if (readAttr(el, name) !== want) return false
      }
      continue
    }
    const simple = m[2]
    if (simple.startsWith('.')) {
      if (!el.classList.contains(simple.slice(1))) return false
    } else if (simple.startsWith('#')) {
      if (el.id !== simple.slice(1)) return false
    } else if (el.tagName.toLowerCase() !== simple.toLowerCase()) {
      return false
    }
  }
  return matched
}

function matchesSelector(el: StubElement, selector: string): boolean {
  const parts = selector.trim().split(/\s+/)
  let idx = parts.length - 1
  if (!matchesCompound(el, parts[idx])) return false
  idx--
  let node: StubElement | null = el.parent
  while (idx >= 0) {
    if (!node) return false
    if (matchesCompound(node, parts[idx])) idx--
    node = node.parent
  }
  return true
}

/** 深度优先列出子元素（含自身） */
function walk(root: StubElement, out: StubElement[] = []): StubElement[] {
  out.push(root)
  for (const c of root.children) walk(c, out)
  return out
}

export class StubElement {
  parent: StubElement | null = null
  children: StubElement[] = []
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  attrs: Record<string, string> = {}
  id = ''
  title = ''
  alt = ''
  src = ''
  hidden = false
  draggable = false
  className = ''
  tagName: string
  /** 所属文档的 body（收栏态栏面退场的判据来源：body[data-bar-mode]，真 DOM 同款） */
  body: StubElement | null = null
  private text = ''
  private rect = { x: 0, y: 0, w: 0, h: 0 }
  private listeners = new Map<string, Listener[]>()

  constructor(tagName = 'div') {
    this.tagName = tagName
  }

  get textContent(): string {
    return this.text
  }

  set textContent(v: string) {
    this.text = v
    this.children = [] // 真 DOM：写 textContent 即清子节点
  }

  get offsetWidth(): number {
    return this.effectiveWidth()
  }

  get classList() {
    const list = () => this.className.split(/\s+/).filter(Boolean)
    const self = this
    return {
      contains: (c: string) => list().includes(c),
      add: (...cs: string[]) => {
        const now = list()
        for (const c of cs) if (!now.includes(c)) now.push(c)
        self.className = now.join(' ')
      },
      remove: (...cs: string[]) => {
        self.className = list().filter((c) => !cs.includes(c)).join(' ')
      },
      toggle: (c: string, force?: boolean) => {
        const has = list().includes(c)
        const want = force === undefined ? !has : !!force
        if (want !== has) {
          if (want) self.classList.add(c)
          else self.classList.remove(c)
        }
        return want
      },
    }
  }

  /**
   * 栏面退场（真 DOM 同款，工单243 取证口径）：收栏态（body[data-bar-mode="maximize-retract"]）
   * 下**未唤出**的组 pill 是 display:none ⇒ 实测矩形全零（宽 0）——这正是工单253 缺陷一的
   * 机制：挤撞守卫量到的邻组宽度是 0，把已唤出的组按 0 宽裁剪。被唤出的组（带
   * .summon-popped）复现，矩形照旧。让位态（fullscreen-yield）整窗隐藏 ⇒ 一切元素零矩形。
   */
  withdrawn(): boolean {
    const mode = this.body?.dataset.barMode
    // 让位态：整窗退场（隐藏）——窗内一切元素实测矩形全零
    if (mode === 'fullscreen-yield') return true
    if (mode !== 'maximize-retract') return false
    if (!GROUP_PILL_IDS.has(this.id)) return false
    return !this.classList.contains('summon-popped')
  }

  /** 桩里的实测宽度：退场组为 0；其余受 max-width 收窄（挤撞守卫只动 maxWidth） */
  private effectiveWidth(): number {
    if (this.withdrawn()) return 0
    if (this.parent?.withdrawn()) return 0
    let w = this.rect.w
    const max = this.style.maxWidth
    if (max && max.endsWith('px')) {
      const limit = Number.parseFloat(max)
      if (Number.isFinite(limit)) w = Math.min(w, limit)
    }
    return w
  }

  /** 桩里的实测矩形（按 id 给真布局数；动态节点给默认格位） */
  getBoundingClientRect(): StubRect {
    const w = this.effectiveWidth()
    if (w <= 0) return { x: 0, y: 0, width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 }
    const h = this.rect.h
    return {
      x: this.rect.x,
      y: this.rect.y,
      width: w,
      height: h,
      // DOMRect 同款：left/right/top/bottom 与 x/y/width/height 同源（挤撞守卫读的是 .left/.right）
      left: this.rect.x,
      right: this.rect.x + w,
      top: this.rect.y,
      bottom: this.rect.y + h,
    }
  }

  setRect(rect: { x: number; y: number; w: number; h: number }): void {
    this.rect = { ...rect }
  }

  appendChild(node: StubElement): StubElement {
    node.parent = this
    this.children.push(node)
    return node
  }

  remove(): void {
    const p = this.parent
    if (!p) return
    const i = p.children.indexOf(this)
    if (i >= 0) p.children.splice(i, 1)
    this.parent = null
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = value
  }

  getAttribute(name: string): string | null {
    return name in this.attrs ? this.attrs[name] : null
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

  /** 派发事件（真冒泡：自 target 沿 parent 链上溯） */
  dispatch(type: string, init: Partial<StubEvent> = {}): StubEvent {
    const ev: StubEvent = {
      type,
      target: this,
      clientX: 0,
      clientY: 0,
      stopPropagation() { /* 桩不实现冒泡截断 */ },
      preventDefault() { /* 桩不实现默认行为 */ },
      ...init,
    }
    let n: StubElement | null = this
    while (n) {
      for (const fn of [...(n.listeners.get(type) ?? [])]) fn(ev)
      n = n.parent
    }
    return ev
  }

  /** Web Animations API 桩：渲染层的上滑淡入走这条通路（真 DOM 才有 animate） */
  animate(_keyframes: unknown, _options?: unknown): { cancel(): void; finish(): void } {
    return { cancel: () => {}, finish: () => {} }
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector)
  }

  closest(selector: string): StubElement | null {
    let n: StubElement | null = this
    while (n) {
      if (matchesSelector(n, selector)) return n
      n = n.parent
    }
    return null
  }

  querySelectorAll(selector: string): StubElement[] {
    return walk(this).filter((n) => n !== this && matchesSelector(n, selector))
  }

  querySelector(selector: string): StubElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }
}

/** 渲染入口用到的六个宿主元素（id 与 taskbar.html 一致） */
const HOST_IDS = ['pill-start', 'pill-recs', 'pill-apps', 'right-pill', 'show-desktop', 'summon-strips']

export interface TaskbarDomStub {
  /** 宿主元素（按 id 取） */
  element(id: string): StubElement
  /** 唤出条元素（按组取；不存在即 null——该组不在场时不出条） */
  stripFor(group: string): StubElement | null
  /** 存证事件流水（按名筛） */
  notifyCalls(name: string): unknown[]
  /** 存证事件计数（按名） */
  notifyCount(name: string): number
  /** 热区声明流水 */
  hotZones(): unknown[]
  /** 派发桥接事件（taskbar/bar-mode 等） */
  emit(event: string, payload: unknown): void
  /** 面板就绪（taskbar-ready 存证落地即就绪——bar-mode 订阅在其之前登记） */
  whenReady(): Promise<void>
  /** 还原全局（document / window / HTMLElement） */
  cleanup(): void
}

/**
 * 装一份 DOM 桩到全局（供渲染入口 import 时取用）。
 *
 * @param options.state 面板启动时的 taskbar/get-state 回执（渲染入口 boot 即用它渲染）
 */
export function installTaskbarDomStub(options: { state: TaskbarState }): TaskbarDomStub {
  const elements = new Map<string, StubElement>()
  for (const id of HOST_IDS) {
    const el = new StubElement('div')
    el.id = id
    el.setRect(RECTS[id] ?? { x: 0, y: 0, w: 36, h: 48 })
    elements.set(id, el)
  }

  const body = new StubElement('body')
  for (const el of elements.values()) el.body = body
  const notifies: Array<{ name: string; payload: unknown }> = []
  const zones: unknown[] = []
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  let readyResolve: () => void = () => {}
  const ready = new Promise<void>((r) => { readyResolve = r })

  const doc = {
    body,
    createElement: (tag: string) => {
      const el = new StubElement(tag)
      el.body = body
      return el
    },
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: () => { /* 渲染入口在 document 上挂的监听不参与本桩的断言 */ },
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  }

  const win = {
    innerWidth: 1920,
    innerHeight: 1080,
    deck: {
      host: {
        notify: (name: string, payload: unknown) => {
          notifies.push({ name, payload })
          if (name === 'taskbar-ready') readyResolve()
        },
        setHotZones: (z: unknown) => { zones.push(z) },
      },
      bridge: {
        invoke: async (method: string, _payload: unknown) => {
          if (method === 'taskbar/get-state') return options.state
          return { ok: true }
        },
        on: (event: string, listener: (payload: unknown) => void) => {
          const arr = listeners.get(event) ?? []
          arr.push(listener)
          listeners.set(event, arr)
          return () => { /* 退订不实现——桩内无退订场景 */ }
        },
      },
    },
    addEventListener: () => { /* resize 不参与本桩的断言 */ },
  }

  const g = globalThis as unknown as Record<string, unknown>
  const saved = { document: g.document, window: g.window, HTMLElement: g.HTMLElement }
  g.document = doc
  g.window = win
  g.HTMLElement = StubElement

  return {
    element: (id: string) => {
      const el = elements.get(id)
      if (!el) throw new Error(`桩里没有宿主元素：${id}`)
      return el
    },
    stripFor: (group: string) => elements.get('summon-strips')!.querySelector(`.tb-summon-strip[data-group="${group}"]`),
    notifyCalls: (name: string) => notifies.filter((n) => n.name === name).map((n) => n.payload),
    notifyCount: (name: string) => notifies.filter((n) => n.name === name).length,
    hotZones: () => zones.slice(),
    emit: (event: string, payload: unknown) => {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(payload)
    },
    whenReady: () => ready,
    cleanup: () => {
      g.document = saved.document
      g.window = saved.window
      g.HTMLElement = saved.HTMLElement
    },
  }
}
