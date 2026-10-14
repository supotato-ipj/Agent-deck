/**
 * 组卡交互与生命周期的接线（工单181 = spec166 之④）。
 *
 * 上一份测试（doc-group-cards-interaction.spec.ts）钉的是**裁决**：点哪儿、要不要截冒泡、
 * 状态怎么迁移。本份钉的是**接线**：那些裁决在 card.js 里真的落到 DOM 上了吗？
 *   - 图标那格点了，卡片那侧到底收没收到这次点击（不冒泡）；
 *   - 点空白折叠切换、点空白清高亮；
 *   - 卸载后插在文档头的样式元素与任何遮罩无残留；
 *   - 热重载（换代重挂）后不留旧状态、id 仍唯一。
 *
 * 为什么自带一个极简 DOM 桩而不上 jsdom：本仓库没装 jsdom/happy-dom（package.json 里没有，
 * 且不为一条测试加依赖），渲染层的既有测试一律是纯逻辑（tests/renderer/*）。故这里手写一个
 * 只实现 card.js 真实用到的那几个面的桩——createElement / append / classList / closest /
 * addEventListener + **真冒泡**（沿 parent 链上溯，stopPropagation 即断链）。
 * 桩证明的不是「DOM 怎么冒泡」（那是规范，本桩只做最小近似），而是
 * **card.js 把监听挂在哪、有没有截断、卸载摘了哪些节点**。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { CARD_CLASS, CELL_CLASS, EXPANDED_CLASS, HIGHLIGHT_CLASS } from '../../plugins/doc-group-cards/interaction'
import plugin, { STYLE_ID, type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'

// ---------------------------------------------------------------------------
// 极简 DOM 桩
// ---------------------------------------------------------------------------

type Listener = (ev: DomEvent) => void

type DomEvent = { type: string; target: Element; stopped: boolean; stopPropagation(): void }

/** 只认 class 选择器的 `closest`（card.js 只用 `.dgc-cell` / `.dgc-more` 这类） */
function matches(node: Element, selector: string): boolean {
  return selector.startsWith('.') && node.classList.contains(selector.slice(1))
}

class Element {
  parent: Element | null = null
  children: Element[] = []
  listeners = new Map<string, Listener[]>()
  style: Record<string, string> = {}
  dataset: Record<string, string> = {}
  /** 文档根标记：document.head 与宿主容器顶层各一 */
  isRoot = false

  constructor(public tagName: string, public id = '', public textContent = '') {}

  set className(v: string) {
    this._className = v
  }

  get className(): string {
    return this._className ?? ''
  }

  private _className = ''

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

