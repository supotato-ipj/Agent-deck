/**
 * 卡内滚轮与热区翻转时序的**实测**（工单180 = spec166 之③）。
 *
 * 工单要回答的是一个真问题，不是写一句「已知边界」搪塞：
 *   > 面板默认鼠标穿透，光标落入已声明热区时由主进程以 25ms 一拍轮询解除穿透——
 *   > 刚进入卡片的第一次滚轮可能落在翻转生效前，**这是已知边界，本票要实测它是否可接受并记录结论**。
 *
 * 本仓库没有 jsdom，也没有真机 GUI（GUI 目视由 accept-guard 托管的那一轮做，且是唯一一个共享的
 * 验收位，本票不占）。故这里做的是**离线可执行建模**：把 `src/main/hotzone.ts` 的 `poll()` 逐行照搬成
 * 一个模型（虚拟时钟、1ms 粒度），并且——关键——**轮询间隔与离开确认拍数从内核源码里正则读出**，
 * 不在本文件里另抄一份常量。内核哪天改了这两个数，本测试的结论自动跟着变，不会变成过期结论。
 *
 * 建模的诚实边界（读结论前先看这段）：
 *   - 忠实照搬：光标命中判定（`<=` 双闭）、进入立刻翻转、离开连续两拍确认、翻转时
 *     `setIgnoreMouseEvents(false/true)`。这些就是 `hotzone.ts` 的全部判据。
 *   - 未建模：Windows 消息队列的排队、`setIgnoreMouseEvents` 真正生效到合成器输入的那段延迟
 *     （本机无法离线测），以及 Chromium 对「翻转瞬间在途的那一个滚轮消息」的处理。
 *     真机那轮要复核的就是这两条——结论里单列了复核口径。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { EXPANDED_H, EXPANDED_W, rowLayoutOf } from '../../plugins/doc-group-cards/geometry'

/** 内核那侧的真实来源——常量从这里读，本文件不另抄一份（与 contract.spec.ts 同一条读取约定） */
const HOTZONE_SRC = path.resolve(__dirname, '../../src/main/hotzone.ts')
const hotzoneSource = fs.readFileSync(HOTZONE_SRC, 'utf8')

/** 轮询拍间隔（ms）——从内核源码读，不另抄一份 */
const POLL_MS = Number(/const POLL_MS = (\d+)/.exec(hotzoneSource)?.[1])
/** 离开确认拍数——同上 */
const LEAVE_CONFIRM_POLLS = Number(/const LEAVE_CONFIRM_POLLS = (\d+)/.exec(hotzoneSource)?.[1])

type Rect = { id: string; x: number; y: number; w: number; h: number }

/**
 * 主进程轮询器的可执行模型：`hotzone.ts` 的 `poll()` 逐行照搬。
 * 唯一简化：把 `setIgnoreMouseEvents` 换成一个布尔量（模型里不存在真的窗口）。
 */
class TrackerModel {
  rects: Rect[] = []
  /** 面板默认穿透：true = 鼠标事件穿到下面的窗口，渲染层收不到 */
  passthrough = true
  hot = false
  missCount = 0

  constructor(public readonly pollMs = POLL_MS, public readonly leavePolls = LEAVE_CONFIRM_POLLS) {}

  setRects(rects: Rect[]): void {
    this.rects = rects
  }

  /** @param px/py 光标在窗口内的坐标（主进程侧是屏幕坐标减去窗口原点） */
  poll(px: number, py: number): 'enter' | 'leave' | null {
    const hit = this.rects.some((r) =>
      px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
    if (hit) {
      this.missCount = 0
      if (!this.hot) {
        this.hot = true
        this.passthrough = false
        return 'enter'
      }
      return null
    }
    this.missCount += 1
    if (this.hot && this.missCount >= this.leavePolls) {
      this.hot = false
      this.passthrough = true
      return 'leave'
    }
    return null
  }
}

/** 面板参考屏 2560×1440（app/config.json 实配）；任务栏 48px */
const VIEWPORT = { width: 2560, height: 1440 }

/** 渲染层 `declareHotZones` 那一侧会送过来的东西：`.card` 的矩形（零尺寸的已被滤掉） */
function expandedCardRect(): Rect {
  const box = rowLayoutOf(['dgc-docx'], VIEWPORT, 'dgc-docx')[0]
  return { id: 'dgc-docx', x: box.left, y: box.top, w: box.width, h: box.height }
}

/** 光标落在展开卡正中（进入即命中） */
function centerOf(rect: Rect): { x: number; y: number } {
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) }
}

