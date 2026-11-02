// 桌面工作区服务编排测试（工单375，spec #369 决策 2/4/29/30）：实验开关隔离、首次
// 配对（新建回收义务）、单飞切换 + 系统 ID 回读确认、失败保持现状并提示、reconciliation
// 不抢回、配对身份失效安全态、跟随兜底。deps 全假源（service-sequence.spec.ts 先例），
// 零 FFI/Electron；FFI 形态在 t371 探针出证、纯裁决在 workspace-plan.spec.ts。
import { describe, expect, it } from 'vitest'
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

/** 可变假系统：ids/current 双源一致（真实常态），手动改写即系统侧事实推进 */
function fakeSystem(initial: { ids: string[]; current: string }) {
  const state = { ids: [...initial.ids], current: initial.current }
  return {
    state,
    facts: async (): Promise<DesktopSetFacts> => ({ ids: [...state.ids], current: state.current, internalCurrent: state.current }),
    goTo(id: string) { state.current = id },
    add(id: string) { state.ids.push(id) },
    remove(id: string) { state.ids = state.ids.filter((x) => x !== id) },
  }
}

interface Harness {
  svc: DesktopWorkspaceService
  sys: ReturnType<typeof fakeSystem>
  calls: { created: string[]; switched: string[]; removed: Array<[string, string?]>; moved: Array<[number, string]> }
  events: DesktopWorkspaceState[]
  configFile: string
  /** 让下一轮 facts 连续 N 拍不可读（失败关闭观测口） */
  breakFacts(n: number): void
  cleanup(): void
}

