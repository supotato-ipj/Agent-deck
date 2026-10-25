// typepicker.js 的类型声明（工单185）。与 writeops.d.ts / menu.d.ts 同一个理由：
// 投放型插件包的源码就是投放单元，入口只收 .js/.mjs，没有编译步骤；而本仓库 tsconfig 没开
// allowJs——TS 测试 import 这个 .js 时若没有同名 .d.ts，tsc 报 TS2307，`npm run typecheck` 即红。
//
// 声明与实现一一对应；改 typepicker.js 的签名时同步改这里。

/** 勾选浮层里的一行（桌面上此刻真实存在的那个扩展名） */
export type TypeRow = { ext: string; label: string }

export type TypePickerMode = 'create' | 'edit'

export type TypePickerState = {
  open: boolean
  /** create = NEW GROUP（要起名）；edit = EDIT TYPES（只改类型，不改卡名） */
  mode: TypePickerMode
  /** 被改的那张自定义卡的 id（建卡模式为空串；改类型时开层时冻结） */
  cardId: string
  /** 那张卡的卡面名（仅供显示） */
  label: string
  /** 名字草稿（仅 create） */
  name: string
  /** 「没名」的自陈（仅 create；不替用户编一个名） */
  nameError: string
  /** 「接受全部类型」开关 */
  acceptAll: boolean
  /** 开层时冻结的清单（只含桌面上此刻真实存在的扩展名） */
  present: TypeRow[]
  /** 声明里真正勾着的扩展名（含桌面上暂时没有文件的那些，保存不清） */
  picked: string[]
}

/** 盒子（left/top/width/height 四个数一起写进内联样式） */
export type TypePickerBox = { left: number; top: number; width: number; height: number }
/** 视口（面板窗 = 主显示器全屏 bounds，含任务栏占位） */
export type Viewport = { width: number; height: number }
/** 排版要算的两样：清单与模式 */
export type TypePickerView = { present: readonly TypeRow[]; mode?: TypePickerMode }

export type TypePickerEffect =
  | { kind: 'tier'; held: boolean }
  | {
      kind: 'show'
      mode: TypePickerMode
      cardId: string
      label: string
      name: string
      acceptAll: boolean
      present: readonly TypeRow[]
      checked: readonly string[]
      box: TypePickerBox
    }
  | { kind: 'hide' }
  | { kind: 'run'; op: 'create-group'; name: string; exts: readonly string[]; acceptAll: boolean }
  | { kind: 'run'; op: 'edit-types'; cardId: string; exts: readonly string[]; acceptAll: boolean }
  | { kind: 'hotzones' }
  | { kind: 'notify'; type: string; payload?: Record<string, unknown> }

export type TypePickerEvent =
  | { type: 'create'; present: readonly TypeRow[] }
  | {
      type: 'edit'
      cardId: string
      label: string
      exts: readonly string[]
      acceptAll: boolean
      present: readonly TypeRow[]
    }
  | { type: 'toggle'; ext: string }
  | { type: 'toggle-all' }
  | { type: 'set-name'; name: string }
  | { type: 'submit' }
  | { type: 'cancel'; reason: string }
  | { type: 'esc' }
  | { type: 'outside' }
  | { type: 'unmount' }

export type TypePickerResult = { state: TypePickerState; effects: TypePickerEffect[] }

// ---- 身份常量（存证与电池按 id 定位，样式按类名走） ----
export declare const TYPE_OVERLAY_ID: string
export declare const TYPE_OVERLAY_CLASS: string
export declare const TYPE_BOX_ID: string
export declare const TYPE_BOX_CLASS: string
export declare const TYPE_NAME_ID: string
export declare const TYPE_NAME_CLASS: string
export declare const TYPE_ALL_ID: string
export declare const TYPE_ALL_CLASS: string
export declare const TYPE_LIST_ID: string
export declare const TYPE_LIST_CLASS: string
export declare const TYPE_ROW_CLASS: string
export declare const TYPE_BOX_MARK_CLASS: string
export declare const TYPE_OK_ID: string
export declare const TYPE_OK_CLASS: string
export declare const TYPE_CANCEL_ID: string
export declare const TYPE_CANCEL_CLASS: string
export declare const TYPE_STYLE_ID: string
export declare const TYPE_KEYBOARD_TIER: string
export declare const TYPE_OPENED_NOTIFY: string
export declare const TYPE_CLOSED_NOTIFY: string
export declare const TYPE_PICKER_CSS: string

// ---- 几何常量（CSS 与 JS 的尺寸同源，故只有一个出处） ----
export declare const PICKER_W: number
export declare const PICKER_FIELD_H: number
export declare const PICKER_SWITCH_H: number
export declare const PICKER_ROW_H: number
export declare const PICKER_MAX_ROWS: number
export declare const PICKER_PAD_Y: number
export declare const PICKER_GAP_Y: number
export declare const PICKER_BTN_H: number

/** 闭态 */
export declare const CLOSED_TYPES: TypePickerState

/** 盒子尺寸 / 视口正中落位（热区与存证矩形取 getBoundingClientRect，故同源） */
export declare function typePickerSizeOf(view: TypePickerView): { width: number; height: number }
export declare function typePickerBoxOf(viewport: Viewport, view: TypePickerView): TypePickerBox

/** 显示为勾住吗（开关开着时一律勾住）/ 声明里真的勾着吗（两者分家） */
export declare function checkedOf(state: TypePickerState, ext: string): boolean
export declare function isPicked(state: TypePickerState, ext: string): boolean

/** 转移矩阵：一个事件一次合成，效果数组按序执行 */
export declare function nextTypePicker(
  state: TypePickerState,
  event: TypePickerEvent,
  viewport: Viewport,
): TypePickerResult
