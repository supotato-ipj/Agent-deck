// Agent 平铺规划（工单376 立、工单377 成）：无副作用纯函数——输入有序窗口成员、
// 主屏平铺矩形与容量约束，输出平铺树与目标几何。零 IO、零 FFI、零 electron——坐标
// 一律物理像素（t372 实证口径：SetWindowPos/GetWindowRect 全物理 px，与目标窗自身
// DPI awareness 无关）。离线 vitest 矩阵直驱；窗口枚举与几何写入在 tile-scope.ts /
// geom-write.ts，编排在其上的 services/agent-tiling.ts。
//
// 分裂模型（spec 决策 7「初始分裂队列 B、A，子窗格追加队尾，分裂轴随深度交替」+
// 用户故事 13-17 实义）：窗口 1 铺满根窗格；窗口 2 裂变根窗格——既有内容（窗 1）
// 落左半（A），新窗落右半（B），分裂队列 seeding 为 [B, A]；此后每次裂变从队首取
// 叶窗格、按深度交替轴切开（深度偶数 = 左右、奇数 = 上下），既有内容留首子格
// （左/上），新窗落次子格（右/下），双子格按 [既有子格, 新子格] 追加队尾。
// 用户故事对账：3 窗裂 B（A 左半、B 右上、C 右下 ✓）、4 窗裂 A（A/D 左列、B/C 右列 ✓）、
// 5 窗再裂 B ✓。同一窗口事件序列必得同一布局（布局只由事件序列决定，与焦点无关）。
//
// 生命周期（工单377，GLOSSARY「Agent 平铺」「平铺窗格」）：376 的无状态重规划只对
// 「纯增加」序列成立；关闭/移出主屏的空位必须由**兄弟**吸收（用户故事 20——重规划
// 会让无关窗格缩水/换位），故 377 起布局状态是一棵**持久二叉分裂树**（TilingTree）：
//   - treeInsert：新窗/补入按叶窗格队列裂变（取队列中第一个可裂叶——队列近似 BFS，
//     队首即最大叶，名义路径与「只取队首」全同；饱和态队首不可裂而深处叶可裂时仍能
//     落格，容量不冻结）；
//   - treeRemove：关闭/移出/异常退出 → 兄弟子树整体上移继承父窗格（深度全体 -1、
//     矩形按既有轴重展）——兄弟吸收空位，其余窗格不动；
//   - 最小化不产生事件：成员留在树里，窗格与顺序原样保留（story 19）；
//   - 容量溢出（spec 决策 12 + 工单410 双约束）：屏内成员已达上限 8（MAX_PANES）或
//     裂变会使子格低于最小窗格（约 320×240 逻辑像素）时，不落格、记入 tree.overflow
//     （仍计数与预览）；溢出成员留在成员序里，编排层每拍按序重试插入——空间一释放
//     即按序补入（story 29；上限态下关窗补入同样按成员序，工单410 story 9）。
// planTiling 保留为「成员序一次性建树」的薄包装（376 离线矩阵的入口，名义路径输出
// 与 376 实现逐字节一致）；编排层持有 TilingTree 实例做增量生命周期。

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

/** 屏内容量上限（工单410，spec #410 决策「屏内平衡二叉分裂最多容纳 8 个平铺窗格」）：
 *  已有 8 个屏内成员时新成员直接进入屏外滚动带，不再尝试裂变。8 是上限不是对小屏的
 *  强制分裂数量——小屏提前入带仍由最小窗格约束承接（容量双约束，GLOSSARY「容量溢出」）。 */
export const MAX_PANES = 8

/** 屏外列露边（逻辑 px；spec #403 用户故事 16「约 32 逻辑像素」，GLOSSARY「屏外滚动带」；
 *  物理值经 bandRevealPx 按主屏缩放换算） */
export const BAND_REVEAL_PX = 32

// ————————————————————————————————————————————————————————————
// 持久平铺树（工单377）
// ————————————————————————————————————————————————————————————

/** 叶窗格：承载至多一个成员（null = 空窗格，只出现在根前态） */
export interface TilingLeaf {
  kind: 'leaf'
  id: string | null
  rect: TileRect
  depth: number
  parent: TilingSplit | null
}

/** 分裂节点：轴在建格时定死（历史轴），吸收上移不重算 */
export interface TilingSplit {
  kind: 'split'
  axis: 'h' | 'v'
  rect: TileRect
  depth: number
  parent: TilingSplit | null
  first: TilingNode
  second: TilingNode
}

