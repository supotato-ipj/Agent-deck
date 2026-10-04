import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { BridgeEventName, BridgeEvents, BridgeMethod, BridgeMethods, DesktopLayout, DesktopZone, PanelSnapshot, SettingsState, WeatherLocation } from '../../shared/contract'
import { defaultDesktopLayout, defaultWeather } from '../config'
import type { SearchService } from './search'
import type { SettingsService } from './settings'

/** 桥接层错误（未知方法等契约违规） */
export class BridgeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeError'
  }
}

/**
 * 内核对渲染层的唯一桥接（spec「内核契约」缝）：invoke 请求/响应 + 事件订阅推送。
 * 数据段（时钟/会话/硬件/桌面）与桌面承载动作经 panelData 端口取——
 * 进程内内核直连采集服务，生产装配转发数据面子进程。后续工单只扩展
 * BridgeMethods / BridgeEvents 映射与本服务的 dispatch，不另开通道。
 */
export class BridgeService extends Service {
  static inject = ['clock', 'panelData', 'search', 'settings', 'focus', 'plugins']

  private readonly weather: WeatherLocation
  private readonly layout: DesktopLayout

  constructor(ctx: Context, options: { weather?: WeatherLocation; layout?: DesktopLayout } = {}) {
    super(ctx, 'bridge')
    this.weather = options.weather ?? defaultWeather()
    this.layout = options.layout ?? defaultDesktopLayout()
    // 数据面快照到达即推送（生产装配：utilityProcess 每拍一发；进程内装配无此事件，
    // 契约测试经 tick 手动驱动）
    ctx.on('dataplane/snapshot', () => this.push())
  }

  snapshot(): PanelSnapshot {
    return {
      clock: this.ctx.panelData.clock(),
      sessions: this.ctx.panelData.sessions(),
      hardware: this.ctx.panelData.hardware(),
      weather: this.weather,
      desktop: this.ctx.panelData.desktop(),
      layout: this.layout,
      settings: this.ctx.settings.state(),
      plugins: this.ctx.plugins.info(),
    }
  }

  async invoke<M extends BridgeMethod>(method: M, payload: BridgeMethods[M]['request']): Promise<BridgeMethods[M]['response']> {
    switch (method) {
      case 'panel/snapshot':
        return this.snapshot() as BridgeMethods[M]['response']
      case 'desktop/icon': {
        const { key } = payload as { key: string }
        return { dataUrl: await this.ctx.panelData.icon(key) } as BridgeMethods[M]['response']
      }
      case 'desktop/launch': {
        const { path } = payload as { path: string }
        return await this.ctx.panelData.launch(path) as BridgeMethods[M]['response']
      }
      case 'desktop/reveal': {
        const { path } = payload as { path: string }
        return await this.ctx.panelData.reveal(String(path)) as BridgeMethods[M]['response']
      }
      case 'desktop/copy-path': {
        const { path } = payload as { path: string }
        return await this.ctx.panelData.copyPath(String(path)) as BridgeMethods[M]['response']
      }
      case 'desktop/move': {
        const { name, zone, beforeName } = payload as { name: string; zone: DesktopZone; beforeName: string | null }
        return await this.ctx.panelData.move(name, zone, beforeName) as BridgeMethods[M]['response']
      }
      case 'desktop/move-batch': {
        const { names, zone, beforeName } = payload as { names: string[]; zone: DesktopZone; beforeName: string | null }
        return await this.ctx.panelData.moveBatch(names, zone, beforeName) as BridgeMethods[M]['response']
      }
      case 'desktop/pin': {
        const { name } = payload as { name: string }
        return await this.ctx.panelData.pin(String(name)) as BridgeMethods[M]['response']
      }
      case 'desktop/unpin': {
        const { name } = payload as { name: string }
        return await this.ctx.panelData.unpin(String(name)) as BridgeMethods[M]['response']
      }
      case 'desktop/reset-layout':
        return await this.ctx.panelData.resetLayout() as BridgeMethods[M]['response']
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
      case 'settings/set-card-opacity': {
        const { opacity } = payload as { opacity: number }
        return this.ctx.settings.setCardOpacity(opacity) as BridgeMethods[M]['response']
      }
      case 'session/focus': {
        const { tool } = payload as { tool: string }
        return await this.ctx.focus.focusTool(String(tool ?? '')) as BridgeMethods[M]['response']
      }
      default:
        throw new BridgeError(`未知桥接方法: ${method}`)
    }
  }

  subscribe<K extends BridgeEventName>(event: K, listener: (payload: BridgeEvents[K]) => void): () => void {
    // K 为联合时 cordis 的逐事件监听签名无法解析（要求交集参数），此处按调用方契约收窄
    return this.ctx.on(event, listener as never) as unknown as () => void
  }

  /** 推送当前快照（生产由数据面快照到达驱动；契约测试手动驱动 tick） */
  tick(): void {
    this.ctx.panelData.refresh()
    this.push()
  }

  /** 推送当前快照（数据面宿主收到子进程快照后调用；与 tick 共用同一事件） */
  push(): void {
    this.ctx.emit('panel/changed', this.snapshot())
  }
}
