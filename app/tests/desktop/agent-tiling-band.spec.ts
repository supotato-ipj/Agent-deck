/**
 * Agent 平铺屏外滚动带服务级矩阵（工单405，spec #403 决策「容量溢出改变含义」「统一
 * 布局坐标与视口」「单一激活入口执行 fit」，用户故事 10-21；GLOSSARY「屏外滚动带」
 * 「容量溢出」）。断言外部可见行为：实际写窗矩形、状态投影、预览成员、授权提示——
 * 不绑定内部类。假窗口 harness 与 agent-tiling-service.spec.ts 同款纪律（deps 全假源、
 * 零 FFI/Electron），另加前台事件假源（工单405 激活 fit 的驱动缝）。
 *
 * 容量夹具：主屏 1200×752 平铺区 + minPane 320×240 → 容量恰 4 扇（第 5 扇必溢出），
 * 列宽 = min(1200, max(320, 600)) = 600、露边 = 32（100% 缩放）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentTilingService } from '../../src/main/services/agent-tiling'
import type { AgentTilingServiceOptions } from '../../src/main/services/agent-tiling'
import type { AgentTilingState } from '../../src/shared/contract'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'
import type { TileRect } from '../../src/main/desktop/tiling-plan'

const PRIMARY = { left: 0, top: 0, right: 1200, bottom: 800 }
const TASKBAR_TOP = 752
// 带几何夹具常量（列宽 600、露边 32、首列连续矩形 [1168, 0, 1768, 752]）
const COL_W = 600
const REVEAL = 32
const COL0: TileRect = { left: 1200 - REVEAL, top: 0, right: 1200 - REVEAL + COL_W, bottom: 752 }

interface Harness {
  svc: AgentTilingService
  windows: Map<number, { rect: TileRect; iconic: boolean; resizable?: boolean; minSize?: { w: number; h: number } }>
  writes: Array<{ hwnd: number; target: TileRect }>
  watchOn: (hwnd: number) => void
  mode: { value: 'normal' | 'agent' | 'unmanaged' }
  events: AgentTilingState[]
  foreground: Set<number>
  /** 前台变化事件（工单405 激活 fit 驱动缝——露边点击/任务栏激活的假源） */
  fgEmit: (hwnd: number) => void
  prompts: Array<{ hwnd: number; rect: TileRect }>
}

