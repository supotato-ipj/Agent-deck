// 任务栏 pill 纯逻辑（工单49/55）：按钮清单是状态 → 视图的纯函数，点击分发只经桥契约。
// 本模块不碰 DOM/Node——fake bridge 契约测试在 Node 中直接驱动（menu-shell 先例）。
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, ClockState, HardwareGauges, TaskbarMetric, TaskbarState, TaskbarSystemAction } from '../shared/contract'

/** 渲染层桥接面（window.deck.bridge 的结构子集；测试注入 fake） */
export interface TaskbarBridge {
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
  on<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void
}

/** 中组系统按钮（工单49 tracer bullet：开始 + TaskView；推荐位属后续票） */
export interface TaskbarButtonSpec {
  id: string
  label: string
  action: TaskbarSystemAction
}

export const TASKBAR_BUTTONS: readonly TaskbarButtonSpec[] = [
  { id: 'start', label: '⊞ START', action: 'start-menu' },
  { id: 'tasks', label: '▦ TASK VIEW', action: 'task-view' },
] as const

/** 右组动作格（工单55）：音量格 = Win+A 快速设置（ADR-0007：音量格自绘、点击触发原生
 * 快速设置）；时钟格 = Win+N 通知中心（label 空——显示文本由时钟帧填充）；显示桌面
 * 细条 = Win+D（label 空——细条无文字，钉屏幕最右端，对齐 Win11 右下角肌肉记忆）。
 * 组内序 = 硬件摘要 →（托盘位 #56 占位）→ 音量 → 时钟 → 细条。 */
export const RIGHT_CELLS: readonly TaskbarButtonSpec[] = [
  { id: 'volume', label: '♪ VOL', action: 'quick-settings' },
  { id: 'clock', label: '', action: 'notification-center' },
  { id: 'show-desktop', label: '', action: 'toggle-desktop' },
] as const

/** 点击分发目录 = 中组按钮 + 右组动作格 */
const CATALOG: readonly TaskbarButtonSpec[] = [...TASKBAR_BUTTONS, ...RIGHT_CELLS]

/** 硬件摘要指标显示名（序 = contract TASKBAR_METRIC_KEYS 规范序的渲染层镜像——
 * 渲染层只做类型级 import（协议资产只服务 dist/renderer 根，运行时值导入会 404），
 * 两侧同序由 tests/renderer/taskbar.spec.ts 的镜像守卫钉住） */
export const TASKBAR_METRICS: ReadonlyArray<{ id: TaskbarMetric; label: string }> = [
  { id: 'cpu', label: 'CPU' },
  { id: 'gpu', label: 'GPU' },
  { id: 'ram', label: 'RAM' },
  { id: 'net-down', label: 'DL' },
  { id: 'net-up', label: 'UP' },
] as const

/** 渲染层规范序（TASKBAR_METRIC_KEYS 的镜像，见 TASKBAR_METRICS 注释） */
const METRIC_ORDER: readonly TaskbarMetric[] = TASKBAR_METRICS.map((s) => s.id)

/** 摘要单元格视图：visible = 是否进格（编辑态五项全可见供勾回），on = 当前勾选 */
export interface SummarySegment {
  id: TaskbarMetric
  label: string
  visible: boolean
  on: boolean
}

/** 状态 → 视图：禁用即空壳（窗口随插件禁用销毁，这里仍给出确定性空态） */
export function taskbarViewModel(state: TaskbarState): { buttons: TaskbarButtonSpec[]; metrics: TaskbarMetric[] } {
  return {
    buttons: state.enabled ? [...TASKBAR_BUTTONS] : [],
    metrics: state.enabled ? [...state.metrics] : [],
  }
}

/** 摘要格段清单：常态只呈现勾选子集，编辑态五项全呈现（未勾选的置灰供勾回） */
export function summaryViewModel(metrics: readonly TaskbarMetric[], editing: boolean): SummarySegment[] {
  return TASKBAR_METRICS.map((spec) => ({
    ...spec,
    visible: editing || metrics.includes(spec.id),
    on: metrics.includes(spec.id),
  }))
}

/** 勾选切换：取消即移出、勾回按规范序归位（与持久化口径同一序） */
export function toggleMetric(metrics: readonly TaskbarMetric[], key: TaskbarMetric): TaskbarMetric[] {
  const next = metrics.includes(key) ? metrics.filter((m) => m !== key) : [...metrics, key]
  return METRIC_ORDER.filter((k) => next.includes(k))
}

/** 摘要数值格式化：口径与硬件卡一致（百分比 Math.round、速率 toFixed(2) KB/s；
 * GPU/网络字段源缺位落占位符，不显示假 0） */
export function formatMetric(id: TaskbarMetric, gauges: HardwareGauges): string {
  const percent = (x: number | null | undefined) => (x == null ? '---' : `${Math.round(x)}%`)
  const kbps = (x: number | null | undefined) => (x == null ? '--' : `${x.toFixed(2)}KB/s`)
  switch (id) {
    case 'cpu': return `CPU ${percent(gauges.cpu)}`
    case 'gpu': return `GPU ${percent(gauges.gpu_usage)}`
    case 'ram': return `RAM ${percent(gauges.memory)}`
    case 'net-down': return `DL ${kbps(gauges.download_speed)}`
    case 'net-up': return `UP ${kbps(gauges.upload_speed)}`
  }
}

/** 时钟格文本：本地 HH:MM（两位补零） */
export function formatClock(clock: ClockState): string {
  const d = new Date(clock.epochMs)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * 按钮点击分发：id → 系统动作经桥 invoke。未知 id 是噪声（不发 invoke）。
 * 响应原样上抛（ok:false 也返回——合成被系统拒收不是渲染层异常）。
 */
export async function dispatchTaskbarButton(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  buttonId: string,
): Promise<{ ok: boolean; action: TaskbarSystemAction | null; error?: string }> {
  const btn = CATALOG.find((b) => b.id === buttonId)
  if (!btn) return { ok: false, action: null }
  const res = await bridge.invoke('taskbar/system-action', { action: btn.action })
  return { ok: res.ok, action: btn.action, ...(res.error ? { error: res.error } : {}) }
}
