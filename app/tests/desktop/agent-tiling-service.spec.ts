/**
 * Agent 平铺编排服务测试（工单376，spec #369 决策 7/8/27）：实验开关隔离、agent 模式
 * 激活/普通桌面失活零改窗、一窗铺满/两窗各半落位、回声抑制（echo 不重排）、外部改窗
 * 单发重排（不形成循环）、失败 reconciliation（有限重试 → 异常化）、计数回推口径。
 * deps 全假源（workspace-service.spec.ts 同款纪律），零 FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  /** 复原写（工单378：首次操作复原走 restoreRect，与普通落位分开记账） */
  restores: Array<{ hwnd: number; target: TileRect }>
  watchOn: (hwnd: number) => void
  mode: { value: 'normal' | 'agent' | 'unmanaged' }
  events: AgentTilingState[]
  /** 让后续写失败（SetWindowPos 返回 false 的观测口）；传次数 = 瞬时失败（工单404 收敛面），
   *  传 hwnd = 只对该窗失败（工单404：同拍有界重试下全局恒失败会连坐其他窗的正当写入） */
  failWrites(count?: number, hwnd?: number): void
  /** 钉死窗集合：写「受理」但矩形纹丝不动（WM_WINDOWPOSCHANGING 拒改的核验面） */
  stuck: Set<number>
  /** 主屏矩形（可变——显示参数变化重算的注入面，工单377） */
  primary: { value: TileRect }
  /** 触发显示参数变化回调（分辨率/DPI/主屏变化的假源） */
  displayChange(): void
  /** 前台窗集合（工单378「用户主动操作」判据的假源） */
  foreground: Set<number>
  /** 授权提示上行事件（hwnd 序） */
  prompts: Array<{ hwnd: number; rect: TileRect }>
  /** 授权提示关闭事件（hwnd 序） */
  closed: number[]
}

