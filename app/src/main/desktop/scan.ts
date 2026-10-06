// 桌面承载扫描核心（工单05，纯逻辑）：用户桌面 + 公共桌面 → 合并去重 → 桌面项池。
// 不碰文件系统与 Win32——目录条目由适配层（adapter.ts）读入，本模块只做集合运算与归类。
import path from 'node:path'
import type { DesktopItem, DesktopItemKind, DesktopPlan, DesktopZone } from '../../shared/contract'

/** 目录条目（适配层读入：readdir + 文件属性 + mtime） */
export interface DesktopDirEntry {
  name: string
  isDirectory: boolean
  /** 含 hidden/system 属性（explorer 桌面不显示这两类，desktop.ini 由此滤除） */
  isHidden: boolean
  mtimeMs: number
}

export interface DesktopRoots {
  user: string
  common: string
}

/** 图标缓存键：path|mtimeMs。路径不含 |（Windows 禁字符），可安全反向解析出路径。 */
export function iconKeyOf(filePath: string, mtimeMs: number): string {
  return `${filePath}|${mtimeMs}`
}

/** 缓存键 → 路径（键格式由 iconKeyOf 保证） */
export function pathOfIconKey(key: string): string {
  return key.slice(0, key.lastIndexOf('|'))
}

function kindOf(entry: DesktopDirEntry): DesktopItemKind {
  if (entry.isDirectory) return 'folder'
  const ext = path.extname(entry.name).toLowerCase()
  if (ext === '.lnk') return 'shortcut'
  if (ext === '.url') return 'url'
  return 'file'
}

/** 应用入口判定（快捷方式/网址）——zoneOf 与 displayOf 共用的领域谓词 */
export function isAppEntry(kind: DesktopItemKind): boolean {
  return kind === 'shortcut' || kind === 'url'
}

function zoneOf(kind: DesktopItemKind): DesktopZone {
  // 归类（06 完整编排前的 05 基线）：应用入口入应用区，其余入文档区
  return isAppEntry(kind) ? 'app' : 'doc'
}

function displayOf(name: string, kind: DesktopItemKind): string {
  // explorer 对 .lnk/.url 永远隐藏扩展（与「隐藏已知扩展名」设置无关），其余原样
  return isAppEntry(kind) ? name.replace(/\.(lnk|url)$/i, '') : name
}

function toItem(root: string, entry: DesktopDirEntry): DesktopItem {
  const kind = kindOf(entry)
  const filePath = path.join(root, entry.name)
  return {
    name: entry.name,
    display: displayOf(entry.name, kind),
    kind,
    zone: zoneOf(kind),
    path: filePath,
    iconKey: iconKeyOf(filePath, entry.mtimeMs),
    mtimeMs: entry.mtimeMs,
  }
}

/**
 * 合并去重得桌面项池：同名条目用户桌面优先（shell 命名空间中用户桌面遮蔽公共桌面的
 * 同名默认项）；hidden/system 条目滤除。输出排序 (zone, name, path)——应用区在前，
 * 渲染层按 zone 分组渲染，编排（06）在此序之上再做栏位分配。
 */
export function collectDesktopItems(
  roots: DesktopRoots,
  userEntries: DesktopDirEntry[],
  commonEntries: DesktopDirEntry[],
): DesktopItem[] {
  const byName = new Map<string, DesktopItem>()
  for (const entry of userEntries) {
    if (entry.isHidden || !entry.name) continue
    byName.set(entry.name, toItem(roots.user, entry))
  }
  for (const entry of commonEntries) {
    if (entry.isHidden || !entry.name) continue
    if (byName.has(entry.name)) continue
    byName.set(entry.name, toItem(roots.common, entry))
  }
  return [...byName.values()].sort((a, b) =>
    a.zone === b.zone ? (a.name === b.name ? a.path.localeCompare(b.path) : a.name.localeCompare(b.name)) : a.zone.localeCompare(b.zone),
  )
}

/** FNV-1a 32 位（指纹基底：条目集合/计划内容任一变化即翻转） */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 指纹（FNV-1a 32 位）：条目集合与 mtime（经 iconKey）任一变化即翻转 */
export function desktopFingerprint(items: DesktopItem[]): string {
  return fnv1a(items.map((i) => `${i.name}\t${i.kind}\t${i.zone}\t${i.path}\t${i.iconKey}`).join('\n'))
}

/**
 * 编排指纹：计划内容（文档组与列位）变化即翻转——与条目指纹拼接
 * 成完整 desktop 指纹，渲染层据此 diff（摆位变化也触发重渲染，条目不变则图标缓存不动）。
 */
export function planFingerprint(plan: DesktopPlan): string {
  return fnv1a(plan.docs.map((d) => `${d.name}\t${d.group}\t${d.col}\t${d.row}`).join('\n'))
}