export type TilingNode = TilingLeaf | TilingSplit

/** 持久平铺树：布局账本（根 + 叶窗格队列 + 溢出集） */
export interface TilingTree {
  /** 建树时的平铺区（显示参数变化检测用——编排层比对决定是否重建） */
  area: TileRect
  minPaneW: number
  minPaneH: number
  /** 屏内容量上限（工单410；建树时定死，显示参数变化重建时随 opts 重算） */
  maxPanes: number
  root: TilingNode
  /** 叶窗格队列（分裂队列）：首裂后全部叶都在队（近似 BFS 序——队首即最大叶） */
  queue: TilingLeaf[]
  /** 容量溢出成员（按成员序；不占格、仍计数，有空间按序补入） */
  overflow: string[]
}

export interface TreeOpts {
  minPaneW?: number
  minPaneH?: number
  /** 屏内容量上限（缺省 MAX_PANES=8；纯函数缝可注入小值验证双约束序） */
  maxPanes?: number
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

function paneSize(rect: TileRect): { w: number; h: number } {
  return { w: rect.right - rect.left, h: rect.bottom - rect.top }
}

/** 建空树（根为空叶窗格；首窗落根，第二窗才首次裂变） */
export function createTree(area: TileRect, opts: TreeOpts = {}): TilingTree {
  return {
    area: { ...area },
    minPaneW: opts.minPaneW ?? MIN_PANE_W,
    minPaneH: opts.minPaneH ?? MIN_PANE_H,
    maxPanes: opts.maxPanes ?? MAX_PANES,
    root: { kind: 'leaf', id: null, rect: { ...area }, depth: 0, parent: null },
    queue: [],
    overflow: [],
  }
}

function collectLeaves(node: TilingNode, out: TilingLeaf[]): void {
  if (node.kind === 'leaf') {
    out.push(node)
    return
  }
  collectLeaves(node.first, out)
  collectLeaves(node.second, out)
}

/**
 * 从持久形状重建平铺树（工单383 重启恢复）：结构/轴原样保留，矩形与深度按当前平铺区
 * 重算（分辨率/DPI 变化不改变布局关系）。形参用宽松的结构类型（与 agent-layout 的
 * LayoutTreeShape 同形），避免本模块依赖持久化模块。
 */
export interface TreeShapeNode {
  kind: 'leaf'
  ref: number | null
}

export interface TreeShapeSplit {
  kind: 'split'
  axis: 'h' | 'v'
  first: TreeShape
  second: TreeShape
}

export type TreeShape = TreeShapeNode | TreeShapeSplit

export function treeFromShape(
  shape: TreeShape,
  area: TileRect,
  opts: TreeOpts = {},
  queueRefs: readonly number[] = [],
  idOfRef: (ref: number) => string | null = (ref) => String(ref),
): TilingTree {
  const build = (node: TreeShape, rect: TileRect, depth: number, parent: TilingSplit | null): TilingNode => {
    if (node.kind === 'leaf') {
      return {
        kind: 'leaf',
        id: node.ref === null ? null : idOfRef(node.ref),
        rect: { ...rect },
        depth,
        parent,
      }
    }
    const [firstRect, secondRect] = splitRect(rect, node.axis)
    const split: TilingSplit = {
      kind: 'split',
      axis: node.axis,
      rect: { ...rect },
      depth,
      parent,
      first: null as unknown as TilingNode,
      second: null as unknown as TilingNode,
    }
    split.first = build(node.first, firstRect, depth + 1, split)
    split.second = build(node.second, secondRect, depth + 1, split)
    return split
  }
  const tree = createTree(area, opts)
  tree.root = build(shape, area, 0, null)
  if (tree.root.kind === 'split') {
    const leaves: TilingLeaf[] = []
    collectLeaves(tree.root, leaves)
    const byId = new Map<string, TilingLeaf>()
    for (const leaf of leaves) if (leaf.id !== null) byId.set(leaf.id, leaf)
    const seen = new Set<TilingLeaf>()
    for (const ref of queueRefs) {
      const id = idOfRef(ref)
      const leaf = id === null ? undefined : byId.get(id)
      if (!leaf || seen.has(leaf)) continue
      seen.add(leaf)
      tree.queue.push(leaf)
    }
    // 队列不完整（持久文档缺项/结构裁剪）：按叶序补齐——裂变确定性优先于字面顺序
    for (const leaf of leaves) {
      if (seen.has(leaf)) continue
      seen.add(leaf)
      tree.queue.push(leaf)
    }
  }
  return tree
}

/** 已落格成员 id 集（溢出成员不在内） */
export function treePlacedIds(tree: TilingTree): Set<string> {
  const leaves: TilingLeaf[] = []
  collectLeaves(tree.root, leaves)
  const out = new Set<string>()
  for (const l of leaves) if (l.id !== null) out.add(l.id)
  return out
}

function replaceChild(tree: TilingTree, oldNode: TilingNode, newNode: TilingNode): void {
  const parent = oldNode.parent
  newNode.parent = parent
  if (parent === null) tree.root = newNode
  else if (parent.first === oldNode) parent.first = newNode
  else parent.second = newNode
}

/**
 * 裂变插入（新窗加入 / 溢出补入，同一入口——补入即「按最新窗口加入」的裂变语义）：
 * 取叶窗格队列中**第一个可裂叶**（队列近似 BFS，名义路径=队首），按深度交替轴切开，
 * 既有内容留首子格（左/上）、新窗落次子格（右/下），双子格追加队尾（首裂 seeding
 * [新格, 旧格] = spec 决策 7 的 [B, A]）。容量双约束（工单410）：屏内成员已达上限
 * （maxPanes=8，先判——上限不随屏幕尺寸放宽）或任一裂变会使子格低于最小窗格 →
 * 容量溢出（不占格、不尝试裂变）。
 * 幂等：已落格成员直接返回 placed（不重复裂变）。
 */
export function treeInsert(tree: TilingTree, id: string): 'placed' | 'overflow' {
  if (treePlacedIds(tree).has(id)) return 'placed'
  const oi = tree.overflow.indexOf(id)
  if (oi >= 0) tree.overflow.splice(oi, 1) // 补入重试：先出溢出账，成功/失败由本轮重新定账

  // 0→1：空根直接落位（不裂变）
  if (tree.root.kind === 'leaf' && tree.root.id === null) {
    tree.root.id = id
    return 'placed'
  }

  // 屏内容量上限（工单410，spec #410「已有 8 个屏内成员时，新成员直接进入有序屏外
  // 集合，不再尝试裂变」）：先于最小窗格判据——上限适用于所有入口，不随屏幕尺寸放宽
  if (treePlacedIds(tree).size >= tree.maxPanes) {
    if (!tree.overflow.includes(id)) tree.overflow.push(id)
    return 'overflow'
  }

  // 候选叶窗格：首裂前队列空、根是唯一叶（被窗 1 占据）；此后全部叶在队列里
  const candidates: TilingLeaf[] = tree.queue.length ? tree.queue : tree.root.kind === 'leaf' ? [tree.root] : []
  for (const leaf of candidates) {
    const axis = axisOf(leaf.depth)
    const [firstRect, secondRect] = splitRect(leaf.rect, axis)
    const f = paneSize(firstRect)
    const s = paneSize(secondRect)
    if (f.w < tree.minPaneW || f.h < tree.minPaneH || s.w < tree.minPaneW || s.h < tree.minPaneH) {
      continue // 容量溢出判据：裂变会使子格低于最小窗格（spec 决策 12）
    }
    const node: TilingSplit = {
      kind: 'split',
      axis,
      rect: { ...leaf.rect },
      depth: leaf.depth,
      parent: leaf.parent,
      first: null as unknown as TilingNode,
      second: null as unknown as TilingNode,
    }
    const existing: TilingLeaf = { kind: 'leaf', id: leaf.id, rect: firstRect, depth: leaf.depth + 1, parent: node }
    const fresh: TilingLeaf = { kind: 'leaf', id, rect: secondRect, depth: leaf.depth + 1, parent: node }
    node.first = existing
    node.second = fresh
    const seeding = tree.queue.length === 0 // 首裂（根窗格被窗 2 切开）
    const qi = tree.queue.indexOf(leaf)
    if (qi >= 0) tree.queue.splice(qi, 1)
    replaceChild(tree, leaf, node)
    if (seeding) tree.queue.push(fresh, existing) // [B, A]——新窗格在前（story 15 的前提）
    else tree.queue.push(existing, fresh) // 子窗格追加队尾 [既有, 新]
    return 'placed'
  }
  if (!tree.overflow.includes(id)) tree.overflow.push(id)
  return 'overflow'
}

/** 兄弟子树上移继承：矩形重展（按各节点既有轴）、深度全体对齐新层位 */
function rebaseSubtree(node: TilingNode, rect: TileRect, depth: number): void {
  node.rect = { ...rect }
  node.depth = depth
  if (node.kind === 'split') {
    const [f, s] = splitRect(rect, node.axis)
    rebaseSubtree(node.first, f, depth + 1)
    rebaseSubtree(node.second, s, depth + 1)
  }
}

/**
 * 移除成员（关闭 / 移出主屏 / 异常退出平铺树——GLOSSARY「Agent 平铺」兄弟吸收语义）：
 * 被删叶出队，兄弟子树整体上移继承父窗格（矩形=父矩形、深度全体 -1）——兄弟吸收
 * 空位，其余窗格不动（story 20）。单窗树退回空根（0→1 前态）。溢出成员移除 = 出
 * 溢出账。幂等：成员不在树（也不在溢出账）返回 false。
 */
export function treeRemove(tree: TilingTree, id: string): boolean {
  const leaves: TilingLeaf[] = []
  collectLeaves(tree.root, leaves)
  const leaf = leaves.find((l) => l.id === id)
  if (!leaf) {
    const oi = tree.overflow.indexOf(id)
    if (oi >= 0) {
      tree.overflow.splice(oi, 1)
      return true
    }
    return false
  }
  if (leaf.parent === null) {
    // 单窗树：退回空根（队列此刻必空——防御性过滤）
    tree.root = { kind: 'leaf', id: null, rect: { ...leaf.rect }, depth: 0, parent: null }
    tree.queue = tree.queue.filter((l) => l !== leaf)
    return true
  }
  const parent = leaf.parent
  const sibling = parent.first === leaf ? parent.second : parent.first
  const qi = tree.queue.indexOf(leaf)
  if (qi >= 0) tree.queue.splice(qi, 1)
  // 兄弟子树上移：继承父位（parent 指向父的父），矩形/深度按父层位重展
  rebaseSubtree(sibling, parent.rect, parent.depth)
  replaceChild(tree, parent, sibling)
  return true
}

/**
 * 平铺规划输出（叶窗格中序 = 空间左上→右下序，确定性）：placements 与溢出集不相交。
 */
export function treePlan(tree: TilingTree): TilingPlan {
  const leaves: TilingLeaf[] = []
  collectLeaves(tree.root, leaves)
  const placements: TilePlacement[] = []
  for (const l of leaves) {
    if (l.id !== null) placements.push({ id: l.id, rect: { ...l.rect } })
  }
  return { placements, overflow: [...tree.overflow] }
}

// ————————————————————————————————————————————————————————————
// 一次性建树（376 离线矩阵入口）与平铺区推导
// ————————————————————————————————————————————————————————————

/**
 * 平铺规划（工单376 契约入口，工单377 起为建树薄包装）：对有序成员（加入序）在平铺区
 * 内产出确定性几何。成员可为空（空桌面 → 空规划）。溢出口径：新成员入列时无可裂叶
 * → 溢出（此前已落格成员几何不变——溢出不重排既有成员）。
 */
export function planTiling(
  members: readonly string[],
  area: TileRect,
  opts: TreeOpts = {},
): TilingPlan {
  const tree = createTree(area, opts)
  for (const id of members) treeInsert(tree, id)
  const plan = treePlan(tree)
  // placements 按成员入列序输出（376 契约：布局账以成员序为准）
  const rectById = new Map(plan.placements.map((p) => [p.id, p.rect] as const))
  const placements: TilePlacement[] = []
  for (const id of members) {
    const rect = rectById.get(id)
    if (rect) placements.push({ id, rect })
  }
  return { placements, overflow: plan.overflow }
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

/**
 * 平铺区可用判（工单377，用户故事 23「窗口不写入不可见坐标」）：区为退化矩形
 * （显示参数变化的过渡态——主屏暂时不可用/取到空矩形）或容不下一个最小窗格时不可用。
 * 编排层在本拍跳过全部几何写入（计数照报、全员未落格）——不往不可见坐标写窗。
 */
export function isTileableArea(
  area: TileRect,
  opts: TreeOpts = {},
): boolean {
  const w = area.right - area.left
  const h = area.bottom - area.top
  return w >= (opts.minPaneW ?? MIN_PANE_W) && h >= (opts.minPaneH ?? MIN_PANE_H)
}

// ————————————————————————————————————————————————————————————
// 屏外滚动带纯几何（工单405，spec #403 决策「统一布局坐标与视口」，GLOSSARY
// 「屏外滚动带」；语义对齐用户已验证的 agent-tiling-hybrid.prototype 原型）：
// 屏内树与屏外列共享连续坐标——带非空时屏内树区右缘让出露边（整树 rebase 到缩窄区），
// 屏外列从树区右缘起依次向右相邻排列；视口偏移（camera）对整组生效，fit = 钳到
// 「目标完整可见 + 左右露边预留」区间内离当前视口最近的点（最小滑动，不居中不回零）。
// ————————————————————————————————————————————————————————————

/**
 * 屏外列宽（用户故事 13/14）：半屏宽（下取整）、最小 minColW（320 逻辑像素的物理
 * 等值——装配层与 minPane.w 同源换算）、最大平铺区宽度。区宽低于下限时取区宽
 * （原型 min(areaW, max(min, half)) 求序——上限规则优先，列不越出平铺区宽度）。
 */
export function bandColumnWidth(areaW: number, minColW: number): number {
  return Math.min(areaW, Math.max(minColW, Math.floor(areaW / 2)))
}

/**
 * 带非空时的屏内树区：右缘让出露边（列的左缘恰好落在树区右缘上——露边 32px 露在
 * 屏内右缘且与树窗格零重叠，点击目标唯一）。带空时树区 = 平铺区（不缩）。
 */
export function bandTreeArea(area: TileRect, reveal: number): TileRect {
  return { ...area, right: area.right - reveal }
}

/**
 * 屏外列连续矩形（进入序）：列 i 左缘 = 树区右缘 + i×列宽，占满平铺高度，
 * 依次向右相邻排列（用户故事 12「按打开或拖入顺序找到」）。
 */
export function bandColumnRects(area: TileRect, count: number, colW: number, reveal: number): TileRect[] {
  const out: TileRect[] = []
  for (let i = 0; i < count; i++) {
    const left = area.right - reveal + i * colW
    out.push({ left, top: area.top, right: left + colW, bottom: area.bottom })
  }
  return out
}

/**
 * 露边物理换算：32 逻辑像素按主屏缩放等比——minPaneW 即 320 逻辑像素的物理等值
 * （装配层同源换算），比例换算保持两者一致。
 */
export function bandRevealPx(minPaneW: number): number {
  return Math.round((minPaneW * BAND_REVEAL_PX) / MIN_PANE_W)
}

/** fit 上下文（编排层按目标在树/带与邻列在位性给出） */
export interface FitOpts {
  /** 目标左侧预留的露边（目标在带内 = reveal——左邻的右缘/树缘保持可见） */
  leftPeek: number
  /** 目标右侧预留的露边（目标右邻在位 = reveal——右邻的左缘保持可见） */
  rightPeek: number
  /** 连续布局内容右端（末列右缘）——视口右界钳制，防空白视口（用户故事 28） */
  contentRight: number
}

/**
 * fit 最小滑动（用户故事 17/18/19；原型 fit 实证语义）：视口偏移钳到「目标完整可见
 * + 左右露边预留」闭区间内离当前视口最近的点——不移动过头、已可见不动、双向对称。
 * 区间为空（目标宽于可用视口，极窄屏）居中兜底；结果再钳到 [0, 内容右端 − 区宽]
 * （视口不越出内容、带收拢后不留空白视口）。
 */
export function fitCamera(camera: number, target: TileRect, area: TileRect, opts: FitOpts): number {
  const areaW = area.right - area.left
  const lo = target.right - area.right + opts.rightPeek
  const hi = target.left - area.left - opts.leftPeek
  let next: number
  if (lo > hi) {
    next = target.left - area.left - Math.floor((areaW - (target.right - target.left)) / 2)
  } else {
    next = Math.min(Math.max(camera, lo), hi)
  }
  const maxCam = Math.max(0, opts.contentRight - area.right)
  return Math.min(Math.max(next, 0), maxCam)
}

/**
 * 整树重展到新平铺区（工单405 带空↔非空迁移，原型 syncArea 语义）：结构/轴/队列
 * 引用原样保留，矩形按新区重算（复用兄弟吸收的 rebase 语义——矩形重展、深度对齐）。
 */
export function rebaseTreeArea(tree: TilingTree, area: TileRect): void {
  tree.area = { ...area }
  rebaseSubtree(tree.root, area, 0)
}
