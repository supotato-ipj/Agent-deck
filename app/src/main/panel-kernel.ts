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
import { DEFAULT_SEARCH_INTERVAL_MS } from './kernel'
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
  /** 退出面板（工单83）：app.quit 注入（index.ts 生产装配提供） */
  quit?: () => void
}

export function createPanelKernel(options: PanelKernelOptions): Context {
  const ctx = new Context()
  ctx.plugin(ClockService)
  ctx.plugin(SearchService, options.search)
  ctx.plugin(SettingsService, options.settings)
  ctx.plugin(FocusService, options.focus)
  // 桌面组件宿主：缺省 roots=[]——不装任何插件、不建目录（与 createKernel 同款默认）
  ctx.plugin(PluginHostService, { roots: [], ...options.plugins })
  // 数据面端口（生产装配：utilityProcess 子进程宿主）——必须先于桥接层注册
  ctx.plugin(DataplaneService, options.dataplane)
  // 任务栏（工单49）：BridgeService 注入依赖它，必须先于桥接层注册
  ctx.plugin(TaskbarService, options.taskbar)
  ctx.plugin(BridgeService, { weather: options.weather, layout: options.layout, quit: options.quit })
  const searchIntervalMs = options.searchIntervalMs ?? DEFAULT_SEARCH_INTERVAL_MS
  if (searchIntervalMs > 0) {
    // 引擎链路泵（防抖到期/限流退避/离线重试的统一判定点；50ms 量级 = 旧 Tk _tick 先例）
    const timer = setInterval(() => ctx.search?.tick(), searchIntervalMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  return ctx
}
