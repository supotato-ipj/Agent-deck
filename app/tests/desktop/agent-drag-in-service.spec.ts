/**
 * Agent 拖入服务测试（工单407，spec #403 Testing Decisions「拖入以主进程公开工作区
 * 命令为最高测试缝」）：用既有虚拟桌面适配器的假实现验证资格核对、移动、回读、交接、
 * 回滚和事件；请求只带源窗口句柄，主进程重核（不信任调用方自报资格）。
 * deps 全假源（workspace-service.spec.ts / agent-tiling-service.spec.ts 同款纪律），
 * 零 FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentDragInService } from '../../src/main/services/agent-drag-in'
import type { AgentDragInServiceOptions } from '../../src/main/services/agent-drag-in'
import type { TileWindowFacts, ScopeRect } from '../../src/main/desktop/tile-scope'

const PRIMARY: ScopeRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
const NORMAL_ID = 'normal-1111'
const AGENT_ID = 'agent-2222'

interface FakeWindow {
  exe?: string
  title?: string
  rect: ScopeRect
  visible?: boolean
  toolWindow?: boolean
  owned?: boolean
  iconic?: boolean
  desktopId?: string | null // null = 假适配器「回读不到」
}

interface Harness {
  svc: AgentDragInService
  windows: Map<number, FakeWindow>
  /** 假适配器账：moveWindowToDesktop 调用序（hwnd + 目标桌面） */
  moves: Array<{ hwnd: number; id: string; accepted: boolean }>
  /** 几何复原调用账（回滚面） */
  geometryRestores: Array<{ hwnd: number; rect: ScopeRect }>
  /** 让指定窗的移动受理但回读不迁移（回读不确认夹具） */
  acceptMoveWithoutMigration: (hwnd: number | null) => void
  /** 让移动恒不受理（移动失败夹具） */
  failMoves(): void
  /** 让回滚移动不受理（回滚失败夹具） */
  failRollback(): void
  /** 让回滚移动先失败 n 次再恢复受理（回滚有界重试夹具，工单408） */
  failRollbackTimes(n: number): void
  /** 拖拽会话假源：起/止钩子（startDragWatch 捕获） */
  dragStart: (hwnd: number) => void
  dragEnd: (hwnd: number, point: { x: number; y: number }, cancelled?: boolean) => void
  /** 用户拖动假动作：把窗拖到新矩形（真实标题栏拖动会实时移窗——面板外事实） */
  userDrag: (hwnd: number, rect: ScopeRect) => void
  /** 存证日志账（options.log 捕获——可诊断终局的观察面） */
  logs: Array<Record<string, unknown>>
  /** workspace/drag-in-feedback 事件账（简短反馈上行面，工单408） */
  feedback: Array<{ hwnd: number; ok: boolean; reason?: string; source: string }>
  /** 光标热区事实（taskbar/cursor-zone 假源——与生产同一 ctx 事件通路） */
  cursorZone: (id: string | null) => void
  /** workspace/drag-in-changed 事件账 */
  changedEvents: Array<{ active: boolean; overAgent: boolean }>
  /** tiling/drag-in-registered 事件账（一次性交接上行序） */
  registered: number[]
}

function factOf(hwnd: number, w: FakeWindow): TileWindowFacts {
  return {
    hwnd,
    pid: 4000 + hwnd,
    exe: w.exe ?? 'C:\\Windows\\System32\\notepad.exe',
    title: w.title ?? `窗 ${hwnd}`,
    visible: w.visible !== false,
    cloaked: false,
    cloakedShell: false,
    toolWindow: w.toolWindow ?? false,
    owned: w.owned ?? false,
    appWindow: false,
    iconic: w.iconic ?? false,
    resizable: true,
    rect: { ...w.rect },
    onCurrentDesktop: true,
  }
}