function harness(over: Partial<AgentTilingServiceOptions> = {}): Harness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean; resizable?: boolean; minSize?: { w: number; h: number } }>()
  const writes: Array<{ hwnd: number; target: TileRect }> = []
  const events: AgentTilingState[] = []
  const mode = { value: 'agent' as 'normal' | 'agent' | 'unmanaged' }
  const foreground = new Set<number>()
  const prompts: Array<{ hwnd: number; rect: TileRect }> = []
  let watchCb: ((hwnd: number) => void) | null = null
  let fgCb: ((hwnd: number) => void) | null = null

  const factsOf = (): TileWindowFacts[] =>
    [...windows.entries()].map(([hwnd, w]) => ({
      hwnd,
      exe: 'C:\\Windows\\System32\\notepad.exe',
      title: `窗 ${hwnd}`,
      visible: true,
      cloaked: false,
      cloakedShell: false,
      toolWindow: false,
      owned: false,
      appWindow: false,
      iconic: w.iconic,
      resizable: w.resizable !== false,
      rect: { ...w.rect },
      onCurrentDesktop: mode.value === 'agent' ? true : null,
    }))

  const ctx = new Context()
  const svc = new AgentTilingService(ctx, {
    enabled: true,
    batchMs: 0,
    settleMs: 40,
    ...over,
    deps: {
      currentMode: () => mode.value,
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => ({ ...PRIMARY }),
      taskbarTop: () => TASKBAR_TOP,
      onDisplayChanged: () => () => undefined,
      collectFacts: factsOf,
      readRect: (hwnd) => ({ ...(windows.get(hwnd)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      restoreRect: (hwnd, target) => {
        writes.push({ hwnd, target: { ...target } })
        const w = windows.get(hwnd)
        if (w) {
          // 最小尺寸夹取（工单414，与 agent-tiling-service.spec 同款）：写受理但应用按
          // 自身 minWidth/minHeight 夹取（WM_GETMINMAXINFO 假身）——回读不达标走既有
          // 核验路径。屏外带列 600×752 > 夹具常规件，仅显式 minSize 的窗触发。
          const ms = w.minSize
          w.rect = ms
            ? {
                left: target.left,
                top: target.top,
                right: target.left + Math.max(target.right - target.left, ms.w),
                bottom: target.top + Math.max(target.bottom - target.top, ms.h),
              }
            : { ...target }
        }
        return true
      },
      isForeground: (hwnd) => foreground.has(hwnd),
      startWatch: (cb) => {
        watchCb = cb
        return () => {
          watchCb = null
        }
      },
      onForegroundChanged: (cb) => {
        fgCb = cb
        return () => {
          fgCb = null
        }
      },
      ...over.deps,
    },
  })
  ctx.on('tiling/changed', (payload) => events.push(payload))
  ctx.on('tiling/authorize-request', (payload) => prompts.push(payload))
  svc.start()
  return {
    svc,
    windows,
    writes,
    watchOn: (hwnd) => watchCb?.(hwnd),
    mode,
    events,
    foreground,
    fgEmit: (hwnd) => fgCb?.(hwnd),
    prompts,
  }
}

/** 等一轮 pass 跑完（runPass 是 async） */
async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** 开一批窗（原矩形各不相同——「不再按原矩形覆盖」的对照面） */
function openWindows(h: Harness, specs: Array<[number, TileRect]>): void {
  for (const [hwnd, rect] of specs) h.windows.set(hwnd, { rect: { ...rect }, iconic: false })
  h.watchOn(specs[specs.length - 1][0])
}

const R = (n: number): TileRect => ({ left: 100 + n * 40, top: 100 + n * 20, right: 700 + n * 40, bottom: 600 + n * 20 })

describe('容量溢出进屏外滚动带（工单405，用户故事 10/11/12）', () => {
  it('第 5 扇窗（容量外）写入屏外列矩形，不再按原矩形覆盖屏内窗格', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    const writesBefore = h.writes.length
    openWindows(h, [[5, R(5)]])
    await settle()
    // 带首列连续矩形（camera=0 时物理 = 连续）：左缘 = 区右 − 32（露边）、列宽 600、占满平铺高
    expect(h.windows.get(5)!.rect).toEqual(COL0)
    const w5Writes = h.writes.slice(writesBefore).filter((w) => w.hwnd === 5)
    expect(w5Writes.length).toBeGreaterThan(0)
    expect(w5Writes[0].target).toEqual(COL0)
    // 屏内四窗不保原矩形也不被覆盖：树区让出露边后重展（584 宽）
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 584, bottom: 376 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 584, top: 0, right: 1168, bottom: 376 })
    // 投影：带成员是受管平铺成员（overflow=1），不进异常账
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1, anomalies: 0 })
  })

  it('极窄屏列宽下限 320（半宽不足取 320），树区仍让出露边', async () => {
    const h = harness({
      deps: {
        ...({} as Partial<AgentTilingServiceOptions['deps']>),
        primaryRect: () => ({ left: 0, top: 0, right: 500, bottom: 400 }),
        taskbarTop: () => 350,
      },
    })
    h.windows.set(1, { rect: R(1), iconic: false })
    h.watchOn(1)
    await settle()
    h.windows.set(2, { rect: R(2), iconic: false })
    h.watchOn(2)
    await settle()
    // 区 500×350：两窗即溢出（250 < 320）；列宽 = min(500, max(320, 250)) = 320
    expect(h.windows.get(2)!.rect).toEqual({ left: 468, top: 0, right: 788, bottom: 350 })
    expect(h.svc.state()).toMatchObject({ count: 2, placed: 1, overflow: 1 })
  })
})

// ————————————————————————————————————————————————————————————
// 工单410（spec #410 决策「屏内窗格上限 8」，多窗稳定性服务矩阵）：宽屏（几何容量 ≥ 9）
// 上限是唯一约束——逐个打开 6/7/8/9 窗回读实际矩形：非例外成员无原矩形覆盖、无误转
// 浮动、无误消费授权；第 9 窗入带、前台滑入；关闭屏内窗后最早入带者按序补入（story 9）。
// ————————————————————————————————————————————————————————————

