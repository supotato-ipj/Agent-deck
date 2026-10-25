/**
 * 卡内多选的**裁决**（工单184 = spec166 之⑦：开关、框选、ENTER 批量启动）。
 *
 * 测试面 = `app/plugins/doc-group-cards/selection.js`——与 grouping.js / interaction.js /
 * geometry.js / menu.js 同一条缝：**纯模块、零 DOM、零 Electron**。插件源码就是投放单元
 * （面板经 deck-plugin:// 原样 import，无编译步骤），故「多选开关怎么切」「单击切换选中」
 * 「框选命中哪些」「ENTER 该启动哪些」这几类裁决必须离开 DOM 才能被测。
 * 接线面（监听挂在哪、遮没遮住、档持没持）在 doc-group-cards-multiselect-dom.spec.ts。
 *
 * 断言面逐条对应工单184 验收标准：
 *   - 每张卡一个**独立**开关，卡间互不影响（卡内独立由 selection.js 保证，DOM 面另证接线）；
 *   - 多选态单击切换选中、再次点击取消（单选态仍旧是后点顶掉先点）；
 *   - 框选命中集合**只含本卡**图标；
 *   - ENTER 启动整个选中集（逐项走既有契约，故这里只钉「该启动谁」）；
 *   - 多选态右键菜单作用于整个选中集（点在选中项上不动选区，点在未选中项上单独选中它）。
 */
import { describe, expect, it } from 'vitest'
import {
  MARQUEE_CLASS,
  MULTI_CLASS,
  MULTI_ON_CLASS,
  SELECT_KEYBOARD_TIER,
  hasSelection,
  isMultiOn,
  launchTargetsOf,
  marqueeHits,
  marqueeRectOf,
  marqueeSelect,
  menuSelectionFor,
  rectsOverlap,
  selectionPathsOf,
  toggleMulti,
  toggleSelection,
} from '../../plugins/doc-group-cards/selection'
import { CELL, CELL_GAP } from '../../plugins/doc-group-cards/geometry'
import {
  clickOnIcon,
  clickToggleExclusive,
  initialCardState,
  type CardStateTable,
  type CardUiState,
} from '../../plugins/doc-group-cards/interaction'

const P = (n: string) => `C:\\Users\\me\\Desktop\\${n}`
const A = P('方案.docx')
const B = P('纪要.docx')
const C = P('预算.xlsx')
const OTHER_CARD = P('合同.pdf')

/** 本卡的三个格子矩形（网格局部坐标：3 列一行行排开，格边长 CELL、间距 CELL_GAP） */
function localCells(count: number): { path: string; x: number; y: number; width: number; height: number }[] {
  const pitch = CELL + CELL_GAP
  return Array.from({ length: count }, (_, i) => ({
    path: [A, B, C][i],
    x: i * pitch,
    y: 0,
    width: CELL,
    height: CELL,
  }))
}

/** 开了多选、且已选中一批的卡态 */
function multiWith(paths: string[]): CardUiState {
  let s = initialCardState()
  s = toggleMulti(s).state
  for (const p of paths) s = toggleSelection(s, p).state
  return s
}

describe('多选开关（工单184：每张卡一个独立开关）', () => {
  it('初始态是关的（热重载重挂即回到非多选）', () => {
    expect(isMultiOn(initialCardState())).toBe(false)
  })

  it('切一次开、切两次关（往复，不是单向开）', () => {
    const on = toggleMulti(initialCardState())
    expect(isMultiOn(on.state)).toBe(true)
    expect(toggleMulti(on.state).state.multi).toBe(false)
  })

  it('开关**不碰展开态**（多选与折叠是两件事，互不代劳）', () => {
    const expanded = { ...initialCardState(), expanded: true }
    expect(toggleMulti(expanded).state.expanded).toBe(true)
  })

  it('关掉多选即清空选区（残留高亮会让用户以为还选着）', () => {
    const off = toggleMulti(multiWith([A, B])).state
    expect(off.multi).toBe(false)
    expect(off.highlight.size).toBe(0)
  })

  it('开关原样不改入参（纯函数：返回值是新态）', () => {
    const before = initialCardState()
    toggleMulti(before)
    expect(before.multi).toBe(false)
  })

  it('**卡间互不影响**：全表里开一张不带动另一张（多选是每卡一个开关，不是一枚全局开关）', () => {
    const states: Map<string, CardUiState> = new Map([
      ['dgc-docx', toggleMulti(initialCardState()).state],
      ['dgc-pdf', initialCardState()],
    ])
    expect(isMultiOn(states.get('dgc-docx')!)).toBe(true)
    expect(isMultiOn(states.get('dgc-pdf')!)).toBe(false)
    // 且开的那张自己开始攒选区，另一张的高亮仍是空的
    const only = toggleSelection(states.get('dgc-docx')!, A).state
    states.set('dgc-docx', only)
    expect(selectionPathsOf(states.get('dgc-docx')!)).toEqual([A])
    expect(selectionPathsOf(states.get('dgc-pdf')!)).toEqual([])
  })

  it('展开排他（工单180）不得顺手关掉别人的多选开关——折叠别人的卡不该改它的模式', () => {
    const states: Map<string, CardUiState> = new Map([
      ['dgc-docx', multiWith([A])],
      ['dgc-pdf', initialCardState()],
    ])
    const next = clickToggleExclusive(states, 'dgc-pdf')
    expect(isMultiOn(next.state)).toBe(false) // 被展开的那张自己没开，仍是关的
    expect(isMultiOn(next.states.get('dgc-docx')!)).toBe(true) // 被顺带收起的：模式原样
  })
})

