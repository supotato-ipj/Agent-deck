/**
 * Agent 聚焦协调（工单379，spec #369 决策 16 / ADR-0028「恢复与聚焦」）：
 * 预览选定后目标真实最大化；再点胶囊/恢复按钮/明确激活其他窗口都先退出聚焦并恢复
 * 默认平铺；后台新窗不退出、抢前台才退出；切出 Agent 桌面释放聚焦。
 * deps 全假源（agent-tiling-service.spec.ts 同款纪律），零 FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentFocusService } from '../../src/main/services/agent-focus'
import type { AgentFocusServiceOptions } from '../../src/main/services/agent-focus'
import type { AgentFocusState, DesktopMode } from '../../src/shared/contract'

interface Harness {
  svc: AgentFocusService
  mode: { value: DesktopMode }
  own: Set<number>
  maximized: number[]
  restored: number[]
  held: Array<number | null>
  restoreTilingCalls: number
  events: AgentFocusState[]
  log: Array<Record<string, unknown>>
  watch: (hwnd: number) => void
  setRestoreTilingResult: (restored: number, skipped: number) => void
}

function harness(over: Partial<AgentFocusServiceOptions> = {}): Harness {
  const mode = { value: 'agent' as DesktopMode }
  const own = new Set<number>()
  const maximized: number[] = []
  const restored: number[] = []
  const held: Array<number | null> = []
  const events: AgentFocusState[] = []
  const log: Array<Record<string, unknown>> = []
  let watchCb: ((hwnd: number) => void) | null = null
  let tilingResult = { ok: true, restored: 0, skipped: 0 }
  let restoreTilingCalls = 0

  const ctx = new Context()
  const svc = new AgentFocusService(ctx, {
    enabled: true,
    log: (e) => log.push(e),
    ...over,
    deps: {
      currentMode: () => mode.value,
      startForegroundWatch: (cb) => {
        watchCb = cb
        return () => {
          watchCb = null
        }
      },
      isOwnWindow: (hwnd) => own.has(hwnd),
      maximize: (hwnd) => {
        maximized.push(hwnd)
        return true
      },
      restoreWindow: (hwnd) => {
        restored.push(hwnd)
        return true
      },
      setTilingHeld: (hwnd) => held.push(hwnd),
      restoreTiling: async () => {
        restoreTilingCalls += 1
        return { ...tilingResult }
      },
      ...over.deps,
    },
  })
  ctx.on('focus/changed', (p) => events.push(p))
  svc.start()
  return {
    svc,
    mode,
    own,
    maximized,
    restored,
    held,
    get restoreTilingCalls() {
      return restoreTilingCalls
    },
    events,
    log,
    watch: (hwnd) => watchCb?.(hwnd),
    setRestoreTilingResult: (r, s) => {
      tilingResult = { ok: true, restored: r, skipped: s }
    },
  } as Harness
}

describe('Agent 聚焦：进入与退出', () => {
  it('Agent 桌面选定条目 → 目标真实最大化并挂起平铺账', () => {
    const h = harness()
    const r = h.svc.enter(0x2001)
    expect(r.ok).toBe(true)
    expect(h.maximized).toEqual([0x2001])
    expect(h.held).toEqual([0x2001])
    expect(h.svc.state().focused).toBe(0x2001)
    expect(h.events.at(-1)).toEqual({ focused: 0x2001 })
  })

  it('普通桌面/非托管桌面不进入聚焦（普通档零自动改窗）', () => {
    const h = harness()
    h.mode.value = 'normal'
    expect(h.svc.enter(0x2001).ok).toBe(false)
    expect(h.maximized).toEqual([])
    expect(h.svc.state().focused).toBeNull()
  })

  it('退出聚焦：还原目标几何、解除平铺挂起并执行恢复平铺（收回浮动/补入溢出）', async () => {
    const h = harness()
    h.setRestoreTilingResult(2, 1)
    h.svc.enter(0x2001)
    const r = await h.svc.exit()
    expect(r.ok).toBe(true)
    expect(r.restored).toBe(2)
    expect(r.skipped).toBe(1)
    expect(h.restored).toEqual([0x2001])
    expect(h.held).toEqual([0x2001, null])
    expect(h.restoreTilingCalls).toBe(1)
    expect(h.svc.state().focused).toBeNull()
    expect(h.events.at(-1)).toEqual({ focused: null })
  })

  it('非聚焦态退出是 no-op（不误触发恢复平铺）', async () => {
    const h = harness()
    const r = await h.svc.exit()
    expect(r.ok).toBe(false)
    expect(h.restoreTilingCalls).toBe(0)
  })

  it('同一目标重复进入幂等；换目标时先还原旧窗再最大化新窗', () => {
    const h = harness()
    h.svc.enter(0x2001)
    h.svc.enter(0x2001)
    expect(h.maximized).toEqual([0x2001])
    h.svc.enter(0x2002)
    expect(h.maximized).toEqual([0x2001, 0x2002])
    expect(h.restored).toEqual([0x2001])
    expect(h.held).toEqual([0x2001, null, 0x2002])
    expect(h.svc.state().focused).toBe(0x2002)
  })
})

describe('Agent 聚焦：前台变化', () => {
  it('明确激活其他窗口 → 自动退出聚焦并恢复默认平铺（先退出，不出现前台/聚焦分裂）', async () => {
    const h = harness()
    h.svc.enter(0x2001)
    h.watch(0x2002)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.restored).toEqual([0x2001])
    expect(h.svc.state().focused).toBeNull()
    expect(h.restoreTilingCalls).toBe(1)
  })

  it('后台新窗不退出：不产生前台事件即保持聚焦', () => {
    const h = harness()
    h.svc.enter(0x2001)
    // 后台新窗只改变成员集合，不触碰前台——没有 watch 回调
    expect(h.svc.state().focused).toBe(0x2001)
    expect(h.restoreTilingCalls).toBe(0)
  })

  it('前台变化到自家窗（预览/提示/面板）不算「激活其他窗口」→ 保持聚焦', () => {
    const h = harness()
    h.own.add(0x9001)
    h.svc.enter(0x2001)
    h.watch(0x9001)
    expect(h.svc.state().focused).toBe(0x2001)
    expect(h.restoreTilingCalls).toBe(0)
  })

  it('前台仍是聚焦目标 → 不退出', () => {
    const h = harness()
    h.svc.enter(0x2001)
    h.watch(0x2001)
    expect(h.svc.state().focused).toBe(0x2001)
  })
})

describe('Agent 聚焦：桌面切换', () => {
  it('切出 Agent 桌面即释放聚焦（还原目标、解挂；不额外恢复平铺——平铺已失活）', async () => {
    const h = harness()
    h.svc.enter(0x2001)
    h.mode.value = 'normal'
    // 服务经 workspace/changed 对齐；直接驱动 syncActivation（生产同路）
    h.svc.syncActivation()
    await Promise.resolve()
    expect(h.svc.state().focused).toBeNull()
    expect(h.restored).toEqual([0x2001])
    expect(h.held).toEqual([0x2001, null])
    expect(h.restoreTilingCalls).toBe(0)
  })
})

describe('Agent 聚焦：隐私与诊断', () => {
  it('存证只记 hwnd/动作，不含窗口标题（ADR-0002 / spec 决策 26）', () => {
    const h = harness()
    h.svc.enter(0x2001)
    h.watch(0x2002)
    const serialized = JSON.stringify(h.log)
    expect(serialized).toContain(String(0x2001))
    expect(serialized).not.toMatch(/title|窗口\s*\d/)
  })
})
