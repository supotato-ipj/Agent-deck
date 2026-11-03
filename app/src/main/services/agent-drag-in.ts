// Agent 拖入编排服务（工单407，spec #403 决策「新增一个内部工作区拖入命令」「拖入是
// 一次事务」）：普通桌面主屏合格窗口经标题栏拖到 Agent 入口完成迁移的最小事务。
//
// 主进程公开工作区命令（bridge 'workspace/drag-in'）是最高测试缝：请求只携带源窗口
// 句柄，主进程重核（不信任调用方自报资格）——工作区可用 → 配对 → 配对 ID 双侧 → 当前
// 普通桌面 → 窗口事实在场 → 窗口资格（tile-scope 单一口径）→ 源桌面 = 配对普通桌面。
// 迁移以桌面 ID 回读确认（公开 VDM GetWindowDesktopId，story 46）；确认后才登记一次性
// 待入列交接（'tiling/drag-in-registered'，Agent 平铺下次激活时按交接顺序对账并清除，
// 不形成第二份持久成员账）；移动/回读未确认 → 有界重试后回滚原桌面与原几何，零登记。
// 落放不切桌面（本服务没有切换桌面的通道——结构性边界）。
//
// 拖拽会话投影（spec 决策「拖拽期间协调会话预览」）：MOVESIZE 观察期间推
// 'workspace/drag-in-changed' { active, overAgent }——任务栏渲染层据此显示落点高亮、
// 会话预览据此暂停；overAgent 光标事实与任务栏热区跟踪器同源（'taskbar/cursor-zone'）。
//
// 分层：纯裁决在 desktop/drag-in-plan.ts（门禁/确认/回滚判据）、desktop/title-drag.ts
// （MOVESIZE FFI 观察）；窗口资格在 desktop/tile-scope.ts；本服务只编排——离线测试经
// deps 注入假源（DesktopWorkspaceService 同款纪律），零 FFI/Electron。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { DesktopMode } from '../../shared/contract'
import {
  DRAG_IN_CONFIRM_POLL_MS,
  DRAG_IN_CONFIRM_TIMEOUT_MS,
  DRAG_IN_MOVE_ATTEMPTS,
  DRAG_IN_MOVE_RETRY_DELAY_MS,
  decideDragInGate,
  migrationConfirmed,
  rollbackConfirmed,
} from '../desktop/drag-in-plan'
import type { DragInRejectReason } from '../desktop/drag-in-plan'
import { startTitleDragWatch } from '../desktop/title-drag'
import type { ScreenPoint } from '../desktop/title-drag'
import type { TileWindowFacts, ScopeRect } from '../desktop/tile-scope'
import { classifyTileWindow } from '../desktop/tile-scope'

export type DragInSource = 'drop' | 'command'

export interface DragInResult {
  ok: boolean
  reason?: DragInRejectReason
  /** 人工可读明细（不含窗口标题——隐私边界同 spec 决策 50） */
  detail?: string
}

export interface AgentDragInServiceOptions {
  /** 功能开关（config agentDesktop.enabled 下发；生产装配必下发，缺省 = 关——零观察） */
  enabled?: boolean
  /** 存证日志（只记 hwnd/阶段/桌面 ID——不含窗口标题或拖入内容） */
  log?: (event: Record<string, unknown>) => void
  /** 依赖缝：真源缺省延迟绑定（离线测试注入假源后零 FFI） */
  deps?: {
    /** 当前模式（缺省延迟绑定 desktop-workspace 投影——缺装配 = unmanaged 恒拒绝） */
    currentMode?: () => DesktopMode
    /** 工作区可用（缺省延迟绑定 desktop-workspace available） */
    workspaceAvailable?: () => boolean
    /** 配对身份（缺省延迟绑定 desktop-workspace.pairingIds；null = 未配对） */
    pairingIds?: () => { normalId: string; agentId: string } | null
    /** 窗口所属桌面系统 ID（缺省延迟绑定公开 GetWindowDesktopId——迁移确认的回读真源） */
    windowDesktopId?: (hwnd: number) => string | null
    /** 窗口迁移（缺省延迟绑定公开 MoveWindowToDesktop；返回 = 系统受理与否） */
    moveWindowToDesktop?: (hwnd: number, id: string) => boolean
    /** 读窗矩形（回滚前的原几何保存；缺省延迟绑定 geom-write.readWindowRect） */
    readRect?: (hwnd: number) => ScopeRect
    /** 复原窗几何（回滚通道；缺省延迟绑定 geom-write.restoreWindowRect） */
    restoreRect?: (hwnd: number, rect: ScopeRect) => boolean
    /** 窗口事实采集（资格核对用；缺省延迟绑定 tile-scan 采集链） */
    collectFacts?: () => TileWindowFacts[]
    /** 面板自家 exe 集（合格窗口排除；缺省延迟绑定本进程 executablePath） */
    ownExes?: () => string[]
    /** 主屏物理矩形（缺省延迟绑定 electron screen 主屏） */
    primaryRect?: () => ScopeRect
    /** 起标题栏拖动观察（缺省延迟绑定 desktop/title-drag；返回停表函数） */
    startDragWatch?: (hooks: {
      onStart: (hwnd: number) => void
      onEnd: (hwnd: number, point: ScreenPoint | null) => void
    }) => () => void
    /** 移动尝试上限（缺省 drag-in-plan 常量；离线矩阵可收紧） */
    moveAttempts?: number
    /** 移动重试间隔 ms（缺省常量；离线测试可置 0） */
    moveRetryDelayMs?: number
    /** 迁移确认预算 ms（缺省常量；离线测试可收紧） */
    confirmTimeoutMs?: number
    /** 确认轮询步进 ms（缺省常量；离线测试可置 1） */
    confirmPollMs?: number
  }
}

