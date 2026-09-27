import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, DesktopLayout, DesktopZone, PanelSnapshot, WeatherLocation } from '../../shared/contract'
import { defaultDesktopLayout, defaultWeather } from '../config'
import type { ClockService } from './clock'
import type { SessionsService } from './sessions'
import type { HardwareService } from './hardware'
import type { DesktopService } from './desktop'
import type { SearchService } from './search'

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
  static inject = ['clock', 'sessions', 'hardware', 'desktop', 'search']

  private readonly weather: WeatherLocation
  private readonly layout: DesktopLayout

  constructor(ctx: Context, options: { weather?: WeatherLocation; layout?: DesktopLayout } = {}) {
    super(ctx, 'bridge')
    this.weather = options.weather ?? defaultWeather()
    this.layout = options.layout ?? defaultDesktopLayout()
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
      desktop: this.ctx.desktop.state(),
      layout: this.layout,
    }
  }

  async invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']> {
    switch (method) {
      case 'panel/snapshot':
        return this.snapshot() as BridgeMethods[M]['response']
      case 'desktop/icon': {
        const { key } = payload as { key: string }
        return { dataUrl: await this.ctx.desktop.icon(key) } as BridgeMethods[M]['response']
      }
      case 'desktop/launch': {
        const { path } = payload as { path: string }
        return await this.ctx.desktop.launch(path) as BridgeMethods[M]['response']
      }
      case 'desktop/move': {
        const { name, zone, beforeName } = payload as { name: string; zone: DesktopZone; beforeName: string | null }
        return this.ctx.desktop.move(name, zone, beforeName) as BridgeMethods[M]['response']
      }
      case 'desktop/reset-layout':
        return this.ctx.desktop.resetLayout() as BridgeMethods[M]['response']
      case 'search/activate':
        return { state: this.ctx.search.activate() } as BridgeMethods[M]['response']
      case 'search/query': {
        const { query } = payload as { query: string }
        return { accepted: this.ctx.search.setQuery(String(query ?? '')) } as BridgeMethods[M]['response']
      }
      case 'search/deactivate':
        return { state: this.ctx.search.deactivate() } as BridgeMethods[M]['response']
      case 'search/action': {
        const { path, reveal } = payload as { path: string; reveal: boolean }
        return await this.ctx.search.action(String(path), Boolean(reveal)) as BridgeMethods[M]['response']
      }
      default:
        throw new BridgeError(`未知桥接方法: ${method}`)
    }
  }

  subscribe<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void {
    // K 为联合时 cordis 的逐事件监听签名无法解析（要求交集参数），此处按调用方契约收窄
    return this.ctx.on(event, listener as never) as unknown as () => void
  }

  /** 推送当前快照（生产由主进程定时驱动；契约测试手动驱动） */
  tick(): void {
    this.ctx.sessions.refresh()
    this.ctx.desktop.refresh()
    this.ctx.emit('panel/changed', this.snapshot())
  }
}
