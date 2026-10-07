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

export declare interface ClassifiedWindow {
  cls: string
  title: string
  pid: number
  /** 控制器自身 pid（同款窗排除用；缺省不排除任何 pid） */
  selfPid?: number
}

/** 遗留面板窗核验：只认 Chrome_WidgetWin_1 + 标题 AGENT DECK 且 pid≠selfPid 的窗 */
export declare function findPanelWindows(classified: ClassifiedWindow[]): ClassifiedWindow[]

/** preflight 警示条目（工单113 四类 + 工单34 第五类）：kind = 五类污染源枚举；detail 为入账文本 */
export declare interface PreflightEntry {
  kind: 'double-panel' | 'leftover-panel' | 'dwm-ghost' | 'fullscreen-overlay' | 'user-window-activity'
  detail: string
}

/** preflight 探测行（battery.js 从 win32 枚举产出后注入） */
export declare interface PreflightProbes {
  /** 面板本体窗（findPanelWindows 产出；exeQueryable=进程镜像可查询） */
  panelWindows?: (ClassifiedWindow & { exeQueryable?: boolean })[]
  /** Ghost 类窗（dwm/OLE 幽灵） */
  ghostWindows?: { cls: string; pid: number }[]
  /** 壳层白名单外的全屏可见未 cloaked 窗（cua 覆盖层候选） */
  fullscreenForeign?: { cls: string; pid: number; title?: string }[]
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
 * 快照无前台行=未检出。警示入账不拒跑、不进三路计数（ADR-0011 同构）。 */
export declare function classifyUserWindowActivity(rows?: WindowSnapshotRow[]): PreflightEntry[]