interface DragInDeps {
  currentMode: () => DesktopMode
  workspaceAvailable: () => boolean
  pairingIds: () => { normalId: string; agentId: string } | null
  windowDesktopId: (hwnd: number) => string | null
  moveWindowToDesktop: (hwnd: number, id: string) => boolean
  readRect: (hwnd: number) => ScopeRect
  restoreRect: (hwnd: number, rect: ScopeRect) => boolean
  collectFacts: () => TileWindowFacts[]
  ownExes: () => string[]
  primaryRect: () => ScopeRect
  startDragWatch: (hooks: {
    onStart: (hwnd: number) => void
    onEnd: (hwnd: number, point: ScreenPoint | null) => void
  }) => () => void
  moveAttempts: number
  moveRetryDelayMs: number
  confirmTimeoutMs: number
  confirmPollMs: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Agent 拖入编排（工单407）：拖拽会话状态投影 + 一次性迁移事务。拖动起止即推
 * 'workspace/drag-in-changed'；落点悬停 Agent 入口（与热区跟踪器同一光标事实）且
 * 松手 → 触发与 bridge 命令同一入口 dragIn(hwnd, 'drop')。
 */
export class AgentDragInService extends Service {
  static inject: Inject = {}

  private readonly enabledFlag: boolean
  private readonly deps: DragInDeps
  private readonly logEvent: (event: Record<string, unknown>) => void
  private stopDrag: (() => void) | null = null
  private started = false
  /** 拖拽会话状态（投影面：active = MOVESIZE 会话在场；overAgent = 光标悬停 Agent 入口） */
  private dragActive = false
  private overAgent = false
  /** 最近一次光标热区事实（'taskbar/cursor-zone'——与任务栏热区跟踪器同源） */
  private lastZoneId: string | null = null
  /** 一次性待入列交接（确认序；Agent 平铺经 'tiling/drag-in-registered' 事件消费，
   *  本账只是上行序的暂存面——不参与任何布局计算） */
  private handoff: number[] = []
  /** 同一拖入事务单飞（drop 与命令并发时的重入保护） */
  private inFlight = false

