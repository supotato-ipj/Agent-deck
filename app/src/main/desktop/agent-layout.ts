// Agent 桌面布局持久化·纯模型（工单383，spec #369 决策 13/16「恢复与故障矩阵」）：
// 桌面配对之外的必要恢复信息——窗口**稳定身份**、加入顺序、平铺树形状与分裂队列、
// 浮动几何、以及会话干净退出标记。零 IO、零 FFI、零 electron；落盘/读取在
// services/agent-tiling.ts（编排层注入 IO 缝），离线 vitest 矩阵直驱。
//
// 隐私边界（spec 决策 13/26，用户故事 81）：
// - 身份只含 hwnd / pid / 归一化 exe 路径——**不含窗口标题、对话标题、缩略图**；
// - 不含任何手动几何授权（prompt/armed/locked 一律不落盘，重启后授权全新关闭）；
// - 解析按白名单重建对象：未知字段在 load 时即被丢弃，不随下一轮保存扩散。
//
// 一致性判据（模型不一致 → 安全态）：版本、桌面 ID、身份表、树引用、分裂队列、浮动
// 集合逐项核验。任何一处引用越界/重复/互斥破坏都判 invalid——恢复层停止自动改窗，
// 不猜、不修补、不无限重试。
import type { TileRect, TilingNode, TilingTree } from './tiling-plan'
import { normalizeExe } from './tile-scope'
import type { TileWindowFacts } from './tile-scope'

/** 布局文档版本（升版必须带迁移；未知版本按模型不一致进安全态，不猜读）。
 *  v2（工单406）：新增 band（屏外滚动带顺序）与 anchor（视口锚窗身份）——持久化布局
 *  关系而非旧像素；v1 文档按缺省迁移（空带、无锚）。 */
export const AGENT_LAYOUT_VERSION = 2 as const
/** 上一版（迁移接受：缺 band/anchor 按缺省重建） */
const AGENT_LAYOUT_VERSION_PREV = 1 as const

/** 窗口稳定身份（进程仍活时 hwnd 为窗口身份；pid+exe 用于核对「同一扇窗」） */
export interface WindowIdentity {
  hwnd: number
  /** 进程 ID（生产恒 > 0；离线夹具缺省 0 时只按 exe 核对） */
  pid: number
  /** 归一化可执行文件路径（斜杠归一 + 小写；不含任何标题） */
  exe: string
}

/** 平铺树形状：叶引用 order 下标（null = 空根叶），分裂轴原样保留 */
export type LayoutTreeShape =
  | { kind: 'leaf'; ref: number | null }
  | { kind: 'split'; axis: 'h' | 'v'; first: LayoutTreeShape; second: LayoutTreeShape }

/** 浮动条目：order 下标 + 保留几何（不是授权——重启后授权关闭，几何保留） */
export interface LayoutFloating {
  ref: number
  rect: TileRect
}

/** 持久化文档（字段即白名单；解析不认识的字段一律丢弃） */
export interface AgentLayoutDoc {
  version: typeof AGENT_LAYOUT_VERSION
  /** 归属 Agent 桌面系统 ID（恢复前核对；不一致 → 安全态，不猜接管未知桌面） */
  desktopId: string
  /** 上次会话是否干净退出（false/缺失 = 崩溃标记；崩溃不应用旧布局、不强制搬窗） */
  clean: boolean
  /** 窗口加入顺序（稳定身份；平铺成员在前，浮动窗按浮动序在后） */
  order: WindowIdentity[]
  /** 平铺树形状（null = 无树，按成员序重建） */
  tree: LayoutTreeShape | null
  /** 分裂队列（order 下标；树内叶窗格的裂变顺序——未来插入的确定性延续） */
  queue: number[]
  /** 屏外滚动带顺序（order 下标；受管平铺成员，进带序 = 成员序相对序——工单406） */
  band: number[]
  /** 视口锚窗身份（order 下标或 null；恢复后按当前平铺区重算 fit，不存像素——工单406） */
  anchor: number | null
  /** 浮动窗与保留几何（授权不在此） */
  floating: LayoutFloating[]
}

