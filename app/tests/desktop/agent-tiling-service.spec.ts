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
  windows: Map<number, { rect: TileRect; iconic: boolean; resizable?: boolean }>
  writes: Array<{ hwnd: number; target: TileRect }>
  watchOn: (hwnd: number) => void
  mode: { value: 'normal' | 'agent' | 'unmanaged' }
  events: AgentTilingState[]
  /** 让下一轮写恒失败（SetWindowPos 返回 false 的观测口） */
  failWrites(): void
  /** 钉死窗集合：写「受理」但矩形纹丝不动（WM_WINDOWPOSCHANGING 拒改的核验面） */
  stuck: Set<number>
  /** 主屏矩形（可变——显示参数变化重算的注入面，工单377） */
  primary: { value: TileRect }
  /** 触发显示参数变化回调（分辨率/DPI/主屏变化的假源） */
  displayChange(): void
}

function harness(over: Partial<AgentTilingServiceOptions> & { enabled?: boolean } = {}): Harness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean; resizable?: boolean }>([
    // 面板自家窗（own exe 排除的假身）+ 一扇别的桌面窗（初始集合为空也行——由测试增删）
  ])
  windows.clear()
  const writes: Array<{ hwnd: number; target: TileRect }> = []
  const events: AgentTilingState[] = []
  const mode = { value: 'normal' as 'normal' | 'agent' | 'unmanaged' }
  let failNext = false
  const stuck = new Set<number>()
  const primary = { value: { ...PRIMARY } }
  const displayCbs: Array<() => void> = []
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
      resizable: w.resizable !== false, // 缺省可改窗；显式 resizable:false = 固定尺寸窗（工单377）
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
      primaryRect: () => ({ ...primary.value }),
      taskbarTop: () => TASKBAR_TOP,
      onDisplayChanged: (cb) => {
        displayCbs.push(cb)
        return () => {
          const i = displayCbs.indexOf(cb)
          if (i >= 0) displayCbs.splice(i, 1)
        }
      },
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
    primary,
    displayChange: () => {
      for (const cb of [...displayCbs]) cb()
    },
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

// ————————————————————————————————————————————————————————————
// 工单377：完整生命周期与容量降级（3-5 窗落位、关闭吸收、移回最新加入、最小化保留、
// 显示参数变化重算与不可见坐标防线、异常三分类、容量溢出与按序补入）
// ————————————————————————————————————————————————————————————

/** 依次加窗并各触发一拍（加入事件序 = memberOrder） */
async function addWindows(h: Harness, ids: number[], rect = AREA): Promise<void> {
  for (const id of ids) {
    h.windows.set(id, { rect: { ...rect }, iconic: false })
    h.watchOn(id)
    await settle(60)
  }
}

function rectOfWrites(h: Harness, hwnd: number): TileRect {
  const w = h.writes.filter((x) => x.hwnd === hwnd).at(-1)
  if (!w) throw new Error(`hwnd ${hwnd} 无写集`)
  return w.target
}