async function makeService(over: Partial<DesktopWorkspaceServiceOptions> & {
  system?: { ids: string[]; current: string }
  createFails?: boolean
  /** 新建的桌面不进 facts 集合（模拟创建后回读核验不命中） */
  hideCreatedFromFacts?: boolean
  onSwitch?: (id: string, sys: Harness['sys']) => void
} = {}): Promise<Harness> {
  const sys = fakeSystem(over.system ?? { ids: [NORMAL, THIRD], current: NORMAL })
  const calls = { created: [] as string[], switched: [] as string[], removed: [] as Array<[string, string?]>, moved: [] as Array<[number, string]> }
  const events: DesktopWorkspaceState[] = []
  let broken = 0
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t375-'))
  const configFile = path.join(dir, 'config.json')
  const enabled = over.enabled ?? true
  fs.writeFileSync(configFile, JSON.stringify({ agentDesktop: { enabled, normalDesktopId: '', agentDesktopId: '' } }))
  const appConfig = { agentDesktop: { enabled, normalDesktopId: '', agentDesktopId: '' } } as unknown as import('../../src/main/config').AppConfig
  const ctx = new Context()
  const baseDeps: NonNullable<DesktopWorkspaceServiceOptions['deps']> = {
    internalAvailable: () => true,
    facts: async () => {
      if (broken > 0) {
        broken--
        return { ids: [], current: null, internalCurrent: null }
      }
      const f = await sys.facts()
      if (over.hideCreatedFromFacts) {
        return { ...f, ids: f.ids.filter((id) => !calls.created.includes(id)) }
      }
      return f
    },
    createDesktop: () => {
      if (over.createFails) throw new Error('CreateDesktop 失败 hr=0x80004005')
      const id = `new-${calls.created.length + 1}-agent`
      calls.created.push(id)
      sys.add(id)
      return id
    },
    switchDesktop: (id) => {
      calls.switched.push(id)
      // 真实语义镜像：COM 切换受理后系统事实跟进（确认回读以此为前提）
      if (over.onSwitch) over.onSwitch(id, sys)
      else sys.goTo(id)
    },
    removeDesktop: (id, fallbackId) => {
      calls.removed.push([id, fallbackId])
      sys.remove(id)
    },
    isWindowOnCurrent: () => true,
    moveWindowToDesktop: (hwnd, id) => { calls.moved.push([hwnd, id]); return true },
    currentId: () => sys.state.current,
    followTargets: () => [],
  }
  const opts: DesktopWorkspaceServiceOptions = {
    enabled,
    pairing: (over.pairing as StoredPairing | null | undefined) ?? null,
    file: over.file !== undefined ? over.file : configFile,
    config: appConfig,
    pollMs: 0, // 离线测试手动驱动 reconciliation（refreshRecommendations 同款纪律）
    confirmTimeoutMs: over.confirmTimeoutMs ?? 300,
    confirmPollMs: 10,
    deps: baseDeps,
  }
  if (over.deps) Object.assign(opts.deps!, over.deps)
  ctx.on('workspace/changed', (s: DesktopWorkspaceState) => events.push(s))
  ctx.plugin(DesktopWorkspaceService, opts)
  await ctx.start()
  const svc = (ctx as unknown as { desktopWorkspace: DesktopWorkspaceService }).desktopWorkspace
  await svc.start() // 首次对账（后续测试直接改假系统事实 + reconcileNow 手动驱动）
  return {
    svc,
    sys,
    calls,
    events,
    configFile,
    breakFacts: (n: number) => { broken = n },
    cleanup: () => { void ctx.stop(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

describe('实验开关隔离（spec #369 决策 29：Agent 入口默认关闭）', () => {
  it('开关关闭：available=false、切换拒绝、零桌面零切换、未配对', async () => {
    const h = await makeService({ enabled: false })
    try {
      expect(h.svc.state().available).toBe(false)
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(false)
      expect(h.calls.created).toEqual([])
      expect(h.calls.switched).toEqual([])
      expect(h.svc.pairingForTest()).toBeNull()
      expect(h.svc.state().current).toBe('unmanaged')
    } finally { h.cleanup() }
  })

  it('平台能力不可用（内部 COM 绑定失败）：失败关闭，同零动作面', async () => {
    const h = await makeService({ deps: { internalAvailable: () => false } })
    try {
      expect(h.svc.state().available).toBe(false)
      const r = await h.svc.switchTo('normal')
      expect(r.ok).toBe(false)
      expect(h.calls.switched).toEqual([])
    } finally { h.cleanup() }
  })
})

describe('首次配对与切换（验收①：保留当前桌面、Agent 首空）', () => {
  it('未配对点 Agent：普通 = 当下所在桌面、新建 Agent、落盘、确认后 current=agent', async () => {
    const h = await makeService({ system: { ids: [NORMAL, THIRD], current: NORMAL } })
    try {
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(true)
      expect(h.calls.created).toHaveLength(1)
      expect(h.calls.switched).toEqual([h.calls.created[0]])
      expect(h.svc.pairingForTest()).toEqual({ normalId: NORMAL, agentId: h.calls.created[0] })
      // 落盘：config agentDesktop 段写入配对身份（重启恢复最小闭环，完整恢复归工单383）
      const saved = JSON.parse(fs.readFileSync(h.configFile, 'utf8'))
      expect(saved.agentDesktop).toEqual({ enabled: true, normalDesktopId: NORMAL, agentDesktopId: h.calls.created[0] })
      expect(h.svc.state()).toMatchObject({ paired: true, current: 'agent', switching: false, target: null, lastError: null })
    } finally { h.cleanup() }
  })

  it('已存配对重启（config 带入）：直接恢复，不重建桌面（配对持久化的最小闭环）', async () => {
    const h = await makeService({
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      pairing: { normalId: NORMAL, agentId: AGENT },
    })
    try {
      expect(h.svc.state()).toMatchObject({ paired: true, current: 'normal' })
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(true)
      expect(h.calls.created).toEqual([]) // 复用已配对 Agent 桌面
      expect(h.svc.state().current).toBe('agent')
    } finally { h.cleanup() }
  })

  it('同模式再点 = no-op 零切换调用', async () => {
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: AGENT } })
    try {
      expect(h.svc.state().current).toBe('agent')
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(true)
      expect(h.calls.switched).toEqual([])
    } finally { h.cleanup() }
  })
})

describe('单飞连点与失败路径（验收③：在途忽略、ID 匹配才提交、失败保持现状并提示）', () => {
  it('在途期间的第二次请求被忽略（ok:false + 明确提示），第一轮照常完成', async () => {
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      // 假慢切换：受理后 100ms 系统事实才跟进（在途窗口可观测且确认仍在预算内）
      onSwitch: (id, sys) => { setTimeout(() => sys.goTo(id), 100) },
    })
    try {
      const first = h.svc.switchTo('agent')
      await new Promise((r) => setTimeout(r, 20)) // 让第一轮进入在途
      expect(h.svc.state().switching).toBe(true)
      const second = await h.svc.switchTo('normal')
      expect(second.ok).toBe(false)
      expect(second.error).toContain('在途')
      const r = await first
      expect(r.ok).toBe(true)
      expect(h.svc.state().current).toBe('agent')
      expect(h.calls.switched).toEqual([AGENT]) // 连点未产生第二次 COM 切换
    } finally { h.cleanup() }
  })

  it('系统 ID 不回读命中（超时）：ok:false、current 保持原模式、lastError 提示、UI 不提交', async () => {
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      confirmTimeoutMs: 80,
      onSwitch: () => { /* 切换调用受理但系统事实不跟进 → 确认必然超时 */ },
    })
    try {
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('未确认')
      expect(h.svc.state().current).toBe('normal')
      expect(h.svc.state().lastError).toContain('未确认')
      expect(h.svc.state().switching).toBe(false)
      expect(h.svc.state().target).toBeNull()
    } finally { h.cleanup() }
  })

  it('SwitchDesktop 抛错：ok:false 保持现状（COM 调用失败不乐观提交）', async () => {
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL },
      deps: { switchDesktop: () => { throw new Error('SwitchDesktop 失败 hr=0x80004005') } },
    })
    try {
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('SwitchDesktop 失败')
      expect(h.svc.state().current).toBe('normal')
      expect(h.svc.state().switching).toBe(false)
    } finally { h.cleanup() }
  })

  it('CreateDesktop 失败：不装配对、保持现状并提示', async () => {
    const h = await makeService({ createFails: true })
    try {
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('CreateDesktop 失败')
      expect(h.svc.pairingForTest()).toBeNull()
      expect(h.svc.state().current).toBe('unmanaged')
      expect(h.calls.removed).toEqual([])
    } finally { h.cleanup() }
  })

  it('新建回读核验失败（Agent ID 未进系统集合）：回收新建桌面（零残留纪律），不装配对', async () => {
    const h = await makeService({ hideCreatedFromFacts: true })
    try {
      const r = await h.svc.switchTo('agent')
      expect(r.ok).toBe(false)
      expect(r.error).toContain('回读核验失败')
      expect(h.calls.removed).toHaveLength(1) // 回收新建
      expect(h.calls.removed[0][1]).toBe(NORMAL) // 回退桌面 = 普通（启用当下所在桌面）
      expect(h.svc.pairingForTest()).toBeNull()
    } finally { h.cleanup() }
  })

  it('配对落盘失败：回滚内存配对并回收新建桌面（不留孤儿）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t375-fail-'))
    try {
      const blocker = path.join(dir, 'blocked')
      fs.writeFileSync(blocker, 'not a directory') // mkdirSync 在此路径下必然 ENOTDIR
      const h = await makeService({ file: path.join(blocker, 'config.json') })
      try {
        const r = await h.svc.switchTo('agent')
        expect(r.ok).toBe(false)
        expect(r.error).toContain('落盘失败')
        expect(h.calls.removed).toHaveLength(1) // 回收新建桌面
        expect(h.svc.pairingForTest()).toBeNull()
      } finally { h.cleanup() }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('reconciliation（系统侧切换观察，不抢回用户）', () => {
  it('系统快捷键切到 Agent：一拍对账后 current=agent 回推，全程零 SwitchDesktop 调用', async () => {
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL } })
    try {
      expect(h.svc.state().current).toBe('normal')
      h.sys.goTo(AGENT) // 模拟 Win+Ctrl+→ / TaskView
      await h.svc.reconcileNow()
      expect(h.svc.state().current).toBe('agent')
      expect(h.calls.switched).toEqual([])
      expect(h.events.some((e) => e.current === 'agent')).toBe(true)
    } finally { h.cleanup() }
  })

  it('系统切到第三桌面：current=unmanaged 回推（两枚入口均不高亮的事实面），不切回', async () => {
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: AGENT } })
    try {
      h.sys.goTo(THIRD)
      await h.svc.reconcileNow()
      expect(h.svc.state().current).toBe('unmanaged')
      expect(h.calls.switched).toEqual([]) // 不抢回
    } finally { h.cleanup() }
  })

  it('配对身份失效（Agent 桌面被用户删除）：安全态未配对，不自动重建', async () => {
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: NORMAL } })
    try {
      expect(h.svc.state().paired).toBe(true)
      h.sys.remove(AGENT) // 用户在 TaskView 删了 Agent 桌面
      await h.svc.reconcileNow()
      expect(h.svc.state().paired).toBe(false)
      expect(h.calls.created).toEqual([]) // 不自动重建
    } finally { h.cleanup() }
  })

  it('事实不可读拍：沿用上一拍（不猜、不翻脸）', async () => {
    const h = await makeService({ pairing: { normalId: NORMAL, agentId: AGENT }, system: { ids: [NORMAL, AGENT, THIRD], current: AGENT } })
    try {
      expect(h.svc.state().current).toBe('agent')
      h.breakFacts(1)
      await h.svc.reconcileNow()
      expect(h.svc.state().current).toBe('agent')
    } finally { h.cleanup() }
  })
})