function harness(over: Partial<AgentTilingServiceOptions> & { enabled?: boolean } = {}): Harness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean; resizable?: boolean }>([
    // 面板自家窗（own exe 排除的假身）+ 一扇别的桌面窗（初始集合为空也行——由测试增删）
  ])
  windows.clear()
  const writes: Array<{ hwnd: number; target: TileRect }> = []
  const restores: Array<{ hwnd: number; target: TileRect }> = []
  const events: AgentTilingState[] = []
  const mode = { value: 'normal' as 'normal' | 'agent' | 'unmanaged' }
  let failLeft = 0
  let failHwnd: number | null = null
  const stuck = new Set<number>()
  const primary = { value: { ...PRIMARY } }
  const displayCbs: Array<() => void> = []
  let watchCb: ((hwnd: number) => void) | null = null
  const foreground = new Set<number>()
  const prompts: Array<{ hwnd: number; rect: TileRect }> = []
  const closed: number[] = []

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
    settleMs: 40,
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
      // 生产落位统一走 restoreRect（最大化态先 SC_RESTORE）；测试里同时记入 writes（几何写
      // 全集）与 restores（复原通道标记），377 的写集断言与 378 的复原断言各取所需
      restoreRect: (hwnd, target) => {
        restores.push({ hwnd, target: { ...target } })
        writes.push({ hwnd, target: { ...target } })
        if (failLeft > 0 && (failHwnd === null || failHwnd === hwnd)) {
          failLeft--
          return false
        }
        if (stuck.has(hwnd)) return true
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
      ...over.deps,
    },
  })
  ctx.on('tiling/changed', (payload) => events.push(payload))
  ctx.on('tiling/authorize-request', (payload) => prompts.push(payload))
  ctx.on('tiling/authorize-closed', (payload) => closed.push(payload.hwnd))
  svc.start()
  return {
    svc,
    windows,
    writes,
    restores,
    mode,
    events,
    watchOn: (hwnd) => watchCb?.(hwnd),
    failWrites: (count = Number.POSITIVE_INFINITY, hwnd: number | null = null) => {
      failLeft = count
      failHwnd = hwnd
    },
    stuck,
    primary,
    displayChange: () => {
      for (const cb of [...displayCbs]) cb()
    },
    foreground,
    prompts,
    closed,
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
    h.failWrites(Number.POSITIVE_INFINITY, 1) // 只对窗 1 恒拒绝（工单404 同拍有界重试：全局恒失败会连坐窗 2 的正当重排写）
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
    // 夹具 700×500：缩窄区（700−32=668）窗格 334 仍可裂变——带非空时树区让出露边，
    // 补入容量按缩窄区评估（原型 syncArea 语义的固有边界：区宽贴近 2×最小窗格时，
    // 露边会让最近边界的裂变不可行、带不排空；story 4 的补入以缩窄区容量为准）。
    h.primary.value = { left: 0, top: 0, right: 700, bottom: 500 }
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3, 4, 5, 6], { left: 0, top: 0, right: 700, bottom: 500 })
    expect(h.svc.state()).toMatchObject({ count: 6, placed: 4, overflow: 2 })
    // 工单405 屏外滚动带语义：带非空 → 树区右缘让出露边 32px（区宽 668）、窗 5/6 入带。
    // 屏内四窗按缩窄区重展（四窗布局结构不变，列宽 334）；溢出成员写带列矩形，
    // 不再保留打开时的原矩形（spec #403 用户故事 10/13/15）。
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 334, bottom: 250 })
    expect(h.windows.get(4)!.rect).toEqual({ left: 0, top: 250, right: 334, bottom: 500 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 668, top: 0, right: 1018, bottom: 500 })
    // 关窗 4 → 窗 5 按序补入、窗 6 仍溢出（带收拢：窗 6 收拢到列 0）
    h.windows.delete(4)
    h.watchOn(1)
    await settle(60)
    expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
    expect(h.windows.get(5)!.rect).toEqual({ left: 0, top: 250, right: 334, bottom: 500 })
    expect(h.windows.get(6)!.rect).toEqual({ left: 668, top: 0, right: 1018, bottom: 500 })
  })
})


