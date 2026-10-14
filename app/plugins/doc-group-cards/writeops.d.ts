// writeops.js 的类型声明（工单183）。与 grouping.d.ts / interaction.d.ts / geometry.d.ts /
// menu.d.ts / card.d.ts 同一个理由：投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有
// 编译步骤；而本仓库 tsconfig 没开 allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，
// tsc 报 TS2307，`npm run typecheck` 即红。
//
// 声明与实现一一对应；改 writeops.js 的签名时同步改这里。
//
// 这份声明同时是**两块自绘写操作层的接口说明书**：确认层与编辑器各是一个「状态 + 一个事件
// 一次合成」的归约器，动作回调不进状态（由 card.js 旁路持有并经内核既有桥接契约执行）。

// ---------------------------------------------------------------------------
// 删除确认层
// ---------------------------------------------------------------------------

/** 视口（面板窗 = 主显示器全屏 bounds，含任务栏占位） */
export type Viewport = { width: number; height: number }

/** 落位盒子（左上角 + 尺寸，四个数一起写进内联样式） */
export type Box = { left: number; top: number; width: number; height: number }

/** 确认层状态：开层时冻结的文件名清单（显示用）与绝对路径（真正送给 desktop/trash 的载荷） */
export type ConfirmState = {
  open: boolean
  names: readonly string[]
  paths: readonly string[]
}

/** 确认层的一个事件的全部副作用（按数组序执行） */
export type ConfirmEffect =
  | { kind: 'tier'; held: boolean }
  | { kind: 'show'; names: readonly string[]; box: Box }
  | { kind: 'hide' }
  | { kind: 'run'; op: 'trash'; paths: readonly string[] }
  | { kind: 'hotzones' }
  | { kind: 'notify'; type: string; payload?: Record<string, unknown> }

export type ConfirmEvent =
  | { type: 'open'; names: readonly string[]; paths: readonly string[] }
  | { type: 'confirm' }
  | { type: 'cancel'; reason: string }
  | { type: 'esc' }
  | { type: 'outside' }
  | { type: 'unmount' }

export type ConfirmResult = { state: ConfirmState; effects: ConfirmEffect[] }

/** 闭态 */
export declare const CLOSED_CONFIRM: ConfirmState

/** 确认层标题（单数/复数，与内核同款措辞） */
export declare function confirmTitleOf(names: readonly string[]): string
/** 文案行数：标题一行 + 文件名每件一行 */
export declare function confirmLinesOf(names: readonly string[]): number
/** 确认层盒子尺寸 */
export declare function confirmSizeOf(names: readonly string[]): { width: number; height: number }
/** 确认层落位：视口正中 */
export declare function confirmBoxOf(viewport: Viewport, names: readonly string[]): Box
/** 删除确认层的转移矩阵 */
export declare function nextConfirmLayer(state: ConfirmState, event: ConfirmEvent, viewport: Viewport): ConfirmResult

// ---------------------------------------------------------------------------
// 内联重命名编辑器
// ---------------------------------------------------------------------------

/** 编辑器状态：开层时冻结的条目身份 + 草稿 + 预选右端 */
export type RenameState = {
  open: boolean
  name: string
  path: string
  draft: string
  stem: number
}

export type RenameEffect =
  | { kind: 'tier'; held: boolean }
  | { kind: 'show'; path: string; value: string; stem: number }
  | { kind: 'hide' }
  | { kind: 'run'; op: 'rename'; name: string; to: string }
  | { kind: 'notify'; type: string; payload?: Record<string, unknown> }

export type RenameEvent =
  | { type: 'open'; name: string; path: string; display: string }
  | { type: 'submit' }
  | { type: 'cancel'; reason: string }
  | { type: 'esc' }
  | { type: 'outside' }
  | { type: 'unmount' }

export type RenameResult = { state: RenameState; effects: RenameEffect[] }

/** 闭态 */
export declare const CLOSED_RENAME: RenameState

/** 预选右端：扩展名之前的位置；无扩展名即全文 */
export declare function stemEndOf(display: string): number
/** 内联重命名编辑器的转移矩阵 */
export declare function nextRenameEditor(state: RenameState, event: RenameEvent): RenameResult

// ---------------------------------------------------------------------------
// 常量（id / 类名 / 键盘档名 / 存证族 / 样式 / 几何）
// ---------------------------------------------------------------------------

export declare const CONFIRM_OVERLAY_ID: string
export declare const CONFIRM_OVERLAY_CLASS: string
export declare const CONFIRM_BOX_ID: string
export declare const CONFIRM_BOX_CLASS: string
export declare const CONFIRM_TEXT_ID: string
export declare const CONFIRM_TEXT_CLASS: string
export declare const CONFIRM_OK_ID: string
export declare const CONFIRM_OK_CLASS: string
export declare const CONFIRM_CANCEL_ID: string
export declare const CONFIRM_CANCEL_CLASS: string
export declare const CONFIRM_STYLE_ID: string
export declare const RENAME_INPUT_CLASS: string

export declare const CONFIRM_KEYBOARD_TIER: string
export declare const RENAME_KEYBOARD_TIER: string

export declare const CONFIRM_OPENED_NOTIFY: string
export declare const CONFIRM_CLOSED_NOTIFY: string
export declare const RENAME_OPENED_NOTIFY: string
export declare const RENAME_CLOSED_NOTIFY: string

export declare const CONFIRM_W: number
export declare const CONFIRM_LINE_H: number
export declare const CONFIRM_PAD_Y: number
export declare const CONFIRM_GAP_Y: number
export declare const CONFIRM_BTN_H: number

/** 确认层样式（几何数值从上面的常量插值，与 confirmSizeOf 同源） */
export declare const CONFIRM_CSS: string
/** 内联重命名编辑器样式（作用域根由调用方给；并入 card.js 的 CARD_CSS 一起插，不另起样式元素） */
export declare function renameCssOf(scope: string): string
