// 任务栏 pill 纯逻辑（工单49/52/54/55/56/58）：视图模型是状态 → 视图的纯函数（应用组形态映射、
// 开始组系统按钮显隐、推荐位透出、整组显隐边界、右键菜单行、溢出拆分；右组硬件摘要勾选子集、
// 托盘图标名单、时钟/音量格、显示桌面细条），点击分发只经桥契约。
// 本模块不碰 DOM/Node——fake bridge 契约测试在 Node 中直接驱动（menu-shell 先例）。
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, ClockState, HardwareGauges, TaskbarActivateAction, TaskbarAppClickAction, TaskbarButtonId, TaskbarDragDrop, TaskbarMetric, TaskbarRecommendation, TaskbarState, TaskbarSystemAction, TaskbarTrayButton, TaskbarTrayEntry, TaskbarTrayOverflowLimit, TaskbarTrayPixels, TaskbarWindowRef } from '../shared/contract'
import { planAppsOverflow, planTrayOverflow } from '../shared/overflow.js'

/** 渲染层桥接面（window.deck.bridge 的结构子集；测试注入 fake） */
export interface TaskbarBridge {
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
  on<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void
}

/** 开始组系统按钮（工单49：开始 + TaskView） */
export interface TaskbarButtonSpec {
  id: TaskbarButtonId
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
export interface TaskbarCellSpec {
  id: string
  label: string
  action: TaskbarSystemAction
}

export const RIGHT_CELLS: readonly TaskbarCellSpec[] = [
  { id: 'volume', label: '♪ VOL', action: 'quick-settings' },
  { id: 'clock', label: '', action: 'notification-center' },
  { id: 'show-desktop', label: '', action: 'toggle-desktop' },
] as const

/** 点击分发目录 = 开始组按钮 + 右组动作格 */
const CATALOG: ReadonlyArray<{ id: string; action: TaskbarSystemAction }> = [...TASKBAR_BUTTONS, ...RIGHT_CELLS]

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

/** 右键菜单行（工单54）：每个系统按钮一行显隐切换；hidden=true 的行即恢复入口 */
export interface TaskbarMenuRow {
  id: TaskbarButtonId
  label: string
  hidden: boolean
}

/** 按钮 id → 菜单行中文名（隐藏/显示谓语共用同一词干） */
const BUTTON_NAMES: Record<TaskbarButtonId, string> = { start: '开始按钮', tasks: '任务视图按钮' }

/**
 * 应用组条目视图（工单52）：内核编排（apps-plan 纯函数）的输出原样进渲染层，
 * 本层只做形态映射。id = exe 身份原文——工单53 的点击/右键分发以它为挂点
 * （渲染层元素落 data-exe，分发经桥契约按身份寻址）。
 */
export interface TaskbarAppViewEntry {
  id: string
  exe: string
  label: string
  pinned: boolean
  running: boolean
  /** tooltip 文本：窗口标题优先（仅运行中在场，仅内存），回退显示名 */
  tooltip: string
  iconKey: string | null
}

/** 任务栏视图模型：visible=false = 开始组 pill 整个不渲染（只剩应用组与右组的边界条件）；
 * metrics（工单55）= 右组硬件摘要勾选子集（禁用态空壳）；
 * trayOverflowLimit（工单162）= 托盘溢出档位（缺省 5——旧快照无字段的兼容口径） */
export interface TaskbarViewModel {
  visible: boolean
  buttons: TaskbarButtonSpec[]
  recommendations: TaskbarRecommendation[]
  menu: TaskbarMenuRow[]
  metrics: TaskbarMetric[]
  /** 应用组（工单52）：序与运行态由内核编排查好，本层原样透出 + tooltip 回退 */
  apps: TaskbarAppViewEntry[]
  /** 托盘入栏名单（工单56）：身份键/tooltip/像素键原样透出——渲染层只负责摆与画 */
  tray: TaskbarTrayEntry[]
  /** 托盘溢出档位（工单162）：拆分名单与档位菜单 current 标记的唯一来源 */
  trayOverflowLimit: TaskbarTrayOverflowLimit
}

/**
 * 状态 → 视图：禁用即空壳；开始组 pill 显隐 = 可见按钮或推荐位任非空（两按钮都隐藏且
 * 推荐位为空 → 整组不渲染）。菜单行恒列两按钮——只要开始组 pill 还渲染，被藏按钮就有恢复入口；
 * 两按钮全隐藏且推荐位为空的空壳态无栏面可右键，恢复走 config.json 手改口（与几何配置同风格）。
 */
export function taskbarViewModel(state: TaskbarState): TaskbarViewModel {
  if (!state.enabled) return { visible: false, buttons: [], recommendations: [], menu: [], metrics: [], apps: [], tray: [], trayOverflowLimit: 5 }
  const hidden = new Set(state.hiddenButtons)
  const buttons = TASKBAR_BUTTONS.filter((b) => !hidden.has(b.id))
  const recommendations = [...state.recommendations]
  const menu = TASKBAR_BUTTONS.map((b) => ({
    id: b.id,
    label: `${hidden.has(b.id) ? '显示' : '隐藏'}${BUTTON_NAMES[b.id]}`,
    hidden: hidden.has(b.id),
  }))
  const apps = (state.apps ?? []).map((e) => ({
    id: e.exe,
    exe: e.exe,
    label: e.label,
    pinned: e.pinned,
    running: e.running,
    tooltip: e.title ?? e.label,
    iconKey: e.iconKey,
  }))
  return {
    visible: buttons.length > 0 || recommendations.length > 0,
    buttons,
    recommendations,
    menu,
    metrics: [...state.metrics],
    apps,
    tray: [...(state.tray ?? [])],
    trayOverflowLimit: state.trayOverflowLimit ?? 5,
  }
}

/**
 * 应用组图标首字母占位文本（工单156）：无图标键条目不出空白格——显示名首字符
 * （ASCII 字母大写化，非字母原样），显示名空回退 exe 基名首字符，再取不到回退 '?'。
 * 纯函数：DOM 落位在 taskbar.ts 的 makeAppEl，本函数只出文本。
 */
export function appIconFallbackText(e: Pick<TaskbarAppViewEntry, 'label' | 'exe'>): string {
  const first = (s: string) => {
    const c = s.replace(/^.*[\\/]/, '').replace(/^\.+/, '').charAt(0)
    return c ? c.toUpperCase() : ''
  }
  return first(e.label) || first(e.exe) || '?'
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

/**
 * 右键菜单显隐切换（工单54）：id + 目标态经桥 invoke，回执 = 最新任务栏状态
 * （内核已回推 taskbar/changed，回执供调用点即时对齐）。未知 id 是噪声：不发 invoke，返回 null。
 */
export async function dispatchTaskbarVisibility(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  buttonId: TaskbarButtonId,
  hidden: boolean,
): Promise<TaskbarState | null> {
  if (!TASKBAR_BUTTONS.some((b) => b.id === buttonId)) return null
  return bridge.invoke('taskbar/set-button-hidden', { id: buttonId, hidden })
}

// —— 工单56 托盘入栏：像素取字节 + 点击回放分发 ——

/** 托盘图标显示档（工单158：16→24px，观感不小于原生任务栏的 24px 托盘图标） */
export const TASKBAR_TRAY_ICON_PX = 24

/**
 * 托盘图标最近邻放大判据（工单158 纯函数）：源尺寸小于显示档（典型 16px 原生源）
 * 需挂 .tb-tray-px（image-rendering: pixelated）做最近邻放大保持锐利——平滑插值会把
 * 16px 小图标糊成一团；源 ≥ 显示档（典型 32px 源降采样到 24）相反，平滑插值才干净，
 * 最近邻降采样会丢像素出毛边。挂靠 class 的裁决在渲染层 makeTrayEl，本函数只判尺寸。
 */
export function trayIconPixelated(naturalWidth: number): boolean {
  return Number.isFinite(naturalWidth) && naturalWidth > 0 && naturalWidth < TASKBAR_TRAY_ICON_PX
}

/** 托盘图标像素取字节（工单56）：条目身份 → BGRA 像素（渲染层本地 canvas 转 dataURL 并缓存） */
export async function fetchTrayIcon(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  key: string,
): Promise<TaskbarTrayPixels | null> {
  const res = await bridge.invoke('taskbar/tray-icon', { key })
  return res?.icon ?? null
}

/** 托盘图标点击回放（工单56）：左键/右键经桥 invoke，响应原样上抛（ok:false 不抛——
 * 应用退场与点击同帧的竞态按普通失败呈现）。空 key 是噪声：不发 invoke。 */
export async function dispatchTrayClick(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  key: string,
  button: TaskbarTrayButton,
): Promise<{ ok: boolean; error?: string }> {
  if (!key) return { ok: false, error: '空托盘身份' }
  const res = await bridge.invoke('taskbar/tray-click', { key, button })
  return { ok: res.ok, ...(res.error ? { error: res.error } : {}) }
}

// —— 工单162 托盘溢出菜单：档位拆分 + 菜单行生成 + 档位分发 ——

/** 档位菜单行清单（两挂点「⋯」右键/右组空白处右键共用）：序即渲染序 */
export const TRAY_OVERFLOW_TIERS: ReadonlyArray<{ limit: TaskbarTrayOverflowLimit; label: string }> = [
  { limit: 3, label: '3 枚' },
  { limit: 5, label: '5 枚' },
  { limit: 8, label: '8 枚' },
  { limit: 'all', label: '全部' },
] as const

/** 档位菜单行（current = 当前档）：「✓ 」前缀在渲染层落，本函数只给数据 */
export function trayOverflowTierRows(current: TaskbarTrayOverflowLimit): Array<{ limit: TaskbarTrayOverflowLimit; label: string; current: boolean }> {
  return TRAY_OVERFLOW_TIERS.map((t) => ({ ...t, current: t.limit === current }))
}

/**
 * 托盘溢出拆分（工单162）：裁决本体是 shared/overflow 的 planTrayOverflow（与应用组
 * planAppsOverflow 同形态、同处 shared），本层只是把它接到托盘条目上。
 * overflow 非空即栏内「⋯」钮的渲染判据；浮层条目与栏内同一份名单序。
 */
export function splitTrayOverflow(
  tray: readonly TaskbarTrayEntry[],
  limit: TaskbarTrayOverflowLimit,
): { bar: TaskbarTrayEntry[]; overflow: TaskbarTrayEntry[] } {
  return planTrayOverflow(tray, limit)
}

/** 托盘溢出菜单行（工单162）：每行图标+名称——名称取 tooltip，空回退身份键（无 tip
 * 图标不出空行）。序 = 溢出名单序（= 栏内名单序的尾部）。 */
export function trayOverflowMenuRows(overflow: readonly TaskbarTrayEntry[]): Array<{ key: string; label: string }> {
  return overflow.map((e) => ({ key: e.key, label: e.tooltip || e.key }))
}

/**
 * 档位选择分发（工单162）：档位经桥 invoke（taskbar/set-tray-overflow-limit），校验
 * 与持久化在内核；回执 = 最新任务栏状态。档位外取值是噪声：不发 invoke，返回 null
 * （菜单层只有四档固定行，畸形值只可能来自被篡改的调用方）。
 */
export async function dispatchTrayOverflowLimit(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  limit: TaskbarTrayOverflowLimit,
): Promise<TaskbarState | null> {
  if (!(TRAY_OVERFLOW_TIERS as ReadonlyArray<{ limit: TaskbarTrayOverflowLimit }>).some((t) => t.limit === limit)) return null
  return bridge.invoke('taskbar/set-tray-overflow-limit', { limit })
}

// —— 工单53 应用组交互：点击三态/中键新实例/多窗口选窗/右键菜单动作 ——

/** 应用组应用右键菜单动作（工单53）：手钉/解除手钉、关闭窗口、打开文件位置 */
export type TaskbarAppMenuAction = 'pin' | 'unpin' | 'close' | 'reveal'

/** 应用组应用右键菜单行（工单53）：pill 内横排最小菜单（工单54 同形态） */
export interface TaskbarAppMenuRow {
  action: TaskbarAppMenuAction
  label: string
}

/**
 * 应用组应用右键菜单行：手钉/解除手钉按 pinned 取一首行；关闭窗口仅运行中在列
 * （未运行没有可关的窗口）；打开文件位置恒在（手钉条目未运行也可定位 exe）。
 */
export function taskbarAppMenuRows(entry: Pick<TaskbarAppViewEntry, 'pinned' | 'running'>): TaskbarAppMenuRow[] {
  const rows: TaskbarAppMenuRow[] = [
    entry.pinned ? { action: 'unpin', label: '解除手钉' } : { action: 'pin', label: '手钉到任务栏' },
  ]
  if (entry.running) rows.push({ action: 'close', label: '关闭窗口' })
  rows.push({ action: 'reveal', label: '打开文件位置' })
  return rows
}

/** 左键点击回执（工单53）：action=window-list 时 windows 携带带标题清单（标题仅即时显示） */
export interface TaskbarAppClickResult {
  ok: boolean
  action: TaskbarAppClickAction | null
  windows?: TaskbarWindowRef[]
  error?: string
}

/** 左键分发：exe 身份经桥 invoke，三态/多窗口裁决在内核（渲染层不判前台）。空 exe 是噪声。 */
export async function dispatchAppClick(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  exe: string,
): Promise<TaskbarAppClickResult> {
  if (!exe) return { ok: false, action: null }
  return bridge.invoke('taskbar/app-click', { exe })
}

/** 多窗口列表选窗分发：hwnd 精确到达目标窗口。非法 hwnd 是噪声（不发 invoke）。 */
export async function dispatchActivateWindow(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  hwnd: number,
): Promise<{ ok: boolean; error?: string }> {
  if (!Number.isFinite(hwnd) || hwnd <= 0) return { ok: false }
  return bridge.invoke('taskbar/activate-window', { hwnd })
}

/** 中键新实例分发：恒启动（内核应用组护栏兜底）。空 exe 是噪声。 */
export async function dispatchAppNewInstance(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  exe: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!exe) return { ok: false }
  return bridge.invoke('taskbar/app-new-instance', { exe })
}

/**
 * 右键菜单动作分发：pin/unpin 归一为 taskbar/set-app-pinned（回执 = 最新任务栏状态，
 * 内核已回推 taskbar/changed）；close/reveal 各自到桥。未知动作/空 exe 是噪声：不发
 * invoke，返回 null。
 */
export async function dispatchAppMenuAction(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  exe: string,
  action: TaskbarAppMenuAction,
): Promise<TaskbarState | { ok: boolean; closed?: number; error?: string } | null> {
  if (!exe) return null
  switch (action) {
    case 'pin':
      return bridge.invoke('taskbar/set-app-pinned', { exe, pinned: true })
    case 'unpin':
      return bridge.invoke('taskbar/set-app-pinned', { exe, pinned: false })
    case 'close':
      return bridge.invoke('taskbar/close-window', { exe })
    case 'reveal':
      return bridge.invoke('taskbar/reveal-app', { exe })
    default:
      return null
  }
}

/**
 * 栏上拖拽落位分发（工单57）：描述子（from/to 组别、条目身份、落点身份）经桥 invoke，
 * 落位裁决与落盘在内核；响应原样上抛（ok:false 也返回——拖拽落位不需 try/catch）。
 * 畸形描述子在渲染层就被挡下（不发 invoke）：组别/身份缺失是噪声，不是契约违规。
 */
export async function dispatchTaskbarDragDrop(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  drop: TaskbarDragDrop,
): Promise<{ ok: boolean; error?: string }> {
  const groups: readonly string[] = ['apps', 'recs']
  if (!drop || !drop.id || !groups.includes(drop.from) || !groups.includes(drop.to)) {
    return { ok: false, error: '拖拽描述子畸形' }
  }
  return bridge.invoke('taskbar/drag-drop', drop)
}

// —— 工单160 推荐组交互：图标化条目的左键启动 / 右键两行菜单 ——

/** 推荐组条目右键菜单动作（工单160）：手钉到任务栏、打开文件位置——「从推荐栏移除」
 * 是工单161 的持久排除名单领域，本菜单不列。 */
export type TaskbarRecMenuAction = 'pin' | 'reveal'

/** 推荐组条目右键菜单行（工单160）：pill 内横排最小菜单（工单53/54 同形态） */
export interface TaskbarRecMenuRow {
  action: TaskbarRecMenuAction
  label: string
}

/**
 * 推荐组条目右键菜单行（工单160）：固定两行——手钉进既有手钉清单管线（手钉后该应用
 * 从推荐组消失、应用组手钉段出现）、打开文件位置走 explorer 定位通道。无按条目形态
 * 变化的行（推荐位条目恒未手钉——手钉条目被可见性管线滤出推荐组）。
 */
export function taskbarRecMenuRows(): TaskbarRecMenuRow[] {
  return [
    { action: 'pin', label: '手钉到任务栏' },
    { action: 'reveal', label: '打开文件位置' },
  ]
}

/**
 * 推荐组条目左键启动分发（工单160）：富化后的 exe 身份经桥 invoke
 * （taskbar/rec-click），启动走既有 shell 打开通道，裁决与护栏在内核。响应原样上抛
 * （ok:false 也返回——栏面竞态按普通失败呈现）；空 exe 是噪声（不发 invoke）。
 */
export async function dispatchRecClick(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  exe: string,
): Promise<{ ok: boolean; error?: string }> {
  if (!exe) return { ok: false, error: '空推荐条目身份' }
  return bridge.invoke('taskbar/rec-click', { exe })
}

/**
 * 推荐组条目右键菜单动作分发（工单160）：pin→taskbar/rec-pin（回执 = 最新任务栏状态，
 * 内核已回推 taskbar/changed）；reveal→taskbar/rec-reveal。未知动作/空 exe 是噪声：
 * 不发 invoke，返回 null。
 */
export async function dispatchRecMenuAction(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  exe: string,
  action: TaskbarRecMenuAction,
): Promise<TaskbarState | { ok: boolean; error?: string } | null> {
  if (!exe) return null
  switch (action) {
    case 'pin':
      return bridge.invoke('taskbar/rec-pin', { exe })
    case 'reveal':
      return bridge.invoke('taskbar/rec-reveal', { exe })
    default:
      return null
  }
}

/** 应用组溢出拆分（工单58）：裁决本体是 apps-plan 的 planAppsOverflow（编排纯函数），
 * 本层只是把它接到视图条目上——slots 由渲染层按 pill 几何实测（含 ⋯ 钮位）。
 * overflow 非空即 ⋯ 钮的渲染判据；浮层条目与栏内同一份引用（同形态同挂点）。 */
export function splitAppsOverflow(
  apps: readonly TaskbarAppViewEntry[],
  slots: number,
): { bar: TaskbarAppViewEntry[]; overflow: TaskbarAppViewEntry[] } {
  return planAppsOverflow(apps, slots)
}

// —— 工单159 栏分组布局重排：应用组空带居中几何（纯函数；DOM 落位在 taskbar.ts）——
// 布局反转：开始组钉条带左缘、应用组在 [开始组右缘, 右组左缘] 空带内居中（随两侧内容
// 浮动，非屏幕绝对中心）。居中参照系与容量边界两侧化在本层纯函数化——几何算式单测可钉，
// DOM 侧（taskbar.ts）只做矩形实测与落位。

/** 应用组几何常量（与 taskbar.html CSS 同源：pill 内衬 8+8、图标格 44+2 间距、组间距 8、
 * 条带左缘内衬 8——工单158 尺寸基）。格数宁保守不少让——多留缝也不与邻组重叠。 */
export const APPS_INSET = 8
export const PILL_PAD_X = 16
export const CELL_W = 46
export const GROUP_GAP = 8

/** 应用组空带：[lo, hi] = [开始组右缘（含组间距）, 右组左缘（含组间距）]——
 * 应用组居中的参照系（工单159 词汇口径：推荐组右缘与右组左缘之间；推荐位暂栖开始组
 * pill，故左界 = 开始组 pill 右缘，推荐组独立拆出后随迁） */
export interface AppsBand { lo: number; hi: number }

/** 空带两侧边界：开始组整组不渲染（两按钮全隐藏且无推荐）时左界退到条带左缘内衬；
 * 右组自身越界左侵（异常态，26+ 托盘极端拥挤）产出零宽带——不产出负带宽，等下一拍 */
export function appsBand(startRight: number | null, rightLeft: number): AppsBand {
  const lo = startRight === null ? APPS_INSET : startRight + GROUP_GAP
  const hi = Math.max(rightLeft - GROUP_GAP, lo)
  return { lo, hi }
}

/** 应用组容量（工单159 两侧化）：带宽 − pill 内衬 → 图标格数（含 ⋯ 钮位，工单58 口径）。
 * 旧单侧口径（右限 = 开始组 pill 左缘）随布局反转退役——现在两侧邻组都是边界 */
export function appsSlotsFor(band: AppsBand): number {
  return Math.max(0, Math.floor((band.hi - band.lo - PILL_PAD_X) / CELL_W))
}

/** 居中位：带宽足够取带中点；恰占满贴带左缘；超带宽（溢出浮层展开等病态档）钉带左缘
 * ——右溢不反演到开始组一侧（DOM 后绘的右组在上，病态档从右组下溢出，与旧布局同降级）。
 * 夹取保证有带宽时永不与邻组重叠；容量（appsSlotsFor）按闭合形态算，栏内段恒在带内 */
export function appsPillLeft(band: AppsBand, pillWidth: number): number {
  const w = Math.max(0, pillWidth)
  let left = (band.lo + band.hi) / 2 - w / 2
  if (left < band.lo) left = band.lo
  if (left + w > band.hi) left = band.hi - w
  if (left < band.lo) left = band.lo
  return Math.round(left)
}

/**
 * 应用组应用图标点击分发（工单58）：栏内与溢出浮层共用同一道分发——exe 身份经桥
 * invoke，启动/置前裁决在内核（taskbar/activate-app）。响应原样上抛（ok:false 也
 * 返回——点击语义不需 try/catch）；空 exe 是噪声（不发 invoke）。
 * 工单53 衔接面：右键菜单/中键/最小化切换在同一 exe 身份上另开动作，本分发不变。
 */
export async function dispatchTaskbarApp(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  exe: string,
): Promise<{ ok: boolean; action: TaskbarActivateAction | null; error?: string }> {
  if (!exe) return { ok: false, action: null }
  return bridge.invoke('taskbar/activate-app', { exe })
}
