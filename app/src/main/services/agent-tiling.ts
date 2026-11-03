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
import { MIN_PANE_H, MIN_PANE_W, createTree, isTileableArea, tileAreaOf, treeInsert, treePlacedIds, treePlan, treeRemove } from '../desktop/tiling-plan'
import type { TilingTree, TileRect } from '../desktop/tiling-plan'
import { projectTileScope } from '../desktop/tile-scope'
import type { TileWindowFacts, ScopeRect } from '../desktop/tile-scope'
import {
  anomalyDetailOf,
  classifyGeomEvent,
  clearAnomaly,
  markAnomaly,
  planWrites,
  pruneLedger,
  recordPending,
  retractPending,
  verifyWriteOutcome,
} from '../desktop/geom-control'
import type { AnomalyKind, AnomalyKindLedger, AttemptLedger, AnomalySet, EchoLedger } from '../desktop/geom-control'

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
    /** 显示参数变化订阅（分辨率/DPI/主屏增删——缺省无源 noop；Electron 装配接 screen 事件） */
    onDisplayChanged?: (cb: () => void) => () => void
    /** 最小窗格（物理 px；spec 决策 12「约 320×240 逻辑像素」——装配层按主屏 DPI
     *  换算，缺省 320×240 即 100% 缩放等值） */
    minPane?: () => { w: number; h: number }
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
  onDisplayChanged: (cb: () => void) => () => void
  minPane: () => { w: number; h: number }
}

const DEFAULT_BATCH_MS = 80

