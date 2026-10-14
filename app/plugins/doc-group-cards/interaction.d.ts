// interaction.js 的类型声明（工单181）。
//
// 与 grouping.d.ts 同一个理由：投放型插件包的源码就是投放单元，入口只收 .js/.mjs，
// 没有编译步骤；而本仓库 tsconfig 没开 allowJs——TS 测试 import 这个 .js 时若没有
// 同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。故每个纯模块都配一份声明。
//
// 声明与实现一一对应；改 interaction.js 的签名时同步改这里。

/** 点击落点：图标格 / 卡片空白 / 「更多」徽标 / 都不算 */
export type ClickHit = 'icon' | 'card-blank' | 'more' | 'outside'

/**
 * 卡片级交互态（**插件自建**，与内核选区无任何往来）。
 * `expanded` 是工单180 的接缝：几何挂在 EXPANDED_CLASS 上，本模块只切这个布尔量。
 */
export type CardUiState = {
  expanded: boolean
  /** 高亮的绝对路径集合（单选语义：后点的顶掉先点的） */
  highlight: ReadonlySet<string>
}

/** 卡片根类名，同时是本插件样式表的作用域根 */
export declare const CARD_CLASS: string
/** 组内单格（一个文件图标） */
export declare const CELL_CLASS: string
/** 「更多」徽标（工单180 落 +N 徽标时用它） */
export declare const MORE_CLASS: string
/** 展开态类名 —— 工单180 的几何接缝 */
export declare const EXPANDED_CLASS: string
/** 高亮类名（插件私有，不叫内核那个 `sel`） */
export declare const HIGHLIGHT_CLASS: string

/** 卡片级监听器该不该切换折叠：图标命中为 false（那道闸） */
export declare function isCardToggle(hit: ClickHit): boolean

export declare function initialCardState(): CardUiState

export declare function isHighlighted(state: CardUiState, path: string): boolean

/** 点图标：只高亮 + 截断冒泡，展开态不动 */
export declare function clickOnIcon(
  state: CardUiState,
  path: string,
): { state: CardUiState; stopPropagation: true; action: 'highlight' }

/** 点空白/徽标：折叠往复切换 + 清高亮 */
export declare function clickOnCardBlank(
  state: CardUiState,
): { state: CardUiState; stopPropagation: false; action: 'toggle-expand' }

/** 状态 → 展开类名（收起态返回空串） */
export declare function expandedClassOf(state: CardUiState): string

/** 状态 → 某格的高亮类名（未高亮返回空串） */
export declare function highlightClassOf(state: CardUiState, path: string): string