describe('逐窗几何授权、浮动与恢复平铺（工单378）', () => {
  /** 用户主动改几何：先改矩形、置前台、触发一拍（拖动/边框/最大化/键盘/Snap 的假身） */
  const userMove = async (h: Harness, hwnd: number, rect: TileRect): Promise<void> => {
    h.windows.get(hwnd)!.rect = { ...rect }
    h.foreground.add(hwnd)
    h.watchOn(hwnd)
    await settle(60)
  }
  /** 后台自改：非前台的外部几何变化 */
  const backgroundMove = async (h: Harness, hwnd: number, rect: TileRect): Promise<void> => {
    h.windows.get(hwnd)!.rect = { ...rect }
    h.foreground.delete(hwnd)
    h.watchOn(hwnd)
    await settle(60)
  }
  const moved = (r: TileRect, dx: number, dy: number): TileRect => ({
    left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy,
  })

  it('首次用户操作：先复原到窗格并上行提示（不浮动、不重排），取消后保持平铺', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1])
    expect(h.windows.get(1)!.rect).toEqual(AREA)
    const before = { ...h.windows.get(1)!.rect }
    await userMove(h, 1, moved(AREA, 120, 80))
    // 复原：窗口回到窗格（restore 通道），提示上行；零浮动
    expect(h.windows.get(1)!.rect).toEqual(before)
    expect(h.restores.at(-1)).toEqual({ hwnd: 1, target: AREA })
    expect(h.prompts).toEqual([{ hwnd: 1, rect: AREA }])
    expect(h.svc.authPhaseForTest(1)).toBe('prompt')
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 1, authorized: 0, placed: 1 })
    // Esc / 保持平铺：锁定，窗口仍在格上
    const cancelled = h.svc.cancelHwnd(1)
    expect(cancelled.ok).toBe(true)
    expect(h.svc.authPhaseForTest(1)).toBe('locked')
    expect(h.windows.get(1)!.rect).toEqual(before)
    expect(h.closed).toEqual([1])
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0, authorized: 0 })
  })

  it('后台自改不弹框：非前台的外部几何变化静默复原、零提示、零授权（story 30）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    const target2 = { ...h.windows.get(2)!.rect }
    await backgroundMove(h, 2, moved(target2, 60, 40))
    expect(h.windows.get(2)!.rect).toEqual(target2)
    expect(h.prompts).toEqual([])
    expect(h.svc.authPhaseForTest(2)).toBe('locked')
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0 })
  })

  it('确认本身不重排：零写入零复原、进入 armed、窗口仍在格上（决策 9）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1])
    await userMove(h, 1, moved(AREA, 90, 60))
    const writesBefore = h.writes.length
    const restoresBefore = h.restores.length
    const confirmed = h.svc.confirmHwnd(1)
    expect(confirmed.ok).toBe(true)
    expect(h.svc.authPhaseForTest(1)).toBe('armed')
    expect(h.writes.length).toBe(writesBefore)
    expect(h.restores.length).toBe(restoresBefore)
    expect(h.windows.get(1)!.rect).toEqual(AREA)
    expect(h.svc.state()).toMatchObject({ floating: 0, authorized: 1, placed: 1 })
  })

  it('确认后重新发起操作 → 浮动：退出平铺树、其余成员重铺满、授权消费（story 37/38）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    const right = { left: 1280, top: 0, right: 2560, bottom: 1392 }
    expect(h.windows.get(2)!.rect).toEqual(right)
    await userMove(h, 2, moved(right, 80, 50))
    h.svc.confirmHwnd(2)
    const floated = moved(right, 80, 50)
    await userMove(h, 2, floated)
    // 浮动：几何保留（可覆盖窗格），成员 1 重铺满，成员 2 不再落格
    expect(h.windows.get(2)!.rect).toEqual(floated)
    expect(h.windows.get(1)!.rect).toEqual(AREA)
    // 一次持续授权在操作静止后消费（不是第一个浮动事件就消费）
    await settle(120)
    expect(h.svc.authPhaseForTest(2)).toBe('locked')
    expect(h.svc.floatingRectForTest(2)).toEqual(floated)
    expect(h.svc.state()).toMatchObject({ floating: 1, authorized: 0, placed: 1 })
  })

  it('浮动窗再次操作需重新授权：未授权用户改 → 复原到保留浮动几何并提示；确认后操作 → 接受新几何仍浮动', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    const right = { left: 1280, top: 0, right: 2560, bottom: 1392 }
    await userMove(h, 2, moved(right, 60, 40))
    h.svc.confirmHwnd(2)
    const floatRect = moved(right, 60, 40)
    await userMove(h, 2, floatRect)
    expect(h.svc.state().floating).toBe(1)
    // 未授权再次拖动 → 复原到浮动几何并提示（不是拉回平铺）
    await userMove(h, 2, moved(floatRect, 100, 100))
    expect(h.windows.get(2)!.rect).toEqual(floatRect)
    expect(h.prompts.at(-1)).toEqual({ hwnd: 2, rect: floatRect })
    expect(h.svc.state()).toMatchObject({ floating: 1, prompting: 1 })
    // 确认后再次操作 → 接受新几何（仍浮动、授权消费）
    h.svc.confirmHwnd(2)
    const again = moved(floatRect, 100, 100)
    await userMove(h, 2, again)
    expect(h.windows.get(2)!.rect).toEqual(again)
    expect(h.svc.floatingRectForTest(2)).toEqual(again)
    await settle(120)
    expect(h.svc.authPhaseForTest(2)).toBe('locked')
    expect(h.svc.state()).toMatchObject({ floating: 1, authorized: 0 })
  })

  it('切出撤销授权但保留浮动几何；返回后不自动恢复浮动（story 39）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    const right = { left: 1280, top: 0, right: 2560, bottom: 1392 }
    await userMove(h, 2, moved(right, 60, 40))
    h.svc.confirmHwnd(2)
    const floatRect = moved(right, 60, 40)
    await userMove(h, 2, floatRect)
    // 另一个窗进入提示（未消费授权）——切出应撤销它
    await userMove(h, 1, moved(AREA, 40, 20))
    expect(h.svc.state().prompting).toBe(1)
    h.mode.value = 'normal'
    h.svc.syncActivation()
    await settle(60)
    expect(h.svc.authPhaseForTest(1)).toBe('locked')
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0 })
    expect(h.closed).toContain(1)
    // 切回：浮动窗几何不变、不被自动拉回平铺
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle(60)
    expect(h.windows.get(2)!.rect).toEqual(floatRect)
    expect(h.svc.state()).toMatchObject({ floating: 1, placed: 1 })
  })

  it('恢复平铺：收回浮动（按浮动序补入平铺）、清授权、异常窗跳过并报告数量（story 28/40）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3])
    // 浮动 2 与 3（各自确认 + 重新操作）
    const r2 = { left: 1280, top: 0, right: 2560, bottom: 696 }
    const r3 = { left: 1280, top: 696, right: 2560, bottom: 1392 }
    await userMove(h, 2, moved(r2, 40, 30))
    h.svc.confirmHwnd(2)
    await userMove(h, 2, moved(r2, 40, 30))
    await userMove(h, 3, moved(r3, 30, 40))
    h.svc.confirmHwnd(3)
    await userMove(h, 3, moved(r3, 30, 40))
    expect(h.svc.state()).toMatchObject({ floating: 2, placed: 1 })
    // 异常窗（固定尺寸）在场：恢复平铺应跳过并报告
    h.windows.set(9, { rect: { left: 200, top: 200, right: 500, bottom: 460 }, iconic: false, resizable: false })
    h.watchOn(9)
    await settle(60)
    expect(h.svc.state().anomalies).toBe(1)
    const res = await h.svc.restoreTiling()
    expect(res.ok).toBe(true)
    expect(res.restored).toBe(2)
    expect(res.skipped).toBe(1)
    // 三窗布局（按成员序 1,2,3 的确定性裂变）
    expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(h.windows.get(2)!.rect).toEqual(r2)
    expect(h.windows.get(3)!.rect).toEqual(r3)
    expect(h.svc.state()).toMatchObject({ floating: 0, authorized: 0, prompting: 0, placed: 3, anomalies: 1 })
    // 清授权后的首次操作会重新提示
    await userMove(h, 1, moved(AREA, 30, 20))
    expect(h.prompts.at(-1)!.hwnd).toBe(1)
  })

  it('窗口消失清授权：同一 hwnd 新窗身份不继承 prompt/armed', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1])
    await userMove(h, 1, moved(AREA, 50, 30))
    expect(h.svc.authPhaseForTest(1)).toBe('prompt')
    h.windows.delete(1)
    h.watchOn(0)
    await settle(60)
    expect(h.svc.authPhaseForTest(1)).toBe('locked')
    expect(h.closed).toContain(1)
  })
})

