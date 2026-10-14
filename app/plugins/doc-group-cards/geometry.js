// 组卡的折叠/展开几何与溢出计数（工单180 = spec166 之③）。
//
// 与同目录 grouping.js、interaction.js 同一条缝：**纯模块、零 DOM、零 Electron**，vitest 直测。
// 插件源码就是投放单元（面板经 deck-plugin:// 原样 import，无编译步骤），所以「还剩几个文件」
// 与「展开后这张卡多大、摆在哪」这两类裁决必须离开 DOM 才能被测——它们也是最容易在演进中
// 各自漂移的两类数字，故各自只有这一处出处，card.js 一个数都不许另写。
//
// 三个概念别混：
//   - **可见数**（折叠态露出的格数）——「隐藏而不丢弃」：文件仍在 DOM 里，只是没露出。
//   - **剩余数**（折叠态藏起来的个数）——就是「+N」徽标上的那个 N。
//   - **卡框** vs **内容区**——卡框含内边距与卡头；内容区只有格子那一片，展开态它自己滚动。
//
// 居中裁决（SETTLED，工单179 的结论，本票沿用不得推翻）：折叠态整行保持水平居中，卡数变化时
// 整行随之平移是**预期行为**；「位置不随文件增删而跳动」指的是相对顺序稳定，不是绝对 x 不变。
// 展开态则让展开卡独占屏幕正中，并**按它自己的高度重新垂直居中**——沿用折叠态的 top 会让
// 底边直接越过视口插进任务栏（976 高 + 598 的 top = 1574 > 1440）。

/** 面板 `.card` 底盘的横向内边距（index.html `.card { padding: 18px 20px }`） */
export const CARD_PAD_X = 20
/** 面板 `.card` 底盘的纵向内边距（同上） */
export const CARD_PAD_Y = 18
/** 卡头行高（`.card h2` 家族；定死它，热区矩形才稳定） */
export const HEAD_H = 24
/** 单格边长：两态一致，展开只重排列数，不把图标放大 */
export const CELL = 88
/** 格子间距 */
export const CELL_GAP = 8
/** 卡间横向留白，与内核文档区的 column-gap（`#doc-groups`）同值 */
export const CARD_GAP = 18

// ---- 折叠态（工单179 的表，本票一个字都不许改）----
export const COLLAPSED_COLS = 3
export const COLLAPSED_ROWS = 2
export const COLLAPSED_W = 320
export const COLLAPSED_H = 244

// ---- 展开态（工单原文：宽 2 倍、高 4 倍、重排 6 列）----
export const EXPANDED_COLS = 6
export const EXPANDED_W = COLLAPSED_W * 2
export const EXPANDED_H = COLLAPSED_H * 4

/**
 * 折叠态一屏的格数（3 列 × 2 行 = 6）。
 * 「折叠态内容区固定两行」的几何出处：内容区高度恰好等于两行格子高度，溢出部分 `overflow:hidden`。
 * @param {number} [cols]
 * @param {number} [rows]
 * @returns {number}
 */
export function visibleCapacityOf(cols = COLLAPSED_COLS, rows = COLLAPSED_ROWS) {
  return cols * rows
}

/**
 * 折叠态实际露出的格数。**隐藏不等于丢弃**：藏起来的文件仍在 DOM 里（见 card.js 的绘制），
 * 这只是「这一屏最多露几个」。
 * @param {number} total 组内文件总数
 * @returns {number}
 */
export function visibleCountOf(total) {
  return Math.max(0, Math.min(total, visibleCapacityOf()))
}

/**
 * 折叠态藏起来的个数，即「+N」徽标上的 N（无溢出为 0）。
 * @param {number} total
 * @returns {number}
 */
export function remainingCountOf(total) {
  return Math.max(0, total - visibleCapacityOf())
}

/**
 * 确有溢出吗——徽标「仅在确有溢出时出现」的唯一判据。
 * @param {number} total
 * @returns {boolean}
 */
export function hasOverflow(total) {
  return remainingCountOf(total) > 0
}

/**
 * 「+N」徽标文案；无溢出返回空串（调用方据此**不渲染**徽标，而不是渲染一个空的）。
 * @param {number} total
 * @returns {string}
 */
export function moreLabelOf(total) {
  const remaining = remainingCountOf(total)
  return remaining > 0 ? `+${remaining}` : ''
}

/**
 * 内容区（格子网格）的尺寸。
 * @param {number} cols
 * @param {number} rows
 * @returns {{ width: number, height: number }}
 */
