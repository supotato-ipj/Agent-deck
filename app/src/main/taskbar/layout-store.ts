// 任务栏栏布局存储（工单52/57，纯逻辑）：手钉清单（exe 身份 + 展示元数据）与中组
// 推荐位显式序（桌面项 name）的有序名单，「有序名单」模式平移 desktop/layout-store.ts
// （自绘世界没有坐标可存，序即布局）。
// 工单57 扩展：recommended = 用户在中组推荐位拖出的显式序（组内换位持久化）；手钉归属
// 与左组手钉段序仍由 pinned 承担（组内换位 = pinned 名单换位，跨组拖拽 = 两名单间迁移）。
// 另含旧桌面迁移纯逻辑：旧桌面 layout.json 的手钉名单（桌面项名）→ 栏手钉清单（exe 身份）。
// 迁移读路径自包含（不 import desktop 模块）——工单59 退役桌面 dock 后旧存储不再被写。
import type { DesktopItemKind } from '../../shared/contract'
import { normalizeExe, type TaskbarPinnedEntry } from './left-plan'

export interface TaskbarLayoutStore {
  version: 1
  /** 手钉有序清单（exe 身份；顺序 = 左组手钉段顺序） */
  pinned: TaskbarPinnedEntry[]
  /** 中组推荐位显式序（工单57，桌面项 name 有序名单）；陈旧名原样保留、编排时过滤（不在场即跳过），解除手钉时旧位次随之复活 */
  recommended: string[]
}

export const TASKBAR_FACTORY_STORE: TaskbarLayoutStore = { version: 1, pinned: [], recommended: [] }

function asPinnedEntry(value: unknown): TaskbarPinnedEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.exe !== 'string' || !v.exe) return null
  if (typeof v.label !== 'string') return null
  return { exe: v.exe, label: v.label, iconKey: typeof v.iconKey === 'string' ? v.iconKey : null }
}

/** 解析落盘 JSON；缺失/损坏/结构不符 → 出厂态（损坏自愈，下次保存覆写）。
 * recommended 段缺位（工单52 旧版存储）按空名单读入——逐段自愈，不拖垮手钉段。 */
export function loadTaskbarStore(text: string | null): TaskbarLayoutStore {
  if (text === null) return { version: 1, pinned: [], recommended: [] }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { version: 1, pinned: [], recommended: [] }
  }
  if (typeof raw !== 'object' || raw === null) return { version: 1, pinned: [], recommended: [] }
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.pinned)) return { version: 1, pinned: [], recommended: [] }
  return {
    version: 1,
    pinned: r.pinned.map(asPinnedEntry).filter((p): p is TaskbarPinnedEntry => p !== null),
    recommended: Array.isArray(r.recommended) ? r.recommended.filter((n): n is string => typeof n === 'string') : [],
  }
}

export function serializeTaskbarStore(store: TaskbarLayoutStore): string {
  return JSON.stringify(store, null, 1) + '\n'
}

/**
 * 名单换位原语（工单57，desktop/layout-store moveItem 同形）：name 从名单中移除后
 * 插到 before 之前；before 为 null 或不在名单 → 追加末尾。name 本不在名单按插入处理
 * （左→中回池落位就是插入语义）。before === name 的自落点原序返回。
 */
export function moveInOrder(names: readonly string[], name: string, before: string | null): string[] {
  if (before === name) return [...names]
  const rest = names.filter((n) => n !== name)
  const at = before === null ? -1 : rest.indexOf(before)
  if (at < 0) return [...rest, name]
  return [...rest.slice(0, at), name, ...rest.slice(at)]
}

/**
 * 左组手钉段内换位（工单57，组内拖拽裁决）：exe 条目移到 beforeExe 之前（身份归一
 * 比较），落点 null/不在手钉段 → 排到手钉段末尾。exe 不在手钉清单（仅运行条目不可
 * 换位）或自落点 → 原样返回（同一引用 = 幂等空转，服务层据此区分 ok:false/不重推）。
 */
export function reorderPinned(store: TaskbarLayoutStore, exe: string, beforeExe: string | null): TaskbarLayoutStore {
  const key = normalizeExe(exe)
  if (beforeExe !== null && normalizeExe(beforeExe) === key) return store
  const entry = store.pinned.find((p) => normalizeExe(p.exe) === key)
  if (!entry) return store
  const rest = store.pinned.filter((p) => normalizeExe(p.exe) !== key)
  const at = beforeExe === null ? -1 : rest.findIndex((p) => normalizeExe(p.exe) === normalizeExe(beforeExe))
  const pinned = at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)]
  return { ...store, pinned }
}

/**
 * 升为手钉（工单57，中→左跨组裁决）：entry 插到 beforeExe 之前（落点 null/不在手钉段
 * → 末尾）；同 exe（归一）已手钉先去重再插（= 换位，不重复上栏）。recommended 名单不动
 * ——升手钉不擦回池位次（陈旧名留位，解除手钉时旧位次随之复活，「钉不销毁摆」同款纪律）。
 */
export function pinEntry(store: TaskbarLayoutStore, entry: TaskbarPinnedEntry, beforeExe: string | null): TaskbarLayoutStore {
  const key = normalizeExe(entry.exe)
  const rest = store.pinned.filter((p) => normalizeExe(p.exe) !== key)
  const at = beforeExe === null ? -1 : rest.findIndex((p) => normalizeExe(p.exe) === normalizeExe(beforeExe))
  const pinned = at < 0 ? [...rest, entry] : [...rest.slice(0, at), entry, ...rest.slice(at)]
  return { ...store, pinned }
}

/** 解除手钉（工单57，左→中跨组裁决）：归一命中移除、其余序不动；不在手钉 → 原样返回（幂等空转）。 */
export function unpinEntry(store: TaskbarLayoutStore, exe: string): TaskbarLayoutStore {
  const key = normalizeExe(exe)
  if (!store.pinned.some((p) => normalizeExe(p.exe) === key)) return store
  return { ...store, pinned: store.pinned.filter((p) => normalizeExe(p.exe) !== key) }
}

/**
 * 迁移源解析：旧桌面摆位存储（layout.json）的 pinned 名单原文读出，顺序保持。
 * 防御性解析（损坏/非字符串数组 → 空名单）——迁移源不可信度与栏布局存储同款。
 */
export function parseLegacyPinnedNames(text: string | null): string[] {
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
 * 旧桌面手钉名单 → 栏手钉清单（顺序保持）：名字在桌面项池内解析身份——快捷方式经
 * resolve 取目标 exe（解析不出以 lnk 路径为身份：栏位不丢，只是运行态合并不上），
 * 其余以自身路径为身份；label/iconKey 捕获桌面项的展示元数据。池外名字（条目已删）
 * 跳过——无法形成身份的迁移没有落点；归一后同身份的条目去重（首个胜）。
 */
export function migrateLegacyPinned(
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
