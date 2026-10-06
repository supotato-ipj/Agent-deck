// 任务栏 pill 纯逻辑（工单49/52/54）：视图模型是状态 → 视图的纯函数（左组形态映射、
// 中组系统按钮显隐、推荐位透出、整组显隐边界、右键菜单行），点击分发只经桥契约。
// 本模块不碰 DOM/Node——fake bridge 契约测试在 Node 中直接驱动（menu-shell 先例）。
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, TaskbarButtonId, TaskbarRecommendation, TaskbarState, TaskbarSystemAction } from '../shared/contract'

/** 渲染层桥接面（window.deck.bridge 的结构子集；测试注入 fake） */
export interface TaskbarBridge {
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
  on<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void
}

/** 中组系统按钮（工单49：开始 + TaskView） */
export interface TaskbarButtonSpec {
  id: TaskbarButtonId
  label: string
  action: TaskbarSystemAction
}

export const TASKBAR_BUTTONS: readonly TaskbarButtonSpec[] = [
  { id: 'start', label: '⊞ START', action: 'start-menu' },
  { id: 'tasks', label: '▦ TASK VIEW', action: 'task-view' },
] as const

/** 右键菜单行（工单54）：每个系统按钮一行显隐切换；hidden=true 的行即恢复入口 */
export interface TaskbarMenuRow {
  id: TaskbarButtonId
  label: string
  hidden: boolean
}

/** 按钮 id → 菜单行中文名（隐藏/显示谓语共用同一词干） */
const BUTTON_NAMES: Record<TaskbarButtonId, string> = { start: '开始按钮', tasks: '任务视图按钮' }

/**
 * 左组条目视图（工单52）：内核编排（left-plan 纯函数）的输出原样进渲染层，
 * 本层只做形态映射。id = exe 身份原文——工单53 的点击/右键分发以它为挂点
 * （渲染层元素落 data-exe，分发经桥契约按身份寻址）。
 */
export interface TaskbarLeftViewEntry {
  id: string
  exe: string
  label: string
  pinned: boolean
  running: boolean
  /** tooltip 文本：窗口标题优先（仅运行中在场，仅内存），回退显示名 */
  tooltip: string
  iconKey: string | null
}

/** 任务栏视图模型：visible=false = 中组整个不渲染（只剩左右两组的边界条件） */
export interface TaskbarViewModel {
  visible: boolean
  buttons: TaskbarButtonSpec[]
  recommendations: TaskbarRecommendation[]
  menu: TaskbarMenuRow[]
  /** 左组（工单52）：序与运行态由内核编排查好，本层原样透出 + tooltip 回退 */
  left: TaskbarLeftViewEntry[]
}

/**
 * 状态 → 视图：禁用即空壳；中组显隐 = 可见按钮或推荐位任非空（两按钮都隐藏且
 * 推荐位为空 → 整组不渲染）。菜单行恒列两按钮——只要中组还渲染，被藏按钮就有恢复入口；
 * 两按钮全隐藏且推荐位为空的空壳态无栏面可右键，恢复走 config.json 手改口（与几何配置同风格）。
 */
export function taskbarViewModel(state: TaskbarState): TaskbarViewModel {
  if (!state.enabled) return { visible: false, buttons: [], recommendations: [], menu: [], left: [] }
  const hidden = new Set(state.hiddenButtons)
  const buttons = TASKBAR_BUTTONS.filter((b) => !hidden.has(b.id))
  const recommendations = [...state.recommendations]
  const menu = TASKBAR_BUTTONS.map((b) => ({
    id: b.id,
    label: `${hidden.has(b.id) ? '显示' : '隐藏'}${BUTTON_NAMES[b.id]}`,
    hidden: hidden.has(b.id),
  }))
  const left = (state.left ?? []).map((e) => ({
    id: e.exe,
    exe: e.exe,
    label: e.label,
    pinned: e.pinned,
    running: e.running,
    tooltip: e.title ?? e.label,
    iconKey: e.iconKey,
  }))
  return { visible: buttons.length > 0 || recommendations.length > 0, buttons, recommendations, menu, left }
}

/**
 * 按钮点击分发：id → 系统动作经桥 invoke。未知 id 是噪声（不发 invoke）。
 * 响应原样上抛（ok:false 也返回——合成被系统拒收不是渲染层异常）。
 */
export async function dispatchTaskbarButton(
  bridge: Pick<TaskbarBridge, 'invoke'>,
  buttonId: string,
): Promise<{ ok: boolean; action: TaskbarSystemAction | null; error?: string }> {
  const btn = TASKBAR_BUTTONS.find((b) => b.id === buttonId)
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
