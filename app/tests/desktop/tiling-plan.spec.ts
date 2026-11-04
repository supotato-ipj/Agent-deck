/**
 * Agent 平铺规划矩阵（工单376，spec #369 决策 7 + 测试决策 8 的 0-2 窗部分）：一窗铺满、
 * 两窗左右各半的精确几何、确定性（同一序列同一布局）、容量溢出标记、平铺区推导。
 * 3+ 窗裂变队列的完整性归工单377——本票断言 3 窗不越界（裂 B 语义已定，作纯函数
 * 既有行为的事实钉，不改契约）。
 */
import { describe, expect, it } from 'vitest'
import {
  MIN_PANE_H,
  MIN_PANE_W,
  BAND_REVEAL_PX,
  bandColumnRects,
  bandColumnWidth,
  bandRevealPx,
  bandTreeArea,
  createTree,
  fitCamera,
  planTiling,
  rebaseTreeArea,
  tileAreaOf,
  treeInsert,
  treePlan,
} from '../../src/main/desktop/tiling-plan'
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

import { isTileableArea, treePlacedIds, treeRemove } from '../../src/main/desktop/tiling-plan'
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

// ————————————————————————————————————————————————————————————
// 工单410（spec #410 决策「屏内窗格上限 8」）：容量双约束——最小窗格之外新增屏内容量
// 上限 8；已有 8 个屏内成员时新成员直接进入屏外集合，不再尝试裂变（story 3/4/5）。
// 8 是上限不是对小屏的强制分裂数量：小屏提前入带由既有最小窗格约束承接（story 7）。
// ————————————————————————————————————————————————————————————