describe('屏内 8 窗上限（工单410，宽屏多窗稳定性矩阵）', () => {
  const WIDE = { left: 0, top: 0, right: 2560, bottom: 1440 }
  const WIDE_AREA: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }
  const WIDE_REVEAL = 32
  const WIDE_COL_W = 1280 // min(2560, max(320, 1280))
  // 带首列连续矩形（camera=0 时物理 = 连续）：左缘 = 区右 − 露边
  const WIDE_COL0: TileRect = { left: 2560 - WIDE_REVEAL, top: 0, right: 2560 - WIDE_REVEAL + WIDE_COL_W, bottom: 1392 }

  function wideHarness(): Harness {
    return harness({
      deps: {
        ...({} as Partial<AgentTilingServiceOptions['deps']>),
        primaryRect: () => ({ ...WIDE }),
        taskbarTop: () => 1392,
      },
    })
  }

  it('6/7/8 窗逐个打开全部落格（placed=8 overflow=0），无一保原矩形、无误浮动、无误提示', async () => {
    const h = wideHarness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)]])
    await settle()
    for (const n of [6, 7, 8]) {
      openWindows(h, [[n, R(n)]])
      await settle()
      expect(h.svc.state(), `${n} 窗`).toMatchObject({ count: n, placed: n, overflow: 0, floating: 0, prompting: 0, authorized: 0 })
    }
    expect(h.prompts).toEqual([])
    // 八窗全在缩窄前的屏内树区（带空 = 树满区），无一保持打开时的原矩形
    for (const [hwnd] of h.windows) {
      const r = h.windows.get(hwnd)!.rect
      expect(r, `窗 ${hwnd} 不保原矩形`).not.toEqual(R(hwnd))
      expect(r.right).toBeLessThanOrEqual(WIDE_AREA.right + 2)
      expect(r.left).toBeGreaterThanOrEqual(WIDE_AREA.left - 2)
    }
  })

  it('第 9 窗入带（列矩形=半屏宽×全平铺高×露边32px）；前台滑入贴右缘完整可见（story 5/11）', async () => {
    const h = wideHarness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)], [7, R(7)], [8, R(8)]])
    await settle()
    expect(h.svc.state()).toMatchObject({ placed: 8, overflow: 0 })
    openWindows(h, [[9, R(9)]])
    await settle()
    // 入带：受管平铺成员（不是未平铺），列矩形占满平铺高、露边露在屏内右缘
    expect(h.svc.state()).toMatchObject({ count: 9, placed: 8, overflow: 1, floating: 0, anomalies: 0 })
    expect(h.windows.get(9)!.rect).toEqual(WIDE_COL0)
    expect(h.prompts).toEqual([])
    // 前台新窗自动 fit 最小滑动到完整视图：camera=1248 → 带成员贴右缘（右半满高）
    h.fgEmit(9)
    await settle()
    expect(h.windows.get(9)!.rect).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    expect(h.prompts).toEqual([])
  })

  it('第 10 窗按序随入带右端（story 6）：带序 = 进入序', async () => {
    const h = wideHarness()
    openWindows(h, Array.from({ length: 9 }, (_, i) => [i + 1, R(i + 1)] as [number, TileRect]))
    await settle()
    openWindows(h, [[10, R(10)]])
    await settle()
    expect(h.svc.state()).toMatchObject({ count: 10, placed: 8, overflow: 2 })
    // 第 10 窗 = 带第二列：左缘 = 首列左缘 + 列宽
    expect(h.windows.get(10)!.rect).toEqual({
      left: WIDE_COL0.left + WIDE_COL_W, top: 0, right: WIDE_COL0.right + WIDE_COL_W, bottom: 1392,
    })
  })

  it('关闭屏内窗：兄弟吸收 + 最早入带者按序补入（story 9），补入后仍守 8 上限', async () => {
    const h = wideHarness()
    openWindows(h, Array.from({ length: 10 }, (_, i) => [i + 1, R(i + 1)] as [number, TileRect]))
    await settle()
    expect(h.svc.state()).toMatchObject({ placed: 8, overflow: 2 })
    h.windows.delete(1)
    h.watchOn(2) // 任意窗口事件触发重排拍
    await settle()
    // 空位释放 → 最早入带的窗 9 补入屏内；窗 10 仍在带（8 上限）
    expect(h.svc.state()).toMatchObject({ count: 9, placed: 8, overflow: 1 })
    const r9 = h.windows.get(9)!.rect
    expect(r9.left).toBeGreaterThanOrEqual(WIDE_AREA.left - 2)
    expect(r9.right).toBeLessThanOrEqual(WIDE_AREA.right + 2) // 补入 = 回屏内树区
    expect(h.windows.get(10)!.rect).toEqual(WIDE_COL0) // 窗 10 收拢到首列位
  })
})