describe('多选态下单击切换选中（工单184）', () => {
  it('单击选中、再点一次取消（往复的 toggle，不是幂等高亮）', () => {
    const on = toggleMulti(initialCardState()).state
    const once = toggleSelection(on, A)
    expect(selectionPathsOf(once.state)).toEqual([A])
    const twice = toggleSelection(once.state, A)
    expect(selectionPathsOf(twice.state)).toEqual([])
  })

  it('逐个挑选：选中的并起来，不是后点顶掉先点', () => {
    const s = multiWith([A, B])
    expect(selectionPathsOf(s)).toEqual([A, B])
  })

  it('选区落在展开态上时切换仍然成立，且展开态不动', () => {
    const expanded = { ...toggleMulti(initialCardState()).state, expanded: true }
    const s = toggleSelection(expanded, A).state
    expect(s.expanded).toBe(true)
    expect(selectionPathsOf(s)).toEqual([A])
  })

  it('图标命中仍必须截断冒泡（否则同一次点击顺带把整卡折叠，正是 #181 钉死的那道闸）', () => {
    expect(toggleSelection(toggleMulti(initialCardState()).state, A).stopPropagation).toBe(true)
  })

  it('**非多选态走老路**：单击仍是单选高亮（后点顶掉先点），本票不得改动 #181 的语义', () => {
    const s = clickOnIcon(clickOnIcon(initialCardState(), A).state, B).state
    expect(selectionPathsOf(s)).toEqual([B])
    expect(s.multi).toBe(false)
  })

  it('非多选态下重复点同一格仍是高亮（单选的幂等，不许被本票改成取消）', () => {
    const once = clickOnIcon(initialCardState(), A).state
    expect(selectionPathsOf(clickOnIcon(once, A).state)).toEqual([A])
  })
})

describe('框选命中（工单184：可从内容区空白起笔，命中集合只含本卡）', () => {
  it('拖出的矩形总归一化（左上/右下与右下/左上拖法等效）', () => {
    const a = marqueeRectOf({ x: 300, y: 100 }, { x: 40, y: 20 })
    const b = marqueeRectOf({ x: 40, y: 20 }, { x: 300, y: 100 })
    expect(a).toEqual(b)
    expect(a).toEqual({ x: 40, y: 20, width: 260, height: 80 })
  })

  it('相交的格子被命中，不相交的落选（判据是矩形相交，不是中心点落在框内）', () => {
    const cells = localCells(3) // 三格依次占 x∈[0,88) / [96,184) / [192,280)
    // 横跨前两格
    expect(marqueeHits({ x: 10, y: 0, width: 180, height: 88 }, cells)).toEqual([A, B])
    // 只压到第二格的一角：相交即命中
    expect(marqueeHits({ x: 90, y: 80, width: 10, height: 10 }, cells)).toEqual([B])
    // 完全落在三格右侧的空隙里：一个都不命中
    expect(marqueeHits({ x: 300, y: 0, width: 10, height: 10 }, cells)).toEqual([])
  })

  it('零尺寸的框（点一下没拖）不命中任何格子——否则单击空白会误清/误选', () => {
    expect(marqueeHits({ x: 0, y: 0, width: 0, height: 0 }, localCells(3))).toEqual([])
  })

  it('相交判据是**半开区间**：紧贴边不算相交（相邻格子的边界不互相吃掉）', () => {
    const one = [{ path: A, x: 0, y: 0, width: CELL, height: CELL }]
    expect(rectsOverlap({ x: CELL, y: 0, width: 10, height: 10 }, one[0])).toBe(false)
    expect(rectsOverlap({ x: CELL - 1, y: 0, width: 10, height: 10 }, one[0])).toBe(true)
  })

  it('命中集合只由**传进来的那张卡的格子**决定（框选天然卡内：别的卡不在表里就选不到）', () => {
    const cells = [...localCells(3), { path: OTHER_CARD, x: 0, y: 400, width: CELL, height: CELL }]
    const wide = { x: 0, y: 0, width: 300, height: 600 }
    const hitAll = marqueeHits(wide, cells)
    // 全表都在框内时，含那张别的卡的格子——说明判据就是「表里相交的那些」
    expect(hitAll).toEqual([A, B, C, OTHER_CARD])
    // 而本卡的框只压到本卡那一行：别的卡那一格（y=400）根本不在框内，选不到
    expect(marqueeHits({ x: 0, y: 0, width: 300, height: 100 }, cells)).toEqual([A, B, C])
  })

  it('框选落定：选区**替换**成命中集合（不是并上去——框选的口径是「这一框选中的就是全部」）', () => {
    const s = marqueeSelect(multiWith([A]), { x: 96, y: 0, width: 200, height: 88 }, localCells(3))
    expect(selectionPathsOf(s.state)).toEqual([B, C])
  })

  it('框空：清空选区（与点空白清高亮同款口径）', () => {
    const s = marqueeSelect(multiWith([A, B]), { x: 5000, y: 5000, width: 1, height: 1 }, localCells(3))
    expect(selectionPathsOf(s.state)).toEqual([])
  })

  it('框选只在多选态下成立（关着的卡上框一下不产生选区）', () => {
    expect(marqueeSelect(initialCardState(), { x: 0, y: 0, width: 999, height: 999 }).state.highlight.size).toBe(0)
  })

  it('框选不碰展开态、不截断冒泡之外的语义（形状不动，选文件绝不改卡片形状）', () => {
    const expanded = { ...toggleMulti(initialCardState()).state, expanded: true }
    const s = marqueeSelect(expanded, { x: 0, y: 0, width: 999, height: 999 })
    expect(s.state.expanded).toBe(true)
    expect(s.action).toBe('marquee-select')
  })

  it('框选只认表里给出的路径：传入的矩形之外再塞一个也不该被选中', () => {
    const cells = localCells(2)
    const s = marqueeSelect(toggleMulti(initialCardState()).state, { x: 0, y: 0, width: 200, height: 200 }, cells)
    expect(selectionPathsOf(s.state)).toEqual([A, B])
  })
})