/**
 * 模拟一次滚动手势：`wheelTimes` 是各滚轮 tick 到达的时刻，光标始终在 `cursor` 那个点上。
 *
 * 时序按内核真实的对齐方式来：主进程那个 `setInterval(poll, 25)` **第一次拍在 t=25ms**
 * （构造后整整一个周期才跑第一拍），故 t=0 不轮询。若让它在 t=0 就翻一次，本文件里每一条
 * 「丢失多少」的结论都会凭空乐观一整个拍——这类建模自欺正是本测试要避开的东西。
 *
 * `alreadyHot` = 光标在 t=0 **之前**就已入卡且穿透已解除（即用户先移进来、才开始滚）。
 * @returns 送达/丢失的 tick 与翻转时刻
 */
function scrollInsideCard(
  rects: Rect[],
  cursor: { x: number; y: number },
  wheelTimes: number[],
  horizonMs: number,
  alreadyHot = false,
) {
  const tracker = new TrackerModel()
  tracker.setRects(rects)
  if (alreadyHot) tracker.poll(cursor.x, cursor.y)
  const delivered: number[] = []
  const flips: { t: number; flip: string }[] = []
  const wanted = new Set(wheelTimes)
  for (let t = 0; t <= horizonMs; t += 1) {
    if (t > 0 && t % tracker.pollMs === 0) {
      const flip = tracker.poll(cursor.x, cursor.y)
      if (flip) flips.push({ t, flip })
    }
    if (wanted.has(t) && !tracker.passthrough) delivered.push(t)
  }
  return {
    delivered,
    dropped: wheelTimes.filter((t) => !delivered.includes(t)),
    flipAt: flips[0],
  }
}

/** 每 `everyMs` 一个 tick，从 `startMs` 起，共 `count` 个 */
function cadence(everyMs: number, startMs: number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => startMs + i * everyMs)
}

describe('热区翻转时序的底数（读自内核，不在本测试里另抄一份）', () => {
  it('内核轮询拍间隔是 25ms、离开确认 2 拍', () => {
    expect(POLL_MS).toBe(25)
    expect(LEAVE_CONFIRM_POLLS).toBe(2)
    // 这两个数是本票全部时序结论的输入；读不出来说明内核源码挪了窝，先修这里再谈结论
    expect(hotzoneSource).toContain('setIgnoreMouseEvents')
    expect(hotzoneSource).toContain('getCursorScreenPoint')
  })

  it('离开方向要连续两拍才恢复穿透：最迟 2×25 = 50ms（出卡后仍有输入落在卡上）', () => {
    const rect = expandedCardRect()
    const tracker = new TrackerModel()
    tracker.setRects([rect])
    const inside = centerOf(rect)
    tracker.poll(inside.x, inside.y) // 命中即翻转
    expect(tracker.passthrough).toBe(false)
    // 走到卡外：第一拍不翻（边界抖动保护）
    tracker.poll(0, 0)
    expect(tracker.passthrough).toBe(false)
    // 第二拍累计 missCount=2 ≥ LEAVE_CONFIRM_POLLS 才恢复
    tracker.poll(0, 0)
    expect(tracker.passthrough).toBe(true)
    expect(LEAVE_CONFIRM_POLLS * POLL_MS).toBe(50)
  })
})

