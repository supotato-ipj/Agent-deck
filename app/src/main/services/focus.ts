import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { FocusAction } from '../../shared/contract'
import { defaultTools } from '../config'
import type { ToolsConfig } from '../config'
import { nativeFocusWindow, nativeWindowCandidates, shellLaunch } from '../focus/adapter'
import { expandEnvVars, planFocus } from '../focus/plan'
import type { WindowCandidate } from '../focus/plan'

export interface FocusResult {
  ok: boolean
  action: FocusAction
  /** 降级原因（action=degraded 时给出，供存证与排障；不含任何窗口标题） */
  error?: string
  /** 聚焦命中的窗口句柄（action=focused 时给出，十六进制存证用） */
  hwnd?: number
}

/** 会话行直达依赖束：主进程真源 / 测试假源共用一个服务状态机（desktop/search 同法） */
export interface FocusDeps {
  /** 顶层窗口快照（真源 = adapter.nativeWindowCandidates） */
  listWindows(): WindowCandidate[]
  /** 窗口置前（真源 = adapter.nativeFocusWindow）；返回 false = 系统拒绝（前台锁） */
  focusWindow(hwnd: number): boolean
  /** 启动工具（真源 = adapter.shellLaunch；'' = 成功，desktop/launch 同源语义） */
  launch(exe: string): Promise<string>
  /** 环境变量展开（测试注入假 env） */
  env: Record<string, string | undefined>
}

export interface FocusServiceOptions {
  /** 工具→exe 映射（config.json tools 段下发；缺省取本机生产值） */
  tools?: ToolsConfig
  deps?: Partial<FocusDeps>
}

/**
 * 会话行直达服务（工单09）：点击会话卡里的会话行 → 对应工具的窗口被带到前台，
 * 工具未运行则启动它。决策收口内核（focus/plan.ts 纯逻辑），渲染层只发工具名。
 *
 * 边界：
 * - 渲染层永不发路径。启动目标只从 config.tools 取，映射缺失即降级（任意路径执行防线）。
 * - 一切失败静默降级（ok=false + action=degraded），面板不崩、不弹窗——会话行是
 *   「看一眼就顺手点」的轻交互，失败不该打断桌面。
 */
export class FocusService extends Service {
  private readonly tools: ToolsConfig
  private readonly deps: FocusDeps

  constructor(ctx: Context, options: FocusServiceOptions = {}) {
    super(ctx, 'focus')
    this.tools = options.tools ?? defaultTools()
    this.deps = {
      listWindows: options.deps?.listWindows ?? nativeWindowCandidates,
      focusWindow: options.deps?.focusWindow ?? nativeFocusWindow,
      launch: options.deps?.launch ?? shellLaunch,
      env: options.deps?.env ?? process.env,
    }
  }

  /** 点击会话行：tool 为会话所属工具名（qoder/kimicode/kimiwork/zcode/hermes） */
  async focusTool(tool: string): Promise<FocusResult> {
    // 只认自有条目：工具名恰为 toString/constructor 时，直接查表会命中 Object.prototype
    // 的成员（函数），形状校验虽能兜住，但语义上它们本就不是配置条目（见 plan.asToolTarget）
    const target = Object.prototype.hasOwnProperty.call(this.tools, tool) ? this.tools[tool] : undefined
    let windows: WindowCandidate[] = []
    try {
      windows = this.deps.listWindows()
    } catch (err) {
      // 窗口枚举失败（如 FFI 不可用）仍可尝试启动：工具未运行时启动是有效路径
      console.warn(`deck-focus: 窗口枚举失败，降级为仅启动：${err instanceof Error ? err.message : err}`)
    }
    const plan = planFocus(target, windows)
    if (plan.action === 'degrade') return { ok: false, action: 'degraded', error: plan.reason }
    if (plan.action === 'focus') {
      try {
        if (this.deps.focusWindow(plan.hwnd)) return { ok: true, action: 'focused', hwnd: plan.hwnd }
        return { ok: false, action: 'degraded', error: '系统拒绝置前该窗口（前台锁）' }
      } catch (err) {
        return { ok: false, action: 'degraded', error: `置前异常：${err instanceof Error ? err.message : err}` }
      }
    }
    const exe = expandEnvVars(plan.exe, this.deps.env)
    try {
      const error = await this.deps.launch(exe)
      return error ? { ok: false, action: 'degraded', error } : { ok: true, action: 'launched' }
    } catch (err) {
      return { ok: false, action: 'degraded', error: `启动失败：${err instanceof Error ? err.message : err}` }
    }
  }

  /** 测试观察缝：当前生效的工具映射 */
  toolsForTest(): ToolsConfig {
    return JSON.parse(JSON.stringify(this.tools)) as ToolsConfig
  }
}

export type { WindowCandidate }
