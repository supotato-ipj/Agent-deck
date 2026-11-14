// 桌面工作区对账事件化（工单474，spec #472 / ADR-0032「事件驱动优先于轮询」）：
// 通知驱动与轮询驱动的对账等价性（时序容忍）、通知丢失的兜底有界、通知面缺席降级。
// deps 全假源（workspace-service.spec.ts 同款纪律），零 FFI/Electron；真实通知面
// （advapi32 RegNotifyChangeKeyValue 布防/点火）是 FFI 薄壳，由 375-desktop-switch
// 真机电池兜底，本文件不触。
import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { DesktopWorkspaceService, type DesktopWorkspaceServiceOptions } from '../../src/main/services/desktop-workspace'
import type { DesktopSetFacts, StoredPairing } from '../../src/main/desktop/workspace-plan'
import type { DesktopWorkspaceState } from '../../src/shared/contract'

const NORMAL = '11111111-2222-3333-4444-555555555555'
const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const THIRD = '99999999-8888-7777-6666-555555555555'

/** 可变假系统（workspace-service.spec.ts 同款）：facts 是被对账消费的外部事实源 */
function fakeSystem(initial: { ids: string[]; current: string }) {
  const state = { ids: [...initial.ids], current: initial.current }
  return {
    state,
    facts: async (): Promise<DesktopSetFacts> => ({ ids: [...state.ids], current: state.current, internalCurrent: state.current }),
    goTo(id: string) { state.current = id },
    remove(id: string) { state.ids = state.ids.filter((x) => x !== id) },
  }
}

/** 假通知面：available 可塌缩、点火可控、布防/撤防留痕（工单474 deps.watch 缝） */
function fakeWatch(initial: { available?: boolean } = {}) {
  const st = { available: initial.available ?? true, started: false, fired: false, startCalls: 0, stopCalls: 0 }
  return {
    st,
    fire() { st.fired = true },
    facade: {
      available: () => st.available,
      start: () => { st.startCalls++; if (!st.available) return false; st.started = true; return true },
      consumeFired: () => {
        if (!st.available || !st.started) return false
        const f = st.fired
        st.fired = false
        return f
      },
      stop: () => { st.stopCalls++ },
    },
  }
}

interface WatchHarness {
  svc: DesktopWorkspaceService
  sys: ReturnType<typeof fakeSystem>
  calls: { switched: string[] }
  events: DesktopWorkspaceState[]
  factsReads: () => number
  /** 让下一轮 facts 连续 N 拍不可读（失败关闭观测口，workspace-service 同款） */
  breakFacts(n: number): void
  cleanup(): void
}

async function makeService(over: Partial<DesktopWorkspaceServiceOptions> & {
  system?: { ids: string[]; current: string }
  watch?: NonNullable<DesktopWorkspaceServiceOptions['deps']>['watch']
  countFactsReads?: boolean
} = {}): Promise<WatchHarness> {
  const sys = fakeSystem(over.system ?? { ids: [NORMAL, THIRD], current: NORMAL })
  const calls = { switched: [] as string[] }
  const events: DesktopWorkspaceState[] = []
  let reads = 0
  let broken = 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t474-'))
  const appConfig = { agentDesktop: { enabled: true, normalDesktopId: '', agentDesktopId: '' } } as unknown as import('../../src/main/config').AppConfig
  const ctx = new Context()
  const opts: DesktopWorkspaceServiceOptions = {
    enabled: true,
    pairing: (over.pairing as StoredPairing | null | undefined) ?? null,
    file: null,
    config: appConfig,
    pollMs: over.pollMs ?? 0, // 缺省手动驱动（离线纪律）；兜底/降级用例显式给拍距+假时钟
    fallbackReconcileMs: over.fallbackReconcileMs,
    confirmTimeoutMs: 300,
    confirmPollMs: 10,
    deps: {
      internalAvailable: () => true,
      facts: async () => {
        reads++
        if (broken > 0) {
          broken--
          return { ids: [], current: null, internalCurrent: null }
        }
        return sys.facts()
      },
      createDesktop: () => '',
      switchDesktop: (id) => { calls.switched.push(id) },
      removeDesktop: () => {},
      isWindowOnCurrent: () => true,
      moveWindowToDesktop: () => true,
      currentId: () => sys.state.current,
      followTargets: () => [],
      ...(over.watch ? { watch: over.watch } : {}),
    },
  }
  ctx.on('workspace/changed', (s: DesktopWorkspaceState) => events.push(s))
  ctx.plugin(DesktopWorkspaceService, opts)
  await ctx.start()
  const svc = (ctx as unknown as { desktopWorkspace: DesktopWorkspaceService }).desktopWorkspace
  await svc.start()
  return {
    svc,
    sys,
    calls,
    events,
    factsReads: () => reads,
    breakFacts: (n: number) => { broken = n },
    cleanup: () => { void ctx.stop(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('通知驱动一拍（工单474：watchTick）', () => {
  it('watch 点火：系统侧切 Agent 经一拍对账回推，全程零 SwitchDesktop 调用（不抢回）', async () => {
    const w = fakeWatch()
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL }, watch: w.facade })
    try {
      expect(h.svc.state().current).toBe('normal')
      h.sys.goTo(AGENT) // 模拟 Win+Ctrl+→ / TaskView（explorer 写注册表 → 内核事件）
      w.fire()
      await h.svc.watchTick()
      expect(h.svc.state().current).toBe('agent')
      expect(h.calls.switched).toEqual([])
      expect(h.events.some((e) => e.current === 'agent')).toBe(true)
    } finally { h.cleanup() }
  })

  it('未点火拍：零 facts 读（通知驱动不每拍读事实源——票面核心交付的对偶面）', async () => {
    const w = fakeWatch()
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL }, watch: w.facade })
    try {
      const before = h.factsReads()
      await h.svc.watchTick() // 布防首拍（补对账——布防当拍允许一次读）
      const afterArm = h.factsReads()
      expect(afterArm).toBeGreaterThan(before)
      h.sys.goTo(THIRD) // 系统变了但通知没来
      await h.svc.watchTick() // 未点火拍
      await h.svc.watchTick() // 再一拍仍未点火（兜底窗口内）
      expect(h.svc.state().current).toBe('normal') // 未失明也未误读：等通知或兜底
      expect(h.factsReads()).toBe(afterArm) // 布防后到兜底前：零事实读
    } finally { h.cleanup() }
  })
})