describe('跟随兜底（t371 生产待验证项：desktop-bound 窗迁移）', () => {
  it('follow 目标窗不在当前桌面 → 公开 MoveWindowToDesktop 迁到系统当前桌面', async () => {
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: AGENT },
      deps: { isWindowOnCurrent: (hwnd) => hwnd !== 42, followTargets: () => [{ hwnd: 42, label: 'panel' }] },
    })
    try {
      h.sys.goTo(THIRD)
      await h.svc.reconcileNow() // 模式变化触发 ensureFollow
      // 启动首拍（unmanaged → normal 对账）也会兜底一次——最后一记必是迁到系统当前桌面
      expect(h.calls.moved[h.calls.moved.length - 1]).toEqual([42, THIRD])
    } finally { h.cleanup() }
  })

  it('跟随窗已在当前桌面 → 零迁移动作', async () => {
    const h = await makeService({
      pairing: { normalId: NORMAL, agentId: AGENT },
      system: { ids: [NORMAL, AGENT, THIRD], current: AGENT },
      deps: { isWindowOnCurrent: () => true, followTargets: () => [{ hwnd: 42, label: 'panel' }] },
    })
    try {
      await h.svc.reconcileNow()
      expect(h.calls.moved).toEqual([])
    } finally { h.cleanup() }
  })
})