describe('ENTER 批量启动（工单184）', () => {
  it('启动目标是整个选中集，逐项走既有启动契约（故这里给的是「该启动谁」的清单）', () => {
    expect(launchTargetsOf(multiWith([A, B, C]))).toEqual([A, B, C])
  })

  it('非多选态不批量启动（单选时 ENTER 不抢双击的活）', () => {
    const s = clickOnIcon(initialCardState(), A).state
    expect(launchTargetsOf(s)).toEqual([])
  })

  it('选区为空时不启动（档可能在，命中集合不在）', () => {
    expect(launchTargetsOf(toggleMulti(initialCardState()).state)).toEqual([])
  })

  it('ENTER 的键盘档是插件私有的自由档名（宿主按插件 id 加命名空间）', () => {
    expect(SELECT_KEYBOARD_TIER).toBe('multi-select')
    expect(SELECT_KEYBOARD_TIER).not.toBe('menu') // 与 #182 的菜单档各持各的，互不放
  })

  it('全表里**哪张卡**在多选且选区非空（档何时该持/该放）', () => {
    const empty: CardStateTable = new Map([['dgc-docx', initialCardState()]])
    expect(hasSelection(empty)).toBe(false)
    const active: CardStateTable = new Map([['dgc-docx', multiWith([A])]])
    expect(hasSelection(active)).toBe(true)
    // 多选开着但一个都没选 → 档不必持（没有可启动的东西，也没有 ENTER 可按）
    const idle: CardStateTable = new Map([['dgc-docx', toggleMulti(initialCardState()).state]])
    expect(hasSelection(idle)).toBe(false)
  })
})

describe('多选态右键菜单作用于整个选中集（工单184）', () => {
  it('点在**已选中**的格子上：选区原样不动，菜单作用于整个选中集', () => {
    const s = multiWith([A, B])
    expect(menuSelectionFor(s, A)).toEqual([A, B])
  })

  it('点在**未选中**的格子上：单独选中它（菜单作用对象不能是「一个没选中的东西 + 一堆别的」）', () => {
    const s = multiWith([A, B])
    expect(menuSelectionFor(s, C)).toEqual([C])
  })

  it('非多选态右键：就是那一个文件（#182 的单选语义原样）', () => {
    expect(menuSelectionFor(clickOnIcon(initialCardState(), A).state, A)).toEqual([A])
  })
})

describe('类名与档名是插件私有的（#181/#182 钉死的不许被本票破）', () => {
  it('多选开关、框选带都是插件私有类名，不与内核 `.ditem`/`sel` 相撞', () => {
    expect(MULTI_CLASS).toBe('dgc-multi')
    expect(MULTI_ON_CLASS).toBe('dgc-multi-on')
    expect(MARQUEE_CLASS).toBe('dgc-marquee')
    for (const c of [MULTI_CLASS, MULTI_ON_CLASS, MARQUEE_CLASS]) {
      expect(c).not.toBe('sel')
      expect(c).not.toBe('ditem')
      expect(c).not.toBe('dgc-selected')
    }
  })
})
