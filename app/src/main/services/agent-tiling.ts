// Agent 平铺编排服务（工单376，spec #369 决策 7/8/27）：单工作区串行落位——窗口事件
// 驱动（LOCATIONCHANGE hook）+ 短批处理（debounce 合并风暴）+ 单飞在途（重排期间新
// 事件只记一拍待办，不递归改窗）。普通桌面 / 非托管桌面零自动改窗（用户故事 77，
// ADR-0016 硬边界）：本服务只在 workspace current === 'agent' 时激活观察与落位。
//
// 分层：纯裁决在 desktop/tiling-plan.ts（布局）、desktop/tile-scope.ts（范围投影）、
// desktop/geom-control.ts（回声账/失败账/写集）；FFI 动作在 desktop/geom-write.ts
// （t372 实证路径）。本服务只编排：事实采集 → 投影 → 规划 → 批量落位 → 核验记账 →
// 计数回推。离线测试经 deps 注入假源（DesktopWorkspaceService 同款纪律），零 FFI。
//
// 实验开关（spec 决策 29）：config agentDesktop.enabled = false（缺省）时本服务
// available=false——零观察、零落位、投影恒空态。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { AgentTilingState, DesktopMode } from '../../shared/contract'
import { planTiling, tileAreaOf } from '../desktop/tiling-plan'
import type { TileRect } from '../desktop/tiling-plan'
import { projectTileScope } from '../desktop/tile-scope'
import type { TileWindowFacts, ScopeRect } from '../desktop/tile-scope'
import {
  classifyGeomEvent,
  planWrites,
  pruneLedger,
  recordPending,
  retractPending,
  verifyWriteOutcome,
} from '../desktop/geom-control'
import type { AttemptLedger, AnomalySet, EchoLedger } from '../desktop/geom-control'

export interface AgentTilingServiceOptions {
  /** 实验开关（config agentDesktop.enabled 下发；缺省 = 关——零观察零落位） */
  enabled?: boolean
  /** 事件批处理窗口（ms）：LOCATIONCHANGE 风暴合并（缺省 80ms——500ms 稳定预算的主项） */
  batchMs?: number
  /** 依赖缝：真源缺省延迟绑定 desktop/tile-scope 采集链（离线测试注入假源后零 FFI） */
  deps?: {
    /** 当前模式（缺省读 desktopWorkspace 服务投影——缺装配 = unmanaged 恒不激活） */
    currentMode?: () => DesktopMode
    /** 面板自家 exe 集（合格窗口排除；缺省延迟绑定本进程 executablePath） */
    ownExes?: () => string[]
    /** 主屏物理矩形（缺省延迟绑定 electron screen 主屏） */
    primaryRect?: () => ScopeRect
    /** 任务栏条带顶（物理 y；null = 无栏可避。缺省延迟绑定 taskbar 条带几何） */
    taskbarTop?: () => number | null
    /** 窗口事实采集（缺省延迟绑定 win-facts 接缝 + VDM 公开桥 + geom-write 读矩形） */
    collectFacts?: () => TileWindowFacts[]
    /** 读窗矩形（核验与外部事件归类用；缺省延迟绑定 geom-write.readWindowRect） */
    readRect?: (hwnd: number) => ScopeRect
    /** 写窗（缺省延迟绑定 geom-write.writeWindowRect） */
    writeRect?: (hwnd: number, target: TileRect) => boolean
    /** 起 LOCATIONCHANGE 观察（缺省延迟绑定 geom-write.startLocationChangeWatch） */
    startWatch?: (onEvent: (hwnd: number) => void) => () => void
  }
}

interface TilingDeps {
  currentMode: () => DesktopMode
  ownExes: () => string[]
  primaryRect: () => ScopeRect
  taskbarTop: () => number | null
  collectFacts: () => TileWindowFacts[]
  readRect: (hwnd: number) => ScopeRect
  writeRect: (hwnd: number, target: TileRect) => boolean
  startWatch: (onEvent: (hwnd: number) => void) => () => void
}

const DEFAULT_BATCH_MS = 80

/**
 * Agent 平铺编排（工单376）：事件流上单工作区串行。激活（current==='agent'）时起
 * LOCATIONCHANGE 观察；事件经回声账归类——echo 消费即止，external 批合并后走一轮
 * 重排（投影 → 规划 → 写集落位 → 核验记账）。写前登记期望矩形（回声抑制），写后
 * 回读核验：达标清账、未达标计次、达上限异常化（不无限重试、不阻塞其他窗）。
 * 失活（切普通/非托管）即停观察停落位——普通桌面零自动改窗。
 */
