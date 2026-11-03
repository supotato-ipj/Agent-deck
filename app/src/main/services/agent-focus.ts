// Agent 聚焦协调（工单379，spec #369 决策 16 / ADR-0028「恢复与聚焦」）：
// 窗口预览选定条目后，目标窗**真实最大化**（ShowWindow SW_MAXIMIZE——允许既有最大化收栏，
// 胶囊始终置顶由胶囊窗的 screen-saver 置顶承担）；再点胶囊、点恢复按钮或**明确激活其他
// 窗口**都先退出聚焦并恢复默认平铺；后台新窗只更新模型（成员集合/计数）不退出，抢前台
// 才退出。切出 Agent 桌面释放聚焦（还原目标几何、解除平铺挂起——平铺已失活，不再恢复）。
//
// 与平铺账的边界：聚焦期间目标窗被挂起（setTilingHeld）——平铺 pass 不写它、不做授权
// 判定（最大化不是「用户改几何」）；其余成员保持原位（最大化窗覆盖窗格，布局不重排）。
// 退出时还原到最大化前几何，再交平铺账恢复默认平铺（收回浮动/补入溢出/清授权）。
//
// 前台观察（deps.startForegroundWatch）只在聚焦期有意义：生产为 WinEvent
// EVENT_SYSTEM_FOREGROUND 钩子；自家窗（预览/提示/面板/条带/胶囊）的前台变化不算
// 「激活其他窗口」（预览窗取焦是交互面，不是用户切走）。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { AgentFocusState, DesktopMode } from '../../shared/contract'

export interface AgentFocusServiceOptions {
  /** 实验开关（config agentDesktop.enabled；缺省关——零聚焦） */
  enabled?: boolean
  /** 存证日志（只记 hwnd/动作/前台事实，不含窗口标题——决策 26 / ADR-0002） */
  log?: (event: Record<string, unknown>) => void
  /** 依赖缝：真源缺省延迟绑定（离线测试注入假源后零 FFI） */
  deps?: {
    currentMode?: () => DesktopMode
    startForegroundWatch?: (cb: (hwnd: number) => void) => () => void
    isOwnWindow?: (hwnd: number) => boolean
    maximize?: (hwnd: number) => boolean
    restoreWindow?: (hwnd: number) => boolean
    setTilingHeld?: (hwnd: number | null) => void
    restoreTiling?: () => Promise<{ ok: boolean; restored: number; skipped: number }>
  }
}

interface FocusDeps {
  currentMode: () => DesktopMode
  startForegroundWatch: (cb: (hwnd: number) => void) => () => void
  isOwnWindow: (hwnd: number) => boolean
  maximize: (hwnd: number) => boolean
  restoreWindow: (hwnd: number) => boolean
  setTilingHeld: (hwnd: number | null) => void
  restoreTiling: () => Promise<{ ok: boolean; restored: number; skipped: number }>
}

export interface FocusExitResult {
  ok: boolean
  restored: number
  skipped: number
  state: AgentFocusState
}

/**
 * 聚焦协调服务：focused = 当前真实最大化目标（null = 非聚焦态）。所有退出路径
 * （胶囊点击/恢复按钮/前台激活其他窗/桌面切出）都收口到 exit()/release()。
 */
export class AgentFocusService extends Service {
  static inject: Inject = {}

  private readonly enabledFlag: boolean
  private readonly deps: FocusDeps
  private readonly logEvent: (event: Record<string, unknown>) => void
  private focusedHwnd: number | null = null
  private stopWatch: (() => void) | null = null
  private started = false
  /** 退出竞态单飞：前台事件与显式退出并发时只跑一次恢复平铺 */
  private exiting = false

