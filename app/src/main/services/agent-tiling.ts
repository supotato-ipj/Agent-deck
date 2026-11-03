// Agent 平铺编排服务（工单376，spec #369 决策 7/8/27）：单工作区串行落位——窗口事件
// 驱动（LOCATIONCHANGE hook）+ 短批处理（debounce 合并风暴）+ 单飞在途（重排期间新
// 事件只记一拍待办，不递归改窗）。普通桌面 / 非托管桌面零自动改窗（用户故事 77，
// ADR-0016 硬边界）：本服务只在 workspace current === 'agent' 时激活观察与落位。
//
// 分层：纯裁决在 desktop/tiling-plan.ts（布局）、desktop/tile-scope.ts（范围投影）、
// desktop/geom-control.ts（回声账/失败账/写集）、desktop/geom-auth.ts（工单378 逐窗
// 几何授权状态机）；FFI 动作在 desktop/geom-write.ts（t372 实证路径）。本服务只编排：
// 事实采集 → 投影 → 授权决策 → 规划 → 批量落位/复原/浮动 → 核验记账 → 计数回推。
// 离线测试经 deps 注入假源（DesktopWorkspaceService 同款纪律），零 FFI。
//
// 工单378（决策 9/10/11）：逐窗授权覆盖拖动、边框、最大化、键盘与 Snap（都表现为外部
// 几何事件 + 目标窗前台）；首次用户操作先复原并上行授权提示，确认后才在**重新发起**的
// 操作里浮动；后台自改判定为非前台 → 静默复原不弹框。切出撤销授权但保留浮动几何，
// 恢复平铺收回浮动、补入溢出、清授权，异常窗跳过并由调用方报告数量。
//
// 实验开关（spec 决策 29）：config agentDesktop.enabled = false（缺省）时本服务
// available=false——零观察、零落位、投影恒空态。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { AgentTilingState, DesktopMode } from '../../shared/contract'
import { MIN_PANE_H, MIN_PANE_W, createTree, isTileableArea, tileAreaOf, treeInsert, treePlacedIds, treePlan, treeRemove } from '../desktop/tiling-plan'
import type { TilingTree, TileRect } from '../desktop/tiling-plan'
import { rectMatches, projectTileScope } from '../desktop/tile-scope'
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
import {
  acceptFloating,
  authCounts,
  beginPrompt,
  cancelAuth,
  clearFloating,
  confirmAuth,
  consumeAuth,
  createGeomAuthLedger,
  decideGeomEvent,
  enterFloating,
  floatingIds,
  floatingRectOf,
  forget,
  isFloating,
  phaseOf,
  rememberFloating,
  revokeAuth,
} from '../desktop/geom-auth'

export interface AgentTilingServiceOptions {
  /** 实验开关（config agentDesktop.enabled 下发；缺省 = 关——零观察零落位） */
  enabled?: boolean
  /** 事件批处理窗口（ms）：LOCATIONCHANGE 风暴合并（缺省 80ms——500ms 稳定预算的主项） */
  batchMs?: number
  /** 存证日志（诊断面：授权决策的 hwnd/阶段/前台/动作——不含窗口标题，隐私边界同决策 26） */
  log?: (event: Record<string, unknown>) => void
  /** 一次持续授权的静止判据（ms；缺省 800——离线矩阵可缩短以秒级断言） */
  settleMs?: number
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
    /** 起 LOCATIONCHANGE 观察（缺省延迟绑定 geom-write.startLocationChangeWatch） */
    startWatch?: (onEvent: (hwnd: number) => void) => () => void
    /** 显示参数变化订阅（分辨率/DPI/主屏增删——缺省无源 noop；Electron 装配接 screen 事件） */
    onDisplayChanged?: (cb: () => void) => () => void
    /** 最小窗格（物理 px；spec 决策 12「约 320×240 逻辑像素」——装配层按主屏 DPI
     *  换算，缺省 320×240 即 100% 缩放等值） */
    minPane?: () => { w: number; h: number }
    /** 目标窗是否前台（工单378「用户主动操作」判据；缺省延迟绑定 geom-write.isForegroundWindow） */
    isForeground?: (hwnd: number) => boolean
    /** 复原窗到目标矩形（工单378：最大化态先 SC_RESTORE 再写；缺省延迟绑定 geom-write.restoreWindowRect） */
    restoreRect?: (hwnd: number, target: TileRect) => boolean
  }
}

