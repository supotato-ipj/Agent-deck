// 面板控制模块（工单112 强退序列）的类型声明：panel-control.js 是 CJS 纯决策模块
// （杀灭/探询/时钟全经注入），本声明服务 tests/*.spec.ts 的类型检查与后续 TS 消费方。
export declare const DEFAULT_GRACE_MS: number
export declare const DEFAULT_VERIFY_MS: number
export declare const DEFAULT_POLL_MS: number

export declare interface PanelStopRequest {
  /** 待终结进程表（面板主进程 + Electron 外壳等；模块内归一去重） */
  pids: number[]
  /** 优雅终止对象（spawn 回的 child），可空 */
  child?: unknown | null
  /** 优雅退宽限 ms（缺省 800，与既有 stopPanel 等价） */
  graceMs?: number
  /** 强杀后验证消失的有界等待上限 ms（缺省 5000） */
  verifyMs?: number
  /** 验证窗内存活轮询间隔 ms（缺省 200） */
  pollMs?: number
}

export declare interface PanelStopResult {
  /** 进程确认消失（可安全放行重启）；false=需重启清障（中止信号） */
  gone: boolean
  /** 优雅终止即生效 */
  graceful: boolean
  /** 动了整树强杀 */
  forced: boolean
  /** 强退后仍存活的 pid（钉子户指认，取证用） */
  pidsLeft: number[]
  /** 决策标签：'graceful-gone' | 'forced-gone' | 'restart-clear-required' */
  outcome: 'graceful-gone' | 'forced-gone' | 'restart-clear-required'
}

export declare interface PanelControlDeps {
  /** 存活探询（缺省 process.kill(pid,0)） */
  isAlive?: (pid: number) => boolean
  /** 优雅终止（缺省 child.kill()，尽力不抛） */
  gracefulKill?: (child: unknown | null) => void
  /** 整树强杀（缺省 taskkill /PID <pid> /T /F） */
  forceKillTree?: (pid: number) => void
  /** 时钟推进（缺省 setTimeout；单测注入假时钟） */
  sleep?: (ms: number) => Promise<void>
  /** 墙钟（缺省 Date.now；单测与 sleep 同源整定） */
  now?: () => number
}

export declare function createPanelControl(deps?: PanelControlDeps): {
  stop(req: PanelStopRequest): Promise<PanelStopResult>
  isAlive(pid: number): boolean
}

// —— 面板句柄（工单206，spec #202 决策3）——

/** 发射形态：full=全量面板（守卫链同形），accept=验收面板（--panel-accept 绕开单实例锁） */
export type PanelLaunchMode = 'full' | 'accept'
/** stdio 三形态：ignore=无管道 / drain=管道且排空（工单132 正解） / archive=落证据档 */
export type PanelStdioMode = 'ignore' | 'drain' | 'archive'

export declare interface PanelLaunchConfig {
  /** 发射形态 */
  mode: PanelLaunchMode
  /** CDP 调试端口（注入 DECK_CDP_PORT） */
  cdpPort?: number | string
  /** 滞后哨兵开关（注入 DECK_LAG_SENTINEL=1，工单117） */
  lagSentinel?: boolean
  /** stdio 形态（缺省 ignore） */
  stdio?: PanelStdioMode
  /** 追加环境变量（盖在 baseEnv 之上） */
  extraEnv?: Record<string, string | undefined>
}

export declare interface PanelWaitWindowRequest {
  /**
   * 就绪窗标题（面板本体 AGENT DECK / 任务栏条带 DECK-TASKBAR / 浮层窗）。
   * 必填判据：传空串/纯空白/undefined 时**不退化**为「任一可见窗即面板本体窗」——
   * 按「找不到窗」同形处置：落可见 Chrome 窗诊断转储 + 立即返回 null（不抛）。
   * 标题按原值参与匹配（既有语义不动）；「空白」只在闸门处判负（trim 后为空）。
   */
  title: string
  /** 可选类名过滤（缺省不做类名过滤；主电池现行判据的 Chrome_WidgetWin_1 一道） */
  cls?: string
  /** 超时 ms（缺省 20000） */
  timeoutMs?: number
}

