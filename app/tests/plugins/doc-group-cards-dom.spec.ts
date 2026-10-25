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
 * DOM 桩已抽到 doc-group-cards-dom-shim.ts（工单183 抽出，与工单182/183 的接线测试共用同一份）。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { CARD_CLASS, CELL_CLASS, EXPANDED_CLASS, FADED_CLASS, HIGHLIGHT_CLASS, MORE_CLASS } from '../../plugins/doc-group-cards/interaction'
import plugin, { STYLE_ID, type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { CARD_PAD_X, CARD_PAD_Y, HEAD_H } from '../../plugins/doc-group-cards/geometry'
import { Element, newDom, walk } from './doc-group-cards-dom-shim'

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

/** 注入的样式表正文（剥掉注释；桩里没有 CSS 引擎，规则的「命中」只能按文本核对） */
function sheetOf(): string {
  return (dom.documentShim.getElementById(STYLE_ID)?.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
}

/** 卡上的「+N」徽标（没有就是没有——无溢出时它压根不渲染，而不是渲染一个空的） */
function moreOf(card: Element): Element | undefined {
  return walk(card).find((n) => n.classList.contains(MORE_CLASS))
}

/** 徽标必须存在时的取法：不存在直接炸。「徽标不该出现」另有专门用例断言，见 moreOf */
function requireMore(card: Element): Element {
  const more = moreOf(card)
  if (!more) throw new Error('卡上没有 .dgc-more 徽标')
  return more
}

/** n 个 .docx 文件（造溢出用；文件名与路径各不相同，图标各取各的） */
function docxItems(n: number): HostDesktopItem[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `文件${i + 1}.docx`, kind: 'file', path: `C:\\me\\文件${i + 1}.docx`, iconKey: `k${i + 1}`,
  }))
}

