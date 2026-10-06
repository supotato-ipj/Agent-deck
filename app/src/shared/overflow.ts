// 左组溢出拆分（工单58）：栏内容纳格数 → 栏内段 + 溢出段。纯函数零依赖，主进程与
// 渲染层共用同一裁决本体——渲染层按几何测出的格数分栏内/浮层，两侧不许各判一次。
// 放 shared 而非 main/taskbar：渲染层 import 主进程模块会让浏览器 ESM 解析失败
// （主进程侧模块在 dist 里不带浏览器可解析的路径形态，见 renderer-boundary 测试）。

/** 溢出拆分结果：bar = 栏内图标，overflow = 「⋯」浮层图标（编排序的尾部段） */
export interface TaskbarLeftOverflow<T> {
  bar: T[]
  overflow: T[]
}

/**
 * 左组溢出裁决（工单58）：slots = pill 内容纳的图标格数（含 ⋯ 钮位，几何由渲染层测量）。
 * 条目数不超限即全留栏（不预留 ⋯ 格——容量边界的图标不应为不存在的按钮让位）；
 * 超限则栏内让出一格放 ⋯ 钮，其余按编排序尾部收进浮层（手钉在前的编排序即优先级，
 * 仅运行的后排应用先进浮层）。数量回落后重编排自然回栏。泛型：条目形态由调用方定
 * （内核喂 TaskbarLeftEntry、渲染层喂视图条目），裁决只看数量与序。
 */
export function planLeftOverflow<T>(entries: readonly T[], slots: number): TaskbarLeftOverflow<T> {
  if (entries.length <= slots) return { bar: [...entries], overflow: [] }
  const keep = Math.max(0, slots - 1)
  return { bar: entries.slice(0, keep), overflow: entries.slice(keep) }
}