// ————————————————————————————————————————————————————————————
// 工单404（spec #403）：布局自身缩放分流与写窗收敛——
// - 布局自身的目标矩形变化（兄弟裂变/吸收/重算）不是用户改几何：locked 不弹框、
//   armed 不误转浮动不消费授权（前台恰落在待缩/待扩张兄弟也要证）；
// - 一次写窗/回读失败后完全无后续事件：同拍有界重试收敛或异常化（不依赖下一拍事件）；
// - 窗口消失清尝试账（hwnd 复用不继承旧计数）；
// - 缺陷回归清单（#403 Testing Decisions）：6+ 新增、不同顺序逐级关闭到 4/3、同拍多窗、
//   2→1→新增及重启后的连续性。
// 断言全部落在实际矩形（假窗口 map 读回）、授权事件与状态投影，不绑内部类。
// ————————————————————————————————————————————————————————————

describe('工单404：布局自身缩放分流与写窗收敛', () => {
  const RIGHT: TileRect = { left: 1280, top: 0, right: 2560, bottom: 1392 }
  const RIGHT_TOP: TileRect = { left: 1280, top: 0, right: 2560, bottom: 696 }
  const RIGHT_BOTTOM: TileRect = { left: 1280, top: 696, right: 2560, bottom: 1392 }
  // 六窗确定性布局（2560×1392 全部可容——与纯函数矩阵同数字）
  const SIX: Record<number, TileRect> = {
    1: { left: 0, top: 0, right: 1280, bottom: 696 },
    2: { left: 1280, top: 0, right: 1920, bottom: 696 },
    3: { left: 1280, top: 696, right: 1920, bottom: 1392 },
    4: { left: 0, top: 696, right: 1280, bottom: 1392 },
    5: { left: 1920, top: 0, right: 2560, bottom: 696 },
    6: { left: 1920, top: 696, right: 2560, bottom: 1392 },
  }
  const moved = (r: TileRect, dx: number, dy: number): TileRect => ({
    left: r.left + dx, top: r.top + dy, right: r.right + dx, bottom: r.bottom + dy,
  })
  const userMove = async (h: Harness, hwnd: number, rect: TileRect): Promise<void> => {
    h.windows.get(hwnd)!.rect = { ...rect }
    h.foreground.add(hwnd)
    h.watchOn(hwnd)
    await settle(60)
  }
  const expectRects = (h: Harness, map: Record<number, TileRect>): void => {
    for (const [k, v] of Object.entries(map)) {
      expect(h.windows.get(Number(k))!.rect).toEqual(v)
    }
  }

  it('locked 相位：新增兄弟裂变的布局缩放不弹授权框、待缩窗落新格（前台在待缩窗）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    h.foreground.add(2) // 前台恰在将被新窗裂变缩小的窗上
    await addWindows(h, [3])
    expect(h.prompts).toEqual([]) // 布局自身缩放不是用户改几何——零授权提示
    expect(h.svc.authPhaseForTest(2)).toBe('locked')
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0, authorized: 0, count: 3, placed: 3 })
    expectRects(h, { 1: { left: 0, top: 0, right: 1280, bottom: 1392 }, 2: RIGHT_TOP, 3: RIGHT_BOTTOM })
  })

  it('armed 相位：新增兄弟裂变不误转浮动、不消费授权（前台在待缩窗）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    await userMove(h, 2, moved(RIGHT, 60, 40))
    expect(h.svc.confirmHwnd(2).ok).toBe(true) // prompt → armed
    expect(h.prompts.length).toBe(1)
    h.foreground.add(2) // 确认后前台仍在窗 2
    await addWindows(h, [3])
    // 布局缩放：窗 2 写入新格（不浮动、授权不消费——armed 仍在）
    expect(h.svc.state()).toMatchObject({ floating: 0, authorized: 1, placed: 3 })
    expect(h.svc.authPhaseForTest(2)).toBe('armed')
    expect(h.prompts.length).toBe(1) // 无新提示
    expectRects(h, { 1: { left: 0, top: 0, right: 1280, bottom: 1392 }, 2: RIGHT_TOP, 3: RIGHT_BOTTOM })
  })

  it('locked 相位：关闭兄弟吸收不弹框（前台恰在待扩张兄弟）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3])
    h.foreground.add(3) // 前台恰在将吸收空位的兄弟
    h.windows.delete(2)
    h.watchOn(3)
    await settle(60)
    expect(h.prompts).toEqual([])
    expect(h.svc.authPhaseForTest(3)).toBe('locked')
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0, count: 2, placed: 2 })
    expectRects(h, { 1: { left: 0, top: 0, right: 1280, bottom: 1392 }, 3: RIGHT })
  })

  it('armed 相位：关闭兄弟吸收不误转浮动、不消费授权（前台恰在待扩张兄弟）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    await userMove(h, 1, moved({ left: 0, top: 0, right: 1280, bottom: 1392 }, 40, 30))
    expect(h.svc.confirmHwnd(1).ok).toBe(true)
    h.foreground.add(1)
    h.windows.delete(2)
    h.watchOn(1)
    await settle(60)
    expect(h.svc.state()).toMatchObject({ floating: 0, authorized: 1, count: 1, placed: 1 })
    expect(h.svc.authPhaseForTest(1)).toBe('armed')
    expect(h.windows.get(1)!.rect).toEqual(AREA) // 吸收整区
  })

  it('6+ 新增：全部既有窗在前台的极端下，六窗实际矩形全部落定、零授权事件（无非预期遮挡）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3, 4, 5])
    for (const id of [1, 2, 3, 4, 5]) h.foreground.add(id) // 极端：既有窗全部报前台
    await addWindows(h, [6])
    expect(h.prompts).toEqual([])
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0, count: 6, placed: 6, overflow: 0 })
    expectRects(h, SIX)
  })

  it('不同顺序逐级关闭到 3：前台始终落在待扩张兄弟，实际矩形逐步收敛、零授权事件', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2, 3, 4, 5, 6])
    expectRects(h, SIX)
    // 关 6（兄弟 3 吸收右下整列），前台在 3
    h.foreground.add(3)
    h.windows.delete(6)
    h.watchOn(3)
    await settle(60)
    expectRects(h, { 1: SIX[1], 2: SIX[2], 3: RIGHT_BOTTOM, 4: SIX[4], 5: SIX[5] })
    // 关 2（兄弟 5 吸收右上整列），前台在 5
    h.foreground.add(5)
    h.windows.delete(2)
    h.watchOn(5)
    await settle(60)
    expectRects(h, { 1: SIX[1], 5: RIGHT_TOP, 3: RIGHT_BOTTOM, 4: SIX[4] })
    // 关 4（兄弟 1 吸收左列），到 3 窗：四象限收敛为左半/右上/右下
    h.foreground.add(1)
    h.windows.delete(4)
    h.watchOn(1)
    await settle(60)
    expectRects(h, { 1: { left: 0, top: 0, right: 1280, bottom: 1392 }, 5: RIGHT_TOP, 3: RIGHT_BOTTOM })
    expect(h.prompts).toEqual([])
    expect(h.svc.state()).toMatchObject({ floating: 0, prompting: 0, authorized: 0, count: 3, placed: 3 })
  })

  it('首次写窗失败且完全无后续事件：同拍有界重试收敛到目标矩形、零异常', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1])
    h.windows.get(1)!.rect = moved(AREA, 120, 80) // 拖离目标
    h.failWrites(1) // 瞬时失败恰好一次（SetWindowPos 偶发 false）
    h.watchOn(1)
    await settle(60) // 只此一拍——之后零事件
    expect(h.windows.get(1)!.rect).toEqual(AREA) // 同拍重试收敛
    expect(h.svc.anomaliesForTest()).toEqual([])
    expect(h.svc.state()).toMatchObject({ anomalies: 0, placed: 1 })
  })

  it('写窗受理但矩形不动且无后续事件：单拍内有界重试达上限即异常化 refused（写入次数 ≤ 上限）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1])
    h.windows.get(1)!.rect = moved(AREA, 90, 60)
    h.stuck.add(1)
    const before = h.writes.filter((w) => w.hwnd === 1).length
    h.watchOn(1)
    await settle(60) // 单拍（旧行为要等下一次事件才达上限）
    expect(h.svc.anomalyKindsForTest().get(1)).toBe('refused')
    expect(h.writes.filter((w) => w.hwnd === 1).length - before).toBeLessThanOrEqual(2)
    expect(h.svc.state()).toMatchObject({ anomalies: 1 })
  })

  it('尝试账随窗口消失清账：同 hwnd 新窗身份不继承旧计数（旧计数残留会误异常化新窗）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1, 2])
    h.windows.get(1)!.rect = moved(AREA, 70, 50)
    h.stuck.add(1)
    h.watchOn(1)
    await settle(60) // 旧窗 1 计次
    h.windows.delete(1)
    h.stuck.delete(1)
    h.watchOn(0) // 消失拍：清异常账与尝试账
    await settle(60)
    h.windows.set(1, { rect: moved(AREA, 33, 22), iconic: false }) // 同 hwnd 新窗
    h.watchOn(1)
    await settle(60)
    expect(h.svc.anomaliesForTest()).toEqual([]) // 不继承旧计数——不误异常化
    // 新窗按成员序裂变落次子格（memberOrder [2,1] → 窗 2 留首格、新 1 落右半）
    expect(h.windows.get(2)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
    expect(h.windows.get(1)!.rect).toEqual({ left: 1280, top: 0, right: 2560, bottom: 1392 })
  })

  it('同拍多窗出现与关闭：单拍内全部落位/吸收，顺序确定（实际矩形断言）', async () => {
    const h = harness()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    await settle()
    await addWindows(h, [1])
    h.windows.set(2, { rect: { ...AREA }, iconic: false })
    h.windows.set(3, { rect: { ...AREA }, iconic: false })
    h.watchOn(2) // 同拍两个新窗，只触发一拍
    await settle(60)
    expectRects(h, { 1: { left: 0, top: 0, right: 1280, bottom: 1392 }, 2: RIGHT_TOP, 3: RIGHT_BOTTOM })
    expect(h.svc.state()).toMatchObject({ count: 3, placed: 3 })
    h.windows.delete(2)
    h.windows.delete(3)
    h.watchOn(1)
    await settle(60)
    expect(h.windows.get(1)!.rect).toEqual(AREA)
    expect(h.svc.state()).toMatchObject({ count: 1, placed: 1 })
  })

  it('2→1→新增及重启后的连续性：持久模型恢复后实际矩形与干净退出前一致、恢复轮零授权', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t404-'))
    try {
      const file = path.join(dir, 'agent-layout.json')
      const AGENT_ID = 't404-agent-desktop'
      const h = harness({ layoutFile: file, deps: { agentDesktopId: () => AGENT_ID } })
      h.mode.value = 'agent'
      h.svc.syncActivation()
      await settle()
      await addWindows(h, [1, 2])
      h.windows.delete(2)
      h.watchOn(1)
      await settle(60)
      await addWindows(h, [3]) // 2→1→新增
      const before = { w1: h.windows.get(1)!.rect, w3: h.windows.get(3)!.rect }
      expect(before.w1).toEqual({ left: 0, top: 0, right: 1280, bottom: 1392 })
      expect(before.w3).toEqual(RIGHT)
      h.svc.shutdown() // 干净退出（clean=true 落盘）
      // 重启：同一份持久文档、新服务实例、窗口几何已被外部搬动
      const h2 = harness({ layoutFile: file, deps: { agentDesktopId: () => AGENT_ID } })
      h2.windows.set(1, { rect: { left: 300, top: 200, right: 900, bottom: 700 }, iconic: false })
      h2.windows.set(3, { rect: { left: 500, top: 300, right: 1200, bottom: 800 }, iconic: false })
      h2.mode.value = 'agent'
      h2.svc.syncActivation()
      await settle(60)
      expect(h2.windows.get(1)!.rect).toEqual(before.w1)
      expect(h2.windows.get(3)!.rect).toEqual(before.w3)
      expect(h2.prompts).toEqual([]) // 恢复轮不是用户改几何
      expect(h2.svc.state()).toMatchObject({ recovery: 'restored', placed: 2 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
