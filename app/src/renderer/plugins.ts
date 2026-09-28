// 桌面组件运行时（工单10 插件体系，渲染层）。
//
// 边界与 02 注记 4 的 supersede 一致：渲染层从此是原生 ESM 页面（index.html 经
// deck-plugin:// 协议加载），插件资产与宿主页面同源同协议，动态 import 即为加载通道。
// 插件拿到的永远是裁剪过的快照（manifest 的 capabilities 声明多少就给多少，少给而非不给），
// 且插件文件永不由渲染层触碰——资产经协议下发、数据经既有桥接契约，两条通道都不新增。
import type { BridgeMethod, BridgeMethods, PanelSnapshot, PluginInfo } from '../shared/contract'

/** 插件拿到的裁剪视图：按 capabilities 取快照的若干段，其余键根本不存在 */
export type PluginView = Partial<PanelSnapshot>

/** 插件宿主上下文：容器 + 视图 + 与面板同一条存证/桥接通道 */
export interface PluginHost {
  /** 插件自己的容器（插件往里画；manifest.mount 给了就是那个锚点元素） */
  el: HTMLElement
  /** 按 capabilities 裁剪后的快照视图 */
  view: PluginView
  /** 存证上报（与面板同一通道，电池同法断言） */
  notify(type: string, payload?: Record<string, unknown>): void
  /** 内核桥接契约调用（渲染层不另开通道） */
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
}

/** 插件模块契约：默认导出一个对象即被识别（生命周期钩子，缺省项可省） */
export interface PluginApi {
  /** 挂载：拿容器与首次视图 */
  mount(host: PluginHost): void
  /** 快照到达（仅在能力内的数据变化时调；视图内容变了才来） */
  update?(host: PluginHost): void
  /** 卸载：释放自建资源（默认宿主会清空容器） */
  unmount?(): void
}

interface Mounted {
  api: PluginApi
  container: HTMLElement
  view: PluginView
  viewKey: string
  /** 本次装载所依据的 entry URL（含 ?v= 代号）：换代即重挂 */
  entryUrl: string
}

/** 宿主回调：插件增删会改 DOM，热区矩形要跟着重声明 */
export interface PluginRuntimeDeps {
  notify(type: string, payload?: Record<string, unknown>): void
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
  /** 插件挂载/卸载后 DOM 变了（重声明热区） */
  onDomChanged(): void
}

const mounted = new Map<string, Mounted>()
/** 在途 import 的代号：期间插件被卸载/换代号时，令牌作废、迟到的模块不复活组件 */
let seq = 0

/** 按能力裁剪：capability 名即快照段名，认得的段取给，未声明的段不出内核 */
function viewFor(info: PluginInfo, snap: PanelSnapshot): PluginView {
  const view: Record<string, unknown> = {}
  const bag = snap as unknown as Record<string, unknown>
  for (const cap of info.capabilities) {
    if (cap in bag) view[cap] = bag[cap]
  }
  return view as PluginView
}

function hostOf(info: PluginInfo, container: HTMLElement, view: PluginView, deps: PluginRuntimeDeps): PluginHost {
  return {
    el: container,
    view,
    notify: deps.notify,
    invoke: (method, payload) => deps.invoke(method, payload),
  }
}

/** 坏插件静默降级：不弹窗、不打断面板，只留存证（与面板其余失败路径同纪律） */
function unmountOne(id: string): void {
  const entry = mounted.get(id)
  if (!entry) return
  mounted.delete(id)
  try {
    entry.api.unmount?.()
  } catch (err) {
    console.warn(`[deck-plugin] ${id} 的 unmount 抛错：`, err)
  }
  entry.container.remove()
}

async function mountOne(info: PluginInfo, snap: PanelSnapshot, deps: PluginRuntimeDeps): Promise<void> {
  const token = ++seq
  let api: PluginApi
  try {
    const mod = await import(info.entry) as { default?: PluginApi } & PluginApi
    api = mod.default ?? mod
    if (typeof api?.mount !== 'function') throw new Error('模块未导出 mount（default 导出契约对象）')
  } catch (err) {
    deps.notify('plugin-load-failed', { id: info.id, message: String(err) })
    return
  }
  // import 期间面板可能又变了：令牌不符即丢弃这次装载（否则会复活已卸载的组件）
  if (token !== seq) return

  const container = document.createElement('div')
  container.className = 'deck-plugin'
  container.dataset.pluginId = info.id
  const anchor = info.mount ? document.getElementById(info.mount) : null
  ;(anchor ?? document.body).appendChild(container)

  const view = viewFor(info, snap)
  const viewKey = JSON.stringify(view)
  const host = hostOf(info, container, view, deps)
  try {
    api.mount(host)
  } catch (err) {
    deps.notify('plugin-mount-failed', { id: info.id, message: String(err) })
    container.remove()
    return
  }
  mounted.set(info.id, { api, container, view, viewKey, entryUrl: info.entry })
  deps.notify('plugin-mounted', { id: info.id, name: info.name, capabilities: info.capabilities })
  deps.onDomChanged()
}

/**
 * 按快照的 plugins 段对齐现场：新增装载、消失卸载、换代重挂、其余只推视图更新。
 * 每拍都可调——幂等是这里的基本要求（清单未变时不做任何 DOM 动作）。
 */
export function syncPlugins(list: PluginInfo[], snap: PanelSnapshot, deps: PluginRuntimeDeps): void {
  const ok = new Set(list.filter((p) => p.status === 'ok').map((p) => p.id))
  for (const id of [...mounted.keys()]) if (!ok.has(id)) unmountOne(id)

  for (const info of list) {
    if (info.status !== 'ok') continue
    const entry = mounted.get(info.id)
    const key = JSON.stringify(viewFor(info, snap))
    if (!entry) {
      void mountOne(info, snap, deps)
      continue
    }
    // 换代（资产变化 → 新 revision → entry URL 变）即重挂：ESM 模块缓存只能靠换 URL 绕开
    if (info.entry !== entry.entryUrl) {
      unmountOne(info.id)
      void mountOne(info, snap, deps)
      continue
    }
    if (key === entry.viewKey) continue
    entry.view = viewFor(info, snap)
    entry.viewKey = key
    try {
      entry.api.update?.(hostOf(info, entry.container, entry.view, deps))
    } catch (err) {
      deps.notify('plugin-update-failed', { id: info.id, message: String(err) })
    }
  }
}

/** 在装插件数（存证/调试用） */
export function mountedCount(): number {
  return mounted.size
}
