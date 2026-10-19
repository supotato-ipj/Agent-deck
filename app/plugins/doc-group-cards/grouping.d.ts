// grouping.js 的类型声明（工单179）。
//
// 为什么需要这一个文件：投放型插件包的源码就是投放单元——面板经 deck-plugin:// 原样 import，
// 不能有编译步骤，故插件源码是手写的 ES 模块 .js（入口 manifest 的 entry 只收 .js/.mjs）。
// 而本仓库的 tsconfig 没开 allowJs：测试（TS）import 这个 .js 时若没有同名 .d.ts，
// tsc 报 TS2307，`npm run typecheck` 即红。这不是"给 JS 补类型"的洁癖，是 typecheck 绿的前提。
//
// 声明与实现一一对应；改 grouping.js 的签名时同步改这里（typecheck 与 vitest 各自拦一道）。

export type GroupableItem = {
  /** 文件名（含扩展名；分组键由此现推，桌面项自身不带扩展名字段） */
  name: string
  /** 桌面项种类；只有 'file' 进组卡，shortcut / url / folder 一律排除 */
  kind: string
}

export type ExtensionGroup = {
  /** 分组键：单个扩展名（小写、含点，如 '.docx'）；无扩展名组为空串 */
  key: string
  /** 卡面标签（面板既有组标签一律全大写） */
  label: string
  /** 组卡 DOM id（热区扫掠取 card.id 且不去重，必须唯一） */
  id: string
  /** 组内条目，保持入参序 */
  items: GroupableItem[]
}

/** 固有组序表（办公系 → pdf → image 系 → 压缩系）；表外扩展名按字母序兜底 */
export declare const EXT_GROUP_ORDER: readonly string[]

export declare function extOf(name: string): string

/** 非文件条目返回 null（不进卡） */
export declare function groupKeyOf(item: GroupableItem): string | null

export declare function groupLabelOf(key: string): string

/** 分组键 → 组卡 id 基名（撞车后的唯一化在 groupByExtension 内） */
export declare function cardIdOf(key: string): string

/** 组序排法（表内按表序、表外按字母序）：卡序与工单185 勾选浮层的类型清单共用这一份 */
export declare function sortGroupKeys(keys: Iterable<string>, order: readonly string[]): string[]

export declare function groupByExtension(
  items: readonly GroupableItem[],
  order?: readonly string[],
): ExtensionGroup[]
