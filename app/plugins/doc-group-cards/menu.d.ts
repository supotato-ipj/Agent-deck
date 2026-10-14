// menu.js 的类型声明（工单182）。与 grouping.d.ts / interaction.d.ts / geometry.d.ts 同一个理由：
// 投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有编译步骤；而本仓库 tsconfig 没开
// allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。
//
// 声明与实现一一对应；改 menu.js 的签名时同步改这里。
// 这份声明同时是**后续几票的接缝说明书**：工单184/185/186 只需往 `MenuRowSpec` 的行表里加行
// （或改 needs 档、补 visibleWhen），不需要改本文件的任何签名——工单183 正是这么加的。

/** 一行需要什么才可用（选区口径） */
export type RowNeed = 'any' | 'single' | 'pasteable'

/** 菜单上下文：当前选区 + 剪贴板实况 + 来源卡片 */
export type MenuCtx = {
  /** 当前选区（绝对路径数组；工单182 为单选，一个路径） */
  paths: readonly string[]
  /** 剪贴板可贴实况（needs:'pasteable' 的行读它） */
  pasteable?: boolean
  /** 触发本次开层的卡片 id（组卡菜单用；文件菜单为空串。工单185 按它判卡片身份） */
  cardId?: string
}

/** 行描述符：数据驱动的一行。动作回调不进状态，由 card.js 旁路持有 */
export type MenuRowSpec = {
  id: string
  label: string
  needs?: RowNeed
  /** 可见性谓词（工单185 的接缝；缺省恒可见） */
  visibleWhen?: (ctx: MenuCtx) => boolean
}

/** 渲染端要画的一行（描述符 + 当前上下文下的可用性） */
export type MenuRowState = {
  id: string
  label: string
  enabled: boolean
}

/** 菜单盒尺寸 */
export type MenuSize = { width: number; height: number }

/** 钳制后的落位（左上角 + 尺寸，四个数一起写进内联样式） */
export type MenuBox = MenuSize & { left: number; top: number }

/** 视口（面板窗 = 主显示器全屏 bounds，含任务栏占位） */
export type Viewport = { width: number; height: number }

/** 壳状态 */
export type MenuShellState = {
  open: boolean
  /** 光标原点（存证用；真正落位的是钳制后的 box） */
  x: number
  y: number
  /** 本次打开解析出来的行表 */
  rows: readonly MenuRowState[]
  /** 本次打开冻结的选区（动作作用于它） */
  paths: readonly string[]
  /** 本次打开冻结的来源卡片 id（组卡菜单用；文件菜单为空串） */
  cardId: string
  box: MenuBox
}

/** 一个事件的全部副作用（按数组序执行） */
export type MenuEffect =
  | { kind: 'keyboard-tier'; held: boolean }
  | { kind: 'show'; rows: readonly MenuRowState[]; box: MenuBox }
  | { kind: 'hide' }
  | { kind: 'run'; id: string; paths: readonly string[]; cardId: string }
  | { kind: 'hotzones' }
  | { kind: 'notify'; type: string; payload?: Record<string, unknown> }

export type MenuShellEvent =
  | { type: 'open'; x: number; y: number; viewport: Viewport; specs: readonly MenuRowSpec[]; ctx: MenuCtx }
  | { type: 'activate'; id: string }
  | { type: 'dismiss'; reason: string }
  | { type: 'esc' }
  | { type: 'unmount' }

export type MenuShellResult = { state: MenuShellState; effects: MenuEffect[] }

/** 菜单宽度（钳制算式与画出来的盒子同源的唯一出处） */
export declare const MENU_W: number
/** 单行高 */
export declare const MENU_ROW_H: number
/** 菜单上下内边距 */
export declare const MENU_PAD_Y: number
/** 出屏钳制的边距 */
export declare const MENU_EDGE: number

/** 全屏遮罩的 id（它同时是 class='card'，故进热区扫掠；热区身份靠 id，不去重，取唯一） */
export declare const OVERLAY_ID: string
export declare const OVERLAY_CLASS: string
export declare const PANEL_ID: string
export declare const PANEL_CLASS: string
export declare const ROW_CLASS: string
export declare const DISABLED_CLASS: string
export declare const MENU_STYLE_ID: string
/** 键盘档名（宿主按插件 id 加命名空间） */
export declare const KEYBOARD_TIER: string

/** 存证族（本插件一律 doc-group-cards-menu-*，不冒充内核的 desktop-menu-*） */
export declare const MENU_OPENED_NOTIFY: string
export declare const MENU_CLOSED_NOTIFY: string
export declare const MENU_ACTION_NOTIFY: string

/** 菜单自带样式（几何数值从上面的常量插值，与 menuSizeOf 同源） */
export declare const MENU_CSS: string

export declare const NEED_ANY: RowNeed
export declare const NEED_SINGLE: RowNeed
export declare const NEED_PASTEABLE: RowNeed

/** 文件菜单（单选）七项：工单182 的只读五项 + 工单183 的 RENAME / DELETE */
export declare const FILE_MENU_ROWS: readonly MenuRowSpec[]
/** 组卡菜单（卡片空白处右键）行表：工单183 只立骨架与接线，四行由工单185/186 往里加 */
export declare const GROUP_CARD_MENU_ROWS: readonly MenuRowSpec[]

/** 一行在当前上下文下可不可用（唯一的置灰裁决出口） */
export declare function rowEnabledOf(spec: MenuRowSpec, ctx: MenuCtx): boolean
/** 一行在当前上下文下该不该出现（唯一的可见性裁决出口） */
export declare function rowVisibleOf(spec: MenuRowSpec, ctx: MenuCtx): boolean
/** 行描述符 + 上下文 → 渲染端要画的那张表 */
export declare function resolveMenuRows(specs: readonly MenuRowSpec[], ctx: MenuCtx): MenuRowState[]
/** 菜单盒尺寸 */
export declare function menuSizeOf(rows: readonly unknown[], count?: number): MenuSize
/** 光标原点钳制：菜单定位不出屏 */
export declare function clampMenuBox(
  anchor: { x: number; y: number },
  size: MenuSize,
  viewport: Viewport,
  edge?: number,
): MenuBox
/** 壳的转移矩阵 */
export declare function nextMenuShell(state: MenuShellState, event: MenuShellEvent): MenuShellResult
/** 闭态 */
export declare const CLOSED_MENU: MenuShellState
