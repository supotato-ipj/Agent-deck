import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { TaskbarMetric, TaskbarState, TaskbarSystemAction } from '../../shared/contract'
import { TASKBAR_METRIC_KEYS } from '../../shared/contract'
import { defaultTaskbar, saveConfig } from '../config'
import type { AppConfig } from '../config'
import { BridgeError } from './bridge'

export interface TaskbarServiceOptions {
  /** 初始开关（config.json taskbar.enabled 下发；缺省 = 默认开启） */
  enabled?: boolean
  /** 硬件摘要勾选子集（config.json taskbar.metrics 下发；缺省 = 五项全选） */
  metrics?: TaskbarMetric[]
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string
  /** 已加载的 config（可变引用：写开关即整份回写该对象，settings 先例） */
  config?: AppConfig
  /** 依赖缝：按键合成真源（离线测试注入假源；缺省延迟绑定 taskbar/syskeys） */
  deps?: {
    sendSystemKeys?: (action: TaskbarSystemAction) => boolean
  }
}

const SYSTEM_ACTIONS: readonly TaskbarSystemAction[] = ['start-menu', 'task-view', 'notification-center', 'quick-settings', 'toggle-desktop']

/**
 * 任务栏插件（工单49，ADR-0007）：体系第一种非卡片形态的 cordis 主进程插件。
 * 本服务只管状态与动作——开关与硬件摘要勾选（config.json 持久化 + taskbar/changed
 * 回推）与系统动作合成（开始菜单/任务视图/通知中心/快速设置/显示桌面）。置顶窗口的
 * 创建/销毁是效果层，由生产装配（taskbar/window.ts 控制器）订阅 taskbar/changed
 * 驱动，本服务不引 electron，离线契约测试经 createKernel 直装直测。
 */
export class TaskbarService extends Service {
  private readonly file: string | null
  private readonly appConfig: AppConfig | null
  private readonly sendSystemKeys: (action: TaskbarSystemAction) => boolean
  private current: TaskbarState

  constructor(ctx: Context, options: TaskbarServiceOptions = {}) {
    super(ctx, 'taskbar')
    this.file = options.file ?? null
    this.appConfig = options.config ?? null
    this.sendSystemKeys = options.deps?.sendSystemKeys
      ?? ((action) => (require('../taskbar/syskeys') as typeof import('../taskbar/syskeys')).sendSystemAction(action))
    const fallback = defaultTaskbar()
    this.current = { enabled: options.enabled ?? fallback.enabled, metrics: options.metrics ?? fallback.metrics }
  }

  state(): TaskbarState {
    return { ...this.current, metrics: [...this.current.metrics] }
  }

  /** 持久化 + 提交内存态 + 回推的三段收口（setEnabled/setMetrics 共用，settings 同款顺序：
   * 先写盘后提交内存态——写失败即抛，三者一致）。 */
  private commit(next: TaskbarState): TaskbarState {
    if (this.appConfig && this.file) {
      saveConfig(this.file, { ...this.appConfig, taskbar: { ...next } })
      this.appConfig.taskbar = { ...next }
    }
    this.current = { ...next, metrics: [...next.metrics] }
    this.ctx.emit('taskbar/changed', this.state())
    return this.state()
  }

  /** 开关：同值幂等空转（不重写盘、不重推事件）。只动 enabled 位，勾选子集原样。 */
  setEnabled(enabled: boolean): TaskbarState {
    if (typeof enabled !== 'boolean') {
      throw new BridgeError(`taskbar.enabled 须为布尔值，收到 ${String(enabled)}`)
    }
    if (enabled === this.current.enabled) return this.state()
    return this.commit({ ...this.current, enabled })
  }

  /** 硬件摘要勾选（工单55）：metrics 为勾选子集，按规范序归一去重后持久化；
   * 未知指标名是契约违规，抛 BridgeError（不静默吞掉）；同值幂等空转。 */
  setMetrics(metrics: TaskbarMetric[]): TaskbarState {
    if (!Array.isArray(metrics) || metrics.some((m) => !(TASKBAR_METRIC_KEYS as readonly string[]).includes(m as string))) {
      throw new BridgeError(`taskbar.metrics 须为已知指标子集（${TASKBAR_METRIC_KEYS.join('/')}），收到 ${JSON.stringify(metrics)}`)
    }
    const normalized = TASKBAR_METRIC_KEYS.filter((k) => metrics.includes(k))
    if (normalized.length === this.current.metrics.length && normalized.every((k, i) => k === this.current.metrics[i])) {
      return this.state()
    }
    return this.commit({ ...this.current, metrics: normalized })
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

  /** 插件卸载路径（cordis 生命周期）：运行期卸载后不会再有 taskbar/changed——
   * 以 enabled:false 终态补发一帧，效果层（窗口控制器）经既有「禁用即销窗」
   * 路径销窗，窗口不残留（工单49 code-review 补缺）。 */
  protected stop(): void {
    this.ctx.emit('taskbar/changed', { ...this.current, enabled: false })
  }
}