  remove(): void {
    if (!this.parent) return
    const i = this.parent.children.indexOf(this)
    if (i >= 0) this.parent.children.splice(i, 1)
    this.parent = null
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

  contains(node: Element): boolean {
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

  /** 只认 class 选择器（card.js 的 `querySelectorAll` 只用于 `.dgc-cell` 这类） */
  querySelectorAll(selector: string): Element[] {
    return walk(this).filter((n) => n !== this && matches(n, selector))
  }

  /** 真冒泡：自 target 起沿 parent 链上溯，`stopPropagation()` 即断链 */
  dispatch(type: string, target: Element = this): DomEvent {
    const ev: DomEvent = { type, target, stopped: false, stopPropagation() { this.stopped = true } }
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
function walk(root: Element, out: Element[] = []): Element[] {
  out.push(root)
  for (const c of root.children) walk(c, out)
  return out
}

function newDom() {
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
  }
  return { documentShim, head, body, docZone }
}

// ---------------------------------------------------------------------------
// 宿主桩
// ---------------------------------------------------------------------------

/**
 * 三个文件、两个扩展组 → 两张卡，且第一张卡（.docx）里有两格，
 * 「点第一格/点第二格」与「两张卡各一个 id」两处断言都落在同一份数据上。
 */
const ITEMS: HostDesktopItem[] = [
  { name: '方案.docx', kind: 'file', path: 'C:\\me\\方案.docx', iconKey: 'k1' },
  { name: '纪要.docx', kind: 'file', path: 'C:\\me\\纪要.docx', iconKey: 'k2' },
  { name: '预算.pdf', kind: 'file', path: 'C:\\me\\预算.pdf', iconKey: 'k3' },
]

/** 按 capabilities 裁剪过的快照视图：插件只声明 desktop，故只有这一段（card.js 只读 items） */
function viewWith(items: HostDesktopItem[]): HostView {
  return { desktop: { items } }
}

let dom: ReturnType<typeof newDom>
let h: { host: Host; container: Element; domChanges: number[] }

beforeEach(() => {
  // window 是无所谓的公共桩，先摆好；document 此刻还是**上一次**那份——卸载认的是它。
  ;(globalThis as unknown as Record<string, unknown>).window = {
    innerWidth: 2560, innerHeight: 1440, addEventListener: () => {}, removeEventListener: () => {},
  }
  // 每条用例换一份全新的文档与宿主，但 card.js 是**同一个模块实例**（同一 URL import 一次）。
  // 宿主契约是「重挂必先卸载」（plugins.ts syncPlugins 的换代表路径），故这里先卸载把上一条
  // 留下的模块级状态清干净——否则新文档里一张卡都不会被画出来。顺带也钉住了「卸载后不留旧状态」。
  plugin.unmount?.()
  dom = newDom()
  const container = new Element('div', 'deck-plugin')
  dom.body.appendChild(container)
  const domChanges: number[] = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const stub = {
    el: container,
    view: viewWith(ITEMS),
    util: {},
    notify: (type: string, payload?: Record<string, unknown>) => { notes.push({ type, payload }) },
    invoke: () => Promise.resolve({ dataUrl: null }),
    on: () => () => {},
    holdKeyboardTier: () => {},
    releaseKeyboardTier: () => {},
    onDomChanged: () => { domChanges.push(1) },
  }
  // 桩里的 el 是自造的 Element 而非 HTMLElement，整体过一道断言；插件真正用到的是
  // card.d.ts 自述的那几个成员（el / view / invoke / notify / onDomChanged）。
  h = { container, domChanges, host: stub as unknown as Host }
  ;(globalThis as unknown as Record<string, unknown>).document = dom.documentShim
})

/** 文档里现存的全部组卡（带卡片根类名） */
function cards(): Element[] {
  return walk(dom.body).filter((n) => n.classList.contains(CARD_CLASS))
}

function cellsOf(card: Element): Element[] {
  return walk(card).filter((n) => n.classList.contains(CELL_CLASS))
}

/** 卡片标题行——卡片上唯一「空白处」的实体（card.append(head, grid) 的第一个孩子） */
function headOf(card: Element): Element {
  return card.children[0]
}

function classesOf(node: Element): string[] {
  return node.className.split(/\s+/).filter(Boolean)
}

// ---------------------------------------------------------------------------

describe('组卡交互接线（工单181：点空白展开收起、点图标高亮）', () => {
  it('点图标：高亮该格，且这次点击**没有**到达卡片（不冒泡，卡片形状不变）', () => {
    plugin.mount(h.host)
    const card = cards()[0]
    const cell = cellsOf(card)[0]

    // 观察者：卡片上多挂一个计数监听器。若图标点击真的冒泡上来，这里会 +1。
    let reachedCard = 0
    card.addEventListener('click', () => { reachedCard += 1 })

    cell.dispatch('click')

    expect(reachedCard).toBe(0)
    expect(classesOf(cell)).toContain(HIGHLIGHT_CLASS)
    expect(classesOf(card)).not.toContain(EXPANDED_CLASS)
    expect(card.style.height).toBe('244px') // 形状纹丝不动
  })

  it('点第二格：高亮跟着走，且仍不碰卡片', () => {
    plugin.mount(h.host)
    const card = cards()[0]
    const [a, b] = cellsOf(card)

    a.dispatch('click')
    b.dispatch('click')

    expect(classesOf(a)).not.toContain(HIGHLIGHT_CLASS)
    expect(classesOf(b)).toContain(HIGHLIGHT_CLASS)
    expect(classesOf(card)).not.toContain(EXPANDED_CLASS)
  })

  it('点空白：折叠态→展开态；再点空白→收起（往复切换）', () => {
    plugin.mount(h.host)
    const card = cards()[0]

    headOf(card).dispatch('click')
    expect(classesOf(card)).toContain(EXPANDED_CLASS)
    headOf(card).dispatch('click')
    expect(classesOf(card)).not.toContain(EXPANDED_CLASS)
  })

  it('点空白清高亮：先点图标、再点空白，高亮消失而卡片已展开', () => {
    plugin.mount(h.host)
    const card = cards()[0]
    const cell = cellsOf(card)[0]

    cell.dispatch('click')
    expect(classesOf(cell)).toContain(HIGHLIGHT_CLASS)

    headOf(card).dispatch('click')
    expect(classesOf(cell)).not.toContain(HIGHLIGHT_CLASS)
    expect(classesOf(card)).toContain(EXPANDED_CLASS)
  })

  it('折叠切换后重新申报热区（工单181 的热区纪律：动了什么都要让渲染层重扫）', () => {
    plugin.mount(h.host)
    const before = h.domChanges.length
    headOf(cards()[0]).dispatch('click')
    expect(h.domChanges.length).toBeGreaterThan(before)
  })

  it('点图标不申报热区（高亮只改类名不改布局盒，热区矩形不变，不必惊动渲染层）', () => {
    plugin.mount(h.host)
    const before = h.domChanges.length
    cellsOf(cards()[0])[0].dispatch('click')
    expect(h.domChanges.length).toBe(before)
  })
})

describe('每张组卡的 id 唯一（工单181：热区扫掠对重复 id 不去重）', () => {
  it('文档里每张组卡一个 id，且落在本插件命名空间里', () => {
    plugin.mount(h.host)
    const ids = cards().map((c) => c.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('dgc-'))).toBe(true)
  })

  it('折叠/展开与高亮都不改 id（id 是热区身份，不能被交互改写）', () => {
    plugin.mount(h.host)
    const card = cards()[0]
    const id = card.id
    cellsOf(card)[0].dispatch('click')
    headOf(card).dispatch('click')
    expect(card.id).toBe(id)
  })
})

describe('生命周期纪律（工单181：卸载自清、换代不留旧状态）', () => {
  it('卸载后：插在文档头的样式元素无残留、组卡无残留、遮罩无残留', () => {
    plugin.mount(h.host)
    expect(dom.documentShim.getElementById(STYLE_ID)).not.toBeNull()
    expect(cards().length).toBeGreaterThan(0)

    plugin.unmount?.()

    expect(dom.documentShim.getElementById(STYLE_ID)).toBeNull()
    expect(cards()).toEqual([])
    // 本票不造遮罩；凡是本插件插到宿主管之外的节点，卸载后一个都不许剩
    expect(dom.head.children).toEqual([])
  })

  it('注入的样式表每一条规则都挂在真实祖先上（作用域根是卡片根类名）', () => {
    plugin.mount(h.host)
    // 注释不影响 CSS 匹配，先剥掉再逐条看（注释里正好引用了那两种错误写法）
    const sheet = (dom.documentShim.getElementById(STYLE_ID)?.textContent ?? '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
    const selectors = sheet
      .split('}')
      .map((block) => block.split('{')[0].trim())
      .filter(Boolean)

    expect(selectors.length).toBeGreaterThan(5)
    for (const sel of selectors) {
      // 作用域根 = 选择器的头一段复合选择器，必须是卡片根类名
      expect(sel.split(' ')[0]).toBe(`.${CARD_CLASS}`)
    }
    // 反面钉死：作用域根若写成样式元素自己的 id（`#dgc-style .dgc-cell`），选的是
    // 「#dgc-style 元素的**后代**里的 .dgc-cell」，而 <style> 在 DOM 树里没有任何后代——
    // 整表规则一条都不会命中，样式（含本票的高亮与指针）全是哑的。
    expect(sheet).not.toContain(`#${STYLE_ID}`)
  })

  it('卸载把内核文档区原样还回去（工单179 起的纪律不能被本票弄丢）', () => {
    plugin.mount(h.host)
    expect(dom.docZone.style.display).toBe('none')
    plugin.unmount?.()
    expect(dom.docZone.style.display).toBe('flex')
  })

  it('卸载重复调不抛、也不多摘（幂等）', () => {
    plugin.mount(h.host)
    plugin.unmount?.()
    expect(() => plugin.unmount?.()).not.toThrow()
    expect(dom.head.children).toEqual([])
    expect(cards()).toEqual([])
  })

  it('热重载换代重挂：旧代的展开态与高亮都不留，新代从头收起', () => {
    // 第一代：展开一张卡并高亮一个格子
    plugin.mount(h.host)
    const gen1 = cards()[0]
    cellsOf(gen1)[0].dispatch('click')
    headOf(gen1).dispatch('click')
    expect(classesOf(gen1)).toContain(EXPANDED_CLASS)

    // 换代：宿主先 unmount 旧代再装新代（plugins.ts syncPlugins 的换代表路径）
    plugin.unmount?.()
    plugin.mount(h.host)

    const gen2 = cards()
    expect(gen2).toHaveLength(2)
    expect(gen2.some((c) => classesOf(c).includes(EXPANDED_CLASS))).toBe(false)
    expect(walk(dom.body).some((n) => classesOf(n).includes(HIGHLIGHT_CLASS))).toBe(false)
    // 样式元素仍只有一枚（换代不叠加）、id 仍唯一
    expect(dom.head.children).toHaveLength(1)
    expect(new Set(gen2.map((c) => c.id)).size).toBe(2)
  })

  it('同代内结构重画（桌面文件变了）后交互态不粘在旧节点上', () => {
    plugin.mount(h.host)
    const old = cards()[0]
    cellsOf(old)[0].dispatch('click')
    headOf(old).dispatch('click')

    // 文件被删掉一个 → 结构指纹变 → 整排卡重画
    h.host.view = viewWith([ITEMS[0]])
    plugin.update?.(h.host)

    const fresh = cards()[0]
    expect(fresh).not.toBe(old)
    expect(classesOf(fresh)).not.toContain(EXPANDED_CLASS)
    expect(walk(fresh).some((n) => classesOf(n).includes(HIGHLIGHT_CLASS))).toBe(false)
  })
})
