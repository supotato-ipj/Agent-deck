import { Context } from 'cordis'
import type { DesktopLayout } from '../shared/contract'
import type { SessionRoots } from './scanners'
import type { ToolsConfig } from './config'
import type { HardwareSources } from './services/hardware'
import type { DesktopServiceOptions } from './services/desktop'
import type { UsageServiceOptions } from './services/usage'
import type { SearchServiceOptions } from './services/search'
import type { FocusServiceOptions } from './services/focus'
import { BridgeService } from './services/bridge'
import { ClockService } from './services/clock'
import { DesktopService } from './services/desktop'
import { FocusService } from './services/focus'
import { HardwareService } from './services/hardware'
import { SearchService } from './services/search'
import { SessionsService } from './services/sessions'
import { SettingsService, type SettingsServiceOptions } from './services/settings'
import { UsageService } from './services/usage'
import type { WeatherLocation } from '../shared/contract'

export interface KernelOptions {
  /** panel/changed 定时推送间隔（ms）；0 = 不装定时器（契约测试手动驱动 tick） */
  tickIntervalMs?: number
  /** 硬件采样间隔（ms）；0 = 不自动采样（离线测试手动驱动 sample） */
  hardwareIntervalMs?: number
  /** 使用日志采集轮询间隔（ms）；0 = 不自动采集（离线测试手动驱动 collect） */
  usageIntervalMs?: number
  /** 会话扫描数据根（离线测试注入 fixture 根；缺省五工具真实根） */
  sessionRoots?: SessionRoots
  /** 硬件采样源（离线测试注入假源；缺省主进程真源） */
  hardwareSources?: HardwareSources
  /** 天气卡取数坐标（config.json 下发） */
  weather?: WeatherLocation
  /** 桌面承载（工单05 起）：根与依赖（离线测试注入假源；缺省主进程真源） */
  desktop?: DesktopServiceOptions
  /** 使用日志（工单06）：目录与依赖（离线测试注入假源；缺省主进程真源） */
  usage?: UsageServiceOptions
  /** 搜索（工单07）：端口与依赖（离线测试注入假源；缺省主进程真源） */
  search?: SearchServiceOptions
  /** 搜索引擎链路泵间隔（ms）；0 = 不装定时器（离线测试手动驱动 tick） */
  searchIntervalMs?: number
  /** 设置（工单08）：config 文件路径与可变引用（离线测试注入 tmp 桩；缺省只内存态） */
  settings?: SettingsServiceOptions
  /** 桌面承载几何（工单06，config.json 下发；随快照给渲染层） */
  layout?: DesktopLayout
  /** 会话行直达（工单09）：工具→exe 映射与依赖（离线测试注入假源；缺省主进程真源） */
  focus?: FocusServiceOptions
}

export const DEFAULT_TICK_MS = 1000
export const DEFAULT_HARDWARE_MS = 1000
export const DEFAULT_USAGE_MS = 2000
export const DEFAULT_SEARCH_INTERVAL_MS = 50
export const USAGE_PRUNE_MS = 3600_000

/** 组装 cordis 内核：插件生命周期 + 依赖注入（ADR-0004 圈定的子集）。 */
export function createKernel(options: KernelOptions = {}): Context {
  const ctx = new Context()
  ctx.plugin(ClockService)
  ctx.plugin(SessionsService, { roots: options.sessionRoots })
  ctx.plugin(HardwareService, { sources: options.hardwareSources })
  ctx.plugin(UsageService, options.usage)
  ctx.plugin(DesktopService, {
    ...options.desktop,
    deps: {
      ...options.desktop?.deps,
      // 使用频次经 usage 服务拉取（未装/未就绪按无分数——推荐段退稳定名序）
      iconScores: options.desktop?.deps?.iconScores
        ?? ((items, resolve, exists) => ctx.usage?.iconScores(items, resolve, exists) ?? new Map()),
    },
  })
  ctx.plugin(BridgeService, { weather: options.weather, layout: options.layout })
  ctx.plugin(SearchService, options.search)
  ctx.plugin(SettingsService, options.settings)
  ctx.plugin(FocusService, options.focus)
  const tickMs = options.tickIntervalMs ?? DEFAULT_TICK_MS
  if (tickMs > 0) {
    const timer = setInterval(() => ctx.bridge?.tick(), tickMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  const hwMs = options.hardwareIntervalMs ?? DEFAULT_HARDWARE_MS
  if (hwMs > 0) {
    const timer = setInterval(() => ctx.hardware?.sample(), hwMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  const usageMs = options.usageIntervalMs ?? DEFAULT_USAGE_MS
  if (usageMs > 0) {
    const timer = setInterval(() => ctx.usage?.collect(), usageMs)
    ctx.on('dispose', () => clearInterval(timer))
    // 滚动清理每小时一轮（Python run_loop 先例）：常驻面板的 90 天保留期不能只靠重启收敛
    const pruneTimer = setInterval(() => ctx.usage?.prune(), USAGE_PRUNE_MS)
    ctx.on('dispose', () => clearInterval(pruneTimer))
  }
  const searchIntervalMs = options.searchIntervalMs ?? DEFAULT_SEARCH_INTERVAL_MS
  if (searchIntervalMs > 0) {
    // 引擎链路泵（防抖到期/限流退避/离线重试的统一判定点；50ms 量级 = 旧 Tk _tick 先例）
    const timer = setInterval(() => ctx.search?.tick(), searchIntervalMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  return ctx
}