/** 句柄自持状态（#202 决策2：身份四件——发射子进程/面板自报 pid/主窗句柄/发射时点——归句柄，
 *  电池里的可变闭包总线随之消失）；本接口逐成员对应 panel-control.js 运行时持有的 state，
 *  含四件之外的三项记账成员（since 门/末次发射配置快照/stderr 尾）。 */
export declare interface PanelHandleState {
  /** 发射子进程 */
  child: unknown | null
  /** 面板自报 pid（boot 存证；spawn 的 child.pid 在 Electron 父进程下不可靠） */
  panelPid: number | null
  /** 主窗句柄 */
  hwnd: unknown | null
  /** 发射时点（since 门记账） */
  launchedAt: number
  /** since 门当前值（发射时点即门；relaunch 传 sinceMs 时显式覆盖） */
  sinceGate: number
  /** 末次发射配置快照（relaunch 逐字复现首发配置用；未发射过为 null） */
  lastCfg: PanelLaunchConfig | null
  /** stderr 尾（drain 形态下由句柄截留，尾部只留末 4000 字符，供早亡取证；非 drain 形态为空串）。
   *  与 PanelLaunchReceipt.stderrTail() 分工：那里是「取尾」的取值函数，这里是持有字段。 */
  stderrTail: string
}

/** 句柄 stop 的决策（outcome 比面板控制模块多一档 idle 短路） */
export declare interface PanelHandleStopResult extends PanelStopResult {
  outcome: PanelStopResult['outcome'] | 'idle'
}

/** relaunch 的决策（强退决策 + 是否真重发） */
export declare interface PanelRelaunchResult extends PanelHandleStopResult {
  /** 是否真的重发（强退失败=中止信号，为 false） */
  launched: boolean
  /** 重发后的子进程（未重发时为 null） */
  child: unknown | null
  /** 重发后的发射时点 */
  launchedAt: number
}

/** launch 的回执（发射子进程 + 发射时点 + stderr 尾（早亡留证）） */
export declare interface PanelLaunchReceipt {
  child: unknown
  launchedAt: number
  /** stderr 尾部（drain 形态下由句柄截留，缺省空串） */
  stderrTail(): string
}

export declare interface PanelHandleDeps extends PanelControlDeps {
  /** 发射器（缺省 child_process.spawn） */
  spawn?: (cmd: string, args: string[], opts: { cwd: string; env: Record<string, string | undefined>; stdio: unknown }) => unknown
  /** 被拉起的可执行文件路径（缺省 process.execPath） */
  execPath?: string
  /** 工作目录（缺省 app 根） */
  appRoot?: string
  /** 基础环境变量（缺省 process.env） */
  baseEnv?: Record<string, string | undefined>
  /** 事件档路径（注入 DECK_EVENT_LOG；boot 自报 pid 的来源） */
  eventLogPath?: string
  /** 事件档读取（缺省读 eventLogPath 的 JSONL） */
  readEvents?: () => Array<{ type?: string; t?: number; pid?: number }>
  /** 顶层窗枚举（缺省 win32.topLevelWindows） */
  topLevelWindows?: () => unknown[]
  /** 窗归属 pid */
  windowPid?: (hwnd: unknown) => number
  /** 窗标题 */
  windowTitle?: (hwnd: unknown) => string
  /** 窗类名（诊断转储用） */
  windowClass?: (hwnd: unknown) => string
  /** 窗可见性 */
  isWindowVisible?: (hwnd: unknown) => boolean
  /** WM_NULL 探活（缺省真机实现：IsWindow + SendMessageTimeoutW） */
  responsiveProbe?: (hwnd: unknown, timeoutMs: number) => boolean
  /** 证据档打开（缺省 fs.openSync(file,'a')） */
  openArchive?: (file: string) => number
  /** 证据档路径（stdio=archive 时的落盘去处） */
  archivePath?: string
  /** 日志出口（缺省 console.log） */
  log?: (msg: string) => void
}