/** 换成 n 个 .docx 的桌面并重画（结构指纹变 → 整排重画） */
function redrawWithDocx(n: number): void {
  h.host.view = viewWith(docxItems(n))
  plugin.update?.(h.host)
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
    const sheet = sheetOf()
    const selectors = sheet
      .split('}')
      .map((block) => block.split('{')[0].trim())
      .filter(Boolean)

    expect(selectors.length).toBeGreaterThan(5)
    for (const sel of selectors) {
      // 作用域根 = 选择器的头一段复合选择器，必须**起自**卡片根类名。
      // 工单180 起复合段可以更长（`.dgc-card.dgc-expanded .dgc-grid` 仍是同一个作用域根），
      // 但不能长成别的根——那正是 #dgc-style 那种哑规则的写法。
      expect(sel.split(' ')[0].startsWith(`.${CARD_CLASS}`)).toBe(true)
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

// ---------------------------------------------------------------------------
// 工单180（spec166 之③）：溢出折叠与展开——+N 徽标、2×4 展开态、纵向滚动
//
// 裁决在 geometry.js（纯模块）里直测过；这里钉的是**接线**：card.js 真的把那些数写进了
// DOM 吗？徽标真的按剩余数渲染吗？展开真的换了卡框、真的重新居中吗？几何一变真的重申报热区吗？
// 桩里没有 CSS 引擎，故样式层只能按**规则文本**核对（几何本身由 geometry.spec.ts 的字面量钉死）。
// ---------------------------------------------------------------------------

describe('折叠态两行 + 隐藏而不丢弃（工单180）', () => {
  it('折叠态内容区固定两行、溢出隐藏（几何来自 geometry.js 的 184 = 2×88 + 1×8）', () => {
    plugin.mount(h.host)
    const sheet = sheetOf()
    expect(sheet).toContain(`grid-auto-rows: ${88}px`)
    expect(sheet).toContain('height: 184px') // 两行格高 176 + 一道间距 8
    expect(sheet).toContain('overflow: hidden')
    // 折叠态卡框 320×244，且几行之内没有任何一条展开态规则混进折叠态
    expect(cards().every((c) => c.style.width === '320px' && c.style.height === '244px')).toBe(true)
  })

  it('7 个文件：折叠只露 6 个，但**格子一个不少**（隐藏 ≠ 丢弃）', () => {
    plugin.mount(h.host)
    redrawWithDocx(7)
    const card = cards()[0]
    expect(cellsOf(card)).toHaveLength(7)
  })

  it('折叠态卡上找不到任何徽标（无溢出就不渲染）', () => {
    plugin.mount(h.host)
    expect(moreOf(cards()[0])).toBeUndefined()
  })
})

describe('「+N」徽标（工单180：仅在确有溢出时出现）', () => {
  it('恰好 6 个（= 3 列 × 2 行）→ 不出现徽标', () => {
    plugin.mount(h.host)
    redrawWithDocx(6)
    expect(moreOf(cards()[0])).toBeUndefined()
  })

  it('7 个 → 出现徽标，文案是折叠态藏起来的那个数', () => {
    plugin.mount(h.host)
    redrawWithDocx(7)
    expect(moreOf(cards()[0])?.textContent).toBe('+1')
  })

  it('20 个 → +14（露 6 + 藏 14 = 20）', () => {
    plugin.mount(h.host)
    redrawWithDocx(20)
    expect(moreOf(cards()[0])?.textContent).toBe('+14')
    expect(cellsOf(cards()[0])).toHaveLength(20)
  })

  it('徽标在卡头里，用的是工单181 预留的 MORE_CLASS（点它已经接好了，本票只认不造）', () => {
    plugin.mount(h.host)
    redrawWithDocx(7)
    const card = cards()[0]
    expect(moreOf(card)).toBeDefined()
    expect(headOf(card).contains(requireMore(card))).toBe(true) // 在卡头（children[0]）内
  })

  it('点徽标即展开（徽标命中与空白命中是同一个裁决）', () => {
    plugin.mount(h.host)
    redrawWithDocx(7)
    const card = cards()[0]
    requireMore(card).dispatch('click')
    expect(classesOf(card)).toContain(EXPANDED_CLASS)
    expect(card.style.width).toBe('640px')
  })
})

describe('展开态几何（工单180：宽 2 倍、高 4 倍、6 列重排、纵向滚动）', () => {
  it('展开 → 640×976；收起 → 回到 320×244', () => {
    plugin.mount(h.host)
    const card = cards()[0]
    headOf(card).dispatch('click')
    expect([card.style.width, card.style.height]).toEqual(['640px', '976px'])
    headOf(card).dispatch('click')
    expect([card.style.width, card.style.height]).toEqual(['320px', '244px'])
  })

  it('样式层给出 6 列重排与纵向滚动条（工单原文的字面量：repeat(6, 88px)）', () => {
    plugin.mount(h.host)
    const sheet = sheetOf()
    expect(sheet).toContain(`.${CARD_CLASS}.${EXPANDED_CLASS} .dgc-grid`)
    expect(sheet).toContain('repeat(6, 88px)')
    expect(sheet).toContain('overflow-y: auto')
    // 内容区高度 916 = 976 − 18×2 − 24（卡头），卡框里不留死带
    expect(sheet).toContain('height: 916px')
  })

  it('卡内滚轮真能滚：滚动容器就是那张内容区网格（overflow-y:auto + 固定高度）', () => {
    plugin.mount(h.host)
    // 折叠态网格写死高度且 hidden；展开态同一张网格换成 auto —— 是同一张网格在滚，不是新加一个容器
    expect(sheetOf()).toContain(`.${CARD_CLASS} .dgc-grid`)
    expect(cards()[0].querySelectorAll('.dgc-grid').length).toBe(1)
  })
})

describe('展开卡独占屏幕正中并重新垂直居中（工单180）', () => {
  it('展开第二张卡：它独占正中（960/232），其余卡原地不动', () => {
    plugin.mount(h.host)
    const [first, second] = cards()
    // 折叠态：两张 320 卡居中一行 → left 951/1289，top 598
    headOf(second).dispatch('click')
    expect([second.style.width, second.style.height]).toEqual(['640px', '976px'])
    expect([second.style.left, second.style.top]).toEqual(['960px', '232px'])
    // 其余卡位置尺寸一字不改（淡出是样式层的事，不许顺带挪动）
    expect([first.style.left, first.style.top, first.style.width, first.style.height])
      .toEqual(['951px', '598px', '320px', '244px'])
  })

  it('收起后整排回到折叠态的居中位置（整行居中裁决保留，不改成左锚）', () => {
    plugin.mount(h.host)
    const [first, second] = cards()
    headOf(second).dispatch('click')
    headOf(second).dispatch('click')
    expect([first.style.left, first.style.top]).toEqual(['951px', '598px'])
    expect([second.style.left, second.style.top]).toEqual(['1289px', '598px'])
  })

  it('收起第二张不会把第一张拽回原位（各自的态各管各的）', () => {
    plugin.mount(h.host)
    const [first, second] = cards()
    headOf(first).dispatch('click')
    headOf(first).dispatch('click')
    expect([first.style.left, first.style.top]).toEqual(['951px', '598px'])
    expect([second.style.left, second.style.top]).toEqual(['1289px', '598px'])
  })
})

describe('同一时刻只允许一张卡展开（工单180）', () => {
  it('展开 A 再展开 B：A 自动收起', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    headOf(a).dispatch('click')
    headOf(b).dispatch('click')
    expect(classesOf(a)).not.toContain(EXPANDED_CLASS)
    expect(classesOf(b)).toContain(EXPANDED_CLASS)
  })

  it('展开 B 时 A 淡出；B 自己不淡出', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    headOf(b).dispatch('click')
    expect(classesOf(a)).toContain(FADED_CLASS)
    expect(classesOf(b)).not.toContain(FADED_CLASS)
  })

  it('都收起时无人淡出（淡出态不会粘住）', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    headOf(b).dispatch('click')
    headOf(b).dispatch('click')
    expect(cards().some((c) => classesOf(c).includes(FADED_CLASS))).toBe(false)
  })

  it('点图标（高亮）不影响谁展开着——高亮不改卡片形状', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    headOf(a).dispatch('click')
    cellsOf(b)[0].dispatch('click')
    expect(classesOf(a)).toContain(EXPANDED_CLASS)
  })

  it('整排重画（文件变了）后没有卡是展开的，也没人淡出', () => {
    plugin.mount(h.host)
    headOf(cards()[0]).dispatch('click')
    redrawWithDocx(9)
    expect(cards().some((c) => classesOf(c).includes(EXPANDED_CLASS))).toBe(false)
    expect(cards().some((c) => classesOf(c).includes(FADED_CLASS))).toBe(false)
  })
})