/** 矩形逐字节等值（平铺区变化检测——显示参数变化重建判据，非核验容差判） */
function rectEq(a: TileRect, b: TileRect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
}

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
  /** 异常分类账（工单377）：与 anomalies 同进出——异常化的窗必有类别（GLOSSARY「异常未平铺」） */
  private anomalyKinds: AnomalyKindLedger = new Map()
  private stopWatch: (() => void) | null = null
  /** 显示参数变化订阅停表（分辨率/DPI/主屏增删 → 重算平铺——用户故事 23） */
  private stopDisplay: (() => void) | null = null
  /** 显示参数变化脏标（下一拍按「重算语义」重新纳回屏外旧成员——story 23；
   *  只在变化拍生效：普通「用户把窗拖去副屏」仍按移出主屏处理，story 21） */
  private displayDirty = false
  private batchTimer: NodeJS.Timeout | null = null
  private placing = false
  private pendingPass = false
  private lastState: AgentTilingState | null = null
  private started = false
  /** 成员加入序（hwnd，先到在前）：布局只由加入事件序列决定（spec 决策 7「有序窗口
   *  成员」+ 用户故事 18/31——确定性不随 z 序/焦点漂移）；新成员按首见序追加队尾
   *  （story 21「移回主屏按最新窗口加入」），消失成员移除、兄弟吸收空位。显示参数
   *  变化重建平铺树时以本序重算（确定性函数）。 */
  private memberOrder: number[] = []
  /** 持久平铺树（工单377，GLOSSARY「Agent 平铺」）：布局账本——增量裂变/兄弟吸收；
   *  显示参数变化（平铺区变）时按成员序整体重建（重算语义，story 23）。 */
  private tree: TilingTree | null = null

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
      onDisplayChanged: options.deps?.onDisplayChanged ?? (() => () => undefined), // 无源 noop（内核装配无 screen）
      minPane: options.deps?.minPane ?? (() => ({ w: MIN_PANE_W, h: MIN_PANE_H })), // 100% 缩放等值
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
      anomalyDetail: this.lastState?.anomalyDetail ?? { fixedSize: 0, denied: 0, refused: 0 },
    }
  }

  /** 激活态对齐（workspace/changed 与启动路径共用）：agent 激活，其余失活 */
  syncActivation(): void {
    const active = this.available() && this.deps.currentMode() === 'agent'
    if (active) {
      if (!this.stopWatch) {
        this.stopWatch = this.deps.startWatch((hwnd) => this.onLocationChange(hwnd))
        // 显示参数变化（分辨率/DPI/主屏增删）→ 重算平铺（用户故事 23）：事件只触发
        // 一拍批合并——事实与矩形都在 pass 内现读，订阅本身零 FFI
        this.stopDisplay = this.deps.onDisplayChanged(() => this.onDisplayChanged())
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
    if (this.stopDisplay) {
      this.stopDisplay()
      this.stopDisplay = null
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    this.echoLedger.clear()
    this.placing = false
    this.pendingPass = false
    this.pushState({ count: 0, placed: 0, overflow: 0, anomalies: 0, anomalyDetail: { fixedSize: 0, denied: 0, refused: 0 } })
  }

  /** 停表（插件卸载/测试收尾）：失活并清账 */
  protected stop(): void {
    this.deactivate()
    this.attempts.clear()
    this.anomalies.clear()
    this.anomalyKinds.clear()
    this.lastState = null
  }

  /** LOCATIONCHANGE 事件入口（FFI 回调侧只递 hwnd——轻活纪律，归类在 tick） */
  onLocationChange(hwnd: number): void {
    if (!this.available() || !this.stopWatch) return
    // 归类用当拍矩形在 pass 内读（回调里零 FFI）；此处只起批合并定时器
    this.schedulePass(hwnd)
  }

  /** 显示参数变化入口（分辨率/DPI/主屏增删——用户故事 23）：只触发一拍重算，
   *  事实/主屏矩形/条带顶全部在 pass 内现读，本入口零 FFI。脏标让该拍把「因区缩小
   *  而落到屏外」的既有成员重新纳回（否则它们会被当副屏窗踢出、永远拉不回来）。 */
  onDisplayChanged(): void {
    if (!this.available()) return
    this.displayDirty = true
    this.schedulePass(0)
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

  /** 一轮：采集 → 投影 → 异常预判 → 树生命周期（移除吸收/插入补入）→ 写集 → 落位
   *  核验 → 计数回推（异常不抛——改窗失败面不拖垮面板）。生命周期语义（工单377，
   *  spec 决策 12 / 用户故事 19-23、26-27、GLOSSARY「Agent 平铺」「异常未平铺」
   *  「容量溢出」）：
   *  - 异常未平铺不在平铺树里（保留当前几何）——异常窗的空位由兄弟吸收，不阻塞其他
   *    窗口；固定尺寸一次判定即异常化（不试写），拒改/拒绝达重试上限异常化；
   *  - 最小化保留窗格与顺序（成员留在树里，几何写入跳过——还原后下一拍落位）；
   *  - 移出主屏/其他桌面 = 成员集消失 → 兄弟吸收；移回 = 首见序追加队尾（最新窗口加入）；
   *  - 容量溢出成员按成员序重试插入——空间一释放即按序补入（story 29）；
   *  - 平铺区不可用（显示参数变化过渡态/主屏暂不可用）本拍零写入——不写不可见坐标。 */
  private onePass(): void {
    const now = Date.now()
    let facts: TileWindowFacts[]
    try {
      facts = this.deps.collectFacts()
    } catch {
      return // 本拍事实不可读：沿用上一拍（不猜）
    }
    const primary = this.deps.primaryRect()
    const projection = projectTileScope(facts, this.deps.ownExes(), primary)
    const members = projection.members
    // 显示参数变化拍（story 23）：区缩小后旧成员矩形落在新主屏外——它们仍是同一块
    // 物理屏幕上的窗，只是几何还没重算。把「此前在树里、只因 off-main-screen 被排」
    // 的成员纳回本轮（随后按新面积重算落位，不再屏外）。普通拍不纳回：用户把窗拖去
    // 副屏 = 真移出主屏（story 21 退出平铺）。
    if (this.displayDirty) {
      const placed = this.tree ? treePlacedIds(this.tree) : new Set<string>()
      const factById = new Map(facts.map((f) => [f.hwnd, f] as const))
      for (const ex of projection.excluded) {
        if (ex.reason !== 'off-main-screen' || !placed.has(String(ex.hwnd))) continue
        const f = factById.get(ex.hwnd)
        if (f) members.push(f)
      }
      this.displayDirty = false
    }
    const memberSet = new Set(members.map((m) => m.hwnd))

    // 异常预判（工单377）：固定尺寸窗（WS_THICKFRAME 缺位）一次判定即异常化——
    // 不试写（试写对它必然无效果），保留当前几何、不阻塞其他窗口
    for (const m of members) {
      if (!m.resizable && !this.anomalies.has(m.hwnd)) {
        markAnomaly(this.anomalies, this.anomalyKinds, m.hwnd, 'fixed-size')
      }
    }
    // 窗口消失清账（含异常账）：同一 hwnd 复用是新窗身份，不继承旧异常
    for (const h of [...this.anomalies]) {
      if (!memberSet.has(h)) clearAnomaly(this.anomalies, this.anomalyKinds, h)
    }

    // 可平铺候选 = 合格成员 − 异常未平铺（异常窗退出平铺树，空位由兄弟吸收）
    const candidates = members.filter((m) => !this.anomalies.has(m.hwnd))
    const candSet = new Set(candidates.map((m) => m.hwnd))
    // 成员加入序对账：保留在册序，新成员按本拍 z 序追加队尾（首见序 = 加入事件序——
    // 移回主屏按最新窗口加入，story 21）
    this.memberOrder = this.memberOrder.filter((h) => candSet.has(h))
    for (const m of candidates) {
      if (!this.memberOrder.includes(m.hwnd)) this.memberOrder.push(m.hwnd)
    }
    const count = members.length
    const area: TileRect = tileAreaOf(primary, this.deps.taskbarTop())
    // 最小窗格按主屏 DPI 换算（spec 决策 12「约 320×240 逻辑像素」——物理 px 口径）
    const minPane = this.deps.minPane()
    if (!isTileableArea(area, { minPaneW: minPane.w, minPaneH: minPane.h })) {
      // 平铺区不可用（显示参数变化过渡态/主屏暂时不可用）：本拍零写入——不写不可见
      // 坐标（用户故事 23）；计数照报，全员按未落格口径呈现
      this.pushState({
        count,
        placed: 0,
        overflow: candidates.length,
        anomalies: this.anomalies.size,
        anomalyDetail: anomalyDetailOf(this.anomalyKinds),
      })
      return
    }
    // 树生命周期（工单377）：平铺区变化（分辨率/DPI/主屏）→ 按成员序重建（重算语义，
    // story 23）；成员消失 → 兄弟吸收（story 20）；成员新增/溢出补入 → 按成员序裂变
    // 插入（story 17 队列续行 / story 29 按序补入）
    if (
      !this.tree ||
      !rectEq(this.tree.area, area) ||
      this.tree.minPaneW !== minPane.w ||
      this.tree.minPaneH !== minPane.h
    ) {
      this.tree = createTree(area, { minPaneW: minPane.w, minPaneH: minPane.h })
    }
    for (const id of [...treePlacedIds(this.tree)]) {
      if (!candSet.has(Number(id))) treeRemove(this.tree, id)
    }
    this.tree.overflow = this.tree.overflow.filter((id) => candSet.has(Number(id)))
    for (const hwnd of this.memberOrder) {
      treeInsert(this.tree, String(hwnd)) // 已在树=幂等；溢出=入账待补
    }
    const plan = treePlan(this.tree)
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
    const writeFailed = new Set<number>()
    for (const w of writes) {
      recordPending(this.echoLedger, w.hwnd, w.target, now)
      const ok = this.deps.writeRect(w.hwnd, w.target)
      if (!ok) {
        retractPending(this.echoLedger, w.hwnd)
        writeFailed.add(w.hwnd)
      }
      outcomes.push({ hwnd: w.hwnd, target: w.target, ok })
    }

    // 失败 reconciliation（写后核验，spec 决策 12 有限诊断）：落位窗回读——达标清账 /
    // 未达标计次 / 达上限异常化（跳过后续落格、不阻塞其他窗、不无限重试）。异常类别
    // （工单377）：写窗被系统拒绝（false）达上限 = write-denied（权限不足等）；受理但
    // 矩形不达标达上限 = refused（应用侧拒改/夹取）。
    for (const w of outcomes) {
      const actual = this.deps.readRect(w.hwnd)
      const verdict = verifyWriteOutcome(this.attempts, this.anomalies, w.hwnd, actual, w.target)
      if (verdict === 'ok') retractPending(this.echoLedger, w.hwnd) // 达标：期望矩形已落地，回声账清零
      if (verdict === 'anomaly' && !this.anomalyKinds.has(w.hwnd)) {
        this.anomalyKinds.set(w.hwnd, writeFailed.has(w.hwnd) ? 'write-denied' : 'refused')
      }
    }
    pruneLedger(this.echoLedger, Date.now())

    // 计数回推（用户故事 44）：主屏全部合格窗口（含最小化与各类未平铺），变化才推
    this.pushState({
      count,
      placed: plan.placements.length,
      overflow: plan.overflow.length,
      anomalies: this.anomalies.size,
      anomalyDetail: anomalyDetailOf(this.anomalyKinds),
    })
  }

  private pushState(part: {
    count: number
    placed: number
    overflow: number
    anomalies: number
    anomalyDetail: { fixedSize: number; denied: number; refused: number }
  }): void {
    const current = this.deps.currentMode()
    const next: AgentTilingState = {
      available: this.available(),
      current,
      count: part.count,
      placed: part.placed,
      overflow: part.overflow,
      anomalies: part.anomalies,
      anomalyDetail: part.anomalyDetail,
    }
    const prev = this.lastState
    if (
      prev &&
      prev.count === next.count &&
      prev.placed === next.placed &&
      prev.overflow === next.overflow &&
      prev.anomalies === next.anomalies &&
      prev.available === next.available &&
      prev.current === next.current &&
      prev.anomalyDetail.fixedSize === next.anomalyDetail.fixedSize &&
      prev.anomalyDetail.denied === next.anomalyDetail.denied &&
      prev.anomalyDetail.refused === next.anomalyDetail.refused
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

  /** 测试观察缝：异常分类账快照（工单377 三类异常断言） */
  anomalyKindsForTest(): Map<number, AnomalyKind> {
    return new Map(this.anomalyKinds)
  }

  /** 测试观察缝：成员加入序快照（生命周期顺序断言——移回按最新加入） */
  memberOrderForTest(): number[] {
    return [...this.memberOrder]
  }

  /** 测试驱动口：外部事件归类（喂矩形断言 echo/external，不触 FFI） */
  classifyForTest(hwnd: number, rect: ScopeRect, now: number): 'echo' | 'external' {
    return classifyGeomEvent(this.echoLedger, hwnd, rect, now)
  }
}