describe('通知驱动与轮询驱动的对账等价（工单474 验收④，时序容忍）', () => {
  it('同一系统事实序列：watchTick 驱动与 reconcileNow 驱动的状态投影与回推事件流逐项一致', async () => {
    const script = (h: WatchHarness) => {
      h.sys.goTo(AGENT)
      h.sys.goTo(THIRD)
      h.sys.remove(AGENT) // 配对单侧失效 → 安全态
      h.sys.goTo(NORMAL)
    }
    const w = fakeWatch()
    const viaWatch = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL }, watch: w.facade })
    const viaPoll = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL } })
    try {
      script(viaWatch)
      script(viaPoll)
      for (let step = 0; step < 4; step++) {
        w.fire()
        await viaWatch.svc.watchTick()
        await viaPoll.svc.reconcileNow()
      }
      const proj = (h: WatchHarness) => h.svc.state()
      expect(proj(viaWatch)).toEqual(proj(viaPoll))
      expect(viaWatch.events).toEqual(viaPoll.events)
      expect(viaWatch.calls.switched).toEqual([])
      expect(viaPoll.calls.switched).toEqual([])
    } finally { viaWatch.cleanup(); viaPoll.cleanup() }
  })
})

describe('通知丢失兜底有界（工单474 验收③，假时钟）', () => {
  it('布防在但通知永不点火：兜底上限过后仍收敛（不永久失明）', async () => {
    vi.useFakeTimers()
    const w = fakeWatch() // available=true、永不 fire——模拟通知全漏
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      watch: w.facade,
      pollMs: 200,
      fallbackReconcileMs: 1000,
    })
    try {
      await vi.advanceTimersByTimeAsync(200) // 首拍布防（布防拍补对账——此后进入通知等待期）
      h.sys.goTo(THIRD) // 通知全漏：系统变化不点火
      await vi.advanceTimersByTimeAsync(600) // 兜底窗口内数拍（通知未点火）
      expect(h.svc.state().current).toBe('normal') // 未到上限：盲（等待中的正常形态）
      await vi.advanceTimersByTimeAsync(1200) // 越过兜底上限
      expect(h.svc.state().current).toBe('unmanaged') // 有界收敛——漏发不致死
    } finally {
      vi.useRealTimers()
      h.cleanup()
    }
  })

  it('点火读数失败拍不烧毁兜底窗：下一拍兜底/点火仍能收敛', async () => {
    vi.useFakeTimers()
    const w = fakeWatch()
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      watch: w.facade,
      pollMs: 200,
      fallbackReconcileMs: 800,
    })
    try {
      h.sys.goTo(THIRD)
      h.breakFacts(1)
      w.fire()
      await vi.advanceTimersByTimeAsync(200) // 点火拍：facts 恰不可读 → 沿用上一拍
      expect(h.svc.state().current).toBe('normal')
      await vi.advanceTimersByTimeAsync(1000) // 兜底窗口收口
      expect(h.svc.state().current).toBe('unmanaged')
    } finally {
      vi.useRealTimers()
      h.cleanup()
    }
  })
})

describe('通知面缺席降级（工单474：available=false）', () => {
  it('每拍全对账（退回旧轮询语义），一拍即收敛不失明', async () => {
    vi.useFakeTimers()
    const w = fakeWatch({ available: false })
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      watch: w.facade,
      pollMs: 200,
      fallbackReconcileMs: 60_000, // 兜底上限拉远：收敛必须来自降级拍对账而非兜底
    })
    try {
      h.sys.goTo(THIRD)
      await vi.advanceTimersByTimeAsync(250) // 单拍
      expect(h.svc.state().current).toBe('unmanaged')
    } finally {
      vi.useRealTimers()
      h.cleanup()
    }
  })
})

describe('布防生命周期（工单474）', () => {
  it('布防首拍补对账：布防前发生的事实变化当拍不漏（布防后读=无盲窗）', async () => {
    const w = fakeWatch()
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL }, watch: w.facade })
    try {
      h.sys.goTo(AGENT) // doStart 首轮对账之后、布防之前的变化（通知面尚未在场）
      await h.svc.watchTick() // 首拍：布防 + 补对账
      expect(h.svc.state().current).toBe('agent')
    } finally { h.cleanup() }
  })

  it('停表撤防：watch.stop 恰一次（零内核句柄泄漏），未布防则不撤', async () => {
    const w = fakeWatch()
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL }, watch: w.facade })
    try {
      await h.svc.watchTick() // 布防
      expect(w.st.started).toBe(true)
    } finally { h.cleanup() } // cleanup 内 ctx.stop() → 服务 stop → watch.stop
    expect(w.st.stopCalls).toBe(1)
    const idle = fakeWatch()
    const h2 = await makeService({ watch: idle.facade }) // 从未布防（pollMs=0 手动驱动且不调 watchTick）
    try { /* 保持未布防 */ } finally { h2.cleanup() }
    expect(idle.st.stopCalls).toBe(0)
  })
})
