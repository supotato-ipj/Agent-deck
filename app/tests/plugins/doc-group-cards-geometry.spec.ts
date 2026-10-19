/**
 * 组卡溢出折叠与展开的几何与计数（工单180 = spec166 之③）。
 *
 * 测试面 = 投放型插件包 `app/plugins/doc-group-cards/geometry.js`——与工单179 的 `grouping.js`、
 * 工单181 的 `interaction.js` 同一条缝：**纯模块、零 DOM、零 Electron**。插件源码就是投放单元
 * （面板经 deck-plugin:// 原样 import，无编译步骤），故几何与计数必须能脱离 card.js 直测：
 * 徽标的 +N、展开态的 2×4、独占居中与重新垂直居中，全在这里判定，card.js 只负责把数写进 DOM。
 *
 * **断言面逐条对应工单180 验收标准：**
 *   - 折叠态内容区固定两行（可见数 = 3 列 × 2 行），超出部分隐藏而不丢文件（剩余数 ≥ 0 且文件仍在 DOM 里）；
 *   - 「+N」徽标：仅在确有溢出时出现，无溢出返回空串；
 *   - 展开态宽 2 倍、高 4 倍、重排 6 列；
 *   - 展开卡独占屏幕正中并**重新垂直居中**，不顶任务栏、不压左右栏；
 *   - 展开时其余卡原地不动（相对位置稳定，与 SETTLED 的居中裁决一致：整行居中保留，行宽随卡数平移是预期）。
 *
 * 期望值一律取**独立来源**：工单原文的字面量（320/244/640/976、3 列 2 行、6 列）、以及按公式手算的
 * 坐标（不把实现的表达式抄过来当期望值）。几何之间的关系式断言（「卡高 = 内边距 + 卡头 + 内容区」）
 * 是防漂移的关键：它保证「两行」是几何事实而不是一个孤立的数字。
 */
import { describe, expect, it } from 'vitest'
import {
  CARD_GAP,
  CARD_PAD_X,
  CARD_PAD_Y,
  CELL,
  CELL_GAP,
  COLLAPSED_COLS,
  COLLAPSED_H,
  COLLAPSED_ROWS,
  COLLAPSED_W,
  EXPANDED_COLS,
  EXPANDED_H,
  EXPANDED_W,
  HEAD_H,
  cardGeometryOf,
  expandedContentHeight,
  expandedVisibleRows,
  gridSizeOf,
  hasOverflow,
  moreLabelOf,
  remainingCountOf,
  rowLayoutOf,
  visibleCapacityOf,
  visibleCountOf,
} from '../../plugins/doc-group-cards/geometry'

/** 面板参考屏（app/config.json 的实配 2560×1440）；Windows 任务栏按 48px 计 */
const VIEWPORT = { width: 2560, height: 1440 }
const TASKBAR_H = 48
/** 面板左侧内置卡的占位：#clock-card left:48 width:320（index.html:42-48） */
const SIDE_COLUMN = { left: 48, right: 368 }

describe('折叠态几何（工单179 的表，工单180 不得改动它）', () => {
  it('卡 320×244、内容区 280×184、单格 88、3 列 2 行', () => {
    expect([COLLAPSED_W, COLLAPSED_H, CELL, COLLAPSED_COLS, COLLAPSED_ROWS]).toEqual([320, 244, 88, 3, 2])
    // 280 = 3×88 + 2×8；184 = 2×88 + 1×8（手算，不引用实现的表达式）
    expect(gridSizeOf(COLLAPSED_COLS, COLLAPSED_ROWS)).toEqual({ width: 280, height: 184 })
  })

  it('卡高是「内边距 + 卡头 + 内容区」的几何事实（184+18+24+18=244），不是凑出来的数字', () => {
    // 折叠态「固定两行」的真正含义：内容区的高度恰好等于两行格子的高度，一行不多一行不少
    expect(2 * CARD_PAD_Y + HEAD_H + gridSizeOf(COLLAPSED_COLS, COLLAPSED_ROWS).height).toBe(COLLAPSED_H)
    expect(2 * CARD_PAD_X + gridSizeOf(COLLAPSED_COLS, COLLAPSED_ROWS).width).toBe(COLLAPSED_W)
  })

  it('折叠态容量 = 3 列 × 2 行 = 6 格', () => {
    expect(visibleCapacityOf()).toBe(6)
  })
})