/**
 * 渲染层热区声明的**逐字复刻**（src/renderer/main.ts:1560-1575）：
 * `document.querySelectorAll('.card')` → 每个取 getBoundingClientRect() → 滤掉零尺寸。
 * 这一段不是「顺手写个断言」，而是把主进程那套判定搬进来：不滤零尺寸就没有「淡出卡退出热区」这回事。
 */
function declaredHotzones(): Array<{ id: string; x: number; y: number; w: number; h: number }> {
  return dom.documentShim
    .querySelectorAll('.card')
    .map((c: Element) => ({ node: c, r: c.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0)
    .map(({ node, r }) => ({ id: node.id, x: r.left, y: r.top, w: r.width, h: r.height }))
}

describe('淡出的卡退出热区（工单167 评审 F1：淡出不该留一片点不着的死区）', () => {
  it('展开 B 时：A 淡出且**不再声明热区**，B 照旧按自己的新矩形声明', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    headOf(b).dispatch('click')
    const zones = declaredHotzones()
    // 淡出的 A：矩形塌成 0×0 → 被零尺寸那一条滤掉 → 面板在那一带转穿透，点下去落到桌面
    expect(classesOf(a)).toContain(FADED_CLASS)
    expect(zones.map((z) => z.id)).not.toContain(a.id)
    expect(zones.map((z) => z.id)).toContain(b.id)
    // 展开的 B 仍是真矩形（640×976），没有被自己那条规则误伤
    expect(zones.find((z) => z.id === b.id)).toMatchObject({ w: 640, h: 976 })
  })

  it('收起后 A 的热区回来（退出只限淡出这一态，不粘住）', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    headOf(b).dispatch('click')
    headOf(b).dispatch('click')
    expect(declaredHotzones().map((z) => z.id)).toEqual(cards().map((c) => c.id))
  })

  it('幽灵仍停在原处：卡框塌了，偏移从 geometry.js 插值而不是另抄一份数', () => {
    plugin.mount(h.host)
    const sheet = sheetOf()
    // 卡内边距 20/18 与卡头行高 24 都写进了摆位规则（geometry.js 的那三个数）
    expect(sheet).toContain(`.${CARD_CLASS}.${FADED_CLASS} .dgc-head`)
    expect(sheet).toContain(`left: ${CARD_PAD_X}px`)
    expect(sheet).toContain(`top: ${CARD_PAD_Y + HEAD_H}px`)
    expect(sheet).toContain(`.${CARD_CLASS}.${FADED_CLASS} .dgc-grid`)
    // 塌的是卡框，且要压过 layoutRow 写的内联宽高。
    // 声明前的那一位要卡死（`[\s;{]`）：不卡的话 `border-width: 0 !important` 里的
    // `width: 0 !important` 子串会把这条断言喂绿——它当时正是这么假绿的。
    expect(sheet).toMatch(new RegExp(`\\.${CARD_CLASS}\\.${FADED_CLASS}\\s*\\{[^}]*[\\s;{]width:\\s*0\\s*!important`))
    expect(sheet).toMatch(new RegExp(`\\.${CARD_CLASS}\\.${FADED_CLASS}\\s*\\{[^}]*[\\s;{]height:\\s*0\\s*!important`))
  })

  it('淡出卡的样式表里不再有那句把 DOM 命中与 OS 穿透混为一谈的注释', () => {
    // 注释被 sheetOf() 剥掉了，这里直接查原文：那句「走穿到下面的展开卡/桌面」正是 F1 的病根
    const raw = dom.documentShim.getElementById(STYLE_ID)?.textContent ?? ''
    expect(raw).not.toContain('走穿到下面的展开卡/桌面')
  })
})

describe('热区纪律（工单180：每一次几何变化都要主动重申报）', () => {
  it('展开与收起各申报一次（两向都要，别只顾展开那半边）', () => {
    plugin.mount(h.host)
    const card = cards()[0]
    const before = h.domChanges.length
    headOf(card).dispatch('click')
    const afterExpand = h.domChanges.length
    headOf(card).dispatch('click')
    expect(afterExpand).toBeGreaterThan(before)
    expect(h.domChanges.length).toBeGreaterThan(afterExpand)
  })

  it('换一张卡展开也申报（新露出的那块区域立刻可点）', () => {
    plugin.mount(h.host)
    const [a, b] = cards()
    const before = h.domChanges.length
    headOf(b).dispatch('click')
    expect(h.domChanges.length).toBeGreaterThan(before)
    expect(b.style.width).toBe('640px') // 真的换了形状，不是只切了个类名
  })

  it('点图标不申报（高亮不改布局盒）——#181 的纪律本票没破', () => {
    plugin.mount(h.host)
    headOf(cards()[0]).dispatch('click')
    const before = h.domChanges.length
    cellsOf(cards()[1])[0].dispatch('click')
    expect(h.domChanges.length).toBe(before)
  })
})