export type LayoutParseResult =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ok'; doc: AgentLayoutDoc }

/** 矩形核验：整数物理 px、正面积（不接受负宽高/NaN） */
function isRect(v: unknown): v is TileRect {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  const nums = [r.left, r.top, r.right, r.bottom]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return false
  const { left, top, right, bottom } = r as unknown as TileRect
  return right > left && bottom > top
}

function isIdentity(v: unknown): v is WindowIdentity {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const w = v as Record<string, unknown>
  return (
    typeof w.hwnd === 'number' && Number.isInteger(w.hwnd) && w.hwnd > 0 &&
    typeof w.pid === 'number' && Number.isInteger(w.pid) && w.pid >= 0 &&
    typeof w.exe === 'string' && w.exe.length > 0
  )
}

function isShape(v: unknown, depth = 0): v is LayoutTreeShape {
  if (depth > 64) return false // 病态深树：拒绝（不递归到爆栈）
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const s = v as Record<string, unknown>
  if (s.kind === 'leaf') {
    return s.ref === null || (typeof s.ref === 'number' && Number.isInteger(s.ref) && s.ref >= 0)
  }
  if (s.kind === 'split') {
    if (s.axis !== 'h' && s.axis !== 'v') return false
    return isShape(s.first, depth + 1) && isShape(s.second, depth + 1)
  }
  return false
}

function collectShapeRefs(shape: LayoutTreeShape | null, out: number[]): void {
  if (!shape) return
  if (shape.kind === 'leaf') {
    if (shape.ref !== null) out.push(shape.ref)
    return
  }
  collectShapeRefs(shape.first, out)
  collectShapeRefs(shape.second, out)
}

/** 文档结构核验（不含系统事实）：返回 null = 合法，否则为拒绝理由 */
export function validateLayout(doc: unknown): string | null {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return 'document'
  const d = doc as Record<string, unknown>
  if (d.version !== AGENT_LAYOUT_VERSION && d.version !== AGENT_LAYOUT_VERSION_PREV) return 'version'
  if (typeof d.desktopId !== 'string' || !d.desktopId) return 'desktopId'
  if (typeof d.clean !== 'boolean') return 'clean'
  if (!Array.isArray(d.order)) return 'order'
  const order = d.order
  const seenHwnd = new Set<number>()
  for (const item of order) {
    if (!isIdentity(item)) return 'identity'
    if (seenHwnd.has(item.hwnd)) return 'duplicate-hwnd'
    seenHwnd.add(item.hwnd)
  }
  const refOk = (ref: unknown): boolean =>
    typeof ref === 'number' && Number.isInteger(ref) && ref >= 0 && ref < order.length
  if (d.tree !== null && !isShape(d.tree)) return 'tree-shape'
  const shapeRefs: number[] = []
  collectShapeRefs(d.tree as LayoutTreeShape | null, shapeRefs)
  for (const ref of shapeRefs) {
    if (!refOk(ref)) return 'tree-ref'
  }
  if (new Set(shapeRefs).size !== shapeRefs.length) return 'tree-duplicate'
  if (!Array.isArray(d.queue)) return 'queue'
  const seenQueue = new Set<number>()
  for (const ref of d.queue) {
    if (!refOk(ref)) return 'queue-ref'
    if (!shapeRefs.includes(ref)) return 'queue-not-leaf'
    if (seenQueue.has(ref)) return 'queue-duplicate'
    seenQueue.add(ref)
  }
  if (!Array.isArray(d.floating)) return 'floating'
  const floatingRefs = new Set<number>()
  for (const item of d.floating) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return 'floating-entry'
    const f = item as Record<string, unknown>
    if (!refOk(f.ref)) return 'floating-ref'
    if (!isRect(f.rect)) return 'floating-rect'
    if (shapeRefs.includes(f.ref as number)) return 'floating-in-tree'
    if (floatingRefs.has(f.ref as number)) return 'floating-duplicate'
    floatingRefs.add(f.ref as number)
  }
  // 工单406：band（屏外顺序）/ anchor（锚窗）——受管平铺成员，与树、浮动互斥；
  // v1 文档缺省（迁移），出现则核验
  const bandRefs = new Set<number>()
  if (d.band !== undefined) {
    if (!Array.isArray(d.band)) return 'band'
    for (const ref of d.band) {
      if (!refOk(ref)) return 'band-ref'
      if (shapeRefs.includes(ref as number)) return 'band-in-tree'
      if (floatingRefs.has(ref as number)) return 'band-in-floating'
      if (bandRefs.has(ref as number)) return 'band-duplicate'
      bandRefs.add(ref as number)
    }
  }
  if (d.anchor !== undefined && d.anchor !== null) {
    if (typeof d.anchor !== 'number' || !Number.isInteger(d.anchor)) return 'anchor'
    if (!refOk(d.anchor)) return 'anchor-ref'
    if (floatingRefs.has(d.anchor)) return 'anchor-in-floating'
  }
  return null
}