describe('展开态几何（工单原文：宽 2 倍、高 4 倍、重排 6 列）', () => {
  it('宽 ×2 = 640、高 ×4 = 976（字面量取自工单180「What to build」）', () => {
    expect(EXPANDED_W).toBe(640)
    expect(EXPANDED_H).toBe(976)
    // 并且真的是 ×2 / ×4（若有人改了折叠态，比例关系要跟着一起被钉住）
    expect(EXPANDED_W).toBe(COLLAPSED_W * 2)
    expect(EXPANDED_H).toBe(COLLAPSED_H * 4)
  })

  it('内容区重排为 6 列：6×88 + 5×8 = 568', () => {
    expect(EXPANDED_COLS).toBe(6)
    expect(gridSizeOf(EXPANDED_COLS, 1).width).toBe(568)
  })

  it('展开态的内容区填满卡框：976 − 18×2 − 24 = 916', () => {
    expect(expandedContentHeight()).toBe(916)
    expect(2 * CARD_PAD_Y + HEAD_H + expandedContentHeight()).toBe(EXPANDED_H)
  })

  it('【与工单原文的差，已记录】卡框按「高 4 倍」定死，内容区即填满它 → 可见 10 行，不是原文的 8 行', () => {
    // 工单原文「内容区重排为 6 列 × 8 行」与「高度 4 倍（976）」互斥：8 行内容区只有 760 高，
    // 卡框里会空出 156px。验收清单（权威口径）只要求「高 4 倍 + 6 列 + 出现纵向滚动条」，
    // 故本票取卡框 976、内容区填满；可见行数由几何算出来是 10。
    // 若产品最终要 8 行，改法只有一处：让内容区退回 760（见 geometry.js expandedContentHeight）。
    expect(expandedVisibleRows()).toBe(10)
  })

  it('cardGeometryOf 两态各归其位：宽度/列数随折叠切换，格子大小不变', () => {
    const collapsed = cardGeometryOf(false)
    const expanded = cardGeometryOf(true)
    expect(collapsed).toEqual({
      width: 320, height: 244, cols: 3, rows: 2, contentWidth: 280, contentHeight: 184,
    })
    // rows = 该态内容区「看得见几行」：折叠 2 行固定；展开 10 行（见下条「与工单原文的差」）
    expect(expanded).toEqual({
      width: 640, height: 976, cols: 6, rows: 10, contentWidth: 568, contentHeight: 916,
    })
    // 单格尺寸两态一致：展开只重排列数与高度，不把图标放大（放大就不是「同一批文件」了）
    expect(CELL).toBe(88)
  })
})

describe('可见数与剩余数（折叠：隐藏而不丢弃）', () => {
  it('折叠态实际露出的格数 = min(总数, 6)', () => {
    expect(visibleCountOf(0)).toBe(0)
    expect(visibleCountOf(1)).toBe(1)
    expect(visibleCountOf(6)).toBe(6)
    expect(visibleCountOf(7)).toBe(6)
    expect(visibleCountOf(200)).toBe(6)
  })

  it('剩余数 = 总数 − 容量，下限 0（刚好装满不是溢出）', () => {
    expect(remainingCountOf(6)).toBe(0)
    expect(remainingCountOf(7)).toBe(1)
    expect(remainingCountOf(20)).toBe(14)
    expect(remainingCountOf(0)).toBe(0)
  })

  it('剩余数只算差值、不裁剪总数：文件一个都不丢（隐藏 ≠ 丢弃）', () => {
    // 20 个文件：折叠露 6 个、藏 14 个，6 + 14 === 20
    expect(visibleCountOf(20) + remainingCountOf(20)).toBe(20)
  })
})

describe('「+N」徽标（仅在确有溢出时出现）', () => {
  it('恰好装得下 → 空串（徽标不渲染）', () => {
    expect(moreLabelOf(6)).toBe('')
    expect(moreLabelOf(0)).toBe('')
    expect(hasOverflow(6)).toBe(false)
  })

  it('确有溢出 → 「+剩余数」', () => {
    expect(moreLabelOf(7)).toBe('+1')
    expect(moreLabelOf(20)).toBe('+14')
    expect(hasOverflow(7)).toBe(true)
  })

  it('徽标数的是折叠态藏起来的那些：20 个文件 → 露 6、藏 14、徽标 +14', () => {
    // 刻意与「展开态」无关：徽标是「为什么要展开」的说明，展开中改数会让用户以为文件变了
    expect(visibleCountOf(20)).toBe(6)
    expect(remainingCountOf(20)).toBe(14)
    expect(moreLabelOf(20)).toBe('+14')
  })
})

