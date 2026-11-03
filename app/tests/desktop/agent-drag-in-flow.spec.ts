/**
 * 连续拖入 × 屏外带组合矩阵（工单408，spec #403 用户故事 41/42/43 + 405/406 组合面；
 * GLOSSARY「屏外滚动带」「恢复平铺」）。断言外部可见行为：实际写窗矩形、成员序、
 * 状态投影——不绑内部类。假窗口 harness 与 agent-tiling-band.spec.ts 同款纪律
 * （容量夹具：1200×752 平铺区 + minPane 320×240 → 容量恰 4 扇；列宽 600、露边 32），
 * 另加工单407 的拖入交接事件假源（tiling/drag-in-registered——与 agent-drag-in 服务
 * 同一事件通路）。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentTilingService } from '../../src/main/services/agent-tiling'
import type { AgentTilingServiceOptions } from '../../src/main/services/agent-tiling'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'
import type { TileRect } from '../../src/main/desktop/tiling-plan'

const PRIMARY = { left: 0, top: 0, right: 1200, bottom: 800 }
const TASKBAR_TOP = 752
const COL_W = 600
const REVEAL = 32
const COL0: TileRect = { left: 1200 - REVEAL, top: 0, right: 1200 - REVEAL + COL_W, bottom: 752 }
const COL1: TileRect = { left: 1200 - REVEAL + COL_W, top: 0, right: 1200 - REVEAL + 2 * COL_W, bottom: 752 }

interface FlowHarness {
  svc: AgentTilingService
  windows: Map<number, { rect: TileRect; iconic: boolean }>
  writes: Array<{ hwnd: number; target: TileRect }>
  watchOn: (hwnd: number) => void
  events: Array<{ count: number; placed: number; overflow: number }>
  foreground: Set<number>
  fgEmit: (hwnd: number) => void
  /** 工单407 拖入交接假源（与 agent-drag-in 服务同一 ctx 事件通路） */
  emitDragInRegistered: (hwnd: number) => void
  runPass: () => Promise<void>
  restoreTiling: () => Promise<unknown>
}

function harness(over: Partial<AgentTilingServiceOptions> = {}): FlowHarness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean }>()
  const writes: FlowHarness['writes'] = []
  const events: FlowHarness['events'] = []
  const foreground = new Set<number>()
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
      resizable: true,
      rect: { ...w.rect },
      onCurrentDesktop: true,
    }))

  const ctx = new Context()
  const svc = new AgentTilingService(ctx, {
    enabled: true,
    batchMs: 0,
    settleMs: 40,
    ...over,
    deps: {
      currentMode: () => 'agent',
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => ({ ...PRIMARY }),
      taskbarTop: () => TASKBAR_TOP,
      onDisplayChanged: () => () => undefined,
      collectFacts: factsOf,
      readRect: (hwnd) => ({ ...(windows.get(hwnd)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      restoreRect: (hwnd, target) => {
        writes.push({ hwnd, target: { ...target } })
        const w = windows.get(hwnd)
        if (w) w.rect = { ...target }
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
      ...(over.deps ?? {}),
    },
  })
  ctx.on('tiling/changed', (payload) => events.push(payload))
  svc.start()
  return {
    svc,
    windows,
    writes,
    watchOn: (hwnd) => watchCb?.(hwnd),
    events,
    foreground,
    fgEmit: (hwnd) => fgCb?.(hwnd),
    emitDragInRegistered: (hwnd) => ctx.emit('tiling/drag-in-registered', { hwnd }),
    runPass: () => svc.runPass(),
    restoreTiling: () => svc.restoreTiling(),
  }
}

async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

/** 开一批窗（原矩形各不相同——band spec 同款对照面） */
function openWindows(h: FlowHarness, specs: Array<[number, TileRect]>): void {
  for (const [hwnd, rect] of specs) h.windows.set(hwnd, { rect: { ...rect }, iconic: false })
  h.watchOn(specs[specs.length - 1][0])
}

const R = (n: number): TileRect => ({ left: 100 + n * 40, top: 100 + n * 20, right: 700 + n * 40, bottom: 600 + n * 20 })

describe('连续拖入 × 屏外带组合（工单408，story 41/42/43）', () => {
  it('连续拖入两窗：交接序即带序（与 z 序无关）；前台成员滑入完整视图；进入后可继续露边导航', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    // 普通桌面连续拖入两窗（story 42 落放不切桌面；确认事件按拖入序上行），
    // 窗体随后出现在 Agent 桌面——z 序与拖入序相反（连续拖入的顺序可预测性，story 41）
    h.emitDragInRegistered(3005)
    h.emitDragInRegistered(3006)
    h.foreground.add(3005)
    openWindows(h, [[3006, R(6)], [3005, R(5)]])
    await settle()
    // 交接序优先并入成员序尾：3005 先入带（第 1 列）、3006 后入（第 2 列）
    expect(h.svc.memberOrderForTest()).toEqual([1, 2, 3, 4, 3005, 3006])
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
    // 3005 持前台 → fit 滑入完整视图（story 20 同一 fit 入口；带 2 列时 fit 为右邻列
    // 预留 32px 露边 → camera=600，第 1 列物理 [568,1168]）
    expect(h.windows.get(3005)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
    expect(h.windows.get(3006)!.rect).toEqual({ left: 1168, top: 0, right: 1768, bottom: 752 })
    // 继续露边导航（story 17/18 与 405 能力组合）：反向激活屏内窗 → 整组回位
    h.fgEmit(1)
    await settle()
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 584, bottom: 376 })
    expect(h.windows.get(3005)!.rect).toEqual(COL0)
  })

  it('关闭屏内窗：兄弟吸收后按带序（= 交接序）补入；带收拢、次成员原位', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    h.emitDragInRegistered(3005)
    h.emitDragInRegistered(3006)
    openWindows(h, [[3006, R(6)], [3005, R(5)]])
    await settle()
    h.writes.length = 0
    h.windows.delete(4)
    h.watchOn(4)
    await settle()
    // 最早带成员 3005（拖入序第一）补入树，3006 原列位保留（story 4 与 406 组合）
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
    expect(h.windows.get(3005)!.rect).toEqual({ left: 0, top: 376, right: 584, bottom: 752 })
    expect(h.windows.get(3006)!.rect).toEqual(COL0)
  })

  it('恢复平铺保留拖入窗锚：恢复平铺后拖入的最新成员按 fit 完整可见（story 29/30 组合）', async () => {
    const h = harness()
    openWindows(h, [[1, R(1)], [2, R(2)], [3, R(3)], [4, R(4)]])
    await settle()
    h.emitDragInRegistered(3005)
    h.emitDragInRegistered(3006)
    openWindows(h, [[3006, R(6)], [3005, R(5)]])
    await settle()
    h.fgEmit(3005) // 最近前台受管窗 = 拖入成员 → 锚窗
    await settle()
    await h.restoreTiling()
    await settle()
    // 恢复平铺不跳回树起点——以锚窗（3005）执行 fit，完整可见（2 列带 camera=600）
    expect(h.windows.get(3005)!.rect).toEqual({ left: 568, top: 0, right: 1168, bottom: 752 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2, floating: 0 })
  })
})
