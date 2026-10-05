import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { TaskbarState, TaskbarSystemAction } from '../../shared/contract'
import { defaultTaskbar, saveConfig } from '../config'
import type { AppConfig } from '../config'
import { BridgeError } from './bridge'

export interface TaskbarServiceOptions {
  /** 初始开关（config.json taskbar.enabled 下发；缺省 = 默认开启） */
  enabled?: boolean
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string
  /** 已加载的 config（可变引用：写开关即整份回写该对象，settings 先例） */
  config?: AppConfig
  /** 依赖缝：按键合成真源（离线测试注入假源；缺省延迟绑定 taskbar/syskeys） */
  deps?: {
    sendSystemKeys?: (action: TaskbarSystemAction) => boolean
  }
}

const SYSTEM_ACTIONS: readonly TaskbarSystemAction[] = ['start-menu', 'task-view']

/**
 * 任务栏插件（工单49，ADR-0007）：体系第一种非卡片形态的 cordis 主进程插件。
 * 本服务只管状态与动作——开关（config.json 持久化 + taskbar/changed 回推）与
 * 系统动作合成（开始菜单/任务视图）。置顶窗口的创建/销毁是效果层，由生产装配
 * （taskbar/window.ts 控制器）订阅 taskbar/changed 驱动，本服务不引 electron，
 * 离线契约测试经 createKernel 直装直测。
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
    this.current = { enabled: options.enabled ?? defaultTaskbar().enabled }
  }

  state(): TaskbarState {
    return { ...this.current }
  }

  /** 开关：先写盘后提交内存态（settings 同款顺序——写失败即抛，三者一致）；
   * 同值幂等空转（不重写盘、不重推事件）。 */
  setEnabled(enabled: boolean): TaskbarState {
    if (typeof enabled !== 'boolean') {
      throw new BridgeError(`taskbar.enabled 须为布尔值，收到 ${String(enabled)}`)
    }
    if (enabled === this.current.enabled) return { ...this.current }
    if (this.appConfig && this.file) {
      saveConfig(this.file, { ...this.appConfig, taskbar: { enabled } })
      this.appConfig.taskbar = { enabled }
    }
    this.current = { enabled }
    this.ctx.emit('taskbar/changed', { ...this.current })
    return { ...this.current }
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
}
