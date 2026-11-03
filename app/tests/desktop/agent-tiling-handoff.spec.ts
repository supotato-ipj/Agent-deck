/**
 * Agent 平铺 × 拖入交接对账测试（工单407，spec #403 决策「只有确认后才产生一次性
 * 待入列交接，Agent 平铺下次激活时按交接顺序对账并清除，不形成第二份持久成员账」）：
 * 交接序优先于 z 序并入成员序、消费即清、窗口消失条目丢弃。服务缝假窗口 harness
 * （agent-tiling-service.spec.ts 同款最小形态），断言外部可见的成员序与落位。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentTilingService } from '../../src/main/services/agent-tiling'
import type { AgentTilingServiceOptions } from '../../src/main/services/agent-tiling'
import type { TileWindowFacts, ScopeRect } from '../../src/main/desktop/tile-scope'
import type { TileRect } from '../../src/main/desktop/tiling-plan'

const PRIMARY: ScopeRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
const AREA: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }

interface HandoffHarness {
  svc: AgentTilingService
  windows: Map<number, { rect: TileRect; iconic: boolean }>
  emitDragInRegistered: (hwnd: number) => void
  runPass: () => Promise<void>
  writes: Array<{ hwnd: number; target: TileRect }>
}

function harness(over: Partial<AgentTilingServiceOptions> = {}): HandoffHarness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean }>()
  const writes: HandoffHarness['writes'] = []
  const factsOf = (): TileWindowFacts[] =>
    [...windows.entries()].map(([hwnd, w]) => ({
      hwnd,
      pid: 5000 + hwnd,
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
    ...over,
    deps: {
      currentMode: () => 'agent',
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => ({ ...PRIMARY }),
      taskbarTop: () => 1392,
      collectFacts: factsOf,
      readRect: (hwnd) => ({ ...(windows.get(hwnd)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      restoreRect: (hwnd, target) => {
        writes.push({ hwnd, target: { ...target } })
        const w = windows.get(hwnd)
        if (w) w.rect = { ...target }
        return true
      },
      isForeground: () => false,
      startWatch: () => () => undefined,
    },
  })
  svc.start()
  return {
    svc,
    windows,
    emitDragInRegistered: (hwnd) => ctx.emit('tiling/drag-in-registered', { hwnd }),
    runPass: () => svc.runPass(),
    writes,
  }
}

describe('Agent 平铺 × 拖入交接对账（工单407）', () => {
  it('交接按拖入顺序并入成员序：交接序优先于本拍 z 序，既有成员保持原位', async () => {
    const h = harness()
    // 既有两成员已平铺
    h.windows.set(2001, { rect: { left: 0, top: 0, right: 1280, bottom: 1392 }, iconic: false })
    h.windows.set(2002, { rect: { left: 1280, top: 0, right: 2560, bottom: 1392 }, iconic: false })
    await h.runPass()
    expect(h.svc.memberOrderForTest()).toEqual([2001, 2002])
    // 拖入两窗（拖入序 3003 → 3002；z 序相反）——交接在窗出现前登记
    h.emitDragInRegistered(3003)
    h.emitDragInRegistered(3002)
    h.windows.set(3002, { rect: { left: 10, top: 10, right: 400, bottom: 300 }, iconic: false })
    h.windows.set(3003, { rect: { left: 20, top: 20, right: 400, bottom: 300 }, iconic: false })
    await h.runPass()
    // 交接序并入队尾且按交接顺序（不是 z 序 3002→3003）；既有成员保持原位
    expect(h.svc.memberOrderForTest()).toEqual([2001, 2002, 3003, 3002])
    // 落位按成员序：交接首窗拿第三个窗格
    const w3003 = h.writes.find((w) => w.hwnd === 3003)
    const w3002 = h.writes.find((w) => w.hwnd === 3002)
    expect(w3003).toBeDefined()
    expect(w3002).toBeDefined()
    // 消费即清：不形成第二份持久成员账
    expect(h.svc.handoffPendingForTest()).toEqual([])
  })

  it('窗口未出现：交接条目保持待入列（下拍再对账）；窗口已消失：条目丢弃', async () => {
    const h = harness()
    h.emitDragInRegistered(4001) // 还没出现
    h.emitDragInRegistered(4002) // 永远不会出现
    expect(h.svc.handoffPendingForTest()).toEqual([4001, 4002])
    h.windows.set(4001, { rect: { left: 0, top: 0, right: 2560, bottom: 1392 }, iconic: false })
    await h.runPass()
    expect(h.svc.memberOrderForTest()).toEqual([4001])
    expect(h.svc.handoffPendingForTest()).toEqual([]) // 4002 消失 → 丢弃
  })
})