describe('「刚进卡片的第一滚」实测（工单点名要测的那一条）', () => {
  const rect = expandedCardRect()
  const cursor = centerOf(rect)

  it('最坏暴露窗口 = 一个轮询拍（25ms）：光标进卡的瞬间滚轮仍穿到桌面，渲染层收不到', () => {
    const { flipAt } = scrollInsideCard([rect], cursor, [0], 100)
    expect(flipAt.t).toBe(POLL_MS)
    expect(POLL_MS).toBe(25)
  })

  it('滚轮在翻转前落地 = 丢失（模型如实记为 dropped，不假装送达）', () => {
    const { delivered, dropped } = scrollInsideCard([rect], cursor, [0, 10, 20, 30, 40], 100)
    expect(delivered).toEqual([30, 40]) // 第 25ms 那一拍翻转 → t=30 起送达
    expect(dropped).toEqual([0, 10, 20])
  })

  it('结论一：刻度滚轮（每 ~125ms 一格）每次进入**最多丢 1 格**，第 2 格起正常滚', () => {
    for (const phase of [0, 20, 24, 60, 124]) {
      const { dropped, delivered } = scrollInsideCard([rect], cursor, cadence(125, phase, 6), 1200)
      // 关键结论：手势不会被整段吞掉——至多丢进入后的第一格
      expect(dropped.length).toBeLessThanOrEqual(1)
      expect(delivered.length).toBeGreaterThanOrEqual(5)
    }
  })

  it('结论二：高分辨率滚轮（每 ~8ms 一个 tick）丢的也只是进入后的头 ~33ms（≤4 个 tick）', () => {
    const { dropped, delivered } = scrollInsideCard([rect], cursor, cadence(8, 0, 30), 400)
    expect(dropped.length).toBeLessThanOrEqual(4)
    expect(dropped.length).toBeGreaterThan(0)
    expect(delivered.length).toBeGreaterThanOrEqual(26)
  })

  it('结论三：同一次进入里，损失只发生在翻转之前——翻转之后每一拍都送达，不会再丢', () => {
    const { dropped, delivered, flipAt } = scrollInsideCard([rect], cursor, cadence(8, 0, 30), 400)
    expect(flipAt.t).toBe(POLL_MS)
    expect(dropped.every((t) => t < flipAt.t)).toBe(true)
    expect(delivered[0]).toBeGreaterThanOrEqual(flipAt.t)
    expect(delivered).toHaveLength(30 - dropped.length)
  })

  it('结论四：光标先入卡、用户随后才滚滚轮的话，一格都不丢（t=0 已在卡内且已翻转）', () => {
    const { dropped, delivered } = scrollInsideCard([rect], cursor, cadence(8, 0, 30), 400, true)
    expect(dropped).toEqual([])
    expect(delivered).toHaveLength(30)
  })
})

describe('几何变化若不重申报热区，损失的就不是一格滚轮（工单180 的热区纪律）', () => {
  const rect = expandedCardRect()

  it('没申报 = 主进程手上一个矩形都没有 → 卡上既点不到也滚不动（含滚轮，损失不是 25ms 而是全部）', () => {
    const cursor = centerOf(rect)
    const { delivered, dropped, flipAt } = scrollInsideCard([], cursor, cadence(8, 0, 30), 400)
    expect(flipAt).toBeUndefined()
    expect(delivered).toEqual([])
    expect(dropped).toHaveLength(30) // 整段手势全丢
  })

  it('申报之后代价回到「至多 25ms 的进入窗口」——这正是每一次几何变化都要 onDomChanged 的理由', () => {
    const cursor = centerOf(rect)
    const without = scrollInsideCard([], cursor, cadence(8, 0, 30), 400)
    const with_ = scrollInsideCard([rect], cursor, cadence(8, 0, 30), 400)
    expect(without.dropped.length).toBe(30)
    expect(with_.dropped.length).toBeLessThanOrEqual(4)
  })

  it('展开态的矩形确实比折叠态大一圈：新露出的那一圈全靠这次申报才可点', () => {
    const collapsed = rowLayoutOf(['dgc-docx'], VIEWPORT, '')[0]
    const expanded = rowLayoutOf(['dgc-docx'], VIEWPORT, 'dgc-docx')[0]
    expect([expanded.width, expanded.height]).toEqual([640, 976])
    expect(EXPANDED_W / collapsed.width).toBe(2)
    expect(EXPANDED_H / collapsed.height).toBe(4)
    // 展开态四至比折叠态多出来的这一圈，若不在热区里就是死区：滚轮穿到桌面、点击穿到桌面
    const grown = {
      x: Math.min(collapsed.left, expanded.left),
      y: Math.min(collapsed.top, expanded.top),
      w: Math.max(collapsed.width, expanded.width),
      h: Math.max(collapsed.height, expanded.height),
    }
    expect(expandedCardRect()).not.toEqual(grown)
  })
})
