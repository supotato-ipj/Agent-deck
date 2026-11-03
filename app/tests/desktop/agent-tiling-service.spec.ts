/**
 * Agent 平铺编排服务测试（工单376，spec #369 决策 7/8/27）：实验开关隔离、agent 模式
 * 激活/普通桌面失活零改窗、一窗铺满/两窗各半落位、回声抑制（echo 不重排）、外部改窗
 * 单发重排（不形成循环）、失败 reconciliation（有限重试 → 异常化）、计数回推口径。
 * deps 全假源（workspace-service.spec.ts 同款纪律），零 FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentTilingService } from '../../src/main/services/agent-tiling'
import type { AgentTilingServiceOptions } from '../../src/main/services/agent-tiling'
import type { AgentTilingState } from '../../src/shared/contract'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'
import type { TileRect } from '../../src/main/desktop/tiling-plan'

const PRIMARY = { left: 0, top: 0, right: 2560, bottom: 1440 }
const TASKBAR_TOP = 1392
const AREA: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }

interface Harness {
  svc: AgentTilingService
  windows: Map<number, { rect: TileRect; iconic: boolean }>
  writes: Array<{ hwnd: number; target: TileRect }>
  watchOn: (hwnd: number) => void
  mode: { value: 'normal' | 'agent' | 'unmanaged' }
  events: AgentTilingState[]
  /** 让下一轮写恒失败（SetWindowPos 返回 false 的观测口） */
  failWrites(): void
  /** 钉死窗集合：写「受理」但矩形纹丝不动（WM_WINDOWPOSCHANGING 拒改的核验面） */
  stuck: Set<number>
}

