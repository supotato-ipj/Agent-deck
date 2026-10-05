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

/** 状态 → 视图：禁用即空壳（窗口随插件禁用销毁，这里仍给出确定性空态） */
export function taskbarViewModel(state: TaskbarState): { buttons: TaskbarButtonSpec[] } {
  return { buttons: state.enabled ? [...TASKBAR_BUTTONS] : [] }
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
