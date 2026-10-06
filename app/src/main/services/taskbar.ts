import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { TaskbarButtonId, TaskbarRecommendation, TaskbarState, TaskbarSystemAction } from '../../shared/contract'
import { defaultTaskbar, saveConfig } from '../config'
import type { AppConfig } from '../config'
import { BridgeError } from './bridge'

export interface TaskbarServiceOptions {
  /** 初始开关（config.json taskbar.enabled 下发；缺省 = 默认开启） */
  enabled?: boolean
  /** 中组系统按钮隐藏名单初值（config.json taskbar.hiddenButtons 下发，工单54） */
  hiddenButtons?: TaskbarButtonId[]
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string
  /** 已加载的 config（可变引用：写开关即整份回写该对象，settings 先例） */
  config?: AppConfig
  /** 依赖缝：真源 / 离线测试假源共用一个服务状态机 */
  deps?: {
    /** 按键合成真源（离线测试注入假源；缺省延迟绑定 taskbar/syskeys） */
    sendSystemKeys?: (action: TaskbarSystemAction) => boolean
    /**
     * 中组推荐位来源（工单54）：数据面快照推导（fuseScores 链路的产物），
     * 缺省空名单——离线测试注假源或经内核 panelData 装配。
     */
    recommendations?: () => TaskbarRecommendation[]
  }
}

const SYSTEM_ACTIONS: readonly TaskbarSystemAction[] = ['start-menu', 'task-view']

/** 中组系统按钮合法 id（与 config.ts 的持久化校验同源口径） */
const BUTTON_IDS: readonly TaskbarButtonId[] = ['start', 'tasks']

/** 推荐位名单逐条比对（name+path 都变才算变——显示名同拍变化也该触发重渲） */
function sameRecommendations(a: readonly TaskbarRecommendation[], b: readonly TaskbarRecommendation[]): boolean {
  return a.length === b.length && a.every((r, i) => r.name === b[i].name && r.display === b[i].display && r.path === b[i].path)
}

/**
 * 任务栏插件（工单49，ADR-0007）：体系第一种非卡片形态的 cordis 主进程插件。
 * 本服务只管状态与动作——开关与系统按钮显隐（config.json 持久化 + taskbar/changed
 * 回推）、系统动作合成（开始菜单/任务视图）、中组推荐位名单（工单54：从数据面
 * 链路拉取，变化即回推）。置顶窗口的创建/销毁是效果层，由生产装配
 * （taskbar/window.ts 控制器）订阅 taskbar/changed 驱动，本服务不引 electron，
 * 离线契约测试经 createKernel 直装直测。
 */
export class TaskbarService extends Service {
  private readonly file: string | null
  private readonly appConfig: AppConfig | null
  private readonly sendSystemKeys: (action: TaskbarSystemAction) => boolean
  private readonly recommendationsSource: () => TaskbarRecommendation[]
  private current: TaskbarState

  constructor(ctx: Context, options: TaskbarServiceOptions = {}) {
    super(ctx, 'taskbar')
    this.file = options.file ?? null
    this.appConfig = options.config ?? null
    this.sendSystemKeys = options.deps?.sendSystemKeys
      ?? ((action) => (require('../taskbar/syskeys') as typeof import('../taskbar/syskeys')).sendSystemAction(action))
    this.recommendationsSource = options.deps?.recommendations ?? (() => [])
    this.current = {
      enabled: options.enabled ?? defaultTaskbar().enabled,
      hiddenButtons: [...(options.hiddenButtons ?? defaultTaskbar().hiddenButtons)],
      recommendations: [],
    }
    // 推荐位即时刷新（工单54）：数据面每拍快照即重拉一次，变化才回推（1Hz 拉取 ×
    // 逐条 diff——名单稳定时零事件零重渲）。离线内核无 dataplane/snapshot，契约测试
    // 手动驱动 refreshRecommendations（手动驱动采集轮同款纪律）。
    this.ctx.on('dataplane/snapshot', () => this.refreshRecommendations())
  }

