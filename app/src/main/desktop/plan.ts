// 编排核心（工单06，纯逻辑）：归类、应用区栏位与文档区落位。
// zones_plan.py 的自绘世界平移——不再输出屏幕像素坐标（自绘布局不受系统打扰），
// 只输出语义位置：dock 有序条目（含来源），文档条目的组名与组内序；列折叠
// （满 docMaxRows 行折本组右侧相邻列）以全局列号表达，渲染层按组铺列。
// 条目形态类型（DesktopDockEntry/DesktopDocEntry/DesktopPlan）与契约面共用一份，
// 不在此重复声明（防两处漂移）。
import path from 'node:path'
import type {
  DesktopDockEntry,
  DesktopDocEntry,
  DesktopDocGroup,
  DesktopItem,
  DesktopPlan,
} from '../../shared/contract'

/** 文档组（zones_plan.py GROUP_ORDER 原义：固定组序是「分区」能靠肌肉记忆使用的前提） */
type DocGroup = DesktopDocGroup

export const GROUP_ORDER: readonly DocGroup[] = ['folders', 'office', 'pdf', 'image', 'archive', 'other']

const OFFICE_EXTS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.csv'])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg', '.ico', '.tif', '.tiff'])
const ARCHIVE_EXTS = new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz'])

/** 按扩展名归文档组；文件夹恒为 folders 组 */
export function docGroupOf(item: Pick<DesktopItem, 'kind' | 'name'>): DocGroup {
  if (item.kind === 'folder') return 'folders'
  const ext = path.extname(item.name).toLowerCase()
  if (OFFICE_EXTS.has(ext)) return 'office'
  if (ext === '.pdf') return 'pdf'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ARCHIVE_EXTS.has(ext)) return 'archive'
  return 'other'
}

/** 应用区条目的栏位来源（契约面 DesktopDockSource 的域内别名） */
export type DockSource = DesktopDockEntry['source']

/** 用户显式摆位（layout-store 的成员清单：dock/docs 为有序显示名列表） */
export interface PlacedLists {
  dock: string[]
  docs: string[]
}

export interface PlanOptions {
  /** 文档组满几行折列（Python 先例 DOC_MAX_ROWS=8，经 config 下发） */
  docMaxRows: number
}

function columnsUsed(count: number, maxRows: number): number {
  return Math.ceil(count / maxRows)
}

/**
 * 文档区落位：固定组序、每组一列、组间空一列、组内新在上（mtime 降序，同值按名）、
 * 满 docMaxRows 行折本组右侧相邻列。显式拖拽摆位的条目保留其相对顺序且排组首段。
 */
function planDocs(items: DesktopItem[], placed: PlacedLists, opts: PlanOptions): DesktopDocEntry[] {
  const maxRows = opts.docMaxRows
  const groups = new Map<DocGroup, DesktopItem[]>(GROUP_ORDER.map((g) => [g, []]))
  for (const item of items) groups.get(docGroupOf(item))!.push(item)

  const explicitRank = new Map<string, number>()
  placed.docs.forEach((name, i) => explicitRank.set(name, i))

  const out: DesktopDocEntry[] = []
  let col = 0
  for (const group of GROUP_ORDER) {
    const members = groups.get(group)!
    if (!members.length) continue
    const explicit = placed.docs
      .map((name) => members.find((i) => i.name === name))
      .filter((i): i is DesktopItem => Boolean(i))
    const rest = members
      .filter((i) => !explicitRank.has(i.name))
      .sort((a, b) => (b.mtimeMs === a.mtimeMs ? a.name.localeCompare(b.name) : b.mtimeMs - a.mtimeMs))
    const ordered = [...explicit, ...rest]
    ordered.forEach((item, rank) => {
      out.push({ name: item.name, group, rank, col: col + Math.floor(rank / maxRows), row: rank % maxRows })
    })
    col += columnsUsed(ordered.length, maxRows) + 1 // +1 为组间空列
  }
  return out
}

/**
 * 应用区栏位分配（zones_plan.py 两段拼接语义的自绘版，无栏位上限——dock 可折行，
 * 承载一个不漏）：手钉按清单顺序占最前，显式拖拽摆位按其记录顺序紧随，
 * 剩余按使用分数降序填补；同分按当前条目序（name）稳定排序；无分数记 0 仍参与。
 * 手钉永不被推荐顶替（手钉段与推荐段不混排）。分数键 = 显示名（usage 打分的输出键）。
 */
export function planDock(
  items: DesktopItem[],
  pinned: readonly string[],
  placed: readonly string[],
  scores: ReadonlyMap<string, number>,
): DesktopDockEntry[] {
  const present = new Set(items.map((i) => i.name))
  const pinnedOrder: string[] = []
  for (const name of pinned) {
    if (present.has(name) && !pinnedOrder.includes(name)) pinnedOrder.push(name)
  }
  const pinnedSet = new Set(pinnedOrder)
  const placedOrder: string[] = []
  for (const name of placed) {
    if (present.has(name) && !pinnedSet.has(name) && !placedOrder.includes(name)) placedOrder.push(name)
  }
  const placedSet = new Set(placedOrder)
  const rest = items
    .filter((i) => !pinnedSet.has(i.name) && !placedSet.has(i.name))
    .sort((a, b) => {
      const d = (scores.get(b.display) ?? 0) - (scores.get(a.display) ?? 0)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })
  return [
    ...pinnedOrder.map((name) => ({ name, source: 'pinned' as const })),
    ...placedOrder.map((name) => ({ name, source: 'placed' as const })),
    ...rest.map((i) => ({ name: i.name, source: 'recommended' as const })),
  ]
}

/**
 * 编排计划：items 为已按显式摆位改写过 zone 的桌面项池（zoneOfOverride 由服务层处理）。
 * dock 段只收 zone=app 的条目，docs 段只收 zone=doc 的条目。
 */
export function planDesktop(
  items: DesktopItem[],
  pinned: readonly string[],
  placed: PlacedLists,
  scores: ReadonlyMap<string, number>,
  opts: PlanOptions,
): DesktopPlan {
  return {
    dock: planDock(items.filter((i) => i.zone === 'app'), pinned, placed.dock, scores),
    docs: planDocs(items.filter((i) => i.zone === 'doc'), placed, opts),
  }
}