describe('fit 最小滑动（工单405，用户故事 17/18/19；单一激活入口）', () => {
  async function withBand(h: Harness): Promise<void> {
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)]])
    await settle()
  }

  it('露边点击/普通激活屏外窗：整组最小滑动到目标刚好完整可见，授权零误报', async () => {
    const h = harness()
    await withBand(h)
    h.writes.length = 0
    h.prompts.length = 0
    h.fgEmit(5) // 露边点击 → 系统前台变化 → 单一 fit 入口
    await settle()
    // camera = 列右缘 − 区右缘 = 568：窗 5 物理贴右缘完整可见
    expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    // 整组滑动：屏内窗左移同量（布局预期写入，不进授权状态机——工单404 分流）
    expect(h.windows.get(1)!.rect).toEqual({ left: -568, top: 0, right: 16, bottom: 376 })
    expect(h.prompts).toEqual([])
  })

  it('反向返回屏内最左窗：视口整组回位（双向对称）', async () => {
    const h = harness()
    await withBand(h)
    h.fgEmit(5)
    await settle()
    h.writes.length = 0
    h.fgEmit(1)
    await settle()
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 584, bottom: 376 })
    expect(h.windows.get(5)!.rect).toEqual(COL0)
  })

  it('激活已完整可见的屏内窗：视口不动（最小滑动不回零）', async () => {
    const h = harness()
    await withBand(h)
    h.fgEmit(5)
    await settle()
    h.writes.length = 0
    h.fgEmit(2) // 窗 2 连续 [584,0,1168,752]，camera=568 下物理 [16,600] 已完整可见
    await settle()
    expect(h.writes).toEqual([]) // 零写入 = 视口未动
    expect(h.windows.get(2)!.rect).toEqual({ left: 16, top: 0, right: 600, bottom: 376 })
  })

  it('非成员的前台变化不触发 fit', async () => {
    const h = harness()
    await withBand(h)
    h.writes.length = 0
    h.fgEmit(999)
    await settle()
    expect(h.writes).toEqual([])
  })
})

describe('前台/后台新窗（工单405，用户故事 20/21）', () => {
  async function showingBand(h: Harness): Promise<void> {
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)]])
    await settle()
    h.fgEmit(5)
    await settle()
  }

  it('前台新窗：追加屏外带右端并自动滑入完整视图', async () => {
    const h = harness()
    await showingBand(h)
    h.foreground.add(6)
    openWindows(h, [[6, R(6)]])
    await settle()
    // 第 2 列连续 [1768, 2368]；camera = 2368 − 1200 = 1168 → 物理 [600, 1200] 贴右缘完整可见
    expect(h.windows.get(6)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
  })

  it('后台新窗：只追加右端，当前视口不动', async () => {
    const h = harness()
    await showingBand(h)
    openWindows(h, [[6, R(6)]]) // 不入前台
    await settle()
    // camera 保持 568：窗 6 写入第 2 列的物理位（大部屏外），窗 5 与屏内窗全不动
    expect(h.windows.get(6)!.rect).toEqual({ left: 1200, top: 0, right: 1800, bottom: 752 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.windows.get(1)!.rect).toEqual({ left: -568, top: 0, right: 16, bottom: 376 })
  })
})

describe('投影与预览（工单405，用户故事 11；验收标准 5 的服务级证据）', () => {
  it('屏外成员计入窗口预览成员快照（off-main-screen 不再踢出受管窗）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)]])
    await settle()
    const members = h.svc.previewMembers().map((m) => m.hwnd)
    expect(members).toContain(5) // 屏外带成员（物理矩形全在主屏外）仍在预览成员集
    expect(members).toEqual([1, 2, 3, 4, 5])
  })
})