  state(): TaskbarState {
    return { ...this.current, hiddenButtons: [...this.current.hiddenButtons], recommendations: [...this.current.recommendations] }
  }

  /** 开关：先写盘后提交内存态（settings 同款顺序——写失败即抛，三者一致）；
   * 同值幂等空转（不重写盘、不重推事件）。 */
  setEnabled(enabled: boolean): TaskbarState {
    if (typeof enabled !== 'boolean') {
      throw new BridgeError(`taskbar.enabled 须为布尔值，收到 ${String(enabled)}`)
    }
    if (enabled === this.current.enabled) return this.state()
    this.persist({ enabled })
    this.current = { ...this.current, enabled }
    this.ctx.emit('taskbar/changed', this.state())
    return this.state()
  }

  /** 中组系统按钮显隐（工单54）：右键菜单动作落点。同态幂等空转；未知 id 抛
   * BridgeError（契约违规不静默吞掉）。先写盘后提交内存态（setEnabled 同款顺序）。 */
  setButtonHidden(id: TaskbarButtonId, hidden: boolean): TaskbarState {
    if (!BUTTON_IDS.includes(id)) {
      throw new BridgeError(`未知任务栏按钮: ${String(id)}`)
    }
    if (typeof hidden !== 'boolean') {
      throw new BridgeError(`taskbar.set-button-hidden.hidden 须为布尔值，收到 ${String(hidden)}`)
    }
    const has = this.current.hiddenButtons.includes(id)
    if (hidden === has) return this.state()
    const hiddenButtons = hidden
      ? [...this.current.hiddenButtons, id]
      : this.current.hiddenButtons.filter((b) => b !== id)
    this.persist({ hiddenButtons })
    this.current = { ...this.current, hiddenButtons }
    this.ctx.emit('taskbar/changed', this.state())
    return this.state()
  }

  /** 推荐位重拉（工单54）：数据面快照驱动 / 契约测试手动驱动；变化才回推 taskbar/changed */
  refreshRecommendations(): void {
    let next: TaskbarRecommendation[]
    try {
      next = this.recommendationsSource()
    } catch {
      return // 来源未就绪（数据面首拍前）按上次名单继续持有
    }
    if (sameRecommendations(this.current.recommendations, next)) return
    this.current = { ...this.current, recommendations: next }
    this.ctx.emit('taskbar/changed', this.state())
  }

  /** 系统动作：合成按键触发原生系统 UI。合成被拒（UIPI 等）回报 ok:false 而非抛——
   * 渲染层点击语义不需 try/catch；未知动作是契约违规，抛 BridgeError。 */
  systemAction(action: TaskbarSystemAction): { ok: boolean; error?: string } {
    if (!SYSTEM_ACTIONS.includes(action)) {
      throw new BridgeError(`未知任务栏系统动作: ${String(action)}`)
    }
    try {
      return { ok: this.sendSystemKeys(action) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 整份回写 config.json 的 taskbar 段（enabled + hiddenButtons 同段共写）并同步可变引用 */
  private persist(next?: Partial<Pick<TaskbarState, 'enabled' | 'hiddenButtons'>>): void {
    if (!this.appConfig || !this.file) return
    const taskbar = {
      enabled: next?.enabled ?? this.current.enabled,
      hiddenButtons: next?.hiddenButtons ?? [...this.current.hiddenButtons],
    }
    saveConfig(this.file, { ...this.appConfig, taskbar })
    this.appConfig.taskbar = taskbar
  }

  /** 插件卸载路径（cordis 生命周期）：运行期卸载后不会再有 taskbar/changed——
   * 以 enabled:false 终态补发一帧，效果层（窗口控制器）经既有「禁用即销窗」
   * 路径销窗，窗口不残留（工单49 code-review 补缺）。 */
  protected stop(): void {
    this.ctx.emit('taskbar/changed', { ...this.current, enabled: false })
  }
}
