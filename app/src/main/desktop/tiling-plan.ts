// Agent 平铺规划（工单376，spec #369 决策 7「平铺决策模块」）：无副作用纯函数——
// 输入有序窗口成员、主屏平铺矩形与容量约束，输出完整平铺树与目标几何。零 IO、零 FFI、
// 零 electron——坐标一律物理像素（t372 实证口径：SetWindowPos/GetWindowRect 全物理 px，
// 与目标窗自身 DPI awareness 无关）。离线 vitest 矩阵直驱；窗口枚举与几何写入在
// tile-scope.ts / geom-write.ts，编排在其上的 services/agent-tiling.ts。
//
// 分裂模型（spec 决策 7「初始分裂队列 B、A，子窗格追加队尾，分裂轴随深度交替」+
// 用户故事 13-17 实义）：窗口 1 铺满根窗格；窗口 2 裂变根窗格——既有内容（窗 1）
// 落左半（A），新窗落右半（B），分裂队列 seeding 为 [B, A]；此后每次裂变从队首取
// 叶窗格、按深度交替轴切开（深度偶数 = 左右、奇数 = 上下），既有内容留首子格
// （左/上），新窗落次子格（右/下），双子格按 [既有子格, 新子格] 追加队尾。
// 用户故事对账：3 窗裂 B（A 左半、B 右上、C 右下 ✓）、4 窗裂 A（A/D 左列、B/C 右列 ✓）、
// 5 窗再裂 B ✓。同一窗口事件序列必得同一布局（布局只由事件序列决定，与焦点无关）。
//
// 容量（spec 决策 12）：继续裂变会使任一子格低于最小窗格（约 320×240 逻辑像素——
// 物理口径由调用方按主屏 DPI 换算传入）时，新窗口不落格，进容量溢出（仍计数与预览，
// 有空间后按序补入——补入语义归工单377，本模块只标记）。

/** 物理像素矩形（t372/51 电池同款口径，左上为原点） */
export interface TileRect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 平铺目标几何：一个成员窗的目标矩形 */
export interface TilePlacement {
  id: string
  rect: TileRect
}

/** 平铺规划输出：placements 与溢出集不相交；placements 合计铺满平铺区（1+ 窗时） */
export interface TilingPlan {
  /** 已落格成员（含最小化——最小化保留窗格，几何写入由编排层跳过） */
  placements: TilePlacement[]
  /** 容量溢出成员（继续裂变会低于最小窗格；不占格、仍计数） */
  overflow: string[]
}

/** 最小窗格（物理 px；spec 决策 12「约 320×240 逻辑像素」，本机 scale=1 等值） */
export const MIN_PANE_W = 320
export const MIN_PANE_H = 240

interface LeafNode {
  kind: 'leaf'
  /** 承载的成员 id（null = 空窗格：仅出现在规划前态，输出不产生） */
  id: string | null
  rect: TileRect
  depth: number
}

/** 裂变轴：深度偶数 = 左右（'h'），深度奇数 = 上下（'v'）——随深度交替 */
function axisOf(depth: number): 'h' | 'v' {
  return depth % 2 === 0 ? 'h' : 'v'
}

/** 矩形取整（中心线向下取整——左格得 floor、右格得 ceil，合计无损） */
function splitRect(rect: TileRect, axis: 'h' | 'v'): [TileRect, TileRect] {
  if (axis === 'h') {
    const mid = rect.left + Math.floor((rect.right - rect.left) / 2)
    return [
      { ...rect, right: mid },
      { ...rect, left: mid },
    ]
  }
  const mid = rect.top + Math.floor((rect.bottom - rect.top) / 2)
  return [
    { ...rect, bottom: mid },
    { ...rect, top: mid },
  ]
}

function areaOf(rect: TileRect): { w: number; h: number } {
  return { w: Math.max(0, rect.right - rect.left), h: Math.max(0, rect.bottom - rect.top) }
}

/**
 * 平铺规划（工单376）：对有序成员（z 序即入列序——编排层供给）在平铺区内产出确定性
 * 几何。成员可为空（空桌面 → 空规划）。溢出口径：新成员入列时，其裂变会使所在叶窗格
 * 任一子格低于最小窗格 → 该成员不裂变、直接溢出；此前已落格成员几何不变（布局只由
 * 明确事件序列决定——溢出不重排既有成员）。
 */