// ————————————————————————————————————————————————————————————
// 工单406（spec #403 用户故事 3/4/22-31；GLOSSARY「屏外滚动带」「恢复平铺」）：
// 关闭补入与列收拢、关闭与视口锚、最小化与还原、恢复平铺与聚焦退出。
// 断言全部落在实际写窗矩形与状态投影（假窗口 map 读回），不绑内部类。
// ————————————————————————————————————————————————————————————

describe('关闭补入与列收拢（工单406，用户故事 3/4/25）', () => {
  it('关闭屏内窗：兄弟吸收空位、最早进入屏外的窗补入、次带成员原位保留', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)], [6, R(6)]])
    await settle()
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
    h.windows.delete(4)
    h.watchOn(4)
    await settle()
    // 兄弟吸收：窗 1 上移继承父窗格（左半列）再裂变让位——窗 1 原位不动、窗 5 落下半
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 584, bottom: 376 })
    // 最早屏外进入序补入：窗 5（先入带）进树，窗 6（后入带）原列位保留
    expect(h.windows.get(5)!.rect).toEqual({ left: 0, top: 376, right: 584, bottom: 752 })
    expect(h.windows.get(6)!.rect).toEqual(COL0)
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
  })

  it('关闭屏外窗：带只收拢列、屏内树窗格不动；收拢到空带回满区', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)], [6, R(6)]])
    await settle()
    h.windows.delete(5)
    h.watchOn(5)
    await settle()
    // 树窗格原样（不因带成员关闭重排）：列只收拢——窗 6 从第 2 列左移到第 1 列
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 584, bottom: 376 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 584, top: 0, right: 1168, bottom: 376 })
    expect(h.windows.get(6)!.rect).toEqual(COL0)
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
    // 关到带空：树区回满区（600 宽半格）、视口回位、零带成员
    h.windows.delete(6)
    h.watchOn(6)
    await settle()
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 600, bottom: 376 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 376 })
    expect(h.svc.state()).toMatchObject({ count: 4, placed: 4, overflow: 0 })
  })
})

describe('关闭与视口锚（工单406，用户故事 25/26/27）', () => {
  it('关闭非当前列：当前列保持完整可见（视口不被其他列生命周期拖走）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)]])
    await settle()
    h.fgEmit(5)
    await settle()
    expect(h.windows.get(5)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
    h.windows.delete(6)
    h.watchOn(6)
    await settle()
    // 带收拢后当前列仍完整可见（camera 钳到内容右端 = 当前列贴右缘）
    expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ overflow: 1 })
  })

  it('关闭当前列：右邻优先完整可见', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)]])
    await settle()
    h.fgEmit(5)
    await settle()
    h.windows.delete(5)
    h.watchOn(5)
    await settle()
    expect(h.windows.get(6)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ overflow: 1 })
  })

  it('关闭当前列（无右邻）：左邻完整可见', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)]])
    await settle()
    h.fgEmit(6)
    await settle()
    expect(h.windows.get(6)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    h.windows.delete(6)
    h.watchOn(6)
    await settle()
    expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
  })

  it('关闭屏内当前窗：视口跟随系统新前台（受管带窗滑入完整视图）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)], [7, R(7)]])
    await settle()
    h.fgEmit(5)
    await settle()
    h.foreground.add(2)
    h.fgEmit(2)
    await settle()
    expect(h.svc.state()).toMatchObject({ overflow: 3 })
    // 关闭当前树窗 2；系统新前台 = 带成员 7（第 3 列，旧视口下完全屏外）
    h.foreground.delete(2)
    h.foreground.add(7)
    h.windows.delete(2)
    h.watchOn(2)
    await settle()
    // 视口跟随系统新前台：窗 7 完整可见（旧视口下它在物理 [1184,1784] 屏外）
    expect(h.windows.get(7)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
  })

  it('关闭屏内当前窗、系统新前台非受管：不猜锚，视口仅钳制不留空白', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)], [7, R(7)]])
    await settle()
    h.fgEmit(5)
    await settle()
    h.foreground.add(2)
    h.fgEmit(2)
    await settle()
    h.foreground.delete(2) // 新前台不在受管账（无 fit 目标）
    h.windows.delete(2)
    h.watchOn(2)
    await settle()
    // 视口钳在内容右端内：当前可见内容仍是有效带列（无空白视口）
    expect(h.windows.get(6)!.rect).toEqual({ left: 584, top: 0, right: 1184, bottom: 752 })
    expect(h.windows.get(7)!.rect).toEqual({ left: 1184, top: 0, right: 1784, bottom: 752 })
  })
})