/** 解析落盘文本：缺失 → none；损坏/版本/结构不符 → invalid（损坏自愈：下一轮保存覆写） */
export function parseLayout(text: string | null): LayoutParseResult {
  if (text === null) return { kind: 'none' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { kind: 'invalid', reason: 'json' }
  }
  const reason = validateLayout(raw)
  if (reason) return { kind: 'invalid', reason }
  const d = raw as Record<string, unknown>
  // 白名单重建：未知字段不进内存、不再落盘。v1 → v2 迁移：band/anchor 按缺省重建
  // （空带、无锚——旧文档没有屏外语义，恢复后由成员序重推导、视口回起点）。
  const isPrev = d.version === AGENT_LAYOUT_VERSION_PREV
  const order = (d.order as WindowIdentity[]).map((w) => ({ hwnd: w.hwnd, pid: w.pid, exe: w.exe }))
  const tree = d.tree === null ? null : (d.tree as LayoutTreeShape)
  return {
    kind: 'ok',
    doc: {
      version: AGENT_LAYOUT_VERSION,
      desktopId: d.desktopId as string,
      clean: d.clean as boolean,
      order,
      tree,
      queue: [...(d.queue as number[])],
      band: isPrev ? [] : [...(d.band as number[])],
      anchor: isPrev ? null : ((d.anchor as number | null) ?? null),
      floating: (d.floating as LayoutFloating[]).map((f) => ({
        ref: f.ref,
        rect: { ...f.rect },
      })),
    },
  }
}

export function serializeLayout(doc: AgentLayoutDoc): string {
  return JSON.stringify(doc, null, 1) + '\n'
}

/** 当前窗口事实 → 稳定身份（exe 归一化；pid 缺省 0 = 只按 exe 核对） */
export function identityOf(fact: TileWindowFacts): WindowIdentity {
  return { hwnd: fact.hwnd, pid: fact.pid ?? 0, exe: normalizeExe(fact.exe) }
}

/** 同一扇窗判据：hwnd 命中后核对 exe（必有）+ pid（两侧都有值时） */
export function identityMatches(stored: WindowIdentity, fact: TileWindowFacts): boolean {
  if (stored.hwnd !== fact.hwnd) return false
  if (stored.exe && stored.exe !== normalizeExe(fact.exe)) return false
  if (stored.pid > 0 && fact.pid != null && fact.pid > 0 && stored.pid !== fact.pid) return false
  return true
}

function pruneShape(shape: LayoutTreeShape, kept: ReadonlySet<number>): LayoutTreeShape | null {
  if (shape.kind === 'leaf') {
    if (shape.ref === null) return { kind: 'leaf', ref: null }
    return kept.has(shape.ref) ? { kind: 'leaf', ref: shape.ref } : null
  }
  const first = pruneShape(shape.first, kept)
  const second = pruneShape(shape.second, kept)
  if (!first && !second) return null
  if (!first) return second
  if (!second) return first
  return { kind: 'split', axis: shape.axis, first, second }
}

