import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, PanelSnapshot, WeatherLocation } from '../../shared/contract'
import { defaultWeather } from '../config'
import type { ClockService } from './clock'
import type { SessionsService } from './sessions'
import type { HardwareService } from './hardware'

/** 桥接层错误（未知方法等契约违规） */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * 内核对渲染层的唯一桥接（spec「内核契约」缝）：invoke 请求/响应 + 事件订阅推送。
 * 后续工单只扩展 BridgeMethods / BridgeEvents 映射与本服务的 dispatch，不另开通道。
 */
export class BridgeService extends Service {
  static inject = ['clock', 'sessions', 'hardware']

  private readonly weather: WeatherLocation

  constructor(ctx: Context, options: { weather?: WeatherLocation } = {}) {
    super(ctx, 'bridge')
    this.weather = options.weather ?? defaultWeather()
  }

  private get clock(): ClockService {
    return this.ctx.clock
  }

  snapshot(): PanelSnapshot {
    return {
      clock: this.clock.now(),
      sessions: this.ctx.sessions.current(),
      qoder: this.ctx.sessions.qoderState(),
      hardware: this.ctx.hardware.state(),
      weather: this.weather,
    }
  }

  async invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']> {
    switch (method) {
      case 'panel/snapshot':
        return this.snapshot() as BridgeMethods[M]['response']
      default:
        throw new BridgeError(`未知桥接方法: ${method}`)
    }
  }

  subscribe<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void {
    return this.ctx.on(event, listener)
  }

  /** 推送当前快照（生产由主进程定时驱动；契约测试手动驱动） */
  tick(): void {
    this.ctx.sessions.refresh()
    this.ctx.emit('panel/changed', this.snapshot())
  }
}
