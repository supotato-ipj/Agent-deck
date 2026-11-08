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
// 功能开关（spec 决策 29）：config agentDesktop.enabled = false（关闭）时本服务
// available=false——零观察、零落位、投影恒空态。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { AgentTilingState, DesktopMode } from '../../shared/contract'
import {
  MAX_PANES,
  MIN_PANE_H,
  MIN_PANE_W,
  bandColumnRects,
  bandColumnWidth,
  bandRevealPx,
  bandTreeArea,
  createTree,
  fitCamera,
  isTileableArea,
  rebaseTreeArea,
  tileAreaOf,
  treeFromShape,
  treeInsert,
  treePlacedIds,
  treePlan,
  treeRemove,
} from '../desktop/tiling-plan'
import type { TilingTree, TilePlacement, TileRect } from '../desktop/tiling-plan'
import { AGENT_LAYOUT_VERSION, captureLayout, identityOf, parseLayout, planRestore, serializeLayout } from '../desktop/agent-layout'
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
  /** 功能开关（config agentDesktop.enabled 下发；生产装配必下发，缺省 = 关——零观察零落位） */
  enabled?: boolean
  /** 事件批处理窗口（ms）：LOCATIONCHANGE 风暴合并（缺省 80ms——500ms 稳定预算的主项） */
  batchMs?: number
  /** 存证日志（诊断面：授权决策与写窗诊断（工单414 tiling-write/tiling-verify/tiling-anomaly）
   *  的 hwnd/矩形/结果/类别/恢复态——不含窗口标题，隐私边界同决策 26） */
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
    /**
     * 前台变化订阅（工单405 单一激活入口——露边点击/任务栏激活等都表现为系统前台变化，
     * 汇入同一 fit 最小滑动）。回调只递新前台 hwnd（轻活）。缺省 noop（离线测试注入
     * 假源后零 FFI，与 onDisplayChanged 同款）；生产装配绑 geom-write.startForegroundWatch。
     */
    onForegroundChanged?: (cb: (hwnd: number) => void) => () => void
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
  onForegroundChanged: (cb: (hwnd: number) => void) => () => void
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
  /** 前台变化订阅停表（工单405 单一激活入口：露边点击/任务栏激活 → fit 最小滑动） */
  private stopForeground: (() => void) | null = null
  /** 视口偏移（工单405，物理 px）：0 = 屏内树满屏（带首列露边可见）；fit 整组滑动改写。
   *  只存偏移语义；锚窗身份的持久化归工单406（spec 决策「持久化布局关系而非旧像素」）。 */
  private camera = 0
  /** 视口锚窗（工单406，spec 决策「持久化布局关系而非旧像素」）：最近前台受管窗 /
   *  最近一次 fit 目标。恢复/重入/重启/显示参数变化后按它的**当前几何**重算 fit——
   *  不存像素偏移。只在内存 + 布局文档 anchor 身份（GLOSSARY「屏外滚动带」）。 */
  private anchorHwnd: number | null = null
  /** 待 fit 目标（前台事件缝置入、下一拍消费，最新赢；本拍末清零） */
  private pendingFitHwnd: number | null = null
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
  /** 一次性待入列交接（工单407）：拖入确认事件的 hwnd 暂存——下次布局拍按交接顺序
   *  并入成员序后清除（不形成第二份持久成员账；只在内存，停表即清） */
  private pendingHandoff: number[] = []
  /** 布局几何账（工单404，spec #403 决策「布局写窗与用户手势分流」）：hwnd → 该窗最近
   *  一次被布局**实际落定**的矩形（写后回读达标，或观察即达标）。判据事实化：窗口停在
   *  上拍布局落定的矩形上、而本轮规划目标变了 → 差异来自兄弟裂变/吸收/重算（布局自身
   *  缩放），是预期写入——不进入授权状态机（不弹框、不浮动、不消费授权）。窗口消失
   *  即清（同 hwnd 复用是新窗身份，不继承旧几何账）。 */
  private lastPlaced = new Map<number, TileRect>()
  /** 会话内最小尺寸下界证据（工单415，spec413「以真实写窗事实学习约束」「约束证据只在
   *  当前会话」）：hwnd → 已观测的尺寸下界 + 观测时的窗口身份。下界只在「写窗受理但
   *  实际尺寸 > 目标尺寸」的维度记录（实际值 = 该维度最小尺寸的下界估计）；只用于插入
   *  前的免撞墙复核（试插新叶低于下界 → 直接入带），带安置本身仍以真实写窗回读为准。
   *  只在内存：不写入布局文档（持久白名单不含）、窗口消失清账、同句柄换身份失效、
   *  显示参数变化清空重评、异常重建清空。 */
  private minSizeFloor = new Map<number, { w: number; h: number; identity: WindowIdentity }>()
  /** 会话内分裂阻断记忆（工单416，spec413「约束证据只在当前会话」）：hwnd → 使其入带的
   *  既有窗阻断者 + 入带时的窗口身份。既有相关窗拒绝分裂目标时本次新窗入带；阻断者仍在
   *  平铺候选期间该窗不重试插树（否则下一拍经队首其他叶绕回树内，与「新窗自身约束」路径
   *  的外部结果不一致——AC「两条路径外部结果一致」）。阻断者退出候选（关闭/异常化/浮动）、
   *  同句柄换身份、显示参数变化、异常重建、停表即释放/清空。只在内存，不写入布局文档。 */
  private splitBlockMemo = new Map<number, { blocker: number; identity: WindowIdentity }>()
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
  /** 干净退出已落盘（工单442）：shutdown 写完 clean=true 后置位——退出撕卸窗内点燃的
   *  平铺拍（撕卸 dispose 引发前台/几何事件的挂起拍或新拍、placing 在途拍）一律停写，
   *  防止拍末 saveLayout(false) 踏平 clean 标记令下一轮重启误走 rebuilt */
  private quitFlushed = false

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
      onForegroundChanged: options.deps?.onForegroundChanged ?? (() => () => undefined), // 无源 noop（离线缺省）
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

  /** 启动（构造后由装配层调用一次）：订阅 workspace/changed 与拖入交接，按当前模式对齐激活态 */
  start(): void {
    if (this.started) return
    this.started = true
    this.ctx.on('workspace/changed', () => this.syncActivation())
    // 拖入一次性交接（工单407）：确认事件暂存待入列——下次布局拍按交接顺序并入成员序
    // 并清除（见 onePass 对账；不形成第二份持久成员账）
    this.ctx.on('tiling/drag-in-registered', (p: { hwnd: number }) => {
      const hwnd = Number(p?.hwnd)
      if (hwnd > 0 && !this.pendingHandoff.includes(hwnd)) this.pendingHandoff.push(hwnd)
    })
    this.syncActivation()
  }

  /** 可用 = 功能开关开（平台能力在 deps 真源侧失败关闭——collectFacts 抛错按本拍不可用） */
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
   * 受管窗豁免集（工单405）：窗口停在布局实际落定的矩形上（lastPlaced 布局几何账，
   * 容差同授权判据）→ 其「屏外」由受管布局自身负责（屏外列、视口滑动），投影不按
   * off-main-screen 踢出——否则带成员被自家写窗推出口径、成员账自毁。用户真实拖走
   * 的窗不再匹配落定矩形、不进豁免集（story 21 移出主屏语义保持）。
   */
  private exemptOffMainFrom(facts: readonly TileWindowFacts[]): number[] {
    const out: number[] = []
    for (const f of facts) {
      const placed = this.lastPlaced.get(f.hwnd)
      if (placed && rectMatches(f.rect, placed, AUTH_CHANGE_TOLERANCE_PX)) out.push(f.hwnd)
    }
    return out
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
      return projectTileScope(facts, this.deps.ownExes(), this.deps.primaryRect(), this.exemptOffMainFrom(facts)).members
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
        // 前台变化（工单405 单一激活入口）：露边点击/任务栏激活都表现为系统前台变化，
        // 汇入同一 fit；回调零 FFI 轻活（置 fit 标 + 批合并），滑动在 pass 内做
        this.stopForeground = this.deps.onForegroundChanged((hwnd) => this.onForegroundEvent(hwnd))
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
    if (this.stopForeground) {
      this.stopForeground()
      this.stopForeground = null
    }
    this.pendingFitHwnd = null
    if (this.batchTimer) {
      clearTimeout(this.batchTimer)
      this.batchTimer = null
    }
    for (const hwnd of revokeAuth(this.auth)) this.ctx.emit('tiling/authorize-closed', { hwnd })
    this.clearSettleTimers()
    this.echoLedger.clear()
    this.placing = false
    this.pendingPass = false
    // 尺寸能力证据不跨桌面失活泄漏（工单417，spec413「窗口消失、桌面失活、显示参数
    // 变化或异常重建时按既有生命周期清理或重新评估」）：失活即清 minSize 下界与分裂
    // 阻断记忆——重入按当前事实重评，过期约束不把窗口钉死在带里（story 31/32）
    this.minSizeFloor.clear()
    this.splitBlockMemo.clear()
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
    this.lastPlaced.clear()
    this.clearSettleTimers()
    clearFloating(this.auth)
    this.auth = createGeomAuthLedger()
    this.lastState = null
    this.camera = 0
    this.anchorHwnd = null
    this.pendingFitHwnd = null
    this.layoutLoaded = false
    this.pendingRestore = null
    this.pendingHandoff = []
    this.safe = false
    this.recovery = 'none'
    this.recoveryReason = null
    this.restoringPass = false
    this.lastIdentities.clear()
    this.minSizeFloor.clear() // 工单415：尺寸能力证据只在当前会话（停表即清）
    this.splitBlockMemo.clear() // 工单416：分裂阻断记忆同上（停表即清）
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

  /**
   * 前台变化（工单405 单一激活入口，spec 决策「单一激活入口执行 fit」）：露边点击、
   * 任务栏等普通激活都表现为系统前台变化，汇入同一 fit 最小滑动。只对受管成员
   * （memberOrder = 平铺/带成员，浮动与异常不在册）请求滑动；非成员（面板自家窗、
   * 无关窗）忽略。回调体内零 FFI——置 fit 标并批合并，滑动在 pass 内做。
   */
  private onForegroundEvent(hwnd: number): void {
    if (!this.available() || !this.stopForeground) return
    if (!this.memberOrder.includes(hwnd)) return
    this.anchorHwnd = hwnd // 最近前台受管窗 = 视口锚（工单406，story 30）
    this.pendingFitHwnd = hwnd
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
   * 恢复平铺（工单378 决策 11 + 工单406，GLOSSARY「恢复平铺」「窗口聚焦」）：收回全部
   * 手动浮动（按进入浮动序重新补入平铺）、清除未消费授权、按空间补入屏外带；异常未平铺
   * 跳过并报告数量（skipped）。返回被收回的浮动窗数（restored）与跳过数，调用方（胶囊）
   * 据此报告。
   *
   * 视口锚（工单406）：`fitHwnd` 显式目标（聚焦退出 = 刚退出聚焦的窗，GLOSSARY「窗口
   * 聚焦」「随后按 fit 显示刚退出聚焦的窗口」）优先；否则当前前台受管窗（GLOSSARY
   * 「恢复平铺」「以当前前台受管窗为视图锚点执行 fit」）；再否则保留既有锚窗（story 29
   * 「保留当前锚窗」）；全无有效锚才回布局起点（视口归零）。
   */
  async restoreTiling(fitHwnd?: number): Promise<{ ok: boolean; restored: number; skipped: number; state: AgentTilingState }> {
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
    let target = typeof fitHwnd === 'number' && Number.isFinite(fitHwnd) && fitHwnd > 0 ? fitHwnd : null
    if (target === null) {
      for (const hwnd of this.memberOrder) {
        if (this.deps.isForeground(hwnd)) { target = hwnd; break }
      }
    }
    if (target !== null) {
      // 聚焦退出路径：挂起先解（退出窗的还原几何不是用户改几何；调用方随后 setTilingHeld(null) 幂等）
      if (this.heldHwnd === target) this.heldHwnd = null
      this.anchorHwnd = target
      this.pendingFitHwnd = target
    } else if (this.anchorHwnd === null) {
      this.camera = 0 // 无有效锚：回屏内二叉布局起点（story 29 只在「有锚」时保视口）
    }
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
    // 受管窗豁免（工单405）：屏外带成员/视口滑动推出的屏内窗不按副屏踢出（见 helper 头注）
    const projection = projectTileScope(facts, this.deps.ownExes(), primary, this.exemptOffMainFrom(facts))
    const members = projection.members
    // 显示参数变化拍（story 23）：区缩小后旧成员矩形落在新主屏外——它们仍是同一块
    // 物理屏幕上的窗，只是几何还没重算。把「此前在树里、只因 off-main-screen 被排」
    // 的成员纳回本轮（随后按新面积重算落位，不再屏外）。普通拍不纳回：用户把窗拖去
    // 副屏 = 真移出主屏（story 21 退出平铺）。
    if (this.displayDirty) {
      const placed = this.tree ? new Set<string>([...treePlacedIds(this.tree), ...this.tree.overflow]) : new Set<string>()
      const factById = new Map(facts.map((f) => [f.hwnd, f] as const))
      for (const ex of projection.excluded) {
        if (ex.reason !== 'off-main-screen' || !placed.has(String(ex.hwnd))) continue
        const f = factById.get(ex.hwnd)
        if (f) members.push(f)
      }
      this.displayDirty = false
      // 显示参数变化：尺寸能力证据清空重评（spec413 story 31/32——旧会话/旧显示条件下的
      // 像素经验不把约束锁死，随后的写窗事实重新学习）
      this.minSizeFloor.clear()
      this.splitBlockMemo.clear() // 工单416：阻断约束随显示条件一并重评
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
        this.logEvent({
          type: 'tiling-anomaly', hwnd: m.hwnd, kind: 'fixed-size',
          recovery: this.recovery, recoveryReason: this.recoveryReason,
        })
      }
    }
    // 窗口消失清账（含异常账与授权账）：同一 hwnd 复用是新窗身份，不继承旧状态
    for (const h of [...this.anomalies]) {
      if (!memberSet.has(h)) clearAnomaly(this.anomalies, this.anomalyKinds, h)
    }
    // 尝试账与布局几何账随窗口消失清账（工单404）：旧窗残留的重试计数会让同 hwnd 新窗
    // 首拍就达异常上限；旧几何账会让新窗首拍被误判成布局位移
    for (const h of this.attempts.keys()) {
      if (!memberSet.has(h)) this.attempts.delete(h)
    }
    for (const h of this.lastPlaced.keys()) {
      if (!memberSet.has(h)) this.lastPlaced.delete(h)
    }
    // 尺寸能力证据随窗口消失清账（工单415）：证据不跨窗口身份存活
    for (const h of this.minSizeFloor.keys()) {
      if (!memberSet.has(h)) this.minSizeFloor.delete(h)
    }
    // 分裂阻断记忆随窗口消失清账（工单416）：同句柄复用是新窗身份，不继承阻断
    for (const h of this.splitBlockMemo.keys()) {
      if (!memberSet.has(h)) this.splitBlockMemo.delete(h)
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
    // 本拍「既有成员」快照先于拖入交接对账取（工单408）：交接并入的窗是本拍新成员，
    // 持前台时仍走前台新窗 fit 滑入（story 20/43「进入 Agent 后自动完成实际平铺」）；
    // 快照若晚于合并，交接成员会被误判成既有成员而永远跳过 fit。
    const prevOrder = new Set(this.memberOrder)
    // 拖入交接对账（工单407）：确认过的待入列窗按交接顺序并入成员序——交接序优先于
    // 本拍 z 序（story 41「连续拖入的顺序可预测」）。已消费条目即清；窗口已从事实里
    // 消失（拖入后关闭）的条目丢弃——暂存账不沉淀。
    if (this.pendingHandoff.length > 0) {
      const factHwnds = new Set(facts.map((f) => f.hwnd))
      for (const hwnd of this.pendingHandoff) {
        if (candSet.has(hwnd) && !this.memberOrder.includes(hwnd)) this.memberOrder.push(hwnd)
      }
      // 消费即清：已并入成员序的条目移除；窗口已从事实消失（拖入后关闭）的条目丢弃；
      // 只剩「事实在场但还不合格」的条目留待下拍（暂存账不沉淀为第二份成员账）
      this.pendingHandoff = this.pendingHandoff.filter((h) => !this.memberOrder.includes(h) && factHwnds.has(h))
    }
    // 成员加入序对账：保留在册序，新成员按本拍 z 序追加队尾（首见序 = 加入事件序——
    // 移回主屏按最新窗口加入，story 21）
    this.memberOrder = this.memberOrder.filter((h) => candSet.has(h))
    for (const m of candidates) {
      if (!this.memberOrder.includes(m.hwnd)) this.memberOrder.push(m.hwnd)
    }
    // 前台新窗滑入（工单405，story 20）：新成员持前台 → 本拍 fit 目标（z 序首个 =
    // 最前台）；后台新窗只入列不动视口（story 21——无 fit 标即视口原位）
    for (const m of candidates) {
      if (prevOrder.has(m.hwnd) || m.iconic) continue
      if (this.deps.isForeground(m.hwnd)) {
        this.pendingFitHwnd = m.hwnd
        break
      }
    }
    // 关闭屏内当前窗跟随系统新前台（工单406，story 27）：锚窗消失（关闭/移出主屏）→
    // 系统新前台受管窗成为本拍 fit 目标（显式前台事件已置目标时让位）；无受管前台 →
    // 不猜锚，视口仅按内容右端钳制（不留空白视口，story 28）。
    if (this.anchorHwnd !== null && !memberSet.has(this.anchorHwnd)) {
      this.anchorHwnd = null
      if (this.pendingFitHwnd === null) {
        for (const m of candidates) {
          if (!m.iconic && this.deps.isForeground(m.hwnd)) {
            this.pendingFitHwnd = m.hwnd
            break
          }
        }
      }
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
    // 树生命周期（工单377 + 工单405 屏外滚动带）：平铺区变化（分辨率/DPI/主屏）→ 按
    // 成员序重建（重算语义，story 23）；成员消失 → 兄弟吸收（story 20）；成员新增/溢出
    // 补入 → 按成员序裂变插入（story 17 队列续行 / story 29 按序补入）。带非空时屏内
    // 树区右缘让出露边（GLOSSARY「屏外滚动带」——带首列左缘恰好落树区右缘，露边 32px
    // 露在屏内右缘且与树窗格零重叠）；带空↔非空迁移整树 rebase（原型 syncArea 语义）。
    const bandBefore = this.tree ? [...this.tree.overflow] : []
    const bandWasEmpty = bandBefore.length === 0
    const bandReveal = bandRevealPx(minPane.w)
    const treeArea = bandWasEmpty ? area : bandTreeArea(area, bandReveal)
    if (
      !this.tree ||
      !rectEq(this.tree.area, treeArea) ||
      this.tree.minPaneW !== minPane.w ||
      this.tree.minPaneH !== minPane.h ||
      this.tree.maxPanes !== MAX_PANES
    ) {
      this.tree = createTree(treeArea, { minPaneW: minPane.w, minPaneH: minPane.h })
    }
    for (const id of [...treePlacedIds(this.tree)]) {
      if (!candSet.has(Number(id))) treeRemove(this.tree, id)
    }
    this.tree.overflow = this.tree.overflow.filter((id) => candSet.has(Number(id)))
    // 本拍之前已在树里的窗（工单378）：只有「曾经落格、现在几何不对」才是用户/后台改了几何；
    // 新成员首拍的几何差异是正常落位，不进入授权判定（不给新窗弹授权框）。
    // 带成员同属受管账（工单405——用户拖动带成员与拖动屏内窗同一授权语义）。
    const knownPlaced = new Set(treePlacedIds(this.tree))
    const bandBeforeIds = new Set(bandBefore)
    // 工单416：本拍「新落格窗 → 被其裂变的叶占据者」对账表——既有窗夹取时据此级联回退
    const splitParent = new Map<string, string>()
    // 工单417：本拍插树成功集合——其树分裂目标被夹取时按容量回退入带（含带成员恢复
    // 重评/按序补入的插树重试；判据是「本拍新落格」而非「拍前不在带内」）
    const insertedNow = new Set<string>()
    for (const hwnd of this.memberOrder) {
      const idStr = String(hwnd)
      // 分裂阻断记忆（工单416）：阻断者仍在候选且身份未变 → 不重试插树（保持带成员，
      // 与「新窗自身约束」路径的下一拍稳定口径一致）；阻断者退出候选/身份更替即释放，
      // 恢复既有按序补入（story 23）
      const memo = this.splitBlockMemo.get(hwnd)
      if (memo) {
        const ident = this.lastIdentities.get(hwnd)
        if (
          !ident || ident.pid !== memo.identity.pid || ident.exe !== memo.identity.exe ||
          !candSet.has(memo.blocker)
        ) {
          this.splitBlockMemo.delete(hwnd)
        } else {
          continue
        }
      }
      // 同句柄新身份/身份不明：旧证据不继承（spec413 会话边界；复核处仍逐窗验身份）
      const floor = this.minSizeFloor.get(hwnd)
      if (floor) {
        const ident = this.lastIdentities.get(hwnd)
        if (!ident || ident.pid !== floor.identity.pid || ident.exe !== floor.identity.exe) {
          this.minSizeFloor.delete(hwnd)
        }
      }
      // 已在树=幂等（无裂变、无复核面）；新落格才试插复核并记录裂变对
      const wasPlaced = treePlacedIds(this.tree).has(idStr)
      const before = wasPlaced ? null : treePlan(this.tree)
      let placedNow = false
      if (treeInsert(this.tree, idStr) === 'placed' && !wasPlaced) {
        // 试插复核（工单415 自身下界 + 工单416 既有窗下界统一口径）：试插改动的任一
        // 窗格（新叶或被裂叶）低于其占据者的已观测下界 → 免撞墙回退入带（treeRemove
        // 兄弟吸收自动重展被裂叶）；下界只是复核，带安置仍以真实写窗回读为准
        const after = treePlan(this.tree)
        let violates = false
        let parent: string | null = null
        for (const p of after.placements) {
          const b = before!.placements.find((q) => q.id === p.id) // !wasPlaced ⇒ before 必非空
          if (b && rectEq(b.rect, p.rect)) continue // 本次插入未触及的窗格
          const f = this.minSizeFloor.get(Number(p.id))
          const pid = this.lastIdentities.get(Number(p.id))
          if (f && pid && pid.pid === f.identity.pid && pid.exe === f.identity.exe &&
            (p.rect.right - p.rect.left < f.w || p.rect.bottom - p.rect.top < f.h)) {
            violates = true
            break
          }
          if (b) parent = p.id // 矩形被本次裂变改变的既有占据者（至多一个）
        }
        if (violates) {
          treeRemove(this.tree, idStr)
          if (!this.tree.overflow.includes(idStr)) this.tree.overflow.push(idStr)
        } else {
          placedNow = true
          insertedNow.add(idStr)
          if (parent) splitParent.set(idStr, parent)
        }
      }
    }
    // 带空↔非空迁移：整树 rebase（带出现树让位露边、带清空树回满区——矩形重展、
    // 结构/轴/队列引用不变）
    const bandEmptyNow = this.tree.overflow.length === 0
    if (bandWasEmpty !== bandEmptyNow) {
      rebaseTreeArea(this.tree, bandEmptyNow ? area : bandTreeArea(area, bandReveal))
    }
    const rectByHwnd = new Map(members.map((m) => [Number(m.hwnd), m.rect] as const))
    const iconicByHwnd = new Map(members.map((m) => [Number(m.hwnd), m.iconic] as const))

    // —— 工单405 带几何与视口（连续坐标；物理目标 = 连续 − 视口偏移）——
    // 列宽/露边按主屏缩放换算（与 minPane 同源：320 逻辑 ↔ minPane.w）；列矩形按带
    // 进入序（tree.overflow 序）依次向右相邻排列。
    const tree = this.tree
    const bandColW = bandColumnWidth(area.right - area.left, minPane.w)
    const bandCols = (): TileRect[] => bandColumnRects(area, tree.overflow.length, bandColW, bandReveal)
    // fit 决策（单一激活入口）：露边点击/任务栏等普通激活（前台事件缝 pendingFitHwnd）、
    // 前台新窗。目标须在本拍受管账（树或带）且非挂起/浮动/异常/最小化——否则视口不动。
    const fitHwnd = this.pendingFitHwnd
    this.pendingFitHwnd = null
    let plan = treePlan(tree)
    // 单一 fit 计算（工单405 显式事件与工单406 锚窗跟随共用同一条最小滑动路径）
    const applyFit = (hwnd: number): boolean => {
      const idStr = String(hwnd)
      const bandIdx = tree.overflow.indexOf(idStr)
      const treeIdx = plan.placements.findIndex((p) => p.id === idStr)
      const managed = bandIdx >= 0 || treeIdx >= 0
      const suspended =
        hwnd === this.heldHwnd ||
        isFloating(this.auth, hwnd) ||
        this.anomalies.has(hwnd) ||
        (iconicByHwnd.get(hwnd) ?? false)
      if (!managed || suspended) return false
      const onBand = bandIdx >= 0
      const rect = onBand ? bandCols()[bandIdx] : plan.placements[treeIdx].rect
      this.camera = fitCamera(this.camera, rect, area, {
        leftPeek: onBand ? bandReveal : 0,
        rightPeek: onBand
          ? bandIdx < tree.overflow.length - 1 ? bandReveal : 0
          : tree.overflow.length > 0 ? bandReveal : 0,
        contentRight: area.right - bandReveal + tree.overflow.length * bandColW,
      })
      this.anchorHwnd = hwnd
      return true
    }
    // 单一 fit 决策（显式事件与锚窗跟随共用；工单415 容量回退重排后复核复用同一闭包）
    const resolveFit = (): void => {
      if (fitHwnd !== null) {
        applyFit(fitHwnd)
      } else if (this.anchorHwnd !== null) {
        // 锚窗跟随（工单406）：显式 fit 事件缺位时，锚窗的物理矩形若不再完整可见（兄弟
        // 吸收/带补入/列收拢/显示重算动了它的目标矩形），按同一 fit 最小滑动回锚；已完整
        // 可见则零移动（幂等——story 21 后台事件不动视口的前提是锚窗可见性未破）。
        const idStr = String(this.anchorHwnd)
        const bandIdx = tree.overflow.indexOf(idStr)
        const treeIdx = plan.placements.findIndex((p) => p.id === idStr)
        const rect = bandIdx >= 0
          ? bandCols()[bandIdx]
          : treeIdx >= 0 ? plan.placements[treeIdx].rect : null
        const visible = rect !== null &&
          rect.left - this.camera >= area.left &&
          rect.right - this.camera <= area.right
        if (!visible) applyFit(this.anchorHwnd)
      }
    }
    resolveFit()
    // 物理目标（整组最小滑动）：视口先钳到内容右端（带收拢后不留空白视口——story 28），
    // 再对全部受管窗按 −camera 平移。屏幕外带列与屏内树同一平移（GLOSSARY「屏外滚动带」）。
    const targets = (): TilePlacement[] => {
      const len = tree.overflow.length
      const contentRight = area.right - bandReveal + len * bandColW
      this.camera = Math.min(Math.max(this.camera, 0), Math.max(0, contentRight - area.right))
      const shift = (r: TileRect): TileRect => ({ ...r, left: r.left - this.camera, right: r.right - this.camera })
      const out: TilePlacement[] = plan.placements.map((p) => ({ id: p.id, rect: shift(p.rect) }))
      const cols = bandCols()
      for (let i = 0; i < len; i++) out.push({ id: tree.overflow[i], rect: shift(cols[i]) })
      return out
    }
    let currentTargets = targets()

    // —— 工单378 授权决策（先于写集：复原/浮动改变本轮写集与树形）——
    // 计一组：本拍需复原的窗（提示期持续复原 / 首次操作复原）与需上行提示的窗。
    const newPromptSet = new Set<number>()
    const floatSet: number[] = []
    const floatingRestore = new Map<number, TileRect>()
    for (const p of currentTargets) {
      const hwnd = Number(p.id)
      if (hwnd === this.heldHwnd) continue // 聚焦目标（工单379）：最大化不是用户改几何
      if (iconicByHwnd.get(hwnd)) continue // 最小化不算用户改几何（还原事件触发下一拍）
      if (!knownPlaced.has(p.id) && !bandBeforeIds.has(p.id)) continue // 新成员落位/入带：正常写，不授权
      const current = rectByHwnd.get(hwnd)
      if (!current) continue
      const changed = !rectMatches(current, p.rect, AUTH_CHANGE_TOLERANCE_PX)
      if (!changed) {
        // 窗确实在目标上：记入布局几何账（后续目标变化即可判定为布局自身缩放，工单404）
        this.lastPlaced.set(hwnd, { ...p.rect })
        continue
      }
      if (this.restoringPass) continue // 恢复轮：按持久模型落位，不是用户改几何（不弹框）
      // 布局自身缩放分流（工单404，spec #403 决策「布局写窗与用户手势分流」）：窗口仍停
      // 在上一拍布局实际落定的矩形上 → 本轮目标变化来自兄弟裂变/吸收/重算/整组滑动
      // （工单405 fit），是预期写入，不进入授权状态机（locked 不弹框、armed 不浮动不
      // 消费授权）。回声判据救不了这条：期望账在写后核验达标即清，旧矩形不在账里——
      // 必须按布局几何账判。
      const prevPlaced = this.lastPlaced.get(hwnd)
      if (prevPlaced && rectMatches(current, prevPlaced, AUTH_CHANGE_TOLERANCE_PX)) continue
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
    // 浮动者退出平铺树/带（其余成员重新铺满——浮动窗可覆盖窗格；带成员浮动 = 出带，
    // 带收拢列左移）并重规划本轮写集
    if (floatSet.length > 0) {
      for (const hwnd of floatSet) {
        const rect = rectByHwnd.get(hwnd)
        if (rect) enterFloating(this.auth, hwnd, rect)
        this.armSettle(hwnd)
        treeRemove(this.tree, String(hwnd))
      }
      plan = treePlan(this.tree)
      currentTargets = targets()
    }

    // 写集：规划目标 × 当前矩形比对（异常窗跳过、最小化跳过、已达标不重写）。
    // 屏外带成员与屏内窗同一写路径（工单405——带列矩形是布局目标，不是未平铺原矩形）。
    const assignments = currentTargets
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
      // 低敏写窗诊断（工单414）：句柄/目标矩形/写窗结果当拍落事件（不含标题等敏感字段）
      this.logEvent({ type: 'tiling-write', hwnd: w.hwnd, target: { ...w.target }, ok, phase: 'place' })
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
      this.logEvent({ type: 'tiling-write', hwnd, target: { ...target }, ok, phase: 'restore' })
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
    const verifyOnce = (hwnd: number, target: TileRect): 'ok' | 'retry' | 'anomaly' => {
      const attempt = (this.attempts.get(hwnd) ?? 0) + 1 // 本次核验的尝试序（verifyWriteOutcome 内计次）
      const actual = this.deps.readRect(hwnd)
      const verdict = verifyWriteOutcome(this.attempts, this.anomalies, hwnd, actual, target)
      // 低敏写窗诊断（工单414）：目标 vs 实际矩形 + 核验结论——区分尺寸夹取（受理+不达标）、
      // 权限拒绝（ok=false）与异步时序的当拍证据（spec 413 维护者故事 39）
      this.logEvent({
        type: 'tiling-verify', hwnd, target: { ...target },
        actual: actual ? { ...actual } : null, verdict, attempt,
      })
      return verdict
    }
    const settleOk = (hwnd: number, target: TileRect): void => {
      retractPending(this.echoLedger, hwnd) // 达标：期望矩形已落地，回声账清零
      this.lastPlaced.set(hwnd, { ...target }) // 布局几何账：窗确实在此（工单404）
    }
    let retries: Array<{ hwnd: number; target: TileRect }> = []
    // 工单415/416 两级安置降级（spec413）：分裂目标对任一相关窗不可行（写「受理」但
    // 回读被最小尺寸等夹取）→ 由本次新窗收集容量回退，不再对同一目标有界重写（那只会
    // 撞同一堵墙并异常化）。分轴不动：写窗被系统拒绝（restoreRect false）仍走 write-denied。
    const bandFallbacks: Array<{ hwnd: number; target: TileRect; actual: ScopeRect | null }> = []
    // 工单416：既有窗（分裂父叶占据者）夹取——新窗承担回退，既有窗回退到分裂前目标
    const existingClips: Array<{ hwnd: number; target: TileRect; actual: ScopeRect | null }> = []
    for (const w of outcomes) {
      const verdict = verifyOnce(w.hwnd, w.target)
      if (verdict === 'ok') settleOk(w.hwnd, w.target)
      if (
        verdict === 'retry' &&
        !writeFailed.has(w.hwnd) && // 受理（false = 系统拒绝，不入容量回退）
        !isFloating(this.auth, w.hwnd) // 浮动复原写不参与平铺回退
      ) {
        if (insertedNow.has(String(w.hwnd))) {
          // 本次新落格（工单415 自身约束；工单417 扩展到带成员恢复重评/按序补入的插树
          // 重试——判据是「本拍插树成功」，其夹取目标是树分裂窗格而非带列）
          bandFallbacks.push({ hwnd: w.hwnd, target: w.target, actual: this.deps.readRect(w.hwnd) })
          continue
        }
        if (knownPlaced.has(String(w.hwnd))) {
          // 既有窗约束（工单416）：树成员夹取 → 分裂不可行，走回退
          existingClips.push({ hwnd: w.hwnd, target: w.target, actual: this.deps.readRect(w.hwnd) })
          continue
        }
        // 其余（带成员列位写、8 上限直接入带的带列写——均未插树）：带列 = 屏外列本身，
        // 夹取即屏外列也不可接受——保持既有有界重写 → 最终 refused
        // （spec413「屏外目标也失败时保留最终异常分类」）
      }
      if (verdict === 'retry') retries.push({ hwnd: w.hwnd, target: w.target })
      if (verdict === 'anomaly' && !this.anomalyKinds.has(w.hwnd)) {
        const kind = writeFailed.has(w.hwnd) ? 'write-denied' : 'refused'
        this.anomalyKinds.set(w.hwnd, kind)
        this.logEvent({
          type: 'tiling-anomaly', hwnd: w.hwnd, kind,
          recovery: this.recovery, recoveryReason: this.recoveryReason,
        })
      }
    }
    // —— 容量回退入带（工单415/416）：分裂完全回退 + 带安置同拍完成（不留半分裂一拍）——
    // 新窗承担回退（spec413）：既有成员保持分裂前窗格（treeRemove 兄弟自动重展）、
    // 树形与相对顺序不变；本窗入带序尾后按带列安置。既有窗夹取（工单416）时级联移除
    // 其裂变对新窗（含进一步裂变这些新窗的后续新窗），并记分裂阻断记忆（阻断者退出候选
    // 前不重试插树）。带空→非空迁移沿用规划期同一 rebase 语义（树区让出露边 32px）。
    // 回退写逐窗回读（phase='rollback'）：既有窗回退未达标 → 达上限即显式 refused 异常
    // （不只恢复账面树）。屏外列也夹取时核验自然达上限 → 最终 refused。有限写入：每窗
    // 每拍 ≤ MAX_WRITE_ATTEMPTS 次写。
    const rollbackHwnds = new Set<number>()
    if (bandFallbacks.length > 0 || existingClips.length > 0) {
      const adds: Array<{
        hwnd: number; cause: 'self' | 'existing'; target: TileRect; actual: ScopeRect | null
      }> = []
      for (const fb of bandFallbacks) adds.push({ ...fb, cause: 'self' })
      for (const ec of existingClips) {
        // 级联回退集（工单416）：裂变父叶 = 该既有窗的新窗，加上进一步裂变这些新窗的
        // 后续新窗——一次性完全回退到分裂前树形
        const doomed = new Set<string>()
        const stack = [String(ec.hwnd)]
        while (stack.length > 0) {
          const parent = stack.pop() as string
          for (const [nid, pid] of splitParent) {
            if (pid === parent && !doomed.has(nid)) {
              doomed.add(nid)
              stack.push(nid)
            }
          }
        }
        for (const nid of doomed) {
          if (adds.some((a) => String(a.hwnd) === nid) || tree.overflow.includes(nid)) continue
          // 分裂阻断记忆（工单416，会话内证据不持久化）：阻断约束未解除前不重试插树
          const nident = this.lastIdentities.get(Number(nid))
          if (nident) this.splitBlockMemo.set(Number(nid), { blocker: ec.hwnd, identity: nident })
          const oc = outcomes.find((w) => String(w.hwnd) === nid)
          adds.push({
            hwnd: Number(nid), cause: 'existing',
            target: oc ? oc.target : ec.target,
            actual: this.deps.readRect(Number(nid)),
          })
        }
        // 既有窗的真实约束同样学习为会话内证据（spec413「以真实写窗事实学习约束」）
        this.learnMinSizeFloor(ec.hwnd, ec.target, ec.actual, this.lastIdentities.get(ec.hwnd))
        rollbackHwnds.add(ec.hwnd)
        // 低敏回退诊断（spec413 story 39）：句柄/目标/实际/恢复态当拍落事件
        this.logEvent({
          type: 'tiling-split-rollback', hwnd: ec.hwnd,
          target: { ...ec.target }, actual: ec.actual ? { ...ec.actual } : null,
          recovery: this.recovery, recoveryReason: this.recoveryReason,
        })
      }
      // 带空→非空迁移的 rebase 以「回退前溢出账」为准（工单417）：本拍插树可能已把带
      // 清空并 rebase 回满区（如桌面重入重评、按序补入后被夹取），回退重新入带须再次
      // 让位；拍首带本非空且中途未清空时不重复 rebase
      const overflowEmptyBeforeAdds = tree.overflow.length === 0
      for (const a of adds) {
        treeRemove(tree, String(a.hwnd))
        if (!tree.overflow.includes(String(a.hwnd))) tree.overflow.push(String(a.hwnd))
        if (a.cause === 'self') {
          // 以真实写窗事实学习约束（spec413）：只在「实际 > 目标」的维度记下界，会话内有效
          this.learnMinSizeFloor(a.hwnd, a.target, a.actual, this.lastIdentities.get(a.hwnd))
        }
        // 低敏回退诊断（spec413 决策「记录有界的写窗/回退结果」）：句柄/成因/目标/实际/恢复态
        this.logEvent({
          type: 'tiling-band-fallback', hwnd: a.hwnd, cause: a.cause,
          target: { ...a.target }, actual: a.actual ? { ...a.actual } : null,
          recovery: this.recovery, recoveryReason: this.recoveryReason,
        })
      }
      if (overflowEmptyBeforeAdds && tree.overflow.length > 0) {
        rebaseTreeArea(tree, bandTreeArea(area, bandReveal))
      }
      plan = treePlan(tree)
      resolveFit() // 前台新窗入带自动滑入 / 锚窗可见性复核（同一 fit 最小滑动路径，story 18）
      currentTargets = targets()
      const assignments2 = currentTargets
        .filter((p) => Number(p.id) !== this.heldHwnd) // 挂起窗不写（同首轮写集口径）
        .map((p) => {
          const hwnd = Number(p.id)
          // current 用当拍真实回读（工单417，spec413 story 38「状态投影以真实矩形回读
          // 为准」）：拍首快照会把「本拍内已被分裂尝试写过」的窗判成仍在目标位（如桌面
          // 重入重评时窗拍首恰在带列位），漏掉回退安置写、留下夹取残影
          return { hwnd, target: p.rect, iconic: iconicByHwnd.get(hwnd) ?? false, current: this.deps.readRect(hwnd) }
        })
      for (const w of planWrites(assignments2, this.anomalies)) {
        const phase = rollbackHwnds.has(w.hwnd) ? 'rollback' : 'band-fallback'
        recordPending(this.echoLedger, w.hwnd, w.target, now)
        const ok = this.deps.restoreRect(w.hwnd, w.target)
        this.logEvent({ type: 'tiling-write', hwnd: w.hwnd, target: { ...w.target }, ok, phase })
        writeOk.set(w.hwnd, ok)
        if (!ok) {
          retractPending(this.echoLedger, w.hwnd)
          writeFailed.add(w.hwnd)
        }
        const verdict = verifyOnce(w.hwnd, w.target)
        if (verdict === 'ok') settleOk(w.hwnd, w.target)
        if (verdict === 'retry') retries.push({ hwnd: w.hwnd, target: w.target })
        if (verdict === 'anomaly' && !this.anomalyKinds.has(w.hwnd)) {
          const kind = writeFailed.has(w.hwnd) ? 'write-denied' : 'refused'
          this.anomalyKinds.set(w.hwnd, kind)
          this.logEvent({
            type: 'tiling-anomaly', hwnd: w.hwnd, kind,
            recovery: this.recovery, recoveryReason: this.recoveryReason,
          })
        }
      }
      // 回退重算改了目标：回退前登记的 retry 只保留目标仍与当前规划一致的
      //（浮动复原不在规划内，原样保留）
      retries = retries.filter((w) => {
        const p = currentTargets.find((t) => Number(t.id) === w.hwnd)
        return p ? rectEq(p.rect, w.target) : isFloating(this.auth, w.hwnd)
      })
    }
    // 写窗收敛闭环（工单404，spec #403 决策「以实际几何收敛为准」）：retry 不再等下一次
    // 窗口事件——同一拍内有界重写（尝试账已计次，MAX_WRITE_ATTEMPTS 内收敛或异常化），
    // 完全无后续事件也能收敛或进入明确错误态。首轮 retry 必已计 1 次，本轮再不达标即达
    // 上限——每窗每拍至多 MAX_WRITE_ATTEMPTS 次写，有界。
    for (const w of retries) {
      recordPending(this.echoLedger, w.hwnd, w.target, now)
      const ok = this.deps.restoreRect(w.hwnd, w.target)
      this.logEvent({ type: 'tiling-write', hwnd: w.hwnd, target: { ...w.target }, ok, phase: 'retry' })
      writeOk.set(w.hwnd, ok)
      if (!ok) retractPending(this.echoLedger, w.hwnd)
      const verdict = verifyOnce(w.hwnd, w.target)
      if (verdict === 'ok') settleOk(w.hwnd, w.target)
      if (verdict === 'anomaly' && !this.anomalyKinds.has(w.hwnd)) {
        const kind = ok ? 'refused' : 'write-denied'
        this.anomalyKinds.set(w.hwnd, kind)
        this.logEvent({
          type: 'tiling-anomaly', hwnd: w.hwnd, kind,
          recovery: this.recovery, recoveryReason: this.recoveryReason,
        })
      }
      // verdict 'retry' 在本轮不可能（MAX_WRITE_ATTEMPTS=2，首轮已计 1）——防御上不再
      // 第三写，残数留待下一拍（跨拍计次仍单调，有界性不破）
    }
    pruneLedger(this.echoLedger, Date.now())

    // 授权提示上行（工单378 决策 10）：复原受理后显示「调整窗口/保持平铺」；写失败/
    // 异常化的窗不提示（无从授权），并清掉残留阶段（不反复弹窗）
    for (const hwnd of newPromptSet) {
      if (this.anomalies.has(hwnd)) continue
      if (writeOk.get(hwnd) === false) continue
      beginPrompt(this.auth, hwnd)
      const target = currentTargets.find((p) => Number(p.id) === hwnd)?.rect ?? floatingRectOf(this.auth, hwnd)
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

  /**
   * 记录会话内尺寸能力证据（工单415，spec413「以真实写窗事实学习约束」）：写入被受理
   * 但某维度实际尺寸 > 目标尺寸 = 该维度被应用最小尺寸夹取，实际值即下界估计（分量
   * 取历史最大）。同句柄身份变化（pid/exe 不符）即弃旧重学；不持久化（布局文档白名单
   * 不含）、不跨窗口身份。下界只用于插入前复核（免反复撞墙），带安置仍以真实回读为准。
   */
  private learnMinSizeFloor(
    hwnd: number,
    target: TileRect,
    actual: ScopeRect | null,
    identity: WindowIdentity | undefined,
  ): void {
    if (!actual || !identity) return
    const prev = this.minSizeFloor.get(hwnd)
    const stale = prev !== undefined &&
      (prev.identity.pid !== identity.pid || prev.identity.exe !== identity.exe)
    const base = stale || prev === undefined ? { w: 0, h: 0, identity } : prev
    const tw = target.right - target.left
    const th = target.bottom - target.top
    const aw = actual.right - actual.left
    const ah = actual.bottom - actual.top
    this.minSizeFloor.set(hwnd, {
      w: aw > tw ? Math.max(base.w, aw) : base.w,
      h: ah > th ? Math.max(base.h, ah) : base.h,
      identity,
    })
  }

  // ————————————————————————————————————————————————————————————
  // 重启恢复（工单383，spec #369 决策 13 桌面持久化 + 决策 16 恢复与故障矩阵）
  // ————————————————————————————————————————————————————————————

  /**
   * 恢复一拍（纯编排，IO 经 deps 注入）：首激活读一次持久文档；之后每拍重试暂停态。
   * 返回 false = 本拍停止自动改窗（安全态/主屏暂不可用）——调用方零写集、原地保留模型。
   *
   * 判据顺序（安全态即停止，不猜、不修补；工单410 升版）：
   *  1. 持久文档解析/结构不一致 → model；
   *  2. 存储桌面 ID 与当前配对 Agent 桌面不一致 → desktop-id（不猜接管未知桌面——
   *     重建规则同样不接管，story 22）；
   *  3. 上次会话未干净退出（clean=false）→ 异常重建（recovery=rebuilt）：旧成员顺序、
   *     树形、队列、屏外顺序、锚窗和浮动记录全部不应用，平铺不停用——按当前 Agent 桌面
   *     合格窗口及当次事件顺序重建新成员序（正常屏内/屏外规划与实际几何回读收敛）；
   *  4. 干净退出 → pendingRestore 按持久模型恢复（同 hwnd exe/pid 不符 → window-identity；
   *     异常重建不采用旧窗口身份，不做此判定——不因旧句柄消失而阻塞当前窗口）；
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
      const desktopId = this.deps.agentDesktopId()
      if (!desktopId || doc.desktopId !== desktopId) {
        this.enterSafe('desktop-id')
        return false
      }
      if (doc.clean !== true) {
        // 异常重建（工单410）：只废弃旧布局内容，不进入永久停写态。旧成员顺序/树形/
        // 队列/屏外顺序/锚窗/浮动记录全部不应用（pendingRestore 不置入），本拍起按
        // 正常 pass 流程以当前合格窗口重建（新成员首拍落位不进授权判定，无弹框）。
        // 尺寸能力证据一并清空（工单415：异常重建后按既有生命周期重评，spec413）
        this.minSizeFloor.clear()
        this.splitBlockMemo.clear() // 工单416：分裂阻断记忆同上
        this.setRecovery('rebuilt', null)
        return true
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
    // 屏外带（工单406）：持久化的是带顺序与锚窗身份（关系），不是像素——树区按带非空
    // 让出露边重建，恢复后的第一拍以锚窗当前几何重算 fit（不留空白视口、不带旧偏移）
    const bandHwnds = plan.band
      .map((ref) => plan.order[ref]?.hwnd)
      .filter((h): h is number => typeof h === 'number' && !floatingHwnds.has(h))
    const reveal = bandRevealPx(minPane.w)
    const effArea = bandHwnds.length > 0 ? bandTreeArea(area, reveal) : area
    this.tree = plan.shape
      ? treeFromShape(plan.shape, effArea, opts, plan.queue, idOfRef)
      : createTree(effArea, opts)
    this.tree.overflow = bandHwnds.map(String)
    this.anchorHwnd = plan.anchor !== null ? (plan.order[plan.anchor]?.hwnd ?? null) : null
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
    this.pendingHandoff = []
    this.restoringPass = false
    this.memberOrder = []
    this.tree = null
    this.camera = 0
    this.anchorHwnd = null
    this.lastPlaced.clear()
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
    // 屏外顺序与锚窗身份（工单406）：带成员在 memberOrder 内（captureLayout 映射为
    // order 下标）；锚窗不在成员序（已浮动/已消失）时 captureLayout 置空
    const band = this.tree ? this.tree.overflow.map((id) => Number(id)) : []
    const anchor = this.anchorHwnd !== null && this.memberOrder.includes(this.anchorHwnd)
      ? this.anchorHwnd
      : null
    return captureLayout({ desktopId, clean, order, tree: this.tree, floating, band, anchor })
  }

  /**
   * 模型落盘（原子替换；同内容不重复写）。安全态写**空模型 + 干净标记**——下一轮从活
   * 窗口事实重建，绝不把不可信旧布局再次喂给恢复路径。暂停态保留 pending 文档（模型
   * 不丢，主屏恢复后的下一轮继续 reconciliation）。
   */
  private saveLayout(clean: boolean): void {
    if (!this.layoutFile || !this.layoutLoaded) return
    // 干净退出已落盘后停写（工单442）：clean=true 已盖章，此后任何拍（退出撕卸窗内的
    // 挂起拍/新拍/在途拍）都不得覆写——clean=false 文本必异于 clean=true，去重挡不住
    if (this.quitFlushed && !clean) return
    const desktopId = this.deps.agentDesktopId()
    if (!desktopId) return
    let doc: AgentLayoutDoc
    if (this.safe) {
      doc = {
        version: AGENT_LAYOUT_VERSION,
        desktopId,
        clean,
        order: [],
        tree: null,
        queue: [],
        band: [],
        anchor: null,
        floating: [],
      }
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
    this.quitFlushed = true // 工单442：盖章后停写，退出撕卸窗内的拍不再踏平 clean 标记
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

  /** 测试观察缝：拖入交接暂存账快照（工单407——消费即清、消失即弃的断言面） */
  handoffPendingForTest(): number[] {
    return [...this.pendingHandoff]
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