describe('屏内容量上限 8（工单410，用户故事 3/4/5）', () => {
  it('1/2/5/6/7/8 窗全部落格（尺寸允许时 8 窗封顶不入带）', () => {
    for (const n of [1, 2, 5, 6, 7, 8]) {
      const members = Array.from({ length: n }, (_, i) => `w${i + 1}`)
      const plan = planTiling(members, AREA)
      expect(plan.overflow, `${n} 窗不应溢出`).toEqual([])
      expect(plan.placements.length).toBe(n)
      assertTilingInvariant(plan, AREA)
    }
  })

  it('第 9 窗必入带、第 10 窗按序随入（story 5/6）：前 8 窗几何与八窗布局逐字节同', () => {
    const eight = planTiling(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8'], AREA)
    const ten = planTiling(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10'], AREA)
    expect(ten.placements).toEqual(eight.placements) // 溢出不重排既有成员
    expect(ten.overflow).toEqual(['w9', 'w10'])
  })

  it('上限先于几何判据：8 窗后仍可满足最小窗格的裂变也不再尝试（本机 2560×1392 第 9 扇 320×696 本可裂）', () => {
    // 八窗后叶 640×696，任一裂变都满足 320×240——仅凭最小窗格约束第 9 扇会落格；
    // 上限 8 使它直接入带（本测试在本机几何下钉「上限不是最小窗格推导」）
    const nine = planTiling(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9'], AREA)
    expect(nine.overflow).toEqual(['w9'])
    expect(nine.placements.length).toBe(8)
  })

  it('小屏提前入带（story 7）：最小窗格约束优先于凑满 8 窗', () => {
    const SMALL: TileRect = { left: 0, top: 0, right: 660, bottom: 500 } // 四窗后叶 330×250，再裂 165 < 320
    const six = planTiling(['w1', 'w2', 'w3', 'w4', 'w5', 'w6'], SMALL)
    expect(six.placements.length).toBe(4)
    expect(six.overflow).toEqual(['w5', 'w6'])
  })

  it('关闭补入（story 9）：8+2 窗关一扇屏内窗 → 兄弟吸收 + 最早入带者补入、后随者仍在带', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10']) treeInsert(tree, id)
    expect(treePlan(tree).overflow).toEqual(['w9', 'w10'])
    treeRemove(tree, 'w8')
    // 编排层按 memberOrder 全量重试（工单405 补入同一入口）
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w9', 'w10']) treeInsert(tree, id)
    const plan = treePlan(tree)
    expect(plan.overflow).toEqual(['w10']) // 最早入带的 w9 补入，w10 仍在带
    expect(plan.placements.length).toBe(8)
    assertTilingInvariant(plan, AREA)
  })

  it('带成员补入受同一上限约束：补入后 8 窗满员，其余留在带（上限适用所有入口）', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11']) treeInsert(tree, id)
    expect(treePlan(tree).overflow).toEqual(['w9', 'w10', 'w11'])
    treeRemove(tree, 'w1')
    treeRemove(tree, 'w2')
    // 编排层按 memberOrder 全量重试：两空位按序补入 w9/w10，w11 留带
    for (const id of ['w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11']) treeInsert(tree, id)
    const plan = treePlan(tree)
    expect(plan.overflow).toEqual(['w11'])
    expect(plan.placements.length).toBe(8)
    assertTilingInvariant(plan, AREA)
  })

  it('maxPanes 选项可注入（纯函数缝）；缺省 8', () => {
    const plan = planTiling(['w1', 'w2', 'w3'], AREA, { maxPanes: 2 })
    expect(plan.overflow).toEqual(['w3'])
    expect(plan.placements.length).toBe(2)
  })

  it('空位补入遵循成员序：先溢出者先补（上限态下重试不改序）', () => {
    const tree = createTree(AREA)
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10']) treeInsert(tree, id)
    // 重试插入带成员（幂等，不改序）
    for (const id of ['w9', 'w10']) treeInsert(tree, id)
    expect(treePlan(tree).overflow).toEqual(['w9', 'w10'])
    treeRemove(tree, 'w5')
    for (const id of ['w9', 'w10']) treeInsert(tree, id)
    expect(treePlan(tree).overflow).toEqual(['w10'])
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

// ————————————————————————————————————————————————————————————
// 工单405 屏外滚动带纯几何（spec #403 决策「统一布局坐标与视口」+ 用户故事 12-18，
// GLOSSARY「屏外滚动带」；语义对齐用户已验证的 agent-tiling-hybrid.prototype 原型）
// ————————————————————————————————————————————————————————————
describe('屏外滚动带列宽 bandColumnWidth（工单405，用户故事 13/14）', () => {
  it('常规屏：半屏宽（下取整）', () => {
    expect(bandColumnWidth(2560, 320)).toBe(1280)
    expect(bandColumnWidth(1921, 320)).toBe(960) // 半宽 960.5 下取整
  })

  it('半宽低于 320 取 320（极窄屏下限）', () => {
    expect(bandColumnWidth(500, 320)).toBe(320)
    expect(bandColumnWidth(640, 320)).toBe(320)
  })

  it('不超过平铺区宽度（区宽 < 320 时取区宽——原型的 min(areaW, max(320, half)) 序）', () => {
    expect(bandColumnWidth(300, 320)).toBe(300)
    expect(bandColumnWidth(320, 320)).toBe(320)
  })
})

describe('屏外列连续矩形 bandColumnRects（工单405，用户故事 12/13/15）', () => {
  const A: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }
  it('首列左缘 = 树区右缘（露边 32px 露在屏内右缘），列占满平铺高度，依次向右相邻', () => {
    const cols = bandColumnRects(A, 3, 1280, 32)
    expect(cols).toEqual([
      { left: 2528, top: 0, right: 3808, bottom: 1392 },
      { left: 3808, top: 0, right: 5088, bottom: 1392 },
      { left: 5088, top: 0, right: 6368, bottom: 1392 },
    ])
  })
  it('带左偏移的平铺区（主屏非零原点）列随区平移', () => {
    const cols = bandColumnRects({ left: 100, top: 50, right: 2660, bottom: 1442 }, 1, 1280, 32)
    expect(cols).toEqual([{ left: 2628, top: 50, right: 3908, bottom: 1442 }])
  })
  it('零列 = 空集', () => {
    expect(bandColumnRects(A, 0, 1280, 32)).toEqual([])
  })
})

describe('带非空时屏内树区 bandTreeArea / rebaseTreeArea（工单405，原型 syncArea 语义）', () => {
  it('树区右缘让出露边：right = 区右 − 32，其余边不动', () => {
    expect(bandTreeArea({ left: 0, top: 0, right: 2560, bottom: 1392 }, 32)).toEqual({
      left: 0, top: 0, right: 2528, bottom: 1392,
    })
  })
  it('rebaseTreeArea：整树重展到新区（结构不变、叶矩形重算、树记账区更新）', () => {
    const small: TileRect = { left: 0, top: 0, right: 660, bottom: 500 }
    const tree = createTree(small)
    treeInsert(tree, 'w1')
    treeInsert(tree, 'w2')
    const before = treePlan(tree)
    expect(before.placements[0].rect).toEqual({ left: 0, top: 0, right: 330, bottom: 500 })
    const shrunk = bandTreeArea(small, 32)
    rebaseTreeArea(tree, shrunk)
    const after = treePlan(tree)
    // 结构不变（两窗仍左右各半），矩形按缩窄区重展
    expect(after.placements[0].rect).toEqual({ left: 0, top: 0, right: 314, bottom: 500 })
    expect(after.placements[1].rect).toEqual({ left: 314, top: 0, right: 628, bottom: 500 })
    expect(tree.area).toEqual(shrunk)
  })
})

describe('fit 最小滑动 fitCamera（工单405，用户故事 17/18/19；原型 fit 语义逐条对齐）', () => {
  const A: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }
  const COL_W = 1280
  // 带两列：列 0 = [2528, 3808]、列 1 = [3808, 5088]（连续坐标）
  const cols = bandColumnRects(A, 2, COL_W, 32)

  it('从静止（camera=0）fit 屏内窗：视口不动（窗已完整可见）', () => {
    const camera = fitCamera(0, { left: 0, top: 0, right: 1280, bottom: 1392 }, A, {
      leftPeek: 0, rightPeek: 32, contentRight: 2528 + 2 * COL_W,
    })
    expect(camera).toBe(0)
  })

  it('从静止 fit 首列：最小滑动到列刚好完整可见（camera = 列右缘 − 区右缘）', () => {
    const camera = fitCamera(0, cols[0], A, { leftPeek: 32, rightPeek: 0, contentRight: 2528 + 2 * COL_W })
    expect(camera).toBe(cols[0].right - A.right) // 3808-2560 = 1248
    // 滑动后列的物理位置：完整贴右缘可见
    expect(cols[0].right - camera).toBe(A.right)
    expect(cols[0].left - camera).toBe(A.right - COL_W)
  })

  it('fit 非末列：右邻露边预留（camera 再让 32px，右邻左缘滑入屏内可见）', () => {
    const camera = fitCamera(0, cols[0], A, { leftPeek: 32, rightPeek: 32, contentRight: 2528 + 2 * COL_W })
    expect(camera).toBe(cols[0].right - A.right + 32)
    expect(cols[1].left - camera).toBe(A.right - 32) // 右邻露边可见
  })

  it('从右列返回屏内最左窗：视口回到 0（整组回位）', () => {
    const camera = fitCamera(1248, { left: 0, top: 0, right: 320, bottom: 1392 }, A, {
      leftPeek: 0, rightPeek: 32, contentRight: 2528 + 2 * COL_W,
    })
    expect(camera).toBe(0)
  })

  it('双向对称：从屏内深处 fit 更深的屏外列 = 继续右滑最小量；反方向同理', () => {
    const atCol0 = fitCamera(0, cols[0], A, { leftPeek: 32, rightPeek: 32, contentRight: 2528 + 2 * COL_W })
    const atCol1 = fitCamera(atCol0, cols[1], A, { leftPeek: 32, rightPeek: 0, contentRight: 2528 + 2 * COL_W })
    expect(atCol1).toBe(cols[1].right - A.right) // 5088-2560 = 2528
    const backToCol0 = fitCamera(atCol1, cols[0], A, { leftPeek: 32, rightPeek: 32, contentRight: 2528 + 2 * COL_W })
    // 最小滑动 = 钳到可见区间 [lo, hi] 内离当前视口最近的点：从列 1 深处返回落在区间右端
    // （列 0 完整可见 + 左邻露边可见的最右视口），不是从静止出发的左端——原型实证语义
    expect(backToCol0).toBe(cols[0].left - 32)
  })

  it('已在目标可见范围内：视口不动（最小滑动，不居中不回零）', () => {
    // camera=600 时目标 [1000,2000] 物理 [400,1400] 已完整可见（右露边预留后仍可见）
    const camera = fitCamera(600, { left: 1000, top: 0, right: 2000, bottom: 1392 }, A, {
      leftPeek: 0, rightPeek: 0, contentRight: 2528 + 2 * COL_W,
    })
    expect(camera).toBe(600)
  })

  it('视口右界钳制：不超过内容右端（不出现空白视口）', () => {
    const contentRight = 2528 + COL_W // 只一列
    const camera = fitCamera(0, cols[0], A, { leftPeek: 32, rightPeek: 32, contentRight })
    expect(camera).toBe(Math.max(0, contentRight - A.right))
  })

  it('目标宽于可用视口（极窄屏）：居中兜底', () => {
    const narrow: TileRect = { left: 0, top: 0, right: 500, bottom: 400 }
    const camera = fitCamera(0, { left: 2500, top: 0, right: 3600, bottom: 400 }, narrow, {
      leftPeek: 32, rightPeek: 32, contentRight: 3600,
    })
    expect(camera).toBe(2500 - Math.floor((500 - 1100) / 2) - 0 + 0) // 居中：left - (areaW - w)/2
    expect(camera).toBe(2500 + 300)
  })

  it('fitCamera 不产生负视口', () => {
    expect(fitCamera(0, { left: -500, top: 0, right: -100, bottom: 100 }, A, {
      leftPeek: 0, rightPeek: 0, contentRight: 0,
    })).toBe(0)
  })
})

describe('露边物理换算 bandRevealPx（工单405，用户故事 16：32 逻辑像素）', () => {
  it('100% 缩放（minPaneW=320）：32 物理 px', () => {
    expect(bandRevealPx(320)).toBe(32)
    expect(BAND_REVEAL_PX).toBe(32)
  })
  it('高缩放按 minPaneW 等比（minPaneW=480 → 48）', () => {
    expect(bandRevealPx(480)).toBe(48)
  })
})