  constructor(ctx: Context, options: AgentFocusServiceOptions = {}) {
    super(ctx, 'agentFocus')
    this.enabledFlag = options.enabled ?? false
    this.logEvent = options.log ?? (() => undefined)
    this.deps = {
      currentMode: options.deps?.currentMode ?? (() => 'unmanaged'),
      startForegroundWatch:
        options.deps?.startForegroundWatch
        ?? ((cb) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).startForegroundWatch(cb)),
      isOwnWindow:
        options.deps?.isOwnWindow
        ?? ((hwnd) => {
          const { pidOf } = require('../taskbar/win-facts') as typeof import('../taskbar/win-facts')
          return pidOf(hwnd) === process.pid
        }),
      maximize:
        options.deps?.maximize
        ?? ((hwnd) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).maximizeWindow(hwnd)),
      restoreWindow:
        options.deps?.restoreWindow
        ?? ((hwnd) => (require('../desktop/geom-write') as typeof import('../desktop/geom-write')).restoreWindow(hwnd)),
      setTilingHeld: options.deps?.setTilingHeld ?? (() => undefined),
      restoreTiling: options.deps?.restoreTiling ?? (async () => ({ ok: false, restored: 0, skipped: 0 })),
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    // 前台观察常驻订阅（失活/非聚焦时回调零动作）；钩子本体轻（只递 hwnd）
    this.stopWatch = this.deps.startForegroundWatch((hwnd) => this.onForeground(hwnd))
    this.ctx.on('workspace/changed', () => this.syncActivation())
    this.syncActivation()
  }

  protected stop(): void {
    if (this.stopWatch) {
      this.stopWatch()
      this.stopWatch = null
    }
    if (this.focusedHwnd != null) {
      this.deps.setTilingHeld(null)
      this.focusedHwnd = null
    }
    this.exiting = false
  }

  /** 可用 = 实验开关开 */
  private available(): boolean {
    return this.enabledFlag
  }

  /** 激活态：Agent 桌面（普通/非托管零聚焦） */
  private active(): boolean {
    return this.available() && this.deps.currentMode() === 'agent'
  }

  /** 只读投影 */
  state(): AgentFocusState {
    return { focused: this.active() ? this.focusedHwnd : null }
  }

  /** 激活态对齐（workspace/changed）：切出 Agent 桌面释放聚焦（不恢复平铺——已失活） */
  syncActivation(): void {
    if (!this.active() && this.focusedHwnd != null) {
      this.logEvent({ type: 'focus-release', reason: 'desktop-inactive', hwnd: this.focusedHwnd })
      this.release()
    }
  }

  /**
   * 进入聚焦（预览选定条目）：目标真实最大化 + 激活——先挂起平铺账再最大化，平铺 pass
   * 不会把这次最大化当成用户改几何。换目标时先还原旧目标（不触发整体恢复平铺）。
   */
  enter(hwnd: number): { ok: boolean; state: AgentFocusState } {
    if (!this.active() || !Number.isFinite(hwnd) || hwnd <= 0) return { ok: false, state: this.state() }
    if (this.focusedHwnd === hwnd) return { ok: true, state: this.state() }
    if (this.focusedHwnd != null) this.release()
    this.focusedHwnd = hwnd
    this.deps.setTilingHeld(hwnd)
    const maximized = this.deps.maximize(hwnd)
    this.logEvent({ type: 'focus-enter', hwnd, maximized })
    this.ctx.emit('focus/changed', this.state())
    return { ok: true, state: this.state() }
  }

  /**
   * 退出聚焦（再点胶囊/恢复按钮/前台激活其他窗）：还原目标几何 → 解除挂起 → 恢复默认
   * 平铺（收回浮动/补入溢出/清授权）。非聚焦态 no-op（不误触发恢复平铺）。
   */
  async exit(): Promise<FocusExitResult> {
    const hwnd = this.focusedHwnd
    if (hwnd == null) return { ok: false, restored: 0, skipped: 0, state: this.state() }
    if (this.exiting) return { ok: false, restored: 0, skipped: 0, state: this.state() }
    this.exiting = true
    try {
      this.focusedHwnd = null
      this.deps.restoreWindow(hwnd)
      this.logEvent({ type: 'focus-exit', reason: 'user', hwnd })
      this.ctx.emit('focus/changed', this.state())
      // 挂起保持到恢复平铺落位之后：还原引发的 LOCATIONCHANGE 拍不会把目标窗的
      // 中间几何当成用户操作去弹授权（口径：最大化/还原不是「改几何」）
      const r = await this.deps.restoreTiling()
      this.deps.setTilingHeld(null)
      return { ok: true, restored: r.restored, skipped: r.skipped, state: this.state() }
    } finally {
      this.exiting = false
    }
  }

  /** 前台变化入口（WinEvent 回调侧只递 hwnd）：回到聚焦目标/自家窗都不算切换 */
  onForeground(hwnd: number): void {
    const focused = this.focusedHwnd
    if (focused == null) return
    if (!Number.isFinite(hwnd) || hwnd <= 0) return
    if (hwnd === focused) return
    if (this.deps.isOwnWindow(hwnd)) return
    this.logEvent({ type: 'focus-exit', reason: 'foreground', hwnd: focused, next: hwnd })
    void this.exit()
  }

  /** 释放（桌面切出/停表）：还原目标、解挂、清状态——不恢复平铺 */
  private release(): void {
    const hwnd = this.focusedHwnd
    this.focusedHwnd = null
    if (hwnd != null) {
      try {
        this.deps.restoreWindow(hwnd)
      } catch {
        /* 收尾尽力 */
      }
    }
    this.deps.setTilingHeld(null)
    this.ctx.emit('focus/changed', this.state())
  }
}