function remapShape(shape: LayoutTreeShape | null, map: ReadonlyMap<number, number>): LayoutTreeShape | null {
  if (!shape) return null
  if (shape.kind === 'leaf') {
    if (shape.ref === null) return { kind: 'leaf', ref: null }
    const ref = map.get(shape.ref)
    return ref === undefined ? null : { kind: 'leaf', ref }
  }
  const first = remapShape(shape.first, map)
  const second = remapShape(shape.second, map)
  if (!first && !second) return null
  if (!first) return second
  if (!second) return first
  return { kind: 'split', axis: shape.axis, first, second }
}

function shapeLeaves(shape: LayoutTreeShape | null, out: number[]): void {
  if (!shape) return
  if (shape.kind === 'leaf') {
    if (shape.ref !== null) out.push(shape.ref)
    return
  }
  shapeLeaves(shape.first, out)
  shapeLeaves(shape.second, out)
}

/** 恢复计划：合法文档 × 当前事实 → 应用/安全态（系统事实层的不一致在此判定） */
export type RestorePlan =
  | { kind: 'safe'; reason: 'window-identity' }
  | {
    kind: 'apply'
    /** 保留成员的新顺序（stored 命中的在前，当前新增的按现序追加） */
    order: WindowIdentity[]
    /** 已按新 order 下标重映射的树形状（null = 无树，按成员序重建） */
    shape: LayoutTreeShape | null
    /** 分裂队列（新 order 下标；缺叶按树序补齐） */
    queue: number[]
    /** 浮动窗（新 order 下标 + 保留几何） */
    floating: LayoutFloating[]
    /** 屏外滚动带顺序（新 order 下标；消失成员出带——工单406） */
    band: number[]
    /** 视口锚窗（新 order 下标或 null；消失/转浮动置空——工单406） */
    anchor: number | null
    /** 已消失/移出当前桌面而丢弃的成员数 */
    dropped: number
  }

/**
 * 恢复规划（纯裁决）：
 * - 存储身份与当前窗口事实**同 hwnd 但 exe/pid 不符** → 安全态（不猜测接管，停止改窗）；
 * - 窗口已消失或不在当前 Agent 主屏 → 丢弃该成员（正常关闭/移出，不判故障）；
 * - 当前新出现（面板停摆期间打开）→ 按当前序追加队尾（新窗加入语义）。
 */
export function planRestore(
  doc: AgentLayoutDoc,
  facts: readonly TileWindowFacts[],
  members: readonly TileWindowFacts[],
): RestorePlan {
  const byHwnd = new Map(facts.map((f) => [f.hwnd, f] as const))
  const memberSet = new Set(members.map((m) => m.hwnd))
  // 身份核对先于成员过滤：同一 hwnd 被别的进程/窗口复用 → 不能把旧布局强加给新窗
  for (const stored of doc.order) {
    const cur = byHwnd.get(stored.hwnd)
    if (!cur) continue
    if (!identityMatches(stored, cur)) return { kind: 'safe', reason: 'window-identity' }
  }
  const keptOld: number[] = []
  for (let i = 0; i < doc.order.length; i++) {
    const stored = doc.order[i]
    if (memberSet.has(stored.hwnd)) keptOld.push(i)
  }
  const order: WindowIdentity[] = []
  const oldToNew = new Map<number, number>()
  for (const oldRef of keptOld) {
    const fact = byHwnd.get(doc.order[oldRef].hwnd)!
    oldToNew.set(oldRef, order.length)
    order.push(identityOf(fact))
  }
  const keptHwnd = new Set(order.map((w) => w.hwnd))
  for (const m of members) {
    if (keptHwnd.has(m.hwnd)) continue
    keptHwnd.add(m.hwnd)
    order.push(identityOf(m))
  }
  const pruned = doc.tree
    ? remapShape(pruneShape(doc.tree, new Set(keptOld)), oldToNew)
    : null
  const queue: number[] = []
  const queueSeen = new Set<number>()
  for (const oldRef of doc.queue) {
    const ref = oldToNew.get(oldRef)
    if (ref === undefined || queueSeen.has(ref)) continue
    queueSeen.add(ref)
    queue.push(ref)
  }
  const leaves: number[] = []
  shapeLeaves(pruned, leaves)
  for (const ref of leaves) {
    if (queueSeen.has(ref)) continue
    queueSeen.add(ref)
    queue.push(ref)
  }
  const floating: LayoutFloating[] = []
  for (const item of doc.floating) {
    const ref = oldToNew.get(item.ref)
    if (ref === undefined) continue
    floating.push({ ref, rect: { ...item.rect } })
  }
  // 工单406：屏外顺序与锚窗按新下标重映射——消失成员出带（不沉淀）、转浮动成员出带、
  // 锚窗消失/转浮动置空（恢复后无锚回布局起点，不猜）
  const floatingRefs = new Set(floating.map((f) => f.ref))
  const band: number[] = []
  const bandSeen = new Set<number>()
  for (const oldRef of doc.band) {
    const ref = oldToNew.get(oldRef)
    if (ref === undefined || bandSeen.has(ref) || floatingRefs.has(ref)) continue
    bandSeen.add(ref)
    band.push(ref)
  }
  const anchor = doc.anchor === null || doc.anchor === undefined
    ? null
    : (oldToNew.get(doc.anchor) ?? null)
  const anchorEffective = anchor !== null && !floatingRefs.has(anchor) ? anchor : null
  return {
    kind: 'apply',
    order,
    shape: pruned,
    queue,
    floating,
    band,
    anchor: anchorEffective,
    dropped: doc.order.length - keptOld.length,
  }
}

