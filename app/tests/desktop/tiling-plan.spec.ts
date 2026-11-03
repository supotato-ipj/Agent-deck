/**
 * Agent 平铺规划矩阵（工单376，spec #369 决策 7 + 测试决策 8 的 0-2 窗部分）：一窗铺满、
 * 两窗左右各半的精确几何、确定性（同一序列同一布局）、容量溢出标记、平铺区推导。
 * 3+ 窗裂变队列的完整性归工单377——本票断言 3 窗不越界（裂 B 语义已定，作纯函数
 * 既有行为的事实钉，不改契约）。
 */
import { describe, expect, it } from 'vitest'
import { MIN_PANE_H, MIN_PANE_W, planTiling, tileAreaOf } from '../../src/main/desktop/tiling-plan'
import type { TileRect } from '../../src/main/desktop/tiling-plan'

const AREA: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 } // 2560×1440 屏 − 48px 栏

describe('平铺规划 planTiling（工单376）', () => {
  it('零成员 = 空规划', () => {
    expect(planTiling([], AREA)).toEqual({ placements: [], overflow: [] })
  })

  it('一窗铺满平铺区（用户故事 13）', () => {
    const plan = planTiling(['w1'], AREA)
    expect(plan.placements).toEqual([{ id: 'w1', rect: AREA }])
    expect(plan.overflow).toEqual([])
  })

  it('两窗左右各半（用户故事 14）：中心线对分，左 = 先入列窗', () => {
    const plan = planTiling(['w1', 'w2'], AREA)
    expect(plan.overflow).toEqual([])
    const [a, b] = plan.placements
    expect(a.id).toBe('w1')
    expect(b.id).toBe('w2')
    expect(a.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(b.rect).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    // 左右等宽（奇数宽取整无损：floor + ceil 合计还原全宽）
    expect(a.rect.right - a.rect.left).toBe(b.rect.right - b.rect.left)
  })

  it('奇数宽：两窗合计铺满、无缝无叠', () => {
    const area: TileRect = { left: 10, top: 5, right: 2557, bottom: 1391 }
    const plan = planTiling(['w1', 'w2'], area)
    const [a, b] = plan.placements
    expect(a.rect.right).toBe(b.rect.left)
    expect(a.rect.left).toBe(area.left)
    expect(b.rect.right).toBe(area.right)
    expect(a.rect.top).toBe(area.top)
    expect(b.rect.bottom).toBe(area.bottom)
  })

  it('平铺区顶部 = 区顶（不为胶囊留白）、底部 = 区底（避开任务栏由调用方给区）', () => {
    const plan = planTiling(['w1', 'w2'], AREA)
    for (const p of plan.placements) {
      expect(p.rect.top).toBe(AREA.top)
      expect(p.rect.bottom).toBe(AREA.bottom)
    }
  })

  it('三窗：裂 B → A 左半、B 右上、C 右下（用户故事 15，纯函数事实钉——完整性归工单377）', () => {
    const plan = planTiling(['w1', 'w2', 'w3'], AREA)
    expect(plan.overflow).toEqual([])
    const byId = new Map(plan.placements.map((p) => [p.id, p.rect]))
    expect(byId.get('w1')).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(byId.get('w2')).toEqual({ left: 1280, top: 0, right: 2560, bottom: 696 })
    expect(byId.get('w3')).toEqual({ left: 1280, top: 696, right: 2560, bottom: 1392 })
  })

  it('同一事件序列必得同一布局（用户故事 18）', () => {
    const a = planTiling(['x', 'y'], AREA)
    const b = planTiling(['x', 'y'], AREA)
    expect(a).toEqual(b)
    const c = planTiling(['y', 'x'], AREA) // 换序 = 不同事件序列 → 不同布局
    expect(c.placements[0].rect).toEqual(a.placements[0].rect)
  })

  it('容量溢出：裂变会使子格低于最小窗格 → 新窗溢出、既有成员几何不变（spec 决策 12）', () => {
    // 700×500 区：两窗各 350 宽 ≥320 ✓；三/四窗竖裂各 250 高 ≥240 ✓；五窗横裂 B'
    // （深度 2）各 175 宽 < 320 → 溢出（溢出不由窗数决定，由实际空间决定）
    const small: TileRect = { left: 0, top: 0, right: 700, bottom: 500 }
    const plan = planTiling(['w1', 'w2', 'w3', 'w4', 'w5'], small)
    expect(plan.overflow).toEqual(['w5'])
    const byId = new Map(plan.placements.map((p) => [p.id, p.rect]))
    expect(byId.get('w1')!.right).toBe(350)
    expect(byId.get('w2')!.left).toBe(350)
    expect(byId.has('w5')).toBe(false) // 溢出窗不落格
  })

  it('高度不足同样溢出（minPaneH 口径：三窗的竖裂各 230 < 240）', () => {
    const short: TileRect = { left: 0, top: 0, right: 700, bottom: 460 }
    const plan = planTiling(['w1', 'w2', 'w3'], short)
    expect(plan.overflow).toEqual(['w3'])
  })

  it('自定义最小窗格生效', () => {
    const plan = planTiling(['w1', 'w2'], AREA, { minPaneW: 2000, minPaneH: MIN_PANE_H })
    expect(plan.overflow).toEqual(['w2']) // 各半 1280 < 2000
    expect(MIN_PANE_W).toBe(320)
    expect(MIN_PANE_H).toBe(240)
  })
})

describe('平铺区推导 tileAreaOf（工单376，用户故事 22）', () => {
  it('下方避开任务栏：bottom = 条带顶', () => {
    const primary: TileRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
    expect(tileAreaOf(primary, 1392)).toEqual({ left: 0, top: 0, right: 2560, bottom: 1392 })
  })

  it('顶部不为胶囊留白：top = 主屏顶（胶囊覆盖在窗口之上）', () => {
    const primary: TileRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
    expect(tileAreaOf(primary, 1392).top).toBe(0)
  })

  it('条带顶缺位/异常（≥ 屏底）退化为屏底', () => {
    const primary: TileRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
    expect(tileAreaOf(primary, null).bottom).toBe(1440)
    expect(tileAreaOf(primary, 1440).bottom).toBe(1440)
    expect(tileAreaOf(primary, 2000).bottom).toBe(1440)
  })
})
