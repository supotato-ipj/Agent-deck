import { contextBridge, ipcRenderer } from 'electron'

/**
 * 投放包预载脚本（工单331，ADR-0025）：零权限包独立上下文的**唯一**宿主面。
 *
 * 基线宿主 API 分领域（host.view / host.config），**不带通用 invoke**：
 * - 没有 `window.deck`（面板受信内部桥在此不存在）；
 * - 没有原始 ipcRenderer / require / node 集成（sandbox:true + contextIsolation:true）；
 * - 没有 bridge 事件订阅、键盘档、桌面动作——投放窄面之外的面对投放包不存在。
 *
 * 身份绑定在主进程：config 调用只带载荷、不带 id，主进程从执行上下文登记表
 * （webContents.id → 包身份）推导，永不采信调用方自报。
 *
 * 视图数据经 `pkg:host-event` 单通道推送（主进程按 manifest capabilities 裁剪后才出）；
 * config 走 `pkg:config-get|set` 结构化信封（错误码即契约目录 errors 登记的形状）。
 */

/** 基线视图：按 capabilities 裁剪的快照段集合（clock/hardware/layout/settings ⊆ 声明） */
type PackageView = Record<string, unknown>

/** 结构化信封（与契约目录 errors 同形状；不 throw——错误是值不是异常） */
export type ConfigEnvelope =
  | { ok: true; config: Record<string, unknown>; warnings: string[] }
  | { ok: false; code: string; message: string }

/** 媒体缩略图信封（工单336；授权/校验在主进程 Broker，preload 只透传信封） */
export type MediaThumbnailEnvelope =
  | { ok: true; contentType: string; bytes: number; dataUrl: string }
  | { ok: false; code: string; message: string }

let currentView: PackageView = {}
const viewListeners = new Set<() => void>()

ipcRenderer.on('pkg:host-event', (_event, payload: { domain?: string; view?: PackageView }) => {
  if (payload && payload.domain === 'view' && typeof payload.view === 'object' && payload.view !== null) {
    currentView = payload.view
    for (const notify of [...viewListeners]) {
      try {
        notify()
      } catch { /* 监听器异常不连累宿主面 */ }
    }
  }
})

contextBridge.exposeInMainWorld('deckHost', {
  /**
   * host.view：只读快照视图（投放档四段上限，manifest 声明多少给多少）。
   * get() 取当前整份；subscribe(cb) 注册变化回调，返回退订函数。
   */
  view: {
    get: (): PackageView => currentView,
    subscribe: (listener: () => void): (() => void) => {
      viewListeners.add(listener)
      return () => { viewListeners.delete(listener) }
    },
  },
  /**
   * host.config：插件私有状态（按包命名空间；身份由主进程登记表推导）。
   * 结构化信封返回，不抛异常；超限/坏载荷在主进程拒收（config_too_large 等）。
   */
  config: {
    get: (): Promise<ConfigEnvelope> => ipcRenderer.invoke('pkg:config-get'),
    set: (patch: unknown): Promise<ConfigEnvelope> => ipcRenderer.invoke('pkg:config-set', patch),
  },
  /**
   * host.media（工单336，ADR-0025）：受控缩略图按需单取（快照本体走 view.media 推送）。
   * 授权门与类型/大小校验都在主进程 Broker（media.read 在账才供货；校验拒付一个字节
   * 不出——返回字节副本 dataURL，无原生流/WinRT 概念过此边界）。身份由登记表推导，
   * 调用只带会话键（带代次不透明键）。
   */
  media: {
    thumbnail: (sessionKey: string): Promise<MediaThumbnailEnvelope> =>
      ipcRenderer.invoke('pkg:media-thumbnail', sessionKey),
    // 工单337：媒体控制（media.control 授权后；授权门/限流/审计在 Broker）
    control: (sessionKey: string, action: string): Promise<unknown> =>
      ipcRenderer.invoke('pkg:media-control', { key: sessionKey, action }),
  },
  /**
   * host.network（工单338，ADR-0025 网络节）：向已获批的精确 origin 发起有界 HTTP(S)
   * 请求-响应。包页自己的 fetch/XHR 仍被 session 级 webRequest + CSP 全拒；放行只经此
   * 宿主代理面（主进程 NetworkBroker 做逐 origin 授权/限额/重定向策略/脱敏审计）。
   * 返回结构化信封，不抛异常：ok=false 时 code ∈ 契约错误目录（network_permission_denied
   * / network_rate_limited / network_timeout / network_redirect_blocked / network_failed）。
   */
  network: {
    request: (spec: { url: string; method?: string; headers?: Record<string, string>; body?: string; credential?: string }): Promise<unknown> =>
      ipcRenderer.invoke('pkg:network-request', spec),
  },
})