describe('整排布局（工单179 的居中裁决保留；工单180 追加「重新垂直居中」）', () => {
  const IDS = ['dgc-docx', 'dgc-pdf']

  it('折叠态：整行水平居中 + 按视口垂直居中（两张卡 320 宽、间距 18）', () => {
    const layout = rowLayoutOf(IDS, VIEWPORT, '')
    // 行宽 = 320×2 + 18 = 658；left = (2560 − 658)/2 = 950.5 → 951（SETTLED：居中保留）
    expect(layout.map((b) => b.left)).toEqual([951, 1289])
    // top = (1440 − 244)/2 = 598
    expect(layout.every((b) => b.top === 598)).toBe(true)
    expect(layout.every((b) => b.width === 320 && b.height === 244)).toBe(true)
    expect(layout.every((b) => b.expanded === false)).toBe(true)
  })

  it('展开态：展开卡独占屏幕正中（left = (2560−640)/2 = 960）', () => {
    const layout = rowLayoutOf(IDS, VIEWPORT, 'dgc-pdf')
    const expanded = layout.find((b) => b.id === 'dgc-pdf')
    expect(expanded).toEqual({ id: 'dgc-pdf', left: 960, top: 232, width: 640, height: 976, expanded: true })
  })

  it('展开态重新垂直居中：top = (1440−976)/2 = 232，底边 1208 不顶任务栏（上沿 1392）', () => {
    const [b] = rowLayoutOf(IDS, VIEWPORT, 'dgc-docx')
    expect(b.top).toBe(232)
    // 不重新居中会沿用折叠态的 top=598 → 底边 1574，越过视口 1440 直插任务栏，这是工单点名要躲的坑
    expect(b.top + b.height).toBe(1208)
    expect(b.top + b.height).toBeLessThanOrEqual(VIEWPORT.height - TASKBAR_H)
    // 顺带把「若不重新居中」的后果钉死：598 + 976 = 1574 > 1440，必然撞任务栏
    expect(598 + 976).toBeGreaterThan(VIEWPORT.height)
  })

  it('展开卡不压左右栏：左沿 960 > 左栏右沿 368', () => {
    const b = rowLayoutOf(IDS, VIEWPORT, 'dgc-docx')[0]
    expect(b.left).toBeGreaterThan(SIDE_COLUMN.right)
    // 居中展开时左右两侧都留出对称的余量（不靠左锚，SETTLED 裁决：不改成左锚）
    expect(b.left).toBe(VIEWPORT.width - (b.left + b.width))
  })

  it('其余卡在展开时**原地不动**（只有展开卡改形状；淡出是样式层的事）', () => {
    const collapsed = rowLayoutOf(IDS, VIEWPORT, '')
    const expanded = rowLayoutOf(IDS, VIEWPORT, 'dgc-docx')
    const other = expanded.find((b) => b.id === 'dgc-pdf')
    expect(other).toBeDefined()
    expect({ left: other?.left, top: other?.top, width: other?.width, height: other?.height })
      .toEqual({ left: collapsed[1].left, top: collapsed[1].top, width: 320, height: 244 })
  })

  it('卡序即行序，id 顺序决定横坐标（相对位置稳定，与卡数无关）', () => {
    const three = rowLayoutOf(['a', 'b', 'c'], VIEWPORT, '')
    expect(three.map((b) => b.id)).toEqual(['a', 'b', 'c'])
    expect(three[1].left - three[0].left).toBe(COLLAPSED_W + CARD_GAP)
  })

  it('换一组视口同样居中（960×800 的小屏也成立）', () => {
    const layout = rowLayoutOf(['dgc-docx'], { width: 960, height: 800 }, 'dgc-docx')
    expect(layout[0].left).toBe(160) // (960 − 640)/2
    expect(layout[0].top).toBe(-88) // (800 − 976)/2 = −88：高过屏时居中即溢出，交给用户滚，不偷偷上移
  })

  it('零张卡不炸（空桌面也走同一条路）', () => {
    expect(rowLayoutOf([], VIEWPORT, '')).toEqual([])
  })
})