export class AgentTilingService extends Service {
  static inject: Inject = {} // 依赖经 deps 缝注入（workspace 状态读取走注入口，避免硬依赖可选服务）

  private readonly enabledFlag: boolean
  private readonly batchMs: number
  private readonly deps: TilingDeps
  private echoLedger: EchoLedger = new Map()
  private attempts: AttemptLedger = new Map()
  private anomalies: AnomalySet = new Set()
  private stopWatch: (() => void) | null = null
  private batchTimer: NodeJS.Timeout | null = null
  private placing = false
  private pendingPass = false
  private lastState: AgentTilingState | null = null
  private started = false

  constructor(ctx: Context, options: AgentTilingServiceOptions = {}) {
    super(ctx, 'agentTiling')
    this.enabledFlag = options.enabled ?? false
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS
    this.deps = {
      currentMode: options.deps?.currentMode ?? (() => 'unmanaged'),
      ownExes: options.deps?.ownExes ?? (() => []),
      primaryRect: options.deps?.primaryRect ?? (() => ({ left: 0, top: 0, right: 0, bottom: 0 })),
      taskbarTop: options.deps?.taskbarTop ?? (() => null),
      collectFacts:
        options.deps?.collectFacts ??
        (() => (require('../desktop/tile-scan') as typeof import('../desktop/tile-scan')).collectTileFacts()),
      readRect: options.deps?.readRect
        ?? ((hwnd) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).readWindowRect(hwnd)),
      writeRect: options.deps?.writeRect
        ?? ((hwnd, target) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).writeWindowRect(hwnd, target)),
      startWatch: options.deps?.startWatch
        ?? ((onEvent) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).startLocationChangeWatch(onEvent)),
    }
  }

  /** 启动（构造后由装配层调用一次）：订阅 workspace/changed，按当前模式对齐激活态 */
  start(): void {
    if (this.started) return
    this.started = true
    this.ctx.on('workspace/changed', () => this.syncActivation())
    this.syncActivation()
  }

  /** 可用 = 实验开关开（平台能力在 deps 真源侧失败关闭——collectFacts 抛错按本拍不可用） */
  private available(): boolean {
    return this.enabledFlag
  }

  /** 只读投影（桥 tiling/get-state 与回推共用）：计数口径 = 主屏全部合格窗口 */
  state(): AgentTilingState {
    const current = this.deps.currentMode()
    return {
      available: this.available(),
      current,
      count: this.lastState?.count ?? 0,
      placed: this.lastState?.placed ?? 0,
      overflow: this.lastState?.overflow ?? 0,
      anomalies: this.lastState?.anomalies ?? 0,
    }
  }

  /** 激活态对齐（workspace/changed 与启动路径共用）：agent 激活，其余失活 */
  syncActivation(): void {
    const active = this.available() && this.deps.currentMode() === 'agent'
    if (active) {
      if (!this.stopWatch) {
        this.stopWatch = this.deps.startWatch((hwnd) => this.onLocationChange(hwnd))
        void this.runPass() // 激活即对齐一轮（切回 Agent 桌面的既有窗口立刻落位）
      }
    } else {
      this.deactivate()
    }
  }

  /** 失活（幂等）：停观察、清在途——普通/非托管桌面零自动改窗 */
  deactivate(): void {
    if (this.stopWatch) {
      this.stopWatch()
      this.stopWatch = null
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.echoLedger.clear()
    this.placing = false
    this.pendingPass = false
    this.pushState({ count: 0, placed: 0, overflow: 0, anomalies: 0 })
  }

  /** 停表（插件卸载/测试收尾）：失活并清账 */
  protected stop(): void {
    this.deactivate()
    this.attempts.clear()
    this.anomalies.clear()
    this.lastState = null
  }

  /** LOCATIONCHANGE 事件入口（FFI 回调侧只递 hwnd——轻活纪律，归类在 tick） */
  onLocationChange(hwnd: number): void {
    if (!this.available() || !this.stopWatch) return
    // 归类用当拍矩形在 pass 内读（回调里零 FFI）；此处只起批合并定时器
    this.schedulePass(hwnd)
  }

  /** 短批处理（决策 27）：事件风暴合并为一轮重排 */
  private schedulePass(_hwnd: number): void {
    if (this.batchTimer) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      void this.runPass()
    }, this.batchMs)
  }

  /** 测试驱动口：绕过批合并直接触发一轮（离线矩阵对齐时序） */
  async runPass(): Promise<void> {
    if (!this.available() || this.deps.currentMode() !== 'agent') return
    if (this.placing) {
      this.pendingPass = true // 单飞在途：只记一拍待办（决策 27 串行落位）
      return
    }
    this.placing = true
    try {
      do {
        this.pendingPass = false
        this.onePass()
      } while (this.pendingPass)
    } finally {
      this.placing = false
    }
  }

  /** 一轮：采集 → 投影 → 规划 → 写集 → 落位核验 → 计数回推（异常不抛——改窗失败面不拖垮面板） */
  private onePass(): void {
    const now = Date.now()
    let facts: TileWindowFacts[]
    try {
      facts = this.deps.collectFacts()
    } catch {
      return // 本拍事实不可读：沿用上一拍（不猜）
    }
    const primary = this.deps.primaryRect()
    const { members } = projectTileScope(facts, this.deps.ownExes(), primary)
    const area: TileRect = tileAreaOf(primary, this.deps.taskbarTop())
    const plan = planTiling(members.map((m) => String(m.hwnd)), area)
    const rectByHwnd = new Map(members.map((m) => [Number(m.hwnd), m.rect] as const))
    const iconicByHwnd = new Map(members.map((m) => [Number(m.hwnd), m.iconic] as const))

    // 写集：规划目标 × 当前矩形比对（异常窗跳过、最小化跳过、已达标不重写）
    const assignments = plan.placements.map((p) => {
      const hwnd = Number(p.id)
      return { hwnd, target: p.rect, iconic: iconicByHwnd.get(hwnd) ?? false, current: rectByHwnd.get(hwnd) ?? null }
    })
    const writes = planWrites(assignments, this.anomalies)

    // 批量落位：登记期望矩形（回声抑制）→ 写 → 失败即撤账（失败写不吞后续外部事件）
    const outcomes: Array<{ hwnd: number; target: TileRect; ok: boolean }> = []
    for (const w of writes) {
      recordPending(this.echoLedger, w.hwnd, w.target, now)
      const ok = this.deps.writeRect(w.hwnd, w.target)
      if (!ok) retractPending(this.echoLedger, w.hwnd)
      outcomes.push({ hwnd: w.hwnd, target: w.target, ok })
    }

    // 失败 reconciliation（写后核验，spec 决策 12 有限诊断）：落位窗回读——达标清账 /
    // 未达标计次 / 达上限异常化（跳过后续落格、不阻塞其他窗、不无限重试）
    for (const w of outcomes) {
      const actual = this.deps.readRect(w.hwnd)
      const verdict = verifyWriteOutcome(this.attempts, this.anomalies, w.hwnd, actual, w.target)
      if (verdict === 'ok') retractPending(this.echoLedger, w.hwnd) // 达标：期望矩形已落地，回声账清零
    }
    pruneLedger(this.echoLedger, Date.now())

    // 计数回推（用户故事 44）：主屏全部合格窗口（含最小化），变化才推
    this.pushState({
      count: members.length,
      placed: plan.placements.length,
      overflow: plan.overflow.length,
      anomalies: this.anomalies.size,
    })
  }

  private pushState(part: { count: number; placed: number; overflow: number; anomalies: number }): void {
    const current = this.deps.currentMode()
    const next: AgentTilingState = {
      available: this.available(),
      current,
      count: part.count,
      placed: part.placed,
      overflow: part.overflow,
      anomalies: part.anomalies,
    }
    const prev = this.lastState
    if (
      prev &&
      prev.count === next.count &&
      prev.placed === next.placed &&
      prev.overflow === next.overflow &&
      prev.anomalies === next.anomalies &&
      prev.available === next.available &&
      prev.current === next.current
    ) {
      return
    }
    this.lastState = next
    this.ctx.emit('tiling/changed', next)
  }

  /** 测试观察缝：回声账快照（离线矩阵断言回声抑制行为） */
  echoLedgerForTest(): EchoLedger {
    return new Map(this.echoLedger)
  }

  /** 测试观察缝：异常集快照（失败 reconciliation 断言） */
  anomaliesForTest(): number[] {
    return [...this.anomalies]
  }

  /** 测试驱动口：外部事件归类（喂矩形断言 echo/external，不触 FFI） */
  classifyForTest(hwnd: number, rect: ScopeRect, now: number): 'echo' | 'external' {
    return classifyGeomEvent(this.echoLedger, hwnd, rect, now)
  }
}