describe('最小化与还原（工单406，用户故事 22/23/24）', () => {
  it('最小化带成员：保留列位与顺序；还原后回原列', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)]])
    await settle()
    h.fgEmit(5)
    await settle()
    h.windows.set(5, { rect: h.windows.get(5)!.rect, iconic: true })
    h.watchOn(5)
    await settle()
    // 最小化不动视口、不丢列位（成员留带、顺序不变）
    expect(h.windows.get(5)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
    h.windows.set(5, { rect: h.windows.get(5)!.rect, iconic: false })
    h.watchOn(5)
    await settle()
    expect(h.windows.get(5)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
  })

  it('前台还原：fit 滑入完整可见', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)]])
    await settle()
    h.windows.set(5, { rect: h.windows.get(5)!.rect, iconic: true })
    h.watchOn(5)
    await settle()
    h.windows.set(5, { rect: COL0, iconic: false })
    h.foreground.add(5)
    h.fgEmit(5)
    await settle()
    // 前台还原 → 单一 fit 入口：整组最小滑动到窗 5 完整可见
    expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
  })

  it('后台还原：视口不动（不抢当前上下文）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)]])
    await settle()
    h.fgEmit(5)
    await settle()
    h.windows.set(6, { rect: h.windows.get(6)!.rect, iconic: true })
    h.watchOn(6)
    await settle()
    h.windows.set(6, { rect: h.windows.get(6)!.rect, iconic: false })
    h.watchOn(6)
    await settle()
    // 后台还原只回列位，视口原位（窗 6 大部屏外、窗 5 与屏内窗全不动）
    expect(h.windows.get(6)!.rect).toEqual({ left: 1168, top: 0, right: 1768, bottom: 752 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
  })
})

describe('恢复平铺与聚焦退出（工单406，用户故事 29/33）', () => {
  it('恢复平铺：保留当前锚窗（不跳回树起点）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)], [6, R(6)]])
    await settle()
    h.fgEmit(5)
    await settle()
    await h.svc.restoreTiling()
    await settle()
    // 恢复平铺后以当前锚窗（窗 5）执行 fit——不回树起点（窗 5 完整可见）
    expect(h.windows.get(5)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2, floating: 0 })
  })

  it('聚焦退出：restoreTiling(退出窗) 后按 fit 显示刚退出聚焦的窗（带成员）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)], [5, R(5)]])
    await settle()
    h.svc.setHeldWindow(5) // 聚焦进入（最大化由聚焦服务负责；挂起即可隔离平铺写）
    await h.svc.restoreTiling(5)
    await settle()
    expect(h.svc.heldWindowForTest()).toBeNull()
    // 退出聚焦 → 恢复混合布局并 fit 到刚退出的窗（带成员完整可见）
    expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
  })
})

describe('带成员授权与生命周期（工单405 + 工单404 分流）', () => {
  it('用户拖动带成员：locked 相位复原到列位并上行授权提示（带成员是受管平铺成员）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)]])
    await settle()
    h.foreground.add(5)
    h.windows.set(5, { rect: { left: 300, top: 300, right: 900, bottom: 800 }, iconic: false })
    h.watchOn(5)
    await settle()
    expect(h.prompts.length).toBe(1)
    expect(h.windows.get(5)!.rect).toEqual(COL0) // 复原到列位
  })

  it('空间释放：带成员按进入序补入、带收拢、树区回满区、视口回位', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    openWindows(h, [[5, R(5)]])
    await settle()
    h.windows.delete(4)
    h.watchOn(4)
    await settle()
    // 窗 4 空位由兄弟吸收后窗 5 补入；带空 → 树区回满区（600 宽）、camera 钳回 0
    expect(h.svc.state()).toMatchObject({ count: 4, placed: 4, overflow: 0 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 0, top: 376, right: 600, bottom: 752 })
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 600, bottom: 376 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 376 })
  })
})