function harness(over: Partial<AgentDragInServiceOptions> = {}): Harness {
  const windows = new Map<number, FakeWindow>()
  const moves: Harness['moves'] = []
  const geometryRestores: Harness['geometryRestores'] = []
  const changedEvents: Harness['changedEvents'] = []
  const registered: number[] = []
  const feedback: Harness['feedback'] = []
  let failMoveFlag = false
  let rollbackFail = false
  let rollbackFailLeft = 0
  let noMigrateHwnd: number | null = null
  let startCb: ((hwnd: number) => void) | null = null
  let endCb: ((hwnd: number, point: { x: number; y: number }, cancelled: boolean) => void) | null = null
  const logs: Array<Record<string, unknown>> = []

  const ctx = new Context()
  const svc = new AgentDragInService(ctx, {
    enabled: true,
    ...over,
    log: (e) => logs.push(e),
    deps: {
      currentMode: () => 'normal',
      workspaceAvailable: () => true,
      pairingIds: () => ({ normalId: NORMAL_ID, agentId: AGENT_ID }),
      windowDesktopId: (hwnd) => windows.get(hwnd)?.desktopId ?? null,
      moveWindowToDesktop: (hwnd, id) => {
        if (id === NORMAL_ID && rollbackFailLeft > 0) {
          rollbackFailLeft--
          moves.push({ hwnd, id, accepted: false })
          return false
        }
        const accepted = !failMoveFlag && !(rollbackFail && id === NORMAL_ID)
        moves.push({ hwnd, id, accepted })
        if (accepted && !(id === AGENT_ID && noMigrateHwnd === hwnd)) {
          windows.set(hwnd, { ...(windows.get(hwnd) ?? { rect: PRIMARY }), desktopId: id })
        }
        return accepted
      },
      readRect: (hwnd) => ({ ...(windows.get(hwnd)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      restoreRect: (hwnd, rect) => {
        geometryRestores.push({ hwnd, rect: { ...rect } })
        const w = windows.get(hwnd)
        if (w) w.rect = { ...rect }
        return true
      },
      collectFacts: () => [...windows.entries()].map(([hwnd, w]) => factOf(hwnd, w)),
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => ({ ...PRIMARY }),
      startDragWatch: (hooks) => {
        startCb = hooks.onStart
        endCb = hooks.onEnd
        return () => {
          startCb = null
          endCb = null
        }
      },
      moveAttempts: 3,
      moveRetryDelayMs: 0,
      confirmTimeoutMs: 40,
      confirmPollMs: 1,
      ...(over.deps ?? {}),
    },
  })
  ctx.on('workspace/drag-in-changed', (p) => changedEvents.push(p))
  ctx.on('tiling/drag-in-registered', (p) => registered.push(p.hwnd))
  ctx.on('workspace/drag-in-feedback', (p: { hwnd: number; ok: boolean; reason?: string; source: string }) =>
    feedback.push({ ...p }))
  svc.start()
  return {
    svc,
    windows,
    moves,
    geometryRestores,
    logs,
    feedback,
    acceptMoveWithoutMigration: (hwnd) => {
      noMigrateHwnd = hwnd
    },
    failMoves: () => {
      failMoveFlag = true
    },
    failRollback: () => {
      rollbackFail = true
    },
    failRollbackTimes: (n) => {
      rollbackFailLeft = n
    },
    dragStart: (hwnd) => startCb?.(hwnd),
    dragEnd: (hwnd, point, cancelled = false) => endCb?.(hwnd, point, cancelled),
    userDrag: (hwnd, rect) => {
      const w = windows.get(hwnd)
      if (w) w.rect = { ...rect }
    },
    cursorZone: (id) => ctx.emit('taskbar/cursor-zone', { id }),
    changedEvents,
    registered,
  }
}

/** 种一扇主屏合格窗（在配对普通桌面上） */
function seedEligible(h: Harness, hwnd: number, over: Partial<FakeWindow> = {}): void {
  h.windows.set(hwnd, {
    rect: { left: 100, top: 100, right: 520, bottom: 380 },
    desktopId: NORMAL_ID,
    ...over,
  })
}

describe('Agent 拖入服务（工单407）：合格单窗最小事务', () => {
  it('合格单窗：移动到 Agent 桌面 → 桌面 ID 回读确认 → 登记一次性交接并上行事件；不切桌面', async () => {
    const h = harness()
    seedEligible(h, 1001)
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(true)
    expect(h.moves).toEqual([{ hwnd: 1001, id: AGENT_ID, accepted: true }])
    expect(h.svc.handoffForTest()).toEqual([1001])
    expect(h.registered).toEqual([1001])
    // 窗口假适配器账：归属已迁 Agent（回读口径）
    expect(h.windows.get(1001)?.desktopId).toBe(AGENT_ID)
  })

  it('连续两窗：交接按拖入顺序（最新成员序可预测，story 41）', async () => {
    const h = harness()
    seedEligible(h, 1001)
    seedEligible(h, 1002)
    await h.svc.dragIn(1001, 'command')
    await h.svc.dragIn(1002, 'command')
    expect(h.svc.handoffForTest()).toEqual([1001, 1002])
    expect(h.registered).toEqual([1001, 1002])
  })

  it('同窗重复确认不重复登记（交接是集合不是账本——不形成第二份持久成员账）', async () => {
    const h = harness()
    seedEligible(h, 1001)
    await h.svc.dragIn(1001, 'command')
    // 窗口已迁走（desktopId=Agent）：普通桌面重核会按源桌面不符拒绝，不二次登记
    const r2 = await h.svc.dragIn(1001, 'command')
    expect(r2.ok).toBe(false)
    expect(h.svc.handoffForTest()).toEqual([1001])
    expect(h.registered).toEqual([1001])
  })
})

describe('Agent 拖入服务（工单407）：主进程重核资格（不信任请求方自报）', () => {
  it('工作区不可用 → unavailable，零移动', async () => {
    const h = harness({ deps: { workspaceAvailable: () => false } })
    seedEligible(h, 1001)
    const r = await h.svc.dragIn(1001, 'command')
    expect(r).toEqual({ ok: false, reason: 'unavailable' })
    expect(h.moves).toEqual([])
  })

  it('当前 Agent 桌面 → not-normal-desktop；未配对 → unpaired，零移动', async () => {
    const hAgent = harness({ deps: { currentMode: () => 'agent' } })
    seedEligible(hAgent, 1001)
    expect(await hAgent.svc.dragIn(1001, 'command')).toEqual({ ok: false, reason: 'not-normal-desktop' })
    expect(hAgent.moves).toEqual([])

    const hUnpaired = harness({ deps: { pairingIds: () => null } })
    seedEligible(hUnpaired, 1001)
    expect(await hUnpaired.svc.dragIn(1001, 'command')).toEqual({ ok: false, reason: 'unpaired' })
    expect(hUnpaired.moves).toEqual([])
  })

  it('请求句柄不在窗口事实里 → window-unknown，零移动', async () => {
    const h = harness()
    seedEligible(h, 1001)
    const r = await h.svc.dragIn(9999, 'command')
    expect(r).toEqual({ ok: false, reason: 'window-unknown' })
    expect(h.moves).toEqual([])
  })

  it('不合格窗口不迁移：面板自家 exe / 工具窗 / 副屏窗（story 38 资格重核）', async () => {
    const h = harness()
    seedEligible(h, 1001, { exe: 'C:\\apps\\agent-deck\\agentdeck.exe' }) // own-process
    seedEligible(h, 1002, { toolWindow: true })
    seedEligible(h, 1003, { rect: { left: 3000, top: 100, right: 3400, bottom: 400 } }) // 副屏
    for (const hwnd of [1001, 1002, 1003]) {
      const r = await h.svc.dragIn(hwnd, 'command')
      expect(r.ok).toBe(false)
      expect(r.reason).toBe('ineligible-window')
    }
    expect(h.moves).toEqual([])
    expect(h.svc.handoffForTest()).toEqual([])
  })

  it('源桌面不是配对普通桌面 → source-desktop-mismatch，零移动', async () => {
    const h = harness()
    seedEligible(h, 1001, { desktopId: 'third-3333' })
    const r = await h.svc.dragIn(1001, 'command')
    expect(r).toEqual({ ok: false, reason: 'source-desktop-mismatch' })
    expect(h.moves).toEqual([])
  })
})

describe('Agent 拖入服务（工单407）：移动/回读未确认不登记成员（story 47）', () => {
  it('移动恒不受理：有界重试后终局 move-failed + 几何复原 + 零交接', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.failMoves()
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('move-failed')
    expect(h.moves.filter((m) => m.id === AGENT_ID).length).toBe(3) // 有界：恰好 3 次尝试
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
    expect(h.geometryRestores).toEqual([{ hwnd: 1001, rect: { left: 100, top: 100, right: 520, bottom: 380 } }])
  })

  it('移动受理但回读不确认：有界轮询后回滚原桌面 + 复原几何 + 零交接（move-unconfirmed）', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.acceptMoveWithoutMigration(1001)
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('move-unconfirmed')
    // 回滚：原桌面移动恰好一次 + 几何复原一次
    expect(h.moves.filter((m) => m.id === NORMAL_ID)).toEqual([{ hwnd: 1001, id: NORMAL_ID, accepted: true }])
    expect(h.geometryRestores).toEqual([{ hwnd: 1001, rect: { left: 100, top: 100, right: 520, bottom: 380 } }])
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
  })

  it('回滚移动也不受理：如实上报 rollback-failed（不伪造回滚成功），零交接', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.acceptMoveWithoutMigration(1001)
    h.failRollback()
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('rollback-failed')
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
  })
})