export declare function createPanelHandle(deps?: PanelHandleDeps): {
  launch(cfg: PanelLaunchConfig): PanelLaunchReceipt
  waitWindow(req: PanelWaitWindowRequest): Promise<unknown | null>
  relaunch(req?: { sinceMs?: number }): Promise<PanelRelaunchResult>
  stop(): Promise<PanelHandleStopResult>
  alive(): boolean
  responsive(): boolean
}

export declare interface ClassifiedWindow {
  cls: string
  title: string
  pid: number
  /** 控制器自身 pid（同款窗排除用；缺省不排除任何 pid） */
  selfPid?: number
}

/** 遗留面板窗核验：只认 Chrome_WidgetWin_1 + 标题 AGENT DECK 且 pid≠selfPid 的窗 */
export declare function findPanelWindows(classified: ClassifiedWindow[]): ClassifiedWindow[]

/** preflight 警示条目（工单113 四类 + 工单34 第五类 + 工单141 第六类）：kind = 六类污染源枚举；detail 为入账文本 */
export declare interface PreflightEntry {
  kind: 'double-panel' | 'leftover-panel' | 'dwm-ghost' | 'fullscreen-overlay' | 'user-window-activity' | 'tray-machine-state'
  detail: string
}

/** preflight 探测行（battery.js 从 win32 枚举产出后注入；rows 供第五类分类消费） */
export declare interface PreflightProbes {
  /** 面板本体窗（findPanelWindows 产出；exeQueryable=进程镜像可查询） */
  panelWindows?: (ClassifiedWindow & { exeQueryable?: boolean })[]
  /** Ghost 类窗（dwm/OLE 幽灵） */
  ghostWindows?: { cls: string; pid: number }[]
  /** 壳层白名单外的全屏可见未 cloaked 窗（cua 覆盖层候选） */
  fullscreenForeign?: { cls: string; pid: number; title?: string }[]
  /** 可见窗快照原样行（工单34 第五类输入；classifyPreflight 不读） */
  rows?: WindowSnapshotRow[]
  /** 托盘机器态预告（工单141 第六类输入：本电池 exe 的 NotifyIconSettings 条目读数） */
  trayMachine?: { exe?: string; entryExists?: boolean; promoted?: number | null } | null
}

/** preflight 环境体检分类（工单113）：四类污染源 → 警示条目；无污染返回空数组 */
export declare function classifyPreflight(probes?: PreflightProbes): PreflightEntry[]

/** preflight 壳层白名单（工单34 自 battery.js 迁入单点维护）：桌面宿主/任务栏/DefView */
export declare const PREFLIGHT_SHELL_CLASSES: Set<string>
/** 电池自家窗标题（面板本体/验收提示条/任务栏条带） */
export declare const PREFLIGHT_OWN_TITLES: Set<string>

/** 窗口枚举快照行（battery.js preflightProbes 产出；foreground=是否为前台窗） */
export declare interface WindowSnapshotRow {
  cls: string
  title?: string
  pid: number
  selfPid?: number
  visible?: boolean
  cloaked?: boolean
  foreground?: boolean
}

/** preflight 第五类分类（工单34 方向3）：用户窗口活跃度——前台被普通用户应用窗占据
 * 即检出（恰一条 user-window-activity）；壳层静态件/Ghost/cloaked/自家窗在场均未检出；
 * probes.rows 无前台行/缺省=未检出。入参与 classifyPreflight 同缝（整个 probes 对象）。
 * 警示入账不拒跑、不进三路计数（ADR-0011 同构）。 */
export declare function classifyUserWindowActivity(probes?: PreflightProbes): PreflightEntry[]

/** preflight 第六类分类（工单141，spec #145）：托盘机器态预告——条目缺失/提升位未置各恰一条
 * tray-machine-state 警示（不拒跑、不进三路计数）；它只预告，P8/P10 失败时的记账决定由
 * tray-machine-state.js 的严口径判定在断言位做出。入参同缝（整个 probes 对象）。 */
export declare function classifyTrayMachineState(probes?: PreflightProbes): PreflightEntry[]