/** 平铺树 → 持久形状（叶 id 经 hwnd→order 下标映射；调用方保证 order 覆盖树内成员） */
export function captureShape(node: TilingNode, refOf: (hwnd: number) => number | undefined): LayoutTreeShape | null {
  if (node.kind === 'leaf') {
    if (node.id === null) return { kind: 'leaf', ref: null }
    const ref = refOf(Number(node.id))
    return ref === undefined ? null : { kind: 'leaf', ref }
  }
  const first = captureShape(node.first, refOf)
  const second = captureShape(node.second, refOf)
  if (!first && !second) return null
  if (!first) return second
  if (!second) return first
  return { kind: 'split', axis: node.axis, first, second }
}

/** 平铺树 → 持久文档（order 由编排层按加入序 + 浮动序组装）。
 *  band/anchor（工单406）：屏外顺序与锚窗映射为 order 下标；锚不在成员序（已浮动/
 *  已消失）时置空——浮动窗不落成锚。 */
export function captureLayout(input: {
  desktopId: string
  clean: boolean
  order: WindowIdentity[]
  tree: TilingTree | null
  floating: Array<{ hwnd: number; rect: TileRect }>
  band?: readonly number[]
  anchor?: number | null
}): AgentLayoutDoc {
  const refByHwnd = new Map(input.order.map((w, i) => [w.hwnd, i] as const))
  const refOf = (hwnd: number): number | undefined => refByHwnd.get(hwnd)
  const tree = input.tree ? captureShape(input.tree.root, refOf) : null
  const queue: number[] = []
  if (input.tree) {
    for (const leaf of input.tree.queue) {
      if (leaf.id === null) continue
      const ref = refOf(Number(leaf.id))
      if (ref !== undefined && !queue.includes(ref)) queue.push(ref)
    }
  }
  const floating: LayoutFloating[] = []
  for (const f of input.floating) {
    const ref = refOf(f.hwnd)
    if (ref === undefined) continue
    floating.push({ ref, rect: { ...f.rect } })
  }
  const floatingRefs = new Set(floating.map((f) => f.ref))
  const band: number[] = []
  for (const hwnd of input.band ?? []) {
    const ref = refOf(hwnd)
    if (ref === undefined || band.includes(ref) || floatingRefs.has(ref)) continue
    band.push(ref)
  }
  const anchorRef = input.anchor != null ? refOf(input.anchor) : undefined
  const anchor = anchorRef !== undefined && !floatingRefs.has(anchorRef) ? anchorRef : null
  return {
    version: AGENT_LAYOUT_VERSION,
    desktopId: input.desktopId,
    clean: input.clean,
    order: input.order.map((w) => ({ ...w })),
    tree,
    queue,
    band,
    anchor,
    floating,
  }
}
