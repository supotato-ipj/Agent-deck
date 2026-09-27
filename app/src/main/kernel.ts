import { Context } from 'cordis'
import { BridgeService } from './services/bridge'
import { ClockService } from './services/clock'

export interface KernelOptions {
  /** panel/changed 定时推送间隔（ms）；0 = 不装定时器（契约测试手动驱动 tick） */
  tickIntervalMs?: number
}

export const DEFAULT_TICK_MS = 1000

/** 组装 cordis 内核：插件生命周期 + 依赖注入（ADR-0004 圈定的子集）。 */
export function createKernel(options: KernelOptions = {}): Context {
  const ctx = new Context()
  ctx.plugin(ClockService)
  ctx.plugin(BridgeService)
  const tickMs = options.tickIntervalMs ?? DEFAULT_TICK_MS
  if (tickMs > 0) {
    const timer = setInterval(() => ctx.bridge?.tick(), tickMs)
    ctx.on('dispose', () => clearInterval(timer))
  }
  return ctx
}