interface TilingDeps {
  currentMode: () => DesktopMode
  ownExes: () => string[]
  primaryRect: () => ScopeRect
  taskbarTop: () => number | null
  collectFacts: () => TileWindowFacts[]
  readRect: (hwnd: number) => ScopeRect
  startWatch: (onEvent: (hwnd: number) => void) => () => void
  onDisplayChanged: (cb: () => void) => () => void
  minPane: () => { w: number; h: number }
  isForeground: (hwnd: number) => boolean
  restoreRect: (hwnd: number, target: TileRect) => boolean
}

const DEFAULT_BATCH_MS = 80
/** 「实际修改」判据容差（物理 px）：小于它是写窗/收边的抖动，不构成用户改几何 */
const AUTH_CHANGE_TOLERANCE_PX = 2
/** 一次持续授权的静止判据（ms）：几何静止这么久即视为本次操作结束，授权消费
 *  （拖动/边框/键盘/Snap 期间连续事件不反复弹框——决策 10「授权下一次重新发起的操作」） */
const AUTH_SETTLE_MS = 800

/** 矩形逐字节等值（平铺区变化检测——显示参数变化重建判据，非核验容差判） */
function rectEq(a: TileRect, b: TileRect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom
}

type Numbers = Pick<AgentTilingState, 'count' | 'placed' | 'overflow' | 'anomalies' | 'anomalyDetail'>

/**
 * Agent 平铺编排（工单376）：事件流上单工作区串行。激活（current==='agent'）时起
 * LOCATIONCHANGE 观察；事件经回声账归类——echo 消费即止，external 批合并后走一轮
 * 重排（投影 → 授权决策 → 规划 → 写集落位/复原 → 核验记账）。写前登记期望矩形（回声
 * 抑制），写后回读核验：达标清账、未达标计次、达上限异常化（不无限重试、不阻塞其他窗）。
 * 失活（切普通/非托管）即停观察停落位——普通桌面零自动改窗；浮动态保留（几何不丢），
 * 未消费授权撤销（工单378 决策 11）。
 */
export class AgentTilingService extends Service {
  static inject: Inject = {} // 依赖经 deps 缝注入（workspace 状态读取走注入口，避免硬依赖可选服务）

