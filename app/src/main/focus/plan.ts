/**
 * 会话块直达的决策内核（工单09）：给定工具映射与当前窗口快照，决定「聚焦既有窗口」
 * 还是「启动工具」还是「静默降级」。纯逻辑——不碰 FFI、不碰 Electron，
 * 辅缝离线可测（spec 辅缝：进程发现与启动策略不依赖真机与真实工具做回归）。
 */
import type { ToolTarget } from '../config'

/** 候选顶层窗口（适配层产出；刻意不含标题——ADR-0002 隐私边界，匹配只需 exe） */
export interface WindowCandidate {
  hwnd: number
  pid: number
  /** 可执行文件 basename（原始大小写，含 .exe） */
  exe: string
  visible: boolean
  minimized: boolean
}

/** 决策结果：聚焦 / 启动 / 降级（三态穷尽，调用方无需兜底分支） */
export type FocusPlan =
  | { action: 'focus'; hwnd: number; pid: number }
  | { action: 'launch'; exe: string }
  | { action: 'degrade'; reason: string }

/** 进程镜像名归一：basename → 小写 → 去 .exe 后缀（与 config.tools.processes 同一口径） */
export function normalizeProcessName(raw: string): string {
  const base = raw.replace(/^.*[\\/]/, '')
  return base.toLowerCase().replace(/\.exe$/i, '')
}

/** 候选排序权重：可见未最小化 > 可见（已最小化，聚焦时顺带还原） > 不可见（跳过） */
function rank(w: WindowCandidate): number {
  if (!w.visible) return -1
  return w.minimized ? 1 : 2
}

/** 命中 processes 的窗口中择优（分数高者胜；同分取枚举序靠前者——z 序更靠上的窗口） */
function pickWindow(target: ToolTarget, windows: WindowCandidate[]): WindowCandidate | null {
  const names = new Set(processNames(target))
  if (!names.size) return null
  let best: WindowCandidate | null = null
  let bestRank = -1
  for (const w of windows) {
    const score = rank(w)
    if (score < 0) continue
    if (!names.has(normalizeProcessName(w.exe))) continue
    if (score > bestRank) {
      best = w
      bestRank = score
    }
  }
  return best
}

/** 归一后的进程名集合（去重、去空） */
function processNames(target: ToolTarget): string[] {
  return [...new Set(target.processes.map(normalizeProcessName).filter(Boolean))]
}

/**
 * 工具映射的形状守卫：config.tools 之外的查表命中（如工具名恰为 `toString`/`constructor`
 * 时从 Object.prototype 取到函数）不是有效映射。没有它，未知工具会走到
 * `target.processes.map` 抛 TypeError —— 违反「未知/失效目标静默降级」。
 */
function asToolTarget(value: unknown): ToolTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const t = value as Partial<ToolTarget>
  if (typeof t.launch !== 'string' || !Array.isArray(t.processes)) return undefined
  if (!t.processes.every((p) => typeof p === 'string')) return undefined
  return { launch: t.launch, processes: t.processes }
}

/**
 * 主决策：优先聚焦已在跑的窗口（用户要「到现场」，不是「再开一个」）；
 * 没有任何该工具的窗口时按 launch 启动；工具未配置或无启动目标即降级。
 *
 * 工具常驻托盘无可见窗口时走 launch：ShellExecute 对单实例应用是「唤起既有实例」
 * 而非新开一个，语义与用户点击意图一致。
 *
 * @param raw config.tools 查表结果（未校验）；形状不合法一律当未知工具降级
 * @param windows 当前顶层窗口快照
 */
export function planFocus(raw: unknown, windows: WindowCandidate[]): FocusPlan {
  const target = asToolTarget(raw)
  if (!target) return { action: 'degrade', reason: '未知工具（config.tools 无此条目）' }
  const hit = pickWindow(target, windows)
  if (hit) return { action: 'focus', hwnd: hit.hwnd, pid: hit.pid }
  const exe = target.launch.trim()
  if (!exe) return { action: 'degrade', reason: '工具未运行且无启动目标' }
  return { action: 'launch', exe }
}

/** 展开 `%VAR%` 环境变量占位（config 默认值用它表达本机强相关路径段；未知变量原样保留） */
export function expandEnvVars(input: string, env: Record<string, string | undefined> = process.env): string {
  return input.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => env[name] ?? whole)
}
