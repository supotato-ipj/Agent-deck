// 任务栏栏布局存储（工单52，纯逻辑）：手钉清单（exe 身份 + 展示元数据）的有序名单，
// 「有序名单」模式平移 desktop/layout-store.ts（自绘世界没有坐标可存，序即布局）。
// 本票只有手钉段；组内换位/跨组拖拽的名单操作属工单57，届时在本文件同构扩展。
// 另含 dock 迁移纯逻辑：旧 dock 手钉名单（桌面项名）→ 栏手钉清单（exe 身份）。
// 迁移读路径自包含（不 import desktop 模块）——工单59 退役 dock 代码时本读路径不受影响。
import type { DesktopItemKind } from '../../shared/contract'
import { normalizeExe, type TaskbarPinnedEntry } from './left-plan'

export interface TaskbarLayoutStore {
  version: 1
  /** 手钉有序清单（exe 身份；顺序 = 左组手钉段顺序） */
  pinned: TaskbarPinnedEntry[]
}

export const TASKBAR_FACTORY_STORE: TaskbarLayoutStore = { version: 1, pinned: [] }

function asPinnedEntry(value: unknown): TaskbarPinnedEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.exe !== 'string' || !v.exe) return null
  if (typeof v.label !== 'string') return null
  return { exe: v.exe, label: v.label, iconKey: typeof v.iconKey === 'string' ? v.iconKey : null }
}

/** 解析落盘 JSON；缺失/损坏/结构不符 → 出厂态（损坏自愈，下次保存覆写） */
export function loadTaskbarStore(text: string | null): TaskbarLayoutStore {
  if (text === null) return { version: 1, pinned: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { version: 1, pinned: [] }
  }
  if (typeof raw !== 'object' || raw === null) return { version: 1, pinned: [] }
  const pinned = (raw as Record<string, unknown>).pinned
  if (!Array.isArray(pinned)) return { version: 1, pinned: [] }
  return { version: 1, pinned: pinned.map(asPinnedEntry).filter((p): p is TaskbarPinnedEntry => p !== null) }
}

export function serializeTaskbarStore(store: TaskbarLayoutStore): string {
  return JSON.stringify(store, null, 1) + '\n'
}

/**
 * dock 迁移源解析：旧 dock 摆位存储（layout.json）的 pinned 名单原文读出，顺序保持。
 * 防御性解析（损坏/非字符串数组 → 空名单）——迁移源不可信度与栏布局存储同款。
 */
export function parseDockPinnedNames(text: string | null): string[] {
  if (text === null) return []
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof raw !== 'object' || raw === null) return []
  const pinned = (raw as Record<string, unknown>).pinned
  return Array.isArray(pinned) && pinned.every((x) => typeof x === 'string') ? [...pinned] : []
}

/** 迁移解析用的桌面项最小形态（DesktopItem 的子集；迁移只需这五件） */
export interface MigrationItem {
  name: string
  path: string
  kind: DesktopItemKind
  display: string
  iconKey: string
}

/**
 * dock 手钉名单 → 栏手钉清单（顺序保持）：名字在桌面项池内解析身份——快捷方式经
 * resolve 取目标 exe（解析不出以 lnk 路径为身份：栏位不丢，只是运行态合并不上），
 * 其余以自身路径为身份；label/iconKey 捕获桌面项的展示元数据。池外名字（条目已删）
 * 跳过——无法形成身份的迁移没有落点；归一后同身份的条目去重（首个胜）。
 */
export function migrateDockPinned(
  names: readonly string[],
  items: readonly MigrationItem[],
  resolve: (lnkPath: string) => string | null,
): TaskbarPinnedEntry[] {
  const byName = new Map(items.map((i) => [i.name, i]))
  const seen = new Set<string>()
  const out: TaskbarPinnedEntry[] = []
  for (const name of names) {
    const item = byName.get(name)
    if (!item) continue
    const exe = item.kind === 'shortcut' ? (resolve(item.path) ?? item.path) : item.path
    const key = normalizeExe(exe)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ exe, label: item.display, iconKey: item.iconKey })
  }
  return out
}
