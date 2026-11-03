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

// ————————————————————————————————————————————————————————————
// 工单377：完整生命周期与容量降级（3-8 窗裂变队列续行、兄弟吸收、溢出补入、
// 持久树不变量、平铺区可用判）
// ————————————————————————————————————————————————————————————

import { createTree, isTileableArea, treeInsert, treePlacedIds, treePlan, treeRemove } from '../../src/main/desktop/tiling-plan'
import type { TilingTree } from '../../src/main/desktop/tiling-plan'

/** 平铺不变量：placements 两两不重叠、合计铺满平铺区（面积守恒） */
function assertTilingInvariant(plan: { placements: Array<{ rect: TileRect }> }, area: TileRect): void {
  const total = plan.placements.reduce((acc, p) => acc + (p.rect.right - p.rect.left) * (p.rect.bottom - p.rect.top), 0)
  expect(total).toBe((area.right - area.left) * (area.bottom - area.top))
  for (let i = 0; i < plan.placements.length; i++) {
    for (let j = i + 1; j < plan.placements.length; j++) {
      const a = plan.placements[i].rect
      const b = plan.placements[j].rect
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left)
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      expect(w <= 0 || h <= 0).toBe(true)
    }
  }
}

function rectOf(plan: { placements: Array<{ id: string; rect: TileRect }> }, id: string): TileRect {
  const r = plan.placements.find((p) => p.id === id)
  if (!r) throw new Error(`placement ${id} 缺位`)
  return r.rect
}

describe('平铺树：裂变队列续行与确定性（工单377，用户故事 16/17/18）', () => {
  it('四窗裂变 A：A/D 左列、B/C 右列（用户故事 16）', () => {
    const plan = planTiling(['w1', 'w2', 'w3', 'w4'], AREA)
    expect(plan.overflow).toEqual([])
    expect(rectOf(plan, 'w1')).toEqual({ left: 0, top: 0, right: 1280, bottom: 696 })
    expect(rectOf(plan, 'w4')).toEqual({ left: 0, top: 696, right: 1280, bottom: 1392 })
    expect(rectOf(plan, 'w2')).toEqual({ left: 1280, top: 0, right: 2560, bottom: 696 })
    expect(rectOf(plan, 'w3')).toEqual({ left: 1280, top: 696, right: 2560, bottom: 1392 })
    assertTilingInvariant(plan, AREA)
  })

  it('五窗再次裂变 B：窗 2 窗格横裂（用户故事 17）', () => {
    const plan = planTiling(['w1', 'w2', 'w3', 'w4', 'w5'], AREA)
    expect(plan.overflow).toEqual([])
    expect(rectOf(plan, 'w2')).toEqual({ left: 1280, top: 0, right: 1920, bottom: 696 })
    expect(rectOf(plan, 'w5')).toEqual({ left: 1920, top: 0, right: 2560, bottom: 696 })
    // 其余窗格不被五窗裂变牵动
    expect(rectOf(plan, 'w1')).toEqual({ left: 0, top: 0, right: 1280, bottom: 696 })
    expect(rectOf(plan, 'w4')).toEqual({ left: 0, top: 696, right: 1280, bottom: 1392 })
    expect(rectOf(plan, 'w3')).toEqual({ left: 1280, top: 696, right: 2560, bottom: 1392 })
    assertTilingInvariant(plan, AREA)
  })

  it('六至八窗按叶窗格队列续行（队列近似 BFS：随后裂的是窗 3、窗 1、窗 4 的窗格）', () => {
    const plan = planTiling(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'], AREA)
    expect(plan.overflow).toEqual([])
    expect(rectOf(plan, 'w3')).toEqual({ left: 1280, top: 696, right: 1920, bottom: 1392 })
    expect(rectOf(plan, 'w6')).toEqual({ left: 1920, top: 696, right: 2560, bottom: 1392 })
    expect(rectOf(plan, 'w1')).toEqual({ left: 0, top: 0, right: 640, bottom: 696 })
    expect(rectOf(plan, 'w7')).toEqual({ left: 640, top: 0, right: 1280, bottom: 696 })
    expect(rectOf(plan, 'w4')).toEqual({ left: 0, top: 696, right: 640, bottom: 1392 })
    expect(rectOf(plan, 'w8')).toEqual({ left: 640, top: 696, right: 1280, bottom: 1392 })
    assertTilingInvariant(plan, AREA)
  })

  it('六窗以上确定性：同一事件序列两次建树逐字节同布局（用户故事 18）', () => {
    const seq = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    const a = planTiling(seq, AREA)
    const b = planTiling(seq, AREA)
    expect(a).toEqual(b)
    assertTilingInvariant(a, AREA)
  })

  it('增量裂变 = 一次性建树（逐窗加入与批量规划同布局）', () => {
    const seq = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']
    const batch = planTiling(seq, AREA)
    const tree = createTree(AREA)
    for (const id of seq) treeInsert(tree, id)
    // treePlan 输出按叶中序（空间序）；planTiling 按成员序——按 id 对齐比较
    const byId = new Map(batch.placements.map((p) => [p.id, p.rect]))
    const treePlanOut = treePlan(tree)
    expect(treePlanOut.overflow).toEqual([])
    expect(new Map(treePlanOut.placements.map((p) => [p.id, p.rect]))).toEqual(byId)
    expect(treePlanOut.placements.length).toBe(batch.placements.length)
  })
})

describe('平铺树：兄弟吸收（工单377，用户故事 20、GLOSSARY「Agent 平铺」）', () => {
  it('三窗关窗 2：兄弟窗 3 吸收整右半，窗 1 窗格不动', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2', 'w3']) treeInsert(tree, id)
    expect(treeRemove(tree, 'w2')).toBe(true)
    const plan = treePlan(tree)
    expect(rectOf(plan, 'w1')).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(rectOf(plan, 'w3')).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    assertTilingInvariant(plan, AREA)
  })

  it('兄弟子树整体上移：兄弟是已裂变的子树时按既有轴重展（深度全体 -1）', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2', 'w3', 'w4']) treeInsert(tree, id)
    // 关窗 4：兄弟 = 窗 1 叶（同对 A1/A2）→ 窗 1 吸收整左列
    expect(treeRemove(tree, 'w4')).toBe(true)
    const plan = treePlan(tree)
    expect(rectOf(plan, 'w1')).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(rectOf(plan, 'w2')).toEqual({ left: 1280, top: 0, right: 2560, bottom: 696 })
    expect(rectOf(plan, 'w3')).toEqual({ left: 1280, top: 696, right: 2560, bottom: 1392 })
    assertTilingInvariant(plan, AREA)
  })

  it('移除最后成员退回空根；再插入按 0→1 重新铺满', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2']) treeInsert(tree, id)
    treeRemove(tree, 'w2')
    treeRemove(tree, 'w1')
    expect(treePlacedIds(tree).size).toBe(0)
    treeInsert(tree, 'w9')
    expect(rectOf(treePlan(tree), 'w9')).toEqual(AREA)
  })

  it('移回主屏按最新窗口加入：移除后再插入 = 裂变当前队首（story 21）', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2', 'w3']) treeInsert(tree, id)
    treeRemove(tree, 'w2')
    treeInsert(tree, 'w2') // 移回
    const plan = treePlan(tree)
    // 队首是窗 1 叶（A）→ 新窗按裂变规则切它（上下对分左半），窗 3 右半不动
    expect(rectOf(plan, 'w1')).toEqual({ left: 0, top: 0, right: 1280, bottom: 696 })
    expect(rectOf(plan, 'w2')).toEqual({ left: 0, top: 696, right: 1280, bottom: 1392 })
    expect(rectOf(plan, 'w3')).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    assertTilingInvariant(plan, AREA)
  })
})