  constructor(ctx: Context, options: AgentDragInServiceOptions = {}) {
    super(ctx, 'agentDragIn')
    this.enabledFlag = options.enabled ?? false
    this.logEvent = options.log ?? (() => undefined)
    const d = options.deps ?? {}
    this.deps = {
      currentMode: d.currentMode
        ?? (() => 'unmanaged'),
      workspaceAvailable: d.workspaceAvailable ?? (() => false),
      pairingIds: d.pairingIds ?? (() => null),
      windowDesktopId: d.windowDesktopId
        ?? ((hwnd) => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).windowDesktopId(hwnd)),
      moveWindowToDesktop: d.moveWindowToDesktop
        // 拖入迁移 = 跨进程移动（公开 MoveWindowToDesktop 对他进程窗 E_ACCESSDENIED，
        // t407-move-window 探针实证）——内部 GetViewForHwnd + MoveViewToDesktop 真源
        ?? ((hwnd, id) => (require('../desktop/virtual-desktop') as typeof import('../desktop/virtual-desktop')).moveWindowToDesktopInternal(hwnd, id)),
      readRect: d.readRect
        ?? ((hwnd) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).readWindowRect(hwnd)),
      restoreRect: d.restoreRect
        ?? ((hwnd, rect) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).restoreWindowRect(hwnd, rect)),
      collectFacts: d.collectFacts
        ?? (() => (require('../desktop/tile-scan') as typeof import('../desktop/tile-scan')).collectTileFacts()),
      ownExes: d.ownExes ?? (() => [process.execPath]),
      primaryRect: d.primaryRect ?? (() => ({ left: 0, top: 0, right: 0, bottom: 0 })),
      startDragWatch: d.startDragWatch ?? ((hooks) => startTitleDragWatch(hooks)),
      moveAttempts: d.moveAttempts ?? DRAG_IN_MOVE_ATTEMPTS,
      moveRetryDelayMs: d.moveRetryDelayMs ?? DRAG_IN_MOVE_RETRY_DELAY_MS,
      confirmTimeoutMs: d.confirmTimeoutMs ?? DRAG_IN_CONFIRM_TIMEOUT_MS,
      confirmPollMs: d.confirmPollMs ?? DRAG_IN_CONFIRM_POLL_MS,
    }
    ctx.on('dispose', () => this.dispose())
  }

  /** 启动：订阅光标热区事实 + 起 MOVESIZE 观察（开关关 = 零观察零订阅） */
  start(): void {
    if (this.started) return
    this.started = true
    if (!this.enabledFlag) return
    this.ctx.on('taskbar/cursor-zone', (p: { id: string | null }) => this.onCursorZone(p?.id ?? null))
    this.stopDrag = this.deps.startDragWatch({
      onStart: (hwnd) => this.onDragStart(hwnd),
      onEnd: (hwnd, point) => this.onDragEnd(hwnd, point),
    })
  }

  /** 拖拽会话投影（渲染层高亮与会话预览暂停订阅同一份） */
  state(): { active: boolean; overAgent: boolean } {
    return { active: this.dragActive, overAgent: this.overAgent }
  }

  /** 一次性待入列交接快照（测试观察缝；生产消费走 tiling/drag-in-registered 事件） */
  handoffForTest(): number[] {
    return [...this.handoff]
  }

  /** 拖拽会话观察（观察面零裁决：只记起止与光标事实，判定全部在事务入口） */
  private onDragStart(hwnd: number): void {
    if (!this.enabledFlag) return
    this.dragActive = true
    this.overAgent = this.lastZoneId === 'mode:agent'
    this.logEvent({ type: 'drag-in-session', phase: 'start', hwnd, overAgent: this.overAgent })
    this.emitChanged()
  }

  private onDragEnd(hwnd: number, point: ScreenPoint | null): void {
    if (!this.enabledFlag || !this.dragActive) return
    const dropOnAgent = this.lastZoneId === 'mode:agent'
    this.dragActive = false
    this.overAgent = false
    this.logEvent({ type: 'drag-in-session', phase: 'end', hwnd, dropOnAgent, point: point ?? null })
    this.emitChanged()
    if (dropOnAgent) void this.dragIn(hwnd, 'drop')
  }

  /** 光标热区事实（任务栏热区跟踪器 25ms hit-test 的结论——拖拽期落点高亮的唯一来源） */
  private onCursorZone(id: string | null): void {
    if (!this.enabledFlag) return
    this.lastZoneId = id
    if (!this.dragActive) return
    const over = id === 'mode:agent'
    if (over !== this.overAgent) {
      this.overAgent = over
      this.emitChanged()
    }
  }

  private emitChanged(): void {
    this.ctx.emit('workspace/drag-in-changed', { active: this.dragActive, overAgent: this.overAgent })
  }

  /**
   * 拖入事务（bridge 'workspace/drag-in' 与落点触发共同入口）：门禁重核 → 资格重核 →
   * 源桌面重核 → 原几何保存 → 有界移动 → 桌面 ID 回读确认 → 交接登记；任何未确认路径
   * 回滚原桌面与原几何、零登记（不伪造成功）。失败返回 { ok:false, reason }（story 45
   * 简短原因）。落放不切桌面——本方法没有任何桌面切换通道。
   */
  async dragIn(hwnd: number, source: DragInSource = 'command'): Promise<DragInResult> {
    if (!this.enabledFlag) return { ok: false, reason: 'unavailable' }
    if (this.inFlight) return { ok: false, reason: 'move-failed', detail: '拖入事务在途' }
    this.inFlight = true
    try {
      const pairing = this.deps.pairingIds()
      const gate = decideDragInGate({
        workspaceAvailable: this.deps.workspaceAvailable(),
        paired: Boolean(pairing?.normalId && pairing?.agentId),
        currentMode: this.deps.currentMode(),
        agentId: pairing?.agentId ?? null,
        normalId: pairing?.normalId ?? null,
      })
      if (gate.action === 'reject') {
        this.logEvent({ type: 'drag-in-rejected', hwnd, source, reason: gate.reason })
        return { ok: false, reason: gate.reason }
      }
      const agentId = pairing!.agentId
      const normalId = pairing!.normalId

      // 窗口事实在场 + 资格重核（tile-scope 单一口径——主屏/自家/工具窗/副屏/身份）
      let fact: TileWindowFacts | undefined
      try {
        fact = this.deps.collectFacts().find((f) => f.hwnd === hwnd)
      } catch (err) {
        this.logEvent({ type: 'drag-in-rejected', hwnd, source, reason: 'window-unknown', message: err instanceof Error ? err.message : String(err) })
        return { ok: false, reason: 'window-unknown' }
      }
      if (!fact) {
        this.logEvent({ type: 'drag-in-rejected', hwnd, source, reason: 'window-unknown' })
        return { ok: false, reason: 'window-unknown' }
      }
      const verdict = classifyTileWindow(fact, this.deps.ownExes(), this.deps.primaryRect())
      if (verdict.kind !== 'tile') {
        this.logEvent({ type: 'drag-in-rejected', hwnd, source, reason: 'ineligible-window', detail: verdict.reason })
        return { ok: false, reason: 'ineligible-window', detail: verdict.reason }
      }

      // 源桌面重核：窗口必须就在配对普通桌面（story 38「只有主屏合格窗口可以拖入」
      // 的桌面维度；回读不到按不符处理——不猜）
      const sourceDesktop = this.deps.windowDesktopId(hwnd)
      if (!sourceDesktop || sourceDesktop !== normalId) {
        this.logEvent({ type: 'drag-in-rejected', hwnd, source, reason: 'source-desktop-mismatch', sourceDesktop })
        return { ok: false, reason: 'source-desktop-mismatch' }
      }

      // 事务起点：保存原几何（回滚面；原桌面 = normalId 已由源桌面重核确认）
      const originalRect = this.deps.readRect(hwnd)

      // 有界移动尝试
      let moveAccepted = false
      for (let attempt = 1; attempt <= this.deps.moveAttempts; attempt++) {
        if (this.deps.moveWindowToDesktop(hwnd, agentId)) {
          moveAccepted = true
          break
        }
        if (attempt < this.deps.moveAttempts) await sleep(this.deps.moveRetryDelayMs)
      }
      if (!moveAccepted) {
        this.logEvent({ type: 'drag-in-failed', hwnd, source, reason: 'move-failed', attempts: this.deps.moveAttempts })
        // 移动从未受理：窗口仍在原桌面，但按事务纪律复原几何（story 45 无副作用边界）
        this.deps.restoreRect(hwnd, originalRect)
        return { ok: false, reason: 'move-failed' }
      }

      // 桌面 ID 回读确认（有界轮询；确认只认系统事实，story 46）
      const confirmed = await this.confirmDesktopId(hwnd, agentId)
      if (!confirmed) {
        // 未确认：回滚原桌面 + 复原原几何（有界单步；回滚结果如实上报，不伪造成功）
        const rolledBack = this.deps.moveWindowToDesktop(hwnd, normalId)
        this.deps.restoreRect(hwnd, originalRect)
        const rollbackVerified = rolledBack && rollbackConfirmed(this.deps.windowDesktopId(hwnd), normalId)
        this.logEvent({
          type: 'drag-in-failed', hwnd, source, reason: 'move-unconfirmed',
          rolledBack: rollbackVerified,
        })
        return { ok: false, reason: rolledBack && rollbackVerified ? 'move-unconfirmed' : 'rollback-failed' }
      }

      // 确认：登记一次性待入列交接（一次性上行——Agent 平铺按事件对账并清除）
      if (!this.handoff.includes(hwnd)) this.handoff.push(hwnd)
      this.logEvent({ type: 'drag-in-registered', hwnd, source, desktopId: agentId })
      this.ctx.emit('tiling/drag-in-registered', { hwnd })
      return { ok: true }
    } finally {
      this.inFlight = false
    }
  }

  /** 确认轮询：公开 VDM 回读 = 目标桌面 ID（预算内步进轮询；预算耗尽 = 未确认） */
  private async confirmDesktopId(hwnd: number, targetId: string): Promise<boolean> {
    const deadline = Date.now() + this.deps.confirmTimeoutMs
    for (;;) {
      const id = this.deps.windowDesktopId(hwnd)
      if (migrationConfirmed(id, targetId)) return true
      if (Date.now() > deadline) return false
      await sleep(this.deps.confirmPollMs)
    }
  }

  dispose(): void {
    if (this.stopDrag) {
      this.stopDrag()
      this.stopDrag = null
    }
    this.dragActive = false
    this.overAgent = false
    this.handoff = []
  }
}
