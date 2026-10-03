// 桌面组件运行时（工单10 插件体系，渲染层）。
//
// 边界与 02 注记 4 的 supersede 一致：渲染层从此是原生 ESM 页面（index.html 经
// deck-plugin:// 协议加载），插件资产与宿主页面同源同协议，动态 import 即为加载通道。
// 插件拿到的永远是裁剪过的快照（manifest 的 capabilities 声明多少就给多少，少给而非不给），
// 且插件文件永不由渲染层触碰——资产经协议下发、数据经既有桥接契约，两条通道都不新增。
import type { BridgeMethod, BridgeMethods, PanelSnapshot, PluginInfo } from '../shared/contract'
import { esc, pad, pad3, pct } from './format.js'

/** 插件拿到的裁剪视图：按 capabilities 取快照的若干段，其余键根本不存在 */
export type PluginView = Partial<PanelSnapshot>

/**
 * 宿主交给插件的通用呈现工具。
 * 插件资产经协议投递（URL 主机名即插件 id），插件目录**之外**的文件在协议寻址里不存在，
 * 相对导入一出目录就 404。故共用工具经宿主转交——插件保持单文件、零相对导入。
 */
export interface PluginUtil {
  pad(n: number, w?: number): string
  pad3(n: number): string
  pct(x: number | null | undefined): string
  esc(s: string): string
}

const UTIL: PluginUtil = { pad, pad3, pct, esc }

/** 插件宿主上下文：容器 + 视图 + 与面板同一条存证/桥接通道 */
export interface PluginHost {
  /** 插件自己的容器（插件往里画；manifest.mount 给了就是那个锚点元素） */
  el: HTMLElement
  /** 按 capabilities 裁剪后的快照视图 */
  view: PluginView
  /** 通用呈现工具（见 PluginUtil 注释：为什么不是插件自己 import） */
  util: PluginUtil
  /** 存证上报（与面板同一通道，电池同法断言） */
  notify(type: string, payload?: Record<string, unknown>): void
  /** 内核桥接契约调用（渲染层不另开通道） */
  invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']>
  /** 插件自行改了 DOM（浮层/菜单开合等）后调：宿主重声明热区（工单23 起） */
  onDomChanged(): void
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
/**
 * 在途装载的代号，**按插件计**：卸载（或换代重挂）即给该 id 换代。
 * 用全局单计数会让并发的多个插件互相作废——真机踩过：五卡同时 import，只有先落地的那个
 * 侥幸装上，其余四张被后发的计数顶掉，退化成「一张一张每秒补一张」（首屏缺卡 4 秒）。
 */
const generations = new Map<string, number>()
/**
 * 装载失败记账：id → 该 id 最近一次失败的入口与时刻。
 * - 不每拍重试：坏插件每拍重试会把存证日志刷成噪声（真机踩过：一个 404 的卡片 2 秒刷了
 *   88 条 plugin-load-failed）；
 * - 但必须留自愈口子：内置卡片的入口 URL 恒定不变，若被无限期拉黑，一次偶发失败
 *   （协议握手的瞬时抖动、构建时文件被占）会让它**永远**不再出现。故冷却后给一次机会。
 */
const failed = new Map<string, { entry: string; at: number }>()

/** 失败后的重试冷却（ms）：冷却期内不重试，冷却过后给一次自愈机会 */
const FAIL_RETRY_MS = 30_000

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
    util: UTIL,
    notify: deps.notify,
    invoke: (method, payload) => deps.invoke(method, payload),
    onDomChanged: deps.onDomChanged,
  }
}

/** 坏插件静默降级：不弹窗、不打断面板，只留存证（与面板其余失败路径同纪律） */
function unmountOne(id: string): void {
  const entry = mounted.get(id)
  // 卸载即给该 id 换代（并清失败记账）：在途 import 回来时令牌已旧，不得复活组件；
  // 重装时也给一次干净机会
  generations.set(id, (generations.get(id) ?? 0) + 1)
  failed.delete(id)
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
  // 冷却期内不重试；冷却过后（或换了新代资产）给一次自愈机会
  const mark = failed.get(info.id)
  if (mark && mark.entry === info.entry && Date.now() - mark.at < FAIL_RETRY_MS) return
  const gen = generations.get(info.id) ?? 0
  let api: PluginApi
  try {
    const mod = await import(info.entry) as { default?: PluginApi } & PluginApi
    api = mod.default ?? mod
    if (typeof api?.mount !== 'function') throw new Error('模块未导出 mount（default 导出契约对象）')
  } catch (err) {
    failed.set(info.id, { entry: info.entry, at: Date.now() })
    deps.notify('plugin-load-failed', { id: info.id, message: String(err) })
    return
  }
  // import 期间该插件可能已被卸载或换代：令牌已旧即丢弃这次装载（否则会复活已卸载的组件）
  if (gen !== (generations.get(info.id) ?? 0)) return

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
    failed.set(info.id, { entry: info.entry, at: Date.now() })
    deps.notify('plugin-mount-failed', { id: info.id, message: String(err) })
    container.remove()
    return
  }
  failed.delete(info.id) // 装上了，失败记账即刻作废
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
