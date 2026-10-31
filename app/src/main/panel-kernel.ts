// 面板主进程内核装配（Electron 专用）：窗口宿主面的服务 + 数据面宿主（utilityProcess
// 子进程）+ 桥接层。本文件 import 的 DataplaneService 顶层引 electron——离线测试不加载
// 本文件，内核测试用 kernel.ts 的进程内装配（createKernel）。
import { Context } from 'cordis'
import { BridgeService } from './services/bridge'
import { ClockService } from './services/clock'
import { SearchService, type SearchServiceOptions } from './services/search'
import { SettingsService, type SettingsServiceOptions } from './services/settings'
import { FocusService, type FocusServiceOptions } from './services/focus'
import { PluginHostService, type PluginHostOptions } from './plugins/service'
import { DataplaneService, type DataplaneServiceOptions } from './services/dataplane'
import { TaskbarService, type TaskbarServiceOptions } from './services/taskbar'
import { PluginConfigService, type PluginConfigServiceOptions } from './services/plugin-config'
import { ConversationService, type ConversationServiceOptions } from './conversation/service'
import { MediaService, type MediaServiceOptions } from './media/service'
import { NetworkService, type NetworkServiceOptions } from './network/service'
import { CredentialService, type CredentialServiceOptions } from './credentials/service'
import { DEFAULT_SEARCH_INTERVAL_MS, DEFAULT_TASKBAR_POLL_MS } from './kernel'
import type { DesktopLayout, WeatherLocation } from '../shared/contract'

export interface PanelKernelOptions {
  /** 天气卡取数坐标（config.json 下发） */
  weather?: WeatherLocation
  /** 桌面承载几何（config.json 下发；随快照给渲染层） */
  layout?: DesktopLayout
  /** 搜索（工单07）：端口与依赖 */
  search?: SearchServiceOptions
  /** 搜索引擎链路泵间隔（ms）；0 = 不装定时器 */
  searchIntervalMs?: number
  /** 设置（工单08）：config 文件路径与可变引用 */
  settings?: SettingsServiceOptions
  /** 会话行直达（工单09）：工具→exe 映射与依赖 */
  focus?: FocusServiceOptions
  /** 桌面组件宿主（工单10） */
  plugins?: PluginHostOptions
  /** 数据面宿主（采集子进程） */
  dataplane: DataplaneServiceOptions
  /** 任务栏（工单49）：config 文件路径与可变引用（持久化通道，settings 同款） */
  taskbar?: TaskbarServiceOptions
  /** 任务栏应用组编排轮询间隔（ms，工单52）；0 = 不装定时器，缺省 = DEFAULT_TASKBAR_POLL_MS */
  taskbarPollMs?: number
  /** 插件私有状态（工单178）：命名空间存储目录缺省 userData/plugin-config（生产装配不传即缺省落点） */
  pluginConfig?: PluginConfigServiceOptions
  /** 退出面板（工单83）：app.quit 注入（index.ts 生产装配提供） */
  quit?: () => void
  /** 对话窗（工单332）：DSH_HOME/工作目录根/元数据文件/后端档/窗口唤起钩子（生产装配下发） */
  conversation?: ConversationServiceOptions
  /** 媒体域（工单336，ADR-0025）：审计文件/桥 exe/授权账（生产装配下发；缺省 = 桥缺席明确态） */
  media?: MediaServiceOptions
  /** 网络域（工单338，ADR-0025）：审计文件/授权账（生产装配下发；缺省 = 全拒的无授权面） */
  network?: NetworkServiceOptions
  /** 命名凭证域（工单339）：凭证库文件/加密端口（生产装配下发；缺省 = 只读不写） */
  credentials?: CredentialServiceOptions
  /** 诊断读数（工单341 资源预算）：memory = 面板全进程工作集（生产 = app.getAppMetrics 汇总） */
  diagnostics?: {
    memory?: () => { totalWorkingSetMB: number; processes: Array<{ pid: number; type: string; workingSetMB: number }> }
  }
}