describe('Agent 拖入服务（工单407）：拖拽会话投影与落点触发', () => {
  it('拖动起止驱动 workspace/drag-in-changed；悬停 Agent 入口 overAgent 翻转', () => {
    const h = harness()
    seedEligible(h, 1001)
    h.dragStart(1001)
    expect(h.changedEvents).toEqual([{ active: true, overAgent: false }])
    h.cursorZone('mode:agent')
    expect(h.changedEvents).toEqual([
      { active: true, overAgent: false },
      { active: true, overAgent: true },
    ])
    h.cursorZone(null)
    expect(h.changedEvents.at(-1)).toEqual({ active: true, overAgent: false })
    h.dragEnd(1001, { x: 10, y: 10 })
    expect(h.changedEvents.at(-1)).toEqual({ active: false, overAgent: false })
  })

  it('落点在 Agent 入口：拖动结束即触发拖入事务并登记（drop 通路与命令通路同一入口）', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.dragStart(1001)
    h.cursorZone('mode:agent')
    h.dragEnd(1001, { x: 30, y: 30 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([{ hwnd: 1001, id: AGENT_ID, accepted: true }])
    expect(h.svc.handoffForTest()).toEqual([1001])
    expect(h.registered).toEqual([1001])
  })

  it('落点不在 Agent 入口：零移动零登记（普通桌面内的正常拖窗不被面板撤销，story 44）', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.dragStart(1001)
    h.dragEnd(1001, { x: 30, y: 30 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([])
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
  })

  it('落点在入口但不合格：资格重核拒绝，零移动零登记', async () => {
    const h = harness()
    seedEligible(h, 1001, { toolWindow: true })
    h.dragStart(1001)
    h.cursorZone('mode:agent')
    h.dragEnd(1001, { x: 30, y: 30 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([])
    expect(h.registered).toEqual([])
  })
})

// ————————————————————————————————————————————————————————————
// 工单408（spec #403 用户故事 44-48）：取消路径零改窗、不合格落放无副作用、
// 回滚有界与可诊断终局、连续拖入 × 屏外带组合（组合矩阵在 agent-drag-in-flow.spec.ts）。
// ————————————————————————————————————————————————————————————

describe('Agent 拖入服务（工单408）：取消路径只取消迁移（story 44）', () => {
  it('栏外松手（拖走）：零移动零登记零几何复原——用户已完成的拖窗位置原样保留', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.dragStart(1001)
    h.userDrag(1001, { left: 300, top: 600, right: 720, bottom: 880 }) // 用户把窗拖到栏边
    h.cursorZone(null)
    h.dragEnd(1001, { x: 500, y: 1400 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([])
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
    expect(h.geometryRestores).toEqual([]) // 面板零改窗——普通桌面内的拖窗成果不被撤销
    expect(h.windows.get(1001)?.rect).toEqual({ left: 300, top: 600, right: 720, bottom: 880 })
    expect(h.feedback).toEqual([]) // 取消不是失败——零反馈
    expect(h.logs.filter((e) => e.type === 'drag-in-failed')).toEqual([])
  })

  it('Esc 取消（松手时 Esc 按下）：即使光标悬停 Agent 入口也不迁移', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.dragStart(1001)
    h.cursorZone('mode:agent') // Esc 按下时光标仍悬在入口
    h.dragEnd(1001, { x: 30, y: 30 }, true)
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([])
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
    expect(h.geometryRestores).toEqual([]) // Esc 原生复原几何——面板不再插手
    expect(h.feedback).toEqual([])
  })

  it('取消后拖拽前几何账不残留：下一次不合格落放只复原当次拖前矩形', async () => {
    const h = harness()
    seedEligible(h, 1001, { toolWindow: true })
    h.dragStart(1001)
    h.cursorZone(null)
    h.dragEnd(1001, { x: 100, y: 200 }) // 第一次：栏外松手取消
    await new Promise((r) => setTimeout(r, 20))
    h.userDrag(1001, { left: 900, top: 1200, right: 1300, bottom: 1430 }) // 第二次拖动
    h.dragStart(1001) // 拖前矩形 = 第二次的起点
    h.userDrag(1001, { left: 1000, top: 1300, right: 1400, bottom: 1440 })
    h.cursorZone('mode:agent')
    h.dragEnd(1001, { x: 30, y: 30 }) // 不合格落放
    await new Promise((r) => setTimeout(r, 20))
    // 复原的是第二次拖拽的拖前矩形（900,1200），不是上一次会话的残留
    expect(h.geometryRestores).toEqual([{ hwnd: 1001, rect: { left: 900, top: 1200, right: 1300, bottom: 1430 } }])
  })
})

describe('Agent 拖入服务（工单408）：不合格落放无副作用（story 45）', () => {
  it('不合格窗口落放入口：保持原桌面、复原拖拽前几何、给简短反馈', async () => {
    const h = harness()
    seedEligible(h, 1001, { toolWindow: true })
    h.dragStart(1001) // 拖前矩形 A
    const rectA = { ...(h.windows.get(1001)?.rect as ScopeRect) }
    h.userDrag(1001, { left: 400, top: 1250, right: 800, bottom: 1420 }) // 拖动把窗带到落点
    h.cursorZone('mode:agent')
    h.dragEnd(1001, { x: 30, y: 30 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([]) // 原桌面保持——零迁移
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
    // 复原拖拽前几何（不是落点矩形）
    expect(h.geometryRestores).toEqual([{ hwnd: 1001, rect: rectA }])
    expect(h.windows.get(1001)?.rect).toEqual(rectA)
    // 简短反馈：原因枚举上行（不含窗口标题）
    expect(h.feedback).toEqual([{ hwnd: 1001, ok: false, reason: 'ineligible-window', source: 'drop' }])
  })

  it('命令通路不合格：返回原因即可，零复原（无拖拽会话——无拖前几何可复原）', async () => {
    const h = harness()
    seedEligible(h, 1001, { toolWindow: true })
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('ineligible-window')
    expect(h.geometryRestores).toEqual([])
    expect(h.feedback).toEqual([])
  })

  it('源桌面不符不复原几何（窗可能是 Agent 受管成员——几何归平铺/授权账管），反馈仍上行', async () => {
    const h = harness()
    seedEligible(h, 1001, { desktopId: 'third-3333' })
    h.dragStart(1001)
    h.userDrag(1001, { left: 400, top: 1250, right: 800, bottom: 1420 })
    h.cursorZone('mode:agent')
    h.dragEnd(1001, { x: 30, y: 30 })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.moves).toEqual([])
    expect(h.geometryRestores).toEqual([]) // 不插手——避免与平铺 reconciliation 打架
    expect(h.feedback).toEqual([{ hwnd: 1001, ok: false, reason: 'source-desktop-mismatch', source: 'drop' }])
  })
})

describe('Agent 拖入服务（工单408）：回滚有界重试与可诊断终局（story 47）', () => {
  it('回滚移动偶发失败：预算内重试后成功——move-unconfirmed 且几何复原、零交接', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.acceptMoveWithoutMigration(1001)
    h.failRollbackTimes(1)
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('move-unconfirmed')
    const rollbackMoves = h.moves.filter((m) => m.id === NORMAL_ID)
    expect(rollbackMoves.length).toBe(2) // 首次失败 + 重试成功——有界预算内
    expect(h.geometryRestores).toEqual([{ hwnd: 1001, rect: { left: 100, top: 100, right: 520, bottom: 380 } }])
    expect(h.svc.handoffForTest()).toEqual([])
    expect(h.registered).toEqual([])
  })

  it('回滚移动恒失败：有界终局 rollback-failed（恰好 N 次尝试），终局明细可诊断', async () => {
    const h = harness()
    seedEligible(h, 1001)
    h.acceptMoveWithoutMigration(1001)
    h.failRollback()
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('rollback-failed')
    expect(h.moves.filter((m) => m.id === NORMAL_ID).length).toBe(3) // 有界：恰好预算次数
    expect(h.svc.handoffForTest()).toEqual([])
    const term = h.logs.find((e) => e.type === 'drag-in-failed' && e.reason === 'rollback-failed')
    expect(term).toBeDefined()
    expect(term!.rollbackAttempts).toBe(3)
    expect(term!.geometryRestored).toBe(true) // 几何复原仍尽力执行并如实记账
    expect(term!.lastReadback).toBeDefined() // 回读事实随终局留痕（桌面 ID，非窗口标题）
  })

  it('回滚确认成功但几何复原失败：如实上报 geometryRestored=false（不伪造复原成功）', async () => {
    // restoreRect 假源改恒失败
    const h = harness({ deps: { restoreRect: () => false } })
    h.windows.set(1001, {
      rect: { left: 100, top: 100, right: 520, bottom: 380 },
      desktopId: NORMAL_ID,
    })
    h.acceptMoveWithoutMigration(1001)
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('move-unconfirmed')
    expect(r.detail).toContain('geometry-restored=false')
    const term = h.logs.find((e) => e.type === 'drag-in-failed')
    expect(term!.geometryRestored).toBe(false)
  })

  it('move-failed 终局：几何复原失败也如实记账（有界重试恰好 N 次）', async () => {
    const h = harness({ deps: { restoreRect: () => false } })
    h.windows.set(1001, { rect: { left: 100, top: 100, right: 520, bottom: 380 }, desktopId: NORMAL_ID })
    h.failMoves()
    const r = await h.svc.dragIn(1001, 'command')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('move-failed')
    expect(h.moves.filter((m) => m.id === AGENT_ID).length).toBe(3)
    const term = h.logs.find((e) => e.type === 'drag-in-failed' && e.reason === 'move-failed')
    expect(term!.geometryRestored).toBe(false)
  })
})