describe('容量溢出与按序补入（工单377，用户故事 26/29）', () => {
  const SMALL: TileRect = { left: 0, top: 0, right: 660, bottom: 500 } // 四窗后叶 330×250，再裂 165 < 320

  it('溢出不重排既有成员：五/六窗溢出，前四窗几何与四窗布局逐字节同', () => {
    const four = planTiling(['w1', 'w2', 'w3', 'w4'], SMALL)
    const six = planTiling(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'], SMALL)
    expect(six.overflow).toEqual(['w5', 'w6'])
    expect(six.placements).toEqual(four.placements)
  })

  it('有空间后按序补入：关窗 4 → 窗 5 补入、窗 6 仍溢出；再关窗 2 → 窗 6 补入', () => {
    const tree = createTree(SMALL)
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) treeInsert(tree, id)
    expect(treePlan(tree).overflow).toEqual(['w5', 'w6'])
    treeRemove(tree, 'w4')
    treeInsert(tree, 'w5') // 补入重试（编排层每拍按成员序重试同一入口）
    const after5 = treePlan(tree)
    expect(after5.overflow).toEqual(['w6'])
    expect(rectOf(after5, 'w5')).toEqual({ left: 0, top: 250, right: 330, bottom: 500 })
    treeRemove(tree, 'w2')
    treeInsert(tree, 'w6')
    const after6 = treePlan(tree)
    expect(after6.overflow).toEqual([])
    expect(rectOf(after6, 'w6')).toEqual({ left: 330, top: 250, right: 660, bottom: 500 })
    assertTilingInvariant(after6, SMALL)
  })

  it('补入遵循成员序：先溢出者先补（treeInsert 幂等，重试不改序）', () => {
    const tree = createTree(SMALL)
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6']) treeInsert(tree, id)
    treeRemove(tree, 'w4')
    // 编排层按 memberOrder 全量重试：w5 先于 w6
    for (const id of ['w1', 'w2', 'w3', 'w5', 'w6']) treeInsert(tree, id)
    const plan = treePlan(tree)
    expect(plan.overflow).toEqual(['w6'])
    expect(plan.placements.map((p) => p.id).sort()).toEqual(['w1', 'w2', 'w3', 'w5'].sort())
  })
})

describe('平铺区可用判 isTileableArea（工单377，用户故事 23 不写不可见坐标）', () => {
  it('退化矩形不可用（主屏暂不可用/空矩形过渡态）', () => {
    expect(isTileableArea({ left: 0, top: 0, right: 0, bottom: 0 })).toBe(false)
    expect(isTileableArea({ left: 0, top: 0, right: 100, bottom: 0 })).toBe(false)
  })

  it('容不下一个最小窗格不可用；恰好最小窗格可用', () => {
    expect(isTileableArea({ left: 0, top: 0, right: 319, bottom: 240 })).toBe(false)
    expect(isTileableArea({ left: 0, top: 0, right: 320, bottom: 239 })).toBe(false)
    expect(isTileableArea({ left: 0, top: 0, right: 320, bottom: 240 })).toBe(true)
    expect(isTileableArea(AREA)).toBe(true)
  })
})