export function planTiling(
  members: readonly string[],
  area: TileRect,
  opts: { minPaneW?: number; minPaneH?: number } = {},
): TilingPlan {
  const minW = opts.minPaneW ?? MIN_PANE_W
  const minH = opts.minPaneH ?? MIN_PANE_H
  if (members.length === 0) return { placements: [], overflow: [] }

  // 叶窗格队列（分裂队列）：窗 1 铺满根；窗 2 裂根后 seeding [B, A]（B = 新窗格在前）；
  // 此后从队首取叶裂变，双子格按 [既有, 新] 追加队尾（见模块头注对账）。
  let root: LeafNode = { kind: 'leaf', id: null, rect: { ...area }, depth: 0 }
  const queue: LeafNode[] = []
  const placements: TilePlacement[] = []
  const overflow: string[] = []

  members.forEach((id, index) => {
    if (index === 0) {
      root = { kind: 'leaf', id, rect: { ...area }, depth: 0 }
      return
    }
    // 窗 2 裂变根窗格（首个分裂）；此后从队首取叶裂变
    const target = index === 1 ? root : queue.shift()
    if (!target) {
      // 队列空 = 防御路径（正常流每窗必有一格可裂变）：溢出收场，不抛不重排
      overflow.push(id)
      return
    }
    const axis = axisOf(target.depth)
    const [first, second] = splitRect(target.rect, axis)
    const f = areaOf(first)
    const s = areaOf(second)
    if (f.w < minW || f.h < minH || s.w < minW || s.h < minH) {
      // 容量溢出：本窗不落格，被裂窗格原样还原（队首弹出了再塞回去，语义=未裂变）
      if (index === 1) root = target
      else queue.unshift(target)
      overflow.push(id)
      return
    }
    // 既有内容留首子格（左/上），新窗落次子格（右/下）
    const existing: LeafNode = { kind: 'leaf', id: target.id, rect: first, depth: target.depth + 1 }
    const fresh: LeafNode = { kind: 'leaf', id, rect: second, depth: target.depth + 1 }
    if (index === 1) {
      // 窗 2 的裂变即初始 seeding（spec 决策 7「初始分裂队列 B、A」）：B = 新窗格在前，
      // A = 既有窗格殿后（story 15「第三窗裂 B」的前提）。首裂后根窗格不复存在——
      // 全部叶窗格都在队列里（root 置空，收集只走队列）
      root = { kind: 'leaf', id: null, rect: { ...area }, depth: 0 }
      queue.push(fresh, existing)
    } else {
      // 子窗格追加队尾 [既有, 新]（story 17「五窗再裂 B」的对账见模块头注）
      if (target.id !== null) queue.push(existing, fresh)
      else queue.push(fresh) // 空叶不该出现（防御：只补新格）
    }
  })

  // 收集叶窗格：按成员入列序（z 序）输出——队列/根只是内部账，布局账以成员序为准
  const rectById = new Map<string, TileRect>()
  if (root.id !== null) rectById.set(root.id, root.rect)
  for (const leaf of queue) if (leaf.id !== null) rectById.set(leaf.id, leaf.rect)
  for (const id of members) {
    const rect = rectById.get(id)
    if (rect) placements.push({ id, rect: { ...rect } })
  }
  return { placements, overflow }
}

/**
 * 平铺区推导（纯几何）：主屏物理矩形 + 任务栏条带顶（物理 y）→ 平铺矩形。
 * 下方避开任务栏（bottom = 条带顶）、顶部不为胶囊留白（top = 主屏顶——胶囊覆盖在
 * 窗口之上，GLOSSARY「顶部窗口胶囊」「Agent 平铺」同口径）。条带顶缺位（任务栏未
 * 在场）退化为屏底（无栏可避）。
 */
export function tileAreaOf(primary: TileRect, taskbarTop: number | null): TileRect {
  return {
    left: primary.left,
    top: primary.top,
    right: primary.right,
    bottom: taskbarTop !== null && taskbarTop < primary.bottom ? taskbarTop : primary.bottom,
  }
}
