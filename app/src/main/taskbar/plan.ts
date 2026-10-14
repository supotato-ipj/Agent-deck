/**
 * 推荐组推荐位编排纯函数（工单54）：应用区条目 ∩ 正分条目 → 分数降序（同分按名稳定）
 * → 上限截断。零分条目只是「在桌面」，不构成「常用」证据，不占推荐位——这也是
 * 「全隐藏 + 无推荐 → 开始组 pill 不渲染」边界可达的前提。
 * 工单59 起候选直接取自桌面条目池的 zone=app 段（dock 编排退役后不再有 dock 计划可依），
 * 应用组手钉由 taskbar/layout-store 独立承载并在本层之上按 exe 身份去重：推荐位只认「在池 + 有分」。
 * 工单160：上限 8→5（排序算法与候选池口径不变）；条目携带图标键与 exe 身份（图标渲染、
 * 手钉、启动、定位的统一寻址）。exe 在本层以条目路径为暂定身份——快捷方式目标解析
 * 需要 Electron 真源，由主进程服务层富化（数据面子进程无 Electron API，快照携带暂定值）。
 */
import type { DesktopItem, TaskbarRecommendation } from '../../shared/contract'
import { normalizeExe } from './apps-plan'

/** 推荐位上限（工单160 收窄口径：5；工单54 时代的 8 随推荐组交互票退役） */
export const RECOMMENDATION_LIMIT = 5

/**
 * 推荐位候选池上限（工单161）：喂给服务层可见性管线的候选池截断。移除名单（持久排除）
 * 与手钉滤除都发生在服务层——截断只能在**滤除之后**做（滤除腾出的空位由后续名次递补），
 * 故数据面产池不再按可见上限截断；此值只是传输与编排规模的兜底（20 个递补名次远超排除
 * 名单的合理规模），可见上限恒为 RECOMMENDATION_LIMIT，最终截断在 composeVisibleRecommendations。
 */
export const RECOMMENDATION_POOL_LIMIT = 25

export function planTaskbarRecommendations(
  items: readonly DesktopItem[],
  scores: ReadonlyMap<string, number>,
  limit: number = RECOMMENDATION_LIMIT,
): TaskbarRecommendation[] {
  const candidates: Array<{ item: DesktopItem; score: number }> = []
  for (const item of items) {
    if (item.zone !== 'app') continue // 文档条目不是应用入口
    const score = scores.get(item.display) ?? 0
    if (score <= 0) continue
    candidates.push({ item, score })
  }
  candidates.sort((a, b) => (b.score === a.score ? a.item.name.localeCompare(b.item.name) : b.score - a.score))
  return candidates.slice(0, Math.max(0, limit)).map(({ item }) => ({
    name: item.name,
    display: item.display,
    path: item.path,
    iconKey: item.iconKey,
    exe: item.path, // 暂定身份；主进程服务层按快捷方式目标富化（resolveItemExe 同款解析）
  }))
}

/**
 * 推荐位显式序套用（工单57）：用户在推荐位拖出的有序名单压过分数序——序内条目按名单
 * 次前排（陈旧名 = 当前推荐位不在场，跳过；解除手钉回池时旧位次随之复活），序外条目
 * 保持编排原序（分数序）随后。平移 planDock「显式摆位段先于推荐填补」的三段式语义。
 */
export function applyRecommendationOrder(
  recs: readonly TaskbarRecommendation[],
  order: readonly string[],
): TaskbarRecommendation[] {
  if (order.length === 0) return [...recs]
  const rank = new Map(order.map((name, i) => [name, i]))
  return [...recs].sort((a, b) => {
    const ra = rank.get(a.name)
    const rb = rank.get(b.name)
    if (ra === undefined && rb === undefined) return 0 // 序外：保持编排原序（稳定排序）
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}

/** 可见性管线合成入参（工单161）：身份集均为归一键（normalizeExe），本层按同款归一比较 */
export interface VisibleRecommendationsInput {
  /** 手钉条目 exe 身份集（归一键）：手钉不占推荐位（工单57 既有滤除线） */
  pinnedNorm: ReadonlySet<string>
  /** 移除名单 exe 身份集（归一键）：持久排除不上推荐位（工单161 滤除线） */
  excludedNorm: ReadonlySet<string>
  /** 推荐位显式序（桌面项 name 有序名单，陈旧名跳过） */
  order: readonly string[]
  /** 最终截断（缺省 = RECOMMENDATION_LIMIT；截断在滤除后——递补语义的落点） */
  limit?: number
}

/**
 * 推荐位可见性管线合成（工单161 纯函数，服务层 visibleRecommendations 的裁决本体）：
 * 候选池（已按池上限截断的分数序名单）→ 手钉滤除 → 移除名单滤除 → 显式序套用 → 上限截断。
 * 三条滤除线正交（各滤各的，互不侵蚀——手钉不擦显式序、移除不动两名单），截断收尾在
 * 滤除之后：手钉/移除腾出的空位由候选池后续名次递补，可见数恒 ≤ limit（上限仍 5）。
 * exe 身份比较走 normalizeExe（NTFS 大小写/斜杠不敏感，与手钉判重同一口径）。
 */
export function composeVisibleRecommendations(
  pool: readonly TaskbarRecommendation[],
  input: VisibleRecommendationsInput,
): TaskbarRecommendation[] {
  const visible = pool.filter((r) => {
    const key = normalizeExe(r.exe)
    return !input.pinnedNorm.has(key) && !input.excludedNorm.has(key)
  })
  return applyRecommendationOrder(visible, input.order).slice(0, Math.max(0, input.limit ?? RECOMMENDATION_LIMIT))
}