  private readonly enabledFlag: boolean
  private readonly batchMs: number
  private readonly deps: TilingDeps
  private readonly logEvent: (event: Record<string, unknown>) => void
  private readonly settleMs: number
  private echoLedger: EchoLedger = new Map()
  private attempts: AttemptLedger = new Map()
  private anomalies: AnomalySet = new Set()
  /** 异常分类账（工单377）：与 anomalies 同进出——异常化的窗必有类别（GLOSSARY「异常未平铺」） */
  private anomalyKinds: AnomalyKindLedger = new Map()
  /** 逐窗几何授权账（工单378，只在内存：重启即失——决策 13/81；切出撤销、恢复清除） */
  private auth = createGeomAuthLedger()
  /** 一次操作结束的静止计时器（hwnd → timer；浮动/接受的几何静止后消费授权） */
  private settleTimers = new Map<number, NodeJS.Timeout>()
  /** 静止代次（每拍变化 +1；计时器回看代次，避免旧计时器消费新一次操作） */
  private settleGen = new Map<number, number>()
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
    this.logEvent = options.log ?? (() => undefined)
    this.settleMs = options.settleMs ?? AUTH_SETTLE_MS
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
      startWatch: options.deps?.startWatch
        ?? ((onEvent) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).startLocationChangeWatch(onEvent)),
      onDisplayChanged: options.deps?.onDisplayChanged ?? (() => () => undefined), // 无源 noop（内核装配无 screen）
      minPane: options.deps?.minPane ?? (() => ({ w: MIN_PANE_W, h: MIN_PANE_H })), // 100% 缩放等值
      isForeground: options.deps?.isForeground
        ?? ((hwnd) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).isForegroundWindow(hwnd)),
      restoreRect: options.deps?.restoreRect
        ?? ((hwnd, target) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).restoreWindowRect(hwnd, target)),
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

  /** 激活态（授权账只在 Agent 桌面有意义；失活时投影清零） */
  private active(): boolean {
    return this.available() && this.deps.currentMode() === 'agent'
  }

  /** 只读投影（桥 tiling/get-state 与回推共用）：计数口径 = 主屏全部合格窗口 */
  state(): AgentTilingState {
    const current = this.deps.currentMode()
    const counts = this.active() ? authCounts(this.auth) : { floating: 0, prompting: 0, authorized: 0 }
    return {
      available: this.available(),
      current,
      count: this.lastState?.count ?? 0,
      placed: this.lastState?.placed ?? 0,
      overflow: this.lastState?.overflow ?? 0,
      anomalies: this.lastState?.anomalies ?? 0,
      anomalyDetail: this.lastState?.anomalyDetail ?? { fixedSize: 0, denied: 0, refused: 0 },
      floating: counts.floating,
      prompting: counts.prompting,
      authorized: counts.authorized,
    }
  }

  /** 激活态对齐（workspace/changed 与启动路径共用）：agent 激活，其余失活 */
  syncActivation(): void {
    const active = this.active()
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

  /** 失活（幂等）：停观察、清在途——普通/非托管桌面零自动改窗。工单378：撤销未消费
   *  授权（提示/已确认 → 锁定），浮动窗保留几何（返回后不自动恢复、但布局不丢）。 */
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
    for (const hwnd of revokeAuth(this.auth)) this.ctx.emit('tiling/authorize-closed', { hwnd })
    this.clearSettleTimers()
    this.echoLedger.clear()
    this.placing = false
    this.pendingPass = false
    this.pushState({ count: 0, placed: 0, overflow: 0, anomalies: 0, anomalyDetail: { fixedSize: 0, denied: 0, refused: 0 } })
  }

  /** 停表（插件卸载/测试收尾）：失活并清账（授权只在内存——进程退出即失） */
  protected stop(): void {
    this.deactivate()
    this.attempts.clear()
    this.anomalies.clear()
    this.anomalyKinds.clear()
    this.clearSettleTimers()
    clearFloating(this.auth)
    this.auth = createGeomAuthLedger()
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
    if (!this.active()) return
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

  /** 用户确认「调整窗口」（工单378 决策 10）：prompt → armed，**不写几何、不重排**
   *  （决策 9「确认本身不产生几何写入」）；用户须重新发起操作才会浮动。
   *  非 prompt 阶段返回 ok:false（不越级授权）。 */
  confirmHwnd(hwnd: number): { ok: boolean; state: AgentTilingState } {
    const ok = confirmAuth(this.auth, hwnd)
    if (ok) {
      this.ctx.emit('tiling/authorize-closed', { hwnd })
      this.refreshState()
    }
    return { ok, state: this.state() }
  }

  /** 用户选择「保持平铺」/ Esc（工单378 决策 10）：prompt → locked；窗口已在格上。 */
  cancelHwnd(hwnd: number): { ok: boolean; state: AgentTilingState } {
    const ok = cancelAuth(this.auth, hwnd)
    if (ok) {
      this.ctx.emit('tiling/authorize-closed', { hwnd })
      this.refreshState()
    }
    return { ok, state: this.state() }
  }

  /**
   * 恢复平铺（工单378 决策 11）：收回全部手动浮动（按进入浮动序重新补入平铺）、清除
   * 未消费授权、按空间补入容量溢出；异常未平铺跳过并报告数量（skipped）。返回被收回的
   * 浮动窗数（restored）与跳过数，调用方（胶囊）据此报告。
   */
  async restoreTiling(): Promise<{ ok: boolean; restored: number; skipped: number; state: AgentTilingState }> {
    if (!this.active()) {
      return { ok: false, restored: 0, skipped: this.anomalies.size, state: this.state() }
    }
    const floats = clearFloating(this.auth)
    for (const hwnd of revokeAuth(this.auth)) this.ctx.emit('tiling/authorize-closed', { hwnd })
    // 收回序 = 进入浮动序（确定性）：补在成员队尾后由本拍树插入按序裂变
    for (const hwnd of floats) if (!this.memberOrder.includes(hwnd)) this.memberOrder.push(hwnd)
    // 「默认 Agent 平铺」= 按成员加入序整体重算（浮动期兄弟吸收留下的增量树形不作数）：
    // 清树让本拍按成员序重建，收回后的布局与同成员序的默认布局一致
    this.tree = null
    await this.runPass()
    return { ok: true, restored: floats.length, skipped: this.anomalies.size, state: this.state() }
  }

  /** 一轮：采集 → 投影 → 异常预判 → 授权决策（复原/浮动）→ 树生命周期 → 写集 →
   *  落位核验 → 提示上行 → 计数回推（异常不抛——改窗失败面不拖垮面板）。
   *  生命周期语义（工单377，spec 决策 12 / 用户故事 19-23、26-27、GLOSSARY「Agent 平铺」
   *  「异常未平铺」「容量溢出」）：
   *  - 异常未平铺不在平铺树里（保留当前几何）——异常窗的空位由兄弟吸收，不阻塞其他
   *    窗口；固定尺寸一次判定即异常化（不试写），拒改/拒绝达重试上限异常化；
   *  - 最小化保留窗格与顺序（成员留在树里，几何写入跳过——还原后下一拍落位）;
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
    // 窗口消失清账（含异常账与授权账）：同一 hwnd 复用是新窗身份，不继承旧状态
    for (const h of [...this.anomalies]) {
      if (!memberSet.has(h)) clearAnomaly(this.anomalies, this.anomalyKinds, h)
    }
    const authIds = new Set<number>([...this.auth.phase.keys(), ...this.auth.floating.keys()])
    for (const h of authIds) {
      if (memberSet.has(h)) continue
      this.disarmSettle(h)
      if (forget(this.auth, h)) this.ctx.emit('tiling/authorize-closed', { hwnd: h })
    }

    // 可平铺候选 = 合格成员 − 异常未平铺 − 手动浮动（浮动窗几何保留、不参与规划、可覆盖窗格）
    const candidates = members.filter((m) => !this.anomalies.has(m.hwnd) && !isFloating(this.auth, m.hwnd))
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
    // 本拍之前已在树里的窗（工单378）：只有「曾经落格、现在几何不对」才是用户/后台改了几何；
    // 新成员首拍的几何差异是正常落位，不进入授权判定（不给新窗弹授权框）
    const knownPlaced = new Set(treePlacedIds(this.tree))
    for (const hwnd of this.memberOrder) {
      treeInsert(this.tree, String(hwnd)) // 已在树=幂等；溢出=入账待补
    }
    const rectByHwnd = new Map(members.map((m) => [Number(m.hwnd), m.rect] as const))
    const iconicByHwnd = new Map(members.map((m) => [Number(m.hwnd), m.iconic] as const))

    // —— 工单378 授权决策（先于写集：复原/浮动改变本轮写集与树形）——
    // 计一组：本拍需复原的窗（提示期持续复原 / 首次操作复原）与需上行提示的窗。
    let plan = treePlan(this.tree)
    const newPromptSet = new Set<number>()
    const floatSet: number[] = []
    const floatingRestore = new Map<number, TileRect>()
    for (const p of plan.placements) {
      const hwnd = Number(p.id)
      if (iconicByHwnd.get(hwnd)) continue // 最小化不算用户改几何（还原事件触发下一拍）
      if (!knownPlaced.has(String(hwnd))) continue // 新成员落位/溢出补入：正常写，不授权
      const current = rectByHwnd.get(hwnd)
      if (!current) continue
      const changed = !rectMatches(current, p.rect, AUTH_CHANGE_TOLERANCE_PX)
      if (!changed) continue
      // 回声 = 自身写窗的回声（期望矩形命中）：不是用户操作，零动作（且已消费）
      const echo = classifyGeomEvent(this.echoLedger, hwnd, current, now) === 'echo'
      const userGesture = echo ? false : this.deps.isForeground(hwnd)
      const action = decideGeomEvent({ phase: phaseOf(this.auth, hwnd), floating: false, echo, changed, userGesture })
      this.logEvent({ type: 'tiling-auth', hwnd, phase: phaseOf(this.auth, hwnd), floating: false, echo, userGesture, action })
      if (action === 'float') {
        floatSet.push(hwnd)
      } else if (action === 'restore-prompt') {
        newPromptSet.add(hwnd) // 首次用户操作：本轮写集即复原（restoreRect）
      }
      // 'restore' / 'restore-silent'：本轮写集按规划目标落位（restoreRect 同一条写路径）
    }
    // 浮动窗观察（不在平铺树里）：已授权改 → 接受；未授权用户改 → 复原到保留几何并询问；
    // 后台自改 → 浮动窗不受平铺约束，只更新记忆几何（"复原原状"的原状 = 操作前几何）
    for (const hwnd of floatingIds(this.auth)) {
      const current = rectByHwnd.get(hwnd)
      if (!current || iconicByHwnd.get(hwnd)) continue
      const remembered = floatingRectOf(this.auth, hwnd)
      if (!remembered) continue
      const changed = !rectMatches(current, remembered, AUTH_CHANGE_TOLERANCE_PX)
      if (!changed) continue
      const echo = classifyGeomEvent(this.echoLedger, hwnd, current, now) === 'echo'
      const userGesture = echo ? false : this.deps.isForeground(hwnd)
      const action = decideGeomEvent({ phase: phaseOf(this.auth, hwnd), floating: true, echo, changed, userGesture })
      this.logEvent({ type: 'tiling-auth', hwnd, phase: phaseOf(this.auth, hwnd), floating: true, echo, userGesture, action })
      if (action === 'accept') {
        acceptFloating(this.auth, hwnd, current)
        this.armSettle(hwnd)
      } else if (action === 'restore-prompt') {
        floatingRestore.set(hwnd, remembered)
        newPromptSet.add(hwnd)
      } else if (action === 'restore') {
        floatingRestore.set(hwnd, remembered)
      } else {
        rememberFloating(this.auth, hwnd, current)
      }
    }
    // 浮动者退出平铺树（其余成员重新铺满——浮动窗可覆盖窗格）并重规划本轮写集
    if (floatSet.length > 0) {
      for (const hwnd of floatSet) {
        const rect = rectByHwnd.get(hwnd)
        if (rect) enterFloating(this.auth, hwnd, rect)
        this.armSettle(hwnd)
        treeRemove(this.tree, String(hwnd))
      }
      plan = treePlan(this.tree)
    }

    // 写集：规划目标 × 当前矩形比对（异常窗跳过、最小化跳过、已达标不重写）
    const assignments = plan.placements.map((p) => {
      const hwnd = Number(p.id)
      return { hwnd, target: p.rect, iconic: iconicByHwnd.get(hwnd) ?? false, current: rectByHwnd.get(hwnd) ?? null }
    })
    const writes = planWrites(assignments, this.anomalies)

    // 批量落位：登记期望矩形（回声抑制）→ 写 → 失败即撤账（失败写不吞后续外部事件）。
    // 落位统一走 restoreRect（最大化态先 SC_RESTORE 再写）：复原、重排与新窗首落同一条
    // 写路径——新窗打开即最大化也能落格，而不是白付两次失败再判异常。
    const outcomes: Array<{ hwnd: number; target: TileRect; ok: boolean }> = []
    const writeFailed = new Set<number>()
    const writeOk = new Map<number, boolean>()
    for (const w of writes) {
      recordPending(this.echoLedger, w.hwnd, w.target, now)
      const ok = this.deps.restoreRect(w.hwnd, w.target)
      writeOk.set(w.hwnd, ok)
      if (!ok) {
        retractPending(this.echoLedger, w.hwnd)
        writeFailed.add(w.hwnd)
      }
      outcomes.push({ hwnd: w.hwnd, target: w.target, ok })
    }
    for (const [hwnd, target] of floatingRestore) {
      recordPending(this.echoLedger, hwnd, target, now)
      const ok = this.deps.restoreRect(hwnd, target)
      writeOk.set(hwnd, ok)
      if (!ok) {
        retractPending(this.echoLedger, hwnd)
        writeFailed.add(hwnd)
      }
      outcomes.push({ hwnd, target, ok })
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

    // 授权提示上行（工单378 决策 10）：复原受理后显示「调整窗口/保持平铺」；写失败/
    // 异常化的窗不提示（无从授权），并清掉残留阶段（不反复弹窗）
    for (const hwnd of newPromptSet) {
      if (this.anomalies.has(hwnd)) continue
      if (writeOk.get(hwnd) === false) continue
      beginPrompt(this.auth, hwnd)
      const target = plan.placements.find((p) => Number(p.id) === hwnd)?.rect ?? floatingRectOf(this.auth, hwnd)
      if (target) this.ctx.emit('tiling/authorize-request', { hwnd, rect: { ...target } })
    }
    // 异常化即撤销授权（不反复弹窗、不阻塞其他窗口）
    for (const hwnd of authIds) {
      if (!this.anomalies.has(hwnd)) continue
      if (forget(this.auth, hwnd)) this.ctx.emit('tiling/authorize-closed', { hwnd })
    }

    // 计数回推（用户故事 44）：主屏全部合格窗口（含最小化与各类未平铺），变化才推
    this.pushState({
      count,
      placed: plan.placements.length,
      overflow: plan.overflow.length,
      anomalies: this.anomalies.size,
      anomalyDetail: anomalyDetailOf(this.anomalyKinds),
    })
  }

  /** 一次操作开始/继续：重置静止计时器（几何静止 AUTH_SETTLE_MS 后消费授权） */
  private armSettle(hwnd: number): void {
    const gen = (this.settleGen.get(hwnd) ?? 0) + 1
    this.settleGen.set(hwnd, gen)
    const prev = this.settleTimers.get(hwnd)
    if (prev) clearTimeout(prev)
    const timer = setTimeout(() => {
      this.settleTimers.delete(hwnd)
      if (this.settleGen.get(hwnd) !== gen) return
      if (!consumeAuth(this.auth, hwnd)) return
      this.refreshState()
    }, this.settleMs)
    this.settleTimers.set(hwnd, timer)
  }

  /** 撤计时器（窗口消失/失活/停表） */
  private disarmSettle(hwnd: number): void {
    const t = this.settleTimers.get(hwnd)
    if (t) clearTimeout(t)
    this.settleTimers.delete(hwnd)
    this.settleGen.delete(hwnd)
  }

  private clearSettleTimers(): void {
    for (const t of this.settleTimers.values()) clearTimeout(t)
    this.settleTimers.clear()
    this.settleGen.clear()
  }

  /** 用上一拍的平铺数字刷新投影（授权/浮动计数变化即推——胶囊与桥共用） */
  private refreshState(): void {
    const prev = this.lastState
    this.pushState(prev ? {
      count: prev.count,
      placed: prev.placed,
      overflow: prev.overflow,
      anomalies: prev.anomalies,
      anomalyDetail: prev.anomalyDetail,
    } : {
      count: 0, placed: 0, overflow: 0, anomalies: 0, anomalyDetail: { fixedSize: 0, denied: 0, refused: 0 },
    })
  }

  private pushState(part: Numbers): void {
    const current = this.deps.currentMode()
    const counts = this.active() ? authCounts(this.auth) : { floating: 0, prompting: 0, authorized: 0 }
    const next: AgentTilingState = {
      available: this.available(),
      current,
      count: part.count,
      placed: part.placed,
      overflow: part.overflow,
      anomalies: part.anomalies,
      anomalyDetail: part.anomalyDetail,
      floating: counts.floating,
      prompting: counts.prompting,
      authorized: counts.authorized,
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
      prev.anomalyDetail.refused === next.anomalyDetail.refused &&
      prev.floating === next.floating &&
      prev.prompting === next.prompting &&
      prev.authorized === next.authorized
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

  /** 测试观察缝：逐窗授权阶段（工单378 授权矩阵——浮动/提示/已确认） */
  authPhaseForTest(hwnd: number): 'locked' | 'prompt' | 'armed' {
    return phaseOf(this.auth, hwnd)
  }

  /** 测试观察缝：浮动几何快照（切出保留几何断言） */
  floatingRectForTest(hwnd: number): TileRect | null {
    return floatingRectOf(this.auth, hwnd)
  }

  /** 测试驱动口：外部事件归类（喂矩形断言 echo/external，不触 FFI） */
  classifyForTest(hwnd: number, rect: ScopeRect, now: number): 'echo' | 'external' {
    return classifyGeomEvent(this.echoLedger, hwnd, rect, now)
  }
}