export function gridSizeOf(cols, rows) {
  return {
    width: cols * CELL + (cols - 1) * CELL_GAP,
    height: rows * CELL + (rows - 1) * CELL_GAP,
  }
}

/**
 * 展开态内容区的高度：卡框扣掉内边距与卡头，**填满**剩下的全部。
 *
 * 【与工单原文的差，已记录】工单写的是「内容区重排为 6 列 × 8 行」，而卡框又写「高度 4 倍（976）」；
 * 8 行内容区只有 760 高，976 的卡框里会空出 156px 一条死带。验收清单（权威口径）只要求
 * 「宽 2 倍 + 高 4 倍 + 重排 6 列 + 出现纵向滚动条」，故本票取卡框 976、内容区填满，
 * 可见行数由几何算得 10。若产品最终要 8 行，改法只有这一行：返回 `gridSizeOf(EXPANDED_COLS, 8).height`。
 * @returns {number}
 */
export function expandedContentHeight() {
  return EXPANDED_H - 2 * CARD_PAD_Y - HEAD_H
}

/**
 * 展开态内容区看得见几行（行距 = 格高 + 间距，不足半行也露半行，故向上取整）。
 * @returns {number}
 */
export function expandedVisibleRows() {
  const pitch = CELL + CELL_GAP
  return Math.max(1, Math.ceil((expandedContentHeight() + CELL_GAP) / pitch))
}

/**
 * 一态的卡片几何。`rows` 是该态内容区**看得见几行**（折叠 2 行固定；展开由内容区高度算出）。
 * @param {boolean} expanded
 * @returns {{ width: number, height: number, cols: number, rows: number, contentWidth: number, contentHeight: number }}
 */
export function cardGeometryOf(expanded) {
  if (!expanded) {
    const grid = gridSizeOf(COLLAPSED_COLS, COLLAPSED_ROWS)
    return {
      width: COLLAPSED_W,
      height: COLLAPSED_H,
      cols: COLLAPSED_COLS,
      rows: COLLAPSED_ROWS,
      contentWidth: grid.width,
      contentHeight: grid.height,
    }
  }
  return {
    width: EXPANDED_W,
    height: EXPANDED_H,
    cols: EXPANDED_COLS,
    rows: expandedVisibleRows(),
    contentWidth: gridSizeOf(EXPANDED_COLS, 1).width,
    contentHeight: expandedContentHeight(),
  }
}

/**
 * 整排布局：卡序 + 哪一张展开着 → 每张卡的几何。
 *
 * - 都没展开：整行水平居中 + 按**折叠卡**的高度垂直居中（工单179 的表，SETTLED 居中裁决）。
 * - 有一张展开：**只有那一张**改形状并独占屏幕正中（水平居中 + 按展开卡自己的高度重新垂直居中）；
 *   其余卡的位置、尺寸一字不动——淡出是样式层的事（`dgc-faded`），几何不参与，故整排不会二次抖动。
 *
 * @param {readonly string[]} ids 卡序（渲染顺序即 Map 的插入顺序）
 * @param {{ width: number, height: number }} viewport 视口（面板窗 = 主显示器全屏 bounds，含任务栏）
 * @param {string} expandedId 当前展开的卡 id；空串 = 都没展开
 * @returns {{ id: string, left: number, top: number, width: number, height: number, expanded: boolean }[]}
 */
export function rowLayoutOf(ids, viewport, expandedId) {
  const collapsed = cardGeometryOf(false)
  const expanded = cardGeometryOf(true)
  // 行宽按**折叠**卡算（含展开的那张）：折叠态是常态，整排的基准位置不能被展开态扰动
  const rowWidth = ids.length * collapsed.width + Math.max(0, ids.length - 1) * CARD_GAP
  const rowLeft = Math.round((viewport.width - rowWidth) / 2)
  const collapsedTop = Math.round((viewport.height - collapsed.height) / 2)
  const expandedLeft = Math.round((viewport.width - expanded.width) / 2)
  // 重新垂直居中：不重新算的话 976 高的卡沿用折叠态的 top，底边会越过视口插进任务栏
  const expandedTop = Math.round((viewport.height - expanded.height) / 2)
  return ids.map((id, i) => {
    const isExpanded = id === expandedId
    const geo = isExpanded ? expanded : collapsed
    return {
      id,
      left: isExpanded ? expandedLeft : rowLeft + i * (collapsed.width + CARD_GAP),
      top: isExpanded ? expandedTop : collapsedTop,
      width: geo.width,
      height: geo.height,
      expanded: isExpanded,
    }
  })
}
