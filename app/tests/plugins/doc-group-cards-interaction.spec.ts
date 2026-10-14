/**
 * 组卡交互语义的纯逻辑（工单181 = spec166 之④：点击展开、高亮、热区重声明）。
 *
 * 测试面 = 投放型插件包 `app/plugins/doc-group-cards/interaction.js`——与工单179 的
 * `grouping.js` 同一条缝：**纯模块、零 DOM、零 Electron**。插件源码就是投放单元
 * （面板经 deck-plugin:// 原样 import，无编译步骤），故逻辑与呈现必须分家：
 * 「点击落到哪儿、要不要截断冒泡、状态怎么迁移」在这里判定，DOM 接线在 card.js。
 *
 * 为什么「不冒泡」要落成纯判定而不是只在 DOM 里听：卡片级监听器是挂在 `.card` 上的，
 * 而图标是它的后代——只要图标那侧忘了 `stopPropagation()`，同一次点击就会先高亮图标、
 * 再顺带把整卡折叠，正是验收标准里点名要避免的误触。把这条写成 `isCardToggle(hit)`
 * 的纯函数，卡片级监听器就有一道可直测的闸：图标命中**不改卡片形状**。
 *
 * 断言面逐条对应工单181 验收标准：空白处折叠切换、点空白清高亮、图标命中不改形状、
 * 「更多」徽标与空白处等价、高亮是插件自建的一套（类名不与内核选区类名 `sel` 相撞）。
 */
import { describe, expect, it } from 'vitest'
import {
  CARD_CLASS,
  CELL_CLASS,
  EXPANDED_CLASS,
  HIGHLIGHT_CLASS,
  MORE_CLASS,
  clickOnCardBlank,
  clickOnIcon,
  expandedClassOf,
  highlightClassOf,
  initialCardState,
  isCardToggle,
  isHighlighted,
} from '../../plugins/doc-group-cards/interaction'

const P = (n: string) => `C:\\Users\\me\\Desktop\\${n}`

describe('组卡交互语义（工单181：点空白展开收起、点图标高亮）', () => {
  it('点图标只高亮：展开态原样不动（选文件绝不改卡片形状）', () => {
    const before = { ...initialCardState(), expanded: true }
    const { state } = clickOnIcon(before, P('方案.docx'))
    expect(state.expanded).toBe(true)
    expect(isHighlighted(state, P('方案.docx'))).toBe(true)
  })

  it('图标命中必须截断冒泡（否则同一次点击顺带把整卡折叠）', () => {
    const { stopPropagation } = clickOnIcon(initialCardState(), P('方案.docx'))
    expect(stopPropagation).toBe(true)
  })

  it('点空白折叠态→展开态，且高亮被清掉', () => {
    const before = { ...initialCardState(), highlight: new Set([P('方案.docx')]) }
    const { state, action } = clickOnCardBlank(before)
    expect(state.expanded).toBe(true)
    expect(state.highlight.size).toBe(0)
    expect(action).toBe('toggle-expand')
  })

  it('再点空白收起（折叠切换是往复的，不是单向开）', () => {
    const { state: opened } = clickOnCardBlank(initialCardState())
    const { state } = clickOnCardBlank(opened)
    expect(state.expanded).toBe(false)
    expect(state.highlight.size).toBe(0)
  })

  it('高亮是插件自建的一套：以绝对路径为键，与内核选区状态无任何往来', () => {
    const a = P('方案.docx')
    const b = P('预算.xlsx')
    const { state } = clickOnIcon(clickOnIcon(initialCardState(), a).state, b)
    // 单选语义：后点的高亮顶掉先点的（点空白即全清，故不存在多选残留）
    expect([...state.highlight]).toEqual([b])
    expect(isHighlighted(state, a)).toBe(false)
  })

  it('同一图标重复点仍是高亮（幂等，不抖动）', () => {
    const p = P('方案.docx')
    const once = clickOnIcon(initialCardState(), p).state
    const twice = clickOnIcon(once, p).state
    expect([...twice.highlight]).toEqual([p])
  })

  it('高亮用插件私有的类名：不与内核选区类名 `sel` 相撞', () => {
    // 内核选中态是 `.ditem.sel`（main.ts applySelection），插件节点一律不是 .ditem，
    // 故插件高亮即便撞上同一个类名也污染不到内核；仍用私有前缀以免被面板样式表误伤。
    expect(HIGHLIGHT_CLASS).not.toBe('sel')
    expect(EXPANDED_CLASS).not.toBe('sel')
    expect(CELL_CLASS).not.toBe('ditem')
  })
})

describe('图标点击不冒泡（工单181：点图标不改变卡片形状）', () => {
  it('图标命中不是卡片级切换命中——卡片监听器拿它无动作可做', () => {
    expect(isCardToggle('icon')).toBe(false)
  })

  it('空白与「更多」徽标才是卡片级切换命中（徽标与空白等价）', () => {
    expect(isCardToggle('card-blank')).toBe(true)
    expect(isCardToggle('more')).toBe(true)
  })

  it('卡外的命中一律不切换（点了不该有反应的地方就是没反应）', () => {
    expect(isCardToggle('outside')).toBe(false)
  })
})

describe('状态 → 类名（工单180 接缝：折叠几何挂在 EXPANDED_CLASS 上）', () => {
  it('展开态才带展开类名，收起态不带（工单180 只需给这个类名写几何规则）', () => {
    expect(expandedClassOf({ ...initialCardState(), expanded: true })).toBe(EXPANDED_CLASS)
    expect(expandedClassOf(initialCardState())).toBe('')
  })

  it('高亮类名只落在被点的那一个格子上，其余格子没有', () => {
    const p = P('方案.docx')
    const { state } = clickOnIcon(initialCardState(), p)
    expect(highlightClassOf(state, p)).toBe(HIGHLIGHT_CLASS)
    expect(highlightClassOf(state, P('预算.xlsx'))).toBe('')
  })

  it('命名空间常量齐备（卡片根、格子、徽标、展开、高亮）', () => {
    expect([CARD_CLASS, CELL_CLASS, MORE_CLASS, EXPANDED_CLASS, HIGHLIGHT_CLASS]).toEqual([
      'dgc-card',
      'dgc-cell',
      'dgc-more',
      'dgc-expanded',
      'dgc-selected',
    ])
  })

  it('初始态是收起的、无高亮的（热重载重挂即回到这个态）', () => {
    const s = initialCardState()
    expect(s.expanded).toBe(false)
    expect(s.highlight.size).toBe(0)
  })
})
