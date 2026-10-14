// geometry.js 的类型声明（工单180）。与 grouping.d.ts / interaction.d.ts 同一个理由：
// 投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有编译步骤；而本仓库 tsconfig 没开
// allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。
//
// 声明与实现一一对应；改 geometry.js 的签名时同步改这里。

/** 一态的卡片几何 */
export type CardGeometry = {
  width: number
  height: number
  /** 内容区的列数 */
  cols: number
  /** 该态内容区看得见几行 */
  rows: number
  /** 内容区宽（格子网格自己的宽度，展开态小于卡框减去内边距的余量） */
  contentWidth: number
  /** 内容区高（折叠态固定两行；展开态填满卡框） */
  contentHeight: number
}

/** 整排里一张卡的几何 */
export type CardBox = {
  id: string
  left: number
  top: number
  width: number
  height: number
  expanded: boolean
}

/** 视口（面板窗 = 主显示器全屏 bounds，含任务栏占位） */
export type Viewport = { width: number; height: number }

/** 面板 `.card` 底盘的横向内边距 */
export declare const CARD_PAD_X: number
/** 面板 `.card` 底盘的纵向内边距 */
export declare const CARD_PAD_Y: number
/** 卡头行高 */
export declare const HEAD_H: number
/** 单格边长（两态一致） */
export declare const CELL: number
/** 格子间距 */
export declare const CELL_GAP: number
/** 卡间横向留白 */
export declare const CARD_GAP: number

/** 折叠态：3 列 × 2 行，卡 320×244 */
export declare const COLLAPSED_COLS: number
export declare const COLLAPSED_ROWS: number
export declare const COLLAPSED_W: number
export declare const COLLAPSED_H: number

/** 展开态：6 列，卡 640×976（折叠态的 2 倍宽、4 倍高） */
export declare const EXPANDED_COLS: number
export declare const EXPANDED_W: number
export declare const EXPANDED_H: number

/** 折叠态一屏格数（6） */
export declare function visibleCapacityOf(cols?: number, rows?: number): number
/** 折叠态实际露出的格数（隐藏而不丢弃） */
export declare function visibleCountOf(total: number): number
/** 折叠态藏起来的个数（徽标 +N 的 N） */
export declare function remainingCountOf(total: number): number
/** 确有溢出会出现徽标吗 */
export declare function hasOverflow(total: number): boolean
/** 「+N」徽标文案；无溢出返回空串（调用方据此不渲染徽标） */
export declare function moreLabelOf(total: number): string
/** 内容区尺寸 */
export declare function gridSizeOf(cols: number, rows: number): { width: number; height: number }
/** 展开态内容区高度（填满卡框） */
export declare function expandedContentHeight(): number
/** 展开态内容区看得见几行 */
export declare function expandedVisibleRows(): number
/** 一态的卡片几何 */
export declare function cardGeometryOf(expanded: boolean): CardGeometry
/** 整排布局：卡序 + 展开态 → 每张卡的几何 */
export declare function rowLayoutOf(
  ids: readonly string[],
  viewport: Viewport,
  expandedId: string,
): CardBox[]