describe('Agent 平铺生命周期（工单377）', () => {
  it('三至五窗确定性落位：裂变 B / A / 再 B（stories 15-17 的真编排面）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3, 4, 5])
    // 终态 = 五窗布局（与纯函数矩阵同数字：由服务成员序 + 持久树共同保证）
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 696 })
    expect(h.windows.get(4)!.rect).toEqual({ left: 0, top: 696, right: 1280, bottom: 1392 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 1280, top: 0, right: 1920, bottom: 696 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 1920, top: 0, right: 2560, bottom: 696 })
    expect(h.windows.get(3)!.rect).toEqual({ left: 1280, top: 696, right: 2560, bottom: 1392 })
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 5, overflow: 0 })
  })

  it('关闭收缩由兄弟吸收：三窗关窗 2 → 窗 3 吸收整右半、窗 1 不动（story 20）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3])
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    h.windows.delete(2)
    h.watchOn(1)
    await settle(60)
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(h.windows.get(3)!.rect).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    expect(h.svc.state()).toMatchObject({ count: 2, placed: 2 })
  })

  it('移回主屏按最新窗口加入：移除后再加入 = 裂变当前队首（story 21）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3])
    h.windows.delete(2)
    h.watchOn(1)
    await settle(60)
    h.windows.set(2, { rect: { ...AREA }, iconic: false })
    h.watchOn(2)
    await settle(60)
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 696 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 0, top: 696, right: 1280, bottom: 1392 })
    expect(h.windows.get(3)!.rect).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
    expect(h.svc.memberOrderForTest()).toEqual([1, 3, 2])
  })

  it('最小化保留窗格与顺序：零写入、他窗不动；还原回原格（story 19）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3])
    const r1 = h.windows.get(1)!.rect
    const r3 = h.windows.get(3)!.rect
    h.writes.length = 0
    h.windows.set(2, { rect: { left: -32000, top: -32000, right: -31800, bottom: -31800 }, iconic: true })
    h.watchOn(2)
    await settle(60)
    expect(h.writes).toEqual([]) // 最小化零写入（保留窗格）
    expect(h.windows.get(1)!.rect).toEqual(r1)
    expect(h.windows.get(3)!.rect).toEqual(r3)
    expect(h.svc.state()).toMatchObject({ count: 3, placed: 3 })
    // 还原：回原窗格（窗 2 = 右上）
    h.windows.set(2, { rect: { left: 500, top: 400, right: 1200, bottom: 900 }, iconic: false })
    h.watchOn(2)
    await settle(60)
    expect(h.windows.get(2)!.rect).toEqual({ left: 1280, top: 0, right: 2560, bottom: 696 })
  })

  it('显示参数变化重算：主屏变小 → 平铺区重算并落新几何（story 23）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3])
    h.writes.length = 0
    h.primary.value = { left: 0, top: 0, right: 1280, bottom: 720 }
    h.displayChange()
    await settle(60)
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 640, bottom: 720 })
    expect(h.windows.get(2)!.rect).toEqual({ left: 640, top: 0, right: 1280, bottom: 360 })
    expect(h.windows.get(3)!.rect).toEqual({ left: 640, top: 360, right: 1280, bottom: 720 })
  })

  it('不可见坐标防线：主屏退化（零矩形）→ 本拍零写入、全员未落格（story 23）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    const writesBefore = h.writes.length
    h.primary.value = { left: 0, top: 0, right: 0, bottom: 0 }
    h.displayChange()
    await settle(60)
    expect(h.writes.length).toBe(writesBefore)
    expect(h.svc.state()).toMatchObject({ count: 2, placed: 0, overflow: 2 })
    // 恢复后重算回位
    h.primary.value = { ...PRIMARY }
    h.displayChange()
    await settle(60)
    expect(h.svc.state()).toMatchObject({ count: 2, placed: 2, overflow: 0 })
  })

  it('异常分类·固定尺寸：WS_THICKFRAME 缺位窗不试写即异常化，他窗照常平铺', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 100, top: 100, right: 700, bottom: 500 }, iconic: false, resizable: false })
    h.windows.set(2, { rect: { left: 100, top: 100, right: 700, bottom: 500 }, iconic: false })
    h.watchOn(1)
    await settle(60)
    expect(h.writes.filter((w) => w.hwnd === 1)).toEqual([]) // 固定尺寸不试写
    expect(h.svc.anomalyKindsForTest().get(1)).toBe('fixed-size')
    expect(h.svc.state()).toMatchObject({ count: 2, anomalies: 1, placed: 1 })
    // 异常窗不在平铺树：窗 2 独占铺满（兄弟吸收空位——不阻塞其他窗口）
    expect(h.windows.get(2)!.rect).toEqual(AREA)
    expect(h.svc.memberOrderForTest()).toEqual([2])
  })

  it('异常分类·write-denied：写窗被系统拒绝达上限 → write-denied、不再写', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    h.windows.set(1, { rect: { left: 400, top: 300, right: 1500, bottom: 1000 }, iconic: false }) // 拖离目标
    h.failWrites()
    h.watchOn(1)
    await settle(60)
    h.watchOn(1)
    await settle(60)
    expect(h.svc.anomalyKindsForTest().get(1)).toBe('write-denied')
    expect(h.svc.state()).toMatchObject({ anomalies: 1 })
    const n = h.writes.filter((w) => w.hwnd === 1).length
    h.watchOn(1)
    await settle(60)
    expect(h.writes.filter((w) => w.hwnd === 1).length).toBe(n) // 异常化后零再写
  })

  it('异常分类·refused：受理但拒改达上限 → refused；异常窗退出平铺树兄弟吸收', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    h.windows.set(1, { rect: { left: 400, top: 300, right: 1500, bottom: 1000 }, iconic: false }) // 拖离目标
    h.stuck.add(1)
    h.watchOn(1)
    await settle(60)
    h.watchOn(1)
    await settle(60)
    expect(h.svc.anomalyKindsForTest().get(1)).toBe('refused')
    // 下一拍：异常窗出树，窗 2 吸收铺满
    h.watchOn(2)
    await settle(60)
    expect(h.windows.get(2)!.rect).toEqual(AREA)
    expect(h.svc.state()).toMatchObject({ count: 2, placed: 1, anomalies: 1 })
  })

  it('异常清账：异常窗消失后清账，同 hwnd 新窗身份不继承旧异常', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    h.windows.set(1, { rect: { left: 100, top: 100, right: 700, bottom: 500 }, iconic: false, resizable: false })
    h.watchOn(1)
    await settle(60)
    expect(h.svc.anomalyKindsForTest().get(1)).toBe('fixed-size')
    h.windows.delete(1)
    h.watchOn(0) // 触发一拍（0 号窗不在集合，仅作事件源）
    await settle(60)
    expect(h.svc.anomaliesForTest()).toEqual([])
    expect(h.svc.anomalyKindsForTest().size).toBe(0)
  })

  it('容量溢出与按序补入：小屏六窗溢出两扇、关窗 4 → 窗 5 补入（stories 26/29）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.primary.value = { left: 0, top: 0, right: 660, bottom: 500 }
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3, 4, 5, 6], { left: 0, top: 0, right: 660, bottom: 500 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
    // 前四窗 = 四窗布局，溢出不重排既有成员
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 330, bottom: 250 })
    expect(h.windows.get(4)!.rect).toEqual({ left: 0, top: 250, right: 330, bottom: 500 })
    // 关窗 4 → 窗 5 按序补入、窗 6 仍溢出
    h.windows.delete(4)
    h.watchOn(1)
    await settle(60)
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 0, top: 250, right: 330, bottom: 500 })
  })
})
