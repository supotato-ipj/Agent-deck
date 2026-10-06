// 托盘入栏的名单编排（工单56，与 left-plan/plan 同形态）：规范化托盘事件序列 → 栏内
// 图标名单。纯函数、零 Win32——字节解码与像素提取在 trayhost 侧完成，本模块只认
// 事件：增/改 upsert（同 key 覆盖 tooltip 与图标）、删摘除、版本协商/聚焦/未知空转。
// 顺序 = 到达序（Windows 托盘不承诺全局序；栏内沿用到达序，重排由用户拖拽语义管）。
// 条目形态沿用契约面 TaskbarTrayEntry（跨进程面唯一一份，本模块不另立同形类型）。

import type { TaskbarTrayEntry } from '../../shared/contract'
import type { TrayWireEvent } from '../trayhost/protocol'

/** FNV-1a 32 位摘要（图标键用：同尺寸图标换内容后长度不变，只比长度会撞键） */
function digest(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16)
}

/**
 * 图标像素键 = 身份键 + 尺寸 + 像素内容摘要（无像素的事件不覆盖已有图标：
 * tooltip-only 更新不该丢图）。导出供内核的像素缓存落键用——名单与像素缓存两处
 * 必须同一把尺（各算各的会出现名单指向缓存里没有的像素）。
 */
export function trayIconKeyOf(event: TrayWireEvent): string | null {
  if (!event.icon) return null
  const { width, height, bgraBase64 } = event.icon
  return `${event.key}|${width}x${height}:${digest(bgraBase64)}`
}

/**
 * 名单推进：add/update 同道 upsert（Windows 的 NIM_MODIFY 是部分更新——无图不带图、
 * 无 tip 不清 tip），delete 摘除，其余事件（setversion/setfocus/unknown）原样返回。
 * 不变即原引用返回——渲染层据此跳过重渲。
 */
export function applyTrayEvent(
  list: readonly TaskbarTrayEntry[],
  event: TrayWireEvent,
): readonly TaskbarTrayEntry[] {
  const idx = list.findIndex((i) => i.key === event.key)
  if (event.kind === 'delete') {
    return idx < 0 ? list : list.filter((_, i) => i !== idx)
  }
  // setversion/setfocus/unknown 与删除名单外身份都是空转：原引用返回（零分配）
  if (event.kind !== 'add' && event.kind !== 'update') return list
  const iconKey = trayIconKeyOf(event)
  const next: TaskbarTrayEntry = {
    key: event.key,
    tooltip: event.tooltip || (idx >= 0 ? list[idx].tooltip : ''),
    iconKey: iconKey ?? (idx >= 0 ? list[idx].iconKey : null),
  }
  if (idx < 0) return [...list, next]
  const prev = list[idx]
  if (prev.tooltip === next.tooltip && prev.iconKey === next.iconKey) return list
  const out = [...list]
  out[idx] = next
  return out
}

/** 名单逐条比对（渲染层重渲判据——tooltip 与像素键都变才算变） */
export function sameTrayIcons(a: readonly TaskbarTrayEntry[], b: readonly TaskbarTrayEntry[]): boolean {
  return a.length === b.length
    && a.every((i, idx) => i.key === b[idx].key && i.tooltip === b[idx].tooltip && i.iconKey === b[idx].iconKey)
}