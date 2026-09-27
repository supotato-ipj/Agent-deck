import { Context } from 'cordis'
import type { SessionRoots } from './scanners'
import type { HardwareSources } from './services/hardware'
import type { DesktopServiceOptions } from './services/desktop'
import { BridgeService } from './services/bridge'
import { ClockService } from './services/clock'
import { DesktopService } from './services/desktop'
import { HardwareService } from './services/hardware'
import { SessionsService } from './services/sessions'
import type { WeatherLocation } from '../shared/contract'

export interface KernelOptions {
  /** panel/changed 定时推送间隔（ms）；0 = 不装定时器（契约测试手动驱动 tick） */
  tickIntervalMs?: number
  /** 硬件采样间隔（ms）；0 = 不自动采样（离线测试手动驱动 sample） */
  hardwareIntervalMs?: number
  /** 会话扫描数据根（离线测试注入 fixture 根；缺省五工具真实根） */
  sessionRoots?: SessionRoots
  /** 硬件采样源（离线测试注入假源；缺省主进程真源） */
  hardwareSources?: HardwareSources
  /** 天气卡取数坐标（config.json 下发） */
  weather?: WeatherLocation
  /** 桌面承载（工单05）：根与依赖（离线测试注入假源；缺省主进程真源） */
  desktop?: DesktopServiceOptions
}

export const DEFAULT_TICK_MS = 1000
export const DEFAULT_HARDWARE_MS = 1000

/** 组装 cordis 内核：插件生命周期 + 依赖注入（ADR-0004 圈定的子集）。 */
export function createKernel(options: KernelOptions = {}): Context {
  const ctx = new Context()
  ctx.plugin(ClockService)
  ctx.plugin(SessionsService, { roots: options.sessionRoots })
  ctx.plugin(HardwareService, { sources: options.hardwareSources })
  ctx.plugin(DesktopService, options.desktop)
  ctx.plugin(BridgeService, { weather: options.weather })
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
  return ctx
}
