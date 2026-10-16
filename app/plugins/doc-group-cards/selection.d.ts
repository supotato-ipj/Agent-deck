// selection.js 的类型声明（工单184）。
//
// 与 grouping.d.ts / interaction.d.ts 同一个理由：投放型插件包的源码就是投放单元，入口只收
// .js/.mjs，没有编译步骤；而本仓库 tsconfig 没开 allowJs——TS 测试 import 这个 .js 时若没有
// 同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。
//
// 声明与实现一一对应；改 selection.js 的签名时同步改这里。

import type { CardUiState, CardStateTable } from './interaction'

/** 一个矩形（网格局部坐标或视口坐标，同一套算式） */
export type Rect = { x: number; y: number; width: number; height: number }

/** 框选候选格：路径 + 它的矩形。**只放本卡的格子**——命中集卡内由此结构性保证 */
export type MarqueeCell = Rect & { path: string }

/** 多选开关的类名（挂在卡头上，每张卡一枚） */
export declare const MULTI_CLASS: string
/** 开关打开时的附加类名 */
export declare const MULTI_ON_CLASS: string
/** 框选拖拽带的类名 */
export declare const MARQUEE_CLASS: string
/** ENTER 批量启动的键盘档名（宿主按插件 id 加命名空间） */
export declare const SELECT_KEYBOARD_TIER: string
/** 多选态存证族 */
export declare const MULTI_TOGGLED_NOTIFY: string
/** 批量启动存证族 */
export declare const SELECTION_LAUNCHED_NOTIFY: string

export declare function isMultiOn(state: CardUiState): boolean

/** 多选开关：往复切换；关掉即清空选区；展开态不动 */
export declare function toggleMulti(
  state: CardUiState,
): { state: CardUiState; stopPropagation: true; action: 'toggle-multi' }

/** 多选态单击：切换选中（并集语义），并截断冒泡 */
export declare function toggleSelection(
  state: CardUiState,
  path: string,
): { state: CardUiState; stopPropagation: true; action: 'toggle-select' }

/** 该卡当前选中的路径（加入顺序） */
export declare function selectionPathsOf(state: CardUiState): string[]

/** 右键该把菜单作用于谁：多选态下已选中项 → 整个选中集；未选中项 → 单独选中它 */
export declare function menuSelectionFor(state: CardUiState, path: string): string[]

export declare function marqueeRectOf(from: { x: number; y: number }, to: { x: number; y: number }): Rect

/** 半开区间相交判据：紧贴边不算相交 */
export declare function rectsOverlap(a: Rect, b: Rect): boolean

/** 框选命中集：只从传进来的那张表里取，故天然卡内；零尺寸框不命中 */
export declare function marqueeHits(rect: Rect, cells: readonly MarqueeCell[]): string[]

/** 框选落定：选区整批替换成命中集合；框空即清空；只在多选态下成立 */
export declare function marqueeSelect(
  state: CardUiState,
  rect: Rect,
  cells?: readonly MarqueeCell[],
): { state: CardUiState; stopPropagation: false; action: 'marquee-select' }

/** ENTER 该启动谁：仅多选态的整个选中集；单选态与空选区都返回空数组 */
export declare function launchTargetsOf(state: CardUiState): string[]

/** 全表里有卡在多选且选区非空（= 键盘档该不该持） */
export declare function hasSelection(states: CardStateTable): boolean
