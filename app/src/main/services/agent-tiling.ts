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
import { MIN_PANE_H, MIN_PANE_W, createTree, isTileableArea, tileAreaOf, treeFromShape, treeInsert, treePlacedIds, treePlan, treeRemove } from '../desktop/tiling-plan'
import type { TilingTree, TileRect } from '../desktop/tiling-plan'
import { captureLayout, identityOf, parseLayout, planRestore, serializeLayout } from '../desktop/agent-layout'
import type { AgentLayoutDoc, RestorePlan, WindowIdentity } from '../desktop/agent-layout'
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
import fs from 'node:fs'
import path from 'node:path'
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
  /**
   * 布局持久化文件（工单383）：null/缺省 = 无落盘面（离线测试默认）。
   * 生产装配 = userData/agent-desktop-layout.json（验收可经 DECK_AGENT_LAYOUT_FILE 重定向）。
   */
  layoutFile?: string | null
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
    /** 当前配对 Agent 桌面系统 ID（工单383 归属核对；缺省 null = 无配对不恢复） */
    agentDesktopId?: () => string | null
    /** 布局文本读取（工单383；缺省 fs 真源） */
    readLayoutText?: (file: string) => string | null
    /** 布局文本原子写入（工单383；缺省 fs 真源） */
    writeLayoutText?: (file: string, text: string) => void
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
  agentDesktopId: () => string | null
  readLayoutText: (file: string) => string | null
  writeLayoutText: (file: string, text: string) => void
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
  /** 激活态迁移观察（诊断存证：active/current；不含窗口数据） */
  private wasActive: boolean | null = null
  /** 成员加入序（hwnd，先到在前）：布局只由加入事件序列决定（spec 决策 7「有序窗口
   *  成员」+ 用户故事 18/31——确定性不随 z 序/焦点漂移）；新成员按首见序追加队尾
   *  （story 21「移回主屏按最新窗口加入」），消失成员移除、兄弟吸收空位。显示参数
   *  变化重建平铺树时以本序重算（确定性函数）。 */
  private memberOrder: number[] = []
  /** 持久平铺树（工单377，GLOSSARY「Agent 平铺」）：布局账本——增量裂变/兄弟吸收；
   *  显示参数变化（平铺区变）时按成员序整体重建（重算语义，story 23）。 */
  private tree: TilingTree | null = null
  /** 聚焦目标（工单379，决策 16）：挂起窗保留窗格与计数，但平铺 pass 不写它、不做授权
   *  判定——真实最大化不是「用户改几何」。null = 无聚焦。只在内存，切出即清。 */
  private heldHwnd: number | null = null
  // —— 工单383 重启恢复账（只在内存的会话状态；持久文档字段见 desktop/agent-layout） ——
  private readonly layoutFile: string | null
  /** 持久文档已装载（首激活读一次；暂停态每拍重试不重读） */
  private layoutLoaded = false
  /** 待应用文档（主屏暂不可用时保留模型，恢复后 reconciliation） */
  private pendingRestore: AgentLayoutDoc | null = null
  /** 安全态：停止自动改窗（桌面 ID 失效/窗口身份不符/模型不一致/崩溃） */
  private safe = false
  private recovery: AgentTilingState['recovery'] = 'none'
  private recoveryReason: AgentTilingState['recoveryReason'] = null
  /** 恢复后的首个 reconciliation pass：跳过授权判定（恢复写窗不是用户操作、不弹框） */
  private restoringPass = false
  /** 最近一拍全量窗口事实的稳定身份表（持久化身份来源；不含标题） */
  private lastIdentities = new Map<number, WindowIdentity>()
  /** 最近一次落盘文本（同内容不重复写） */
  private lastSavedText: string | null = null

  constructor(ctx: Context, options: AgentTilingServiceOptions = {}) {
    super(ctx, 'agentTiling')
    this.enabledFlag = options.enabled ?? false
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS
    this.logEvent = options.log ?? (() => undefined)
    this.settleMs = options.settleMs ?? AUTH_SETTLE_MS
    this.layoutFile = options.layoutFile ?? null
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
      agentDesktopId: options.deps?.agentDesktopId ?? (() => null),
      readLayoutText: options.deps?.readLayoutText ?? ((file) => {
        try { return fs.readFileSync(file, 'utf8') } catch { return null }
      }),
      writeLayoutText: options.deps?.writeLayoutText ?? ((file, text) => {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const tmp = `${file}.tmp`
        fs.writeFileSync(tmp, text, 'utf8')
        fs.renameSync(tmp, file)
      }),
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
      recovery: this.recovery,
      recoveryReason: this.recoveryReason,
    }
  }

  /**
   * 预览成员快照（工单379，spec 决策 15）：与胶囊计数同口径的主屏合格窗口事实——
   * 含最小化/浮动/未平铺（预览列出全部，不只可见平铺窗格）。标题只作上屏载荷，
   * 调用方（窗口预览服务）不得把它写入日志。不可用/非 Agent 桌面返回空集。
   */
  previewMembers(): TileWindowFacts[] {
    if (!this.active()) return []
    try {
      const facts = this.deps.collectFacts()
      return projectTileScope(facts, this.deps.ownExes(), this.deps.primaryRect()).members
    } catch {
      return [] // 本拍事实不可读：预览空集（不猜）
    }
  }

  /** 聚焦挂起（工单379，决策 16）：挂起窗保留窗格/计数，但平铺 pass 不写它、不做授权
   *  判定（真实最大化不是用户改几何）；null = 解除。只在内存，失活即清。 */
  setHeldWindow(hwnd: number | null): void {
    this.heldHwnd = hwnd
  }

  /** 当前挂起窗（诊断/测试观察缝） */
  heldWindowForTest(): number | null {
    return this.heldHwnd
  }

  /** 激活态对齐（workspace/changed 与启动路径共用）：agent 激活，其余失活 */
  syncActivation(): void {
    const active = this.active()
    if (this.wasActive !== active) {
      this.wasActive = active
      this.logEvent({
        type: 'tiling-activation',
        active,
        available: this.available(),
        current: this.deps.currentMode(),
      })
    }
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
    // 聚焦挂起随失活清除（工单379）：普通/非托管桌面不继承 Agent 桌面的挂起状态
    this.heldHwnd = null
    // 切出前落盘模型（工单383）：浮动几何保留、授权已撤销——重启按同一份布局恢复
    this.saveLayout(false)
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
    this.layoutLoaded = false
    this.pendingRestore = null
    this.safe = false
    this.recovery = 'none'
    this.recoveryReason = null
    this.restoringPass = false
    this.lastIdentities.clear()
    this.lastSavedText = null
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
    if (!this.active() || this.safe) {
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
    } catch (err) {
      this.logEvent({ type: 'tiling-facts-unavailable', message: err instanceof Error ? err.message : String(err) })
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
    // 稳定身份表（工单383）：只留 hwnd/pid/归一化 exe——标题不进入持久化账
    this.lastIdentities = new Map(facts.map((f) => [f.hwnd, identityOf(f)] as const))
    const area: TileRect = tileAreaOf(primary, this.deps.taskbarTop())
    // 最小窗格按主屏 DPI 换算（spec 决策 12「约 320×240 逻辑像素」——物理 px 口径）
    const minPane = this.deps.minPane()
    // 重启恢复（工单383）：安全态/主屏暂不可用时本拍零写入；模型原地保留（不丢）
    if (!this.reconcileRecovery(facts, members, area, minPane)) {
      this.pushState({
        count: members.length,
        placed: 0,
        overflow: members.length,
        anomalies: this.anomalies.size,
        anomalyDetail: anomalyDetailOf(this.anomalyKinds),
      })
      this.saveLayout(false)
      return
    }

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
      if (hwnd === this.heldHwnd) continue // 聚焦目标（工单379）：最大化不是用户改几何
      if (iconicByHwnd.get(hwnd)) continue // 最小化不算用户改几何（还原事件触发下一拍）
      if (!knownPlaced.has(String(hwnd))) continue // 新成员落位/溢出补入：正常写，不授权
      const current = rectByHwnd.get(hwnd)
      if (!current) continue
      const changed = !rectMatches(current, p.rect, AUTH_CHANGE_TOLERANCE_PX)
      if (!changed) continue
      if (this.restoringPass) continue // 恢复轮：按持久模型落位，不是用户改几何（不弹框）
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
      if (hwnd === this.heldHwnd) continue // 聚焦目标（含浮动窗）：挂起期不受平铺约束
      const current = rectByHwnd.get(hwnd)
      if (!current || iconicByHwnd.get(hwnd)) continue
      const remembered = floatingRectOf(this.auth, hwnd)
      if (!remembered) continue
      const changed = !rectMatches(current, remembered, AUTH_CHANGE_TOLERANCE_PX)
      if (!changed) continue
      if (this.restoringPass) continue // 恢复轮：浮动几何已按持久模型写回，不判用户操作
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
    const assignments = plan.placements
      .filter((p) => Number(p.id) !== this.heldHwnd) // 挂起窗不写（保持真实最大化几何）
      .map((p) => {
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
    // 恢复轮结束 + 模型落盘（工单383）：本轮之后的事件回到正常授权判定
    this.restoringPass = false
    this.saveLayout(false)
  }

  // ————————————————————————————————————————————————————————————
  // 重启恢复（工单383，spec #369 决策 13 桌面持久化 + 决策 16 恢复与故障矩阵）
  // ————————————————————————————————————————————————————————————

  /**
   * 恢复一拍（纯编排，IO 经 deps 注入）：首激活读一次持久文档；之后每拍重试暂停态。
   * 返回 false = 本拍停止自动改窗（安全态/主屏暂不可用）——调用方零写集、原地保留模型。
   *
   * 判据顺序（安全态即停止，不猜、不修补）：
   *  1. 持久文档解析/结构不一致 → model；
   *  2. 上次会话未干净退出（crash 标记）→ crash（不应用旧布局、不强制搬窗）；
   *  3. 存储桌面 ID 与当前配对 Agent 桌面不一致 → desktop-id（不猜接管未知桌面）；
   *  4. 同 hwnd 的 exe/pid 不符 → window-identity；
   *  5. 主屏暂不可用 → paused（pendingRestore 保留，恢复后 reconciliation）。
   */
  private reconcileRecovery(
    facts: readonly TileWindowFacts[],
    members: readonly TileWindowFacts[],
    area: TileRect,
    minPane: { w: number; h: number },
  ): boolean {
    if (this.safe) return false
    if (!this.layoutFile) return true
    if (!this.layoutLoaded) {
      this.layoutLoaded = true
      const parsed = parseLayout(this.deps.readLayoutText(this.layoutFile))
      this.logEvent({
        type: 'tiling-recovery-load',
        outcome: parsed.kind,
        reason: parsed.kind === 'invalid' ? parsed.reason : null,
        clean: parsed.kind === 'ok' ? parsed.doc.clean : null,
        order: parsed.kind === 'ok' ? parsed.doc.order.length : null,
      })
      if (parsed.kind === 'invalid') {
        this.enterSafe('model')
        return false
      }
      if (parsed.kind === 'none') {
        this.recovery = 'none'
        this.recoveryReason = null
        return true
      }
      const doc = parsed.doc
      if (doc.clean !== true) {
        this.enterSafe('crash')
        return false
      }
      const desktopId = this.deps.agentDesktopId()
      if (!desktopId || doc.desktopId !== desktopId) {
        this.enterSafe('desktop-id')
        return false
      }
      this.pendingRestore = doc
    }
    if (!this.pendingRestore) return true
    if (!isTileableArea(area, { minPaneW: minPane.w, minPaneH: minPane.h })) {
      // 主屏暂不可用：暂停改窗、保留模型（用户故事 23 / spec 决策 16）
      this.setRecovery('paused', 'display-unavailable')
      return false
    }
    const plan = planRestore(this.pendingRestore, facts, members)
    if (plan.kind === 'safe') {
      this.enterSafe(plan.reason)
      return false
    }
    this.applyRestorePlan(plan, facts, area, minPane)
    this.pendingRestore = null
    this.setRecovery('restored', null)
    return true
  }

  /** 应用恢复计划：顺序/树/分裂队列原样重建（矩形按当前平铺区重算）、浮动几何写回 */
  private applyRestorePlan(
    plan: Extract<RestorePlan, { kind: 'apply' }>,
    facts: readonly TileWindowFacts[],
    area: TileRect,
    minPane: { w: number; h: number },
  ): void {
    const orderHwnds = plan.order.map((w) => w.hwnd)
    const floatingHwnds = new Set<number>()
    const factById = new Map(facts.map((f) => [f.hwnd, f] as const))
    this.auth = createGeomAuthLedger()
    for (const item of plan.floating) {
      const identity = plan.order[item.ref]
      if (!identity) continue
      floatingHwnds.add(identity.hwnd)
      enterFloating(this.auth, identity.hwnd, item.rect)
    }
    // 成员序只含平铺/溢出成员——浮动窗由 auth 账单独承载（恢复平铺时按浮动序补入）
    this.memberOrder = orderHwnds.filter((h) => !floatingHwnds.has(h))
    const idOfRef = (ref: number): string | null => {
      const w = plan.order[ref]
      return w ? String(w.hwnd) : null
    }
    const opts = { minPaneW: minPane.w, minPaneH: minPane.h }
    this.tree = plan.shape
      ? treeFromShape(plan.shape, area, opts, plan.queue, idOfRef)
      : createTree(area, opts)
    // 浮动几何按持久模型写回（干净重启的「恢复」；授权仍然是关闭的——不产生 prompt/armed）
    for (const item of plan.floating) {
      const identity = plan.order[item.ref]
      if (!identity) continue
      const fact = factById.get(identity.hwnd)
      if (!fact || fact.iconic) continue
      if (rectMatches(fact.rect, item.rect, AUTH_CHANGE_TOLERANCE_PX)) continue
      recordPending(this.echoLedger, identity.hwnd, item.rect, Date.now())
      const ok = this.deps.restoreRect(identity.hwnd, item.rect)
      if (!ok) retractPending(this.echoLedger, identity.hwnd)
    }
    this.restoringPass = true
    this.logEvent({
      type: 'tiling-recovery',
      status: 'restored',
      dropped: plan.dropped,
      order: plan.order.length,
      floating: plan.floating.length,
    })
  }

  /** 进入安全态（停止自动改窗）；不覆盖持久文档（旧模型不可信，退出时清干净标记/空模型） */
  private enterSafe(reason: NonNullable<AgentTilingState['recoveryReason']>): void {
    this.safe = true
    this.recovery = 'safe'
    this.recoveryReason = reason
    this.pendingRestore = null
    this.restoringPass = false
    this.memberOrder = []
    this.tree = null
    this.auth = createGeomAuthLedger()
    this.clearSettleTimers()
    this.logEvent({ type: 'tiling-recovery', status: 'safe', reason })
    this.ctx.emit('tiling/recovery', { status: 'safe', reason })
  }

  /** 恢复状态迁移（同态不重复上行；载荷只有枚举，不含窗口数据） */
  private setRecovery(
    status: AgentTilingState['recovery'],
    reason: AgentTilingState['recoveryReason'],
  ): void {
    if (this.recovery === status && this.recoveryReason === reason) return
    this.recovery = status
    this.recoveryReason = reason
    this.logEvent({ type: 'tiling-recovery', status, reason })
    this.ctx.emit('tiling/recovery', { status, reason })
  }

  /** 持久文档组装（白名单字段；标题/缩略图/授权从不在此出现） */
  private capturePersistDoc(desktopId: string, clean: boolean): AgentLayoutDoc {
    const hwnds: number[] = []
    const push = (hwnd: number): void => {
      if (hwnd > 0 && !hwnds.includes(hwnd)) hwnds.push(hwnd)
    }
    for (const h of this.memberOrder) push(h)
    for (const h of floatingIds(this.auth)) push(h)
    if (this.tree) {
      for (const id of treePlacedIds(this.tree)) push(Number(id))
      for (const leaf of this.tree.queue) if (leaf.id !== null) push(Number(leaf.id))
    }
    const order: WindowIdentity[] = []
    for (const hwnd of hwnds) {
      const identity = this.lastIdentities.get(hwnd)
      if (identity) order.push({ ...identity })
    }
    const floating = floatingIds(this.auth)
      .map((hwnd) => ({ hwnd, rect: floatingRectOf(this.auth, hwnd) }))
      .filter((f): f is { hwnd: number; rect: TileRect } => f.rect !== null)
      .map((f) => ({ hwnd: f.hwnd, rect: f.rect }))
    return captureLayout({ desktopId, clean, order, tree: this.tree, floating })
  }

  /**
   * 模型落盘（原子替换；同内容不重复写）。安全态写**空模型 + 干净标记**——下一轮从活
   * 窗口事实重建，绝不把不可信旧布局再次喂给恢复路径。暂停态保留 pending 文档（模型
   * 不丢，主屏恢复后的下一轮继续 reconciliation）。
   */
  private saveLayout(clean: boolean): void {
    if (!this.layoutFile || !this.layoutLoaded) return
    const desktopId = this.deps.agentDesktopId()
    if (!desktopId) return
    let doc: AgentLayoutDoc
    if (this.safe) {
      doc = { version: 1, desktopId, clean, order: [], tree: null, queue: [], floating: [] }
    } else if (this.pendingRestore) {
      doc = { ...this.pendingRestore, desktopId, clean }
    } else {
      doc = this.capturePersistDoc(desktopId, clean)
    }
    const text = serializeLayout(doc)
    if (!clean && text === this.lastSavedText) return
    try {
      this.deps.writeLayoutText(this.layoutFile, text)
      this.lastSavedText = text
    } catch {
      // 落盘失败：模型仍在内存，下一拍重试（不谎报已持久化）
    }
  }

  /**
   * 干净退出（生产装配在 app before-quit 调用）：把当前模型写成 clean=true，
   * 下一轮正常重启按持久模型恢复；崩溃（未调用本方法）保留 clean=false 标记。
   */
  shutdown(): void {
    if (!this.layoutFile || !this.layoutLoaded) return
    this.saveLayout(true)
  }

  /** 测试驱动口：强制落盘（离线矩阵断言存储内容/隐私口径） */
  flushLayoutForTest(clean = false): void {
    this.saveLayout(clean)
  }

  /** 测试观察缝：恢复状态与原因 */
  recoveryForTest(): { status: AgentTilingState['recovery']; reason: AgentTilingState['recoveryReason'] } {
    return { status: this.recovery, reason: this.recoveryReason }
  }

  /** 测试观察缝：是否处于安全态（停止自动改窗） */
  safeForTest(): boolean {
    return this.safe
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
      recovery: this.recovery,
      recoveryReason: this.recoveryReason,
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
      prev.authorized === next.authorized &&
      prev.recovery === next.recovery &&
      prev.recoveryReason === next.recoveryReason
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
