/**
 * 中组推荐位编排纯函数（工单54，desktop/plan.ts planDock 同形态）：
 * dock 计划的推荐段（source=recommended）∩ 正分条目 → 分数降序（同分按名稳定）→ 上限截断。
 * 手钉/显式摆位段永不进推荐位（左组栏位不与中组重复）；零分条目只是「在桌面」，
 * 不构成「常用」证据，不占推荐位——这也是「全隐藏 + 无推荐 → 中组不渲染」边界可达的前提。
 */
import type { DesktopDockEntry, DesktopItem, TaskbarRecommendation } from '../../shared/contract'

/** 推荐位上限（工单54 验收口径：8） */
export const RECOMMENDATION_LIMIT = 8

export function planTaskbarRecommendations(
  dock: readonly DesktopDockEntry[],
  items: readonly DesktopItem[],
  scores: ReadonlyMap<string, number>,
  limit: number = RECOMMENDATION_LIMIT,
): TaskbarRecommendation[] {
  const byName = new Map(items.map((i) => [i.name, i]))
  const candidates: Array<{ item: DesktopItem; score: number }> = []
  for (const entry of dock) {
    if (entry.source !== 'recommended') continue
    const item = byName.get(entry.name)
    if (!item) continue // 陈旧名字：编排输入允许含池外名，推荐位只认在场条目
    const score = scores.get(item.display) ?? 0
    if (score <= 0) continue
    candidates.push({ item, score })
  }
  candidates.sort((a, b) => (b.score === a.score ? a.item.name.localeCompare(b.item.name) : b.score - a.score))
  return candidates.slice(0, Math.max(0, limit)).map(({ item }) => ({
    name: item.name,
    display: item.display,
    path: item.path,
  }))
}

/**
 * 推荐位显式序套用（工单57）：用户在中组拖出的有序名单压过分数序——序内条目按名单
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