function harness(over: Partial<AgentTilingServiceOptions> & { enabled?: boolean } = {}): Harness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean }>([
    // 面板自家窗（own exe 排除的假身）+ 一扇别的桌面窗（初始集合为空也行——由测试增删）
  ])
  windows.clear()
  const writes: Array<{ hwnd: number; target: TileRect }> = []
  const events: AgentTilingState[] = []
  const mode = { value: 'normal' as 'normal' | 'agent' | 'unmanaged' }
  let failNext = false
  const stuck = new Set<number>()
  let watchCb: ((hwnd: number) => void) | null = null

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
      rect: { ...w.rect },
      onCurrentDesktop: mode.value === 'agent' ? true : null,
    }))

  const ctx = new Context()
  const svc = new AgentTilingService(ctx, {
    enabled: over.enabled ?? true,
    batchMs: 0,
    ...over,
    deps: {
      currentMode: () => mode.value,
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => PRIMARY,
      taskbarTop: () => TASKBAR_TOP,
      collectFacts: factsOf,
      readRect: (hwnd) => ({ ...(windows.get(hwnd)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      writeRect: (hwnd, target) => {
        writes.push({ hwnd, target: { ...target } })
        if (failNext) return false
        if (stuck.has(hwnd)) return true // 受理但拒改：矩形纹丝不动（核验面见 readRect）
        const w = windows.get(hwnd)
        if (w) w.rect = { ...target }
        return true
      },
      startWatch: (cb) => {
        watchCb = cb
        return () => {
          watchCb = null
        }
      },
      ...over.deps,
    },
  })
  ctx.on('tiling/changed', (payload) => events.push(payload))
  svc.start()
  return {
    svc,
    windows,
    writes,
    mode,
    events,
    watchOn: (hwnd) => watchCb?.(hwnd),
    failWrites: () => {
      failNext = true
    },
    stuck,
  }
}

/** 等一轮 pass 跑完（runPass 是 async——批合并 timer 0ms 也要一拍） */
async function settle(ms = 30): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

describe('Agent 平铺编排（工单376）', () => {
  it('实验开关关闭：零观察零落位（spec 决策 29）', async () => {
    const h = harness({ enabled: false })
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 100, top: 100, right: 900, bottom: 700 }, iconic: false })
    await settle()
    expect(h.writes).toEqual([])
    expect(h.svc.state()).toMatchObject({ available: false, count: 0 })
  })

  it('普通桌面零自动改窗：模式 normal/unmanaged 不激活（用户故事 77）', async () => {
    const h = harness()
    h.mode.value = 'normal'
    h.svc.syncActivation()
    h.windows.set(1, { rect: { left: 100, top: 100, right: 900, bottom: 700 }, iconic: false })
    await settle()
    expect(h.writes).toEqual([])
    h.mode.value = 'unmanaged'
    h.svc.syncActivation()
    await settle()
    expect(h.writes).toEqual([])
  })

  it('一窗铺满平铺区（下方避开任务栏、顶部不留白）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 100, top: 100, right: 900, bottom: 700 }, iconic: false })
    h.watchOn(1)
    await settle()
    expect(h.writes).toEqual([{ hwnd: 1, target: AREA }])
    expect(h.windows.get(1)!.rect).toEqual(AREA)
  })

  it('两窗左右各半（用户故事 14）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 0, top: 0, right: 2560, bottom: 1392 }, iconic: false })
    h.windows.set(2, { rect: { left: 0, top: 0, right: 2560, bottom: 1392 }, iconic: false })
    h.watchOn(2) // 新窗事件触发重排
    await settle()
    const targets = h.writes.filter((w) => w.hwnd === 1 || w.hwnd === 2)
    const byHwnd = new Map(targets.map((w) => [w.hwnd, w.target]))
    expect(byHwnd.get(1)).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(byHwnd.get(2)).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    expect(h.svc.state()).toMatchObject({ count: 2, placed: 2 })
  })

  it('已达标窗不重写；达标后 echo 事件不再产生写入（无改窗循环）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 0, top: 0, right: 2560, bottom: 1200 }, iconic: false })
    h.watchOn(1)
    await settle()
    expect(h.writes).toEqual([{ hwnd: 1, target: AREA }])
    h.writes.length = 0
    // 窗口在目标几何上继续发 LOCATIONCHANGE（DWM 抖动/回声）——不产生任何新写入
    h.watchOn(1)
    h.watchOn(1)
    await settle(60)
    expect(h.writes).toEqual([])
  })

  it('外部改窗（几何不在目标）→ 单发落位，静置后不再写（无乒乓）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: AREA, iconic: false })
    await settle()
    h.writes.length = 0
    // 用户/应用把窗拖到别处
    h.windows.set(1, { rect: { left: 500, top: 300, right: 1500, bottom: 1000 }, iconic: false })
    h.watchOn(1)
    await settle()
    expect(h.writes).toEqual([{ hwnd: 1, target: AREA }]) // 锁定规则单发纠回
    h.writes.length = 0
    await settle(60)
    expect(h.writes).toEqual([]) // 静置：零再写
  })

  it('失败 reconciliation：拒改窗计次，达上限异常化并不再写（不无限重试、不阻塞其他窗）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    // 窗 1 拒绝改窗（写「受理」但矩形纹丝不动——WM_WINDOWPOSCHANGING 钉死口径）；
    // 窗 2 正常可写
    h.windows.set(1, { rect: { left: 100, top: 100, right: 700, bottom: 500 }, iconic: false })
    h.windows.set(2, { rect: { left: 100, top: 100, right: 700, bottom: 500 }, iconic: false })
    h.stuck.add(1)
    h.watchOn(1)
    await settle(60)
    // 首轮：写 1 次 + 核验不达标（attempt=1, retry）；下轮重写即达上限
    h.watchOn(1)
    await settle(60)
    const w1Writes = h.writes.filter((w) => w.hwnd === 1).length
    expect(w1Writes).toBeGreaterThanOrEqual(1)
    expect(w1Writes).toBeLessThanOrEqual(2) // 有限重试：两轮合计 ≤2 次（MAX_WRITE_ATTEMPTS）
    expect(h.svc.anomaliesForTest()).toContain(1)
    expect(h.svc.state()).toMatchObject({ anomalies: 1, count: 2 })
    // 异常化后：再触发事件，窗 1 零写入、窗 2 继续正常
    h.writes.length = 0
    h.watchOn(1)
    await settle(60)
    expect(h.writes.filter((w) => w.hwnd === 1)).toEqual([])
  })

  it('最小化窗不写几何但仍计数（story 19 + 胶囊口径）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 50, top: 50, right: 800, bottom: 600 }, iconic: true })
    h.watchOn(1)
    await settle(60)
    expect(h.writes).toEqual([])
    expect(h.svc.state()).toMatchObject({ count: 1, placed: 1 })
  })

  it('计数回推：合格窗集合变化才推（排除面不计入——own exe/工具窗）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: AREA, iconic: false })
    h.watchOn(1)
    await settle()
    expect(h.svc.state()).toMatchObject({ count: 1 })
    const nEvents = h.events.length
    // 同集合再触发：不重复回推
    h.watchOn(1)
    await settle()
    expect(h.events.length).toBe(nEvents)
  })

  it('布局确定性：z 序翻转（焦点变化）不改成员加入序 → 布局不漂移（story 18/31）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: AREA, iconic: false })
    h.watchOn(1)
    await settle()
    h.windows.set(2, { rect: AREA, iconic: false })
    h.watchOn(2)
    await settle(60)
    const firstPlan = h.writes.filter((w) => w.hwnd === 2).at(-1)!.target
    expect(firstPlan).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 }) // 窗 2 = 后加入 → 右半
    h.writes.length = 0
    // 焦点切到窗 2 → 枚举 z 序翻转（[2,1]）——加入序账不随之重排，零重写
    const innerCollect = h.svc as unknown as { deps: { collectFacts: () => TileWindowFacts[] } }
    const orig = innerCollect.deps.collectFacts
    innerCollect.deps.collectFacts = () => orig().slice().reverse()
    h.watchOn(1)
    await settle(60)
    expect(h.writes).toEqual([])
  })

  it('失活即清场：切回普通后事件不再产生写入', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 0, top: 0, right: 500, bottom: 400 }, iconic: false })
    h.watchOn(1)
    await settle()
    expect(h.writes.length).toBeGreaterThan(0)
    h.mode.value = 'normal'
    h.svc.syncActivation()
    h.writes.length = 0
    h.windows.set(1, { rect: { left: 0, top: 0, right: 300, bottom: 300 }, iconic: false })
    h.watchOn(1)
    await settle(60)
    expect(h.writes).toEqual([])
  })
})
