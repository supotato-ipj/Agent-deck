// 任务栏 pill 纯逻辑（工单49）：按钮清单是状态 → 视图的纯函数，点击分发只经桥契约。
// 本模块不碰 DOM/Node——fake bridge 契约测试在 Node 中直接驱动（menu-shell 先例）。
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, TaskbarState, TaskbarSystemAction } from '../shared/contract'

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

/** 状态 → 视图：禁用即空壳（窗口随插件禁用销毁，这里仍给出确定性空态） */
export function taskbarViewModel(state: TaskbarState): { buttons: TaskbarButtonSpec[]; left: TaskbarLeftViewEntry[] } {
  if (!state.enabled) return { buttons: [], left: [] }
  return {
    buttons: [...TASKBAR_BUTTONS],
    left: (state.left ?? []).map((e) => ({
      id: e.exe,
      exe: e.exe,
      label: e.label,
      pinned: e.pinned,
      running: e.running,
      tooltip: e.title ?? e.label,
      iconKey: e.iconKey,
    })),
  }
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