export function createPanelKernel(options: PanelKernelOptions): Context {
  const ctx = new Context()
  ctx.plugin(ClockService)
  ctx.plugin(SearchService, options.search)
  ctx.plugin(SettingsService, options.settings)
  ctx.plugin(FocusService, options.focus)
  // 桌面组件宿主：缺省 roots=[]——不装任何插件、不建目录（与 createKernel 同款默认）。
  // 停用集（工单101）：缺省接 settings 注入的 config 活引用（生产装配显式传同一引用），
  // settings/set-card-enabled 改写后重扫即生效。
  ctx.plugin(PluginHostService, {
    roots: [],
    disabledIds: () => options.settings?.config?.plugins?.disabled ?? [],
    ...options.plugins,
  })
  // 数据面端口（生产装配：utilityProcess 子进程宿主）——必须先于桥接层注册
  ctx.plugin(DataplaneService, options.dataplane)
  // 任务栏（工单49）：BridgeService 注入依赖它，必须先于桥接层注册。
  // 推荐位（工单54）缺省接 panelData——数据面快照随拍携带的频次链路产物。
  ctx.plugin(TaskbarService, {
    ...options.taskbar,
    deps: {
      ...options.taskbar?.deps,
      recommendations: options.taskbar?.deps?.recommendations
        ?? (() => ctx.panelData?.taskbarRecommendations() ?? []),
      // 托盘点击回放（工单56）：真源在数据面托盘宿主（Win32 同处），主进程只转发请求。
      // 离线内核无 panelData 时按「送不出去」回报（契约测试注假源）。
      replayTrayClick: options.taskbar?.deps?.replayTrayClick
        ?? ((key, button) => (ctx.panelData as { replayTrayClick?: (k: string, b: 'left' | 'right') => boolean } | undefined)
          ?.replayTrayClick?.(key, button) ?? false),
    },
  })
  // 插件私有状态（工单178）：BridgeService 的 inject 列了 'pluginConfig'，本装配必须注册它——
  // 缺注册时 cordis 静默不装载 BridgeService（ctx.bridge 为 undefined），面板在
  // wireBridgeIpc(win, kernel.bridge) 处即崩，一扇窗都开不出来（工单187 真机轮实证）。
  ctx.plugin(PluginConfigService, options.pluginConfig)
  // 对话窗会话服务（工单332）：BridgeService 注入依赖它，必须先于桥接层注册。
  ctx.plugin(ConversationService, options.conversation)
  // 媒体域（工单336）：可选装配（缺省 = 桥缺席明确态）；BridgeService 的媒体方法经
  // ctx.media? 可选访问（不进 inject 清单——缺装配不得让桥接层静默不装载，pluginConfig 先例）。
  ctx.plugin(MediaService, options.media)
  // 命名凭证域（工单339）：凭证库先于网络域注册——NetworkBroker 的解析口要拿到同一实例。
  ctx.plugin(CredentialService, options.credentials)
  // 网络域（工单338/339）：授权门/限额/审计在 NetworkBroker；凭证注入经凭证库解析口。
  ctx.plugin(NetworkService, {
    ...options.network,
    credentials: {
      resolve: (packageId, credentialName, origin) => {
        const svc = ctx.credentials
        return svc ? svc.resolve(packageId, credentialName, origin) : { ok: false as const, code: 'credential_unavailable' as const, message: '凭证面未装配' }
      },
    },
  })
  ctx.plugin(BridgeService, {
    weather: options.weather,
    layout: options.layout,
    quit: options.quit,
    ...(options.diagnostics?.memory ? { memoryProbe: options.diagnostics.memory } : {}),
  })
  const searchIntervalMs = options.searchIntervalMs ?? DEFAULT_SEARCH_INTERVAL_MS
  if (searchIntervalMs > 0) {
    // 引擎链路泵（防抖到期/限流退避/离线重试的统一判定点；50ms 量级 = 旧 Tk _tick 先例）
    const timer = setInterval(() => ctx.search?.tick(), searchIntervalMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  const taskbarPollMs = options.taskbarPollMs ?? DEFAULT_TASKBAR_POLL_MS
  if (taskbarPollMs > 0) {
    // 应用组编排轮（工单52）：应用启动/退出 1–2 秒内反映到应用组（窗口枚举 → 纯函数编排 → 变化即推）
    const timer = setInterval(() => ctx.taskbar?.refresh(), taskbarPollMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  return ctx
}
