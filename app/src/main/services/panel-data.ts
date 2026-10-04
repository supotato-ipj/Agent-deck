import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { ClockState, DesktopState, DesktopZone, HardwareState, SessionInfo } from '../../shared/contract'

/**
 * 桥接层的数据面端口：panel/snapshot 的数据段与桌面承载动作的统一出口。
 * 两份实现——本地装配（进程内内核：直连采集服务，内核测试用）与数据面宿主
 * （生产：utilityProcess 子进程 + RPC）。桥接层只认本接口，不感知装配形态。
 */
export interface PanelDataPort {
  clock(): ClockState
  sessions(): SessionInfo[]
  hardware(): HardwareState
  desktop(): DesktopState
  /** 一个采样轮：本地装配驱动采集服务刷新；数据面装配为空操作（子进程自驱动） */
  refresh(): void
  /** 首拍就绪（本地装配立即就绪；数据面等子进程第一份快照，超时降级放行） */
  readonly whenReady: Promise<void>
  icon(key: string): Promise<string | null>
  launch(path: string): Promise<{ ok: boolean; error?: string }>
  move(name: string, zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; error?: string }>
  moveBatch(names: readonly string[], zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; moved: string[]; skipped: string[]; error?: string }>
  resetLayout(): Promise<{ ok: boolean; cleared: number }>
}

/** 本地数据面（进程内装配）：直连 cordis 采集服务。内核测试与契约缝用。 */
export class LocalPanelDataService extends Service implements PanelDataPort {
  static inject = ['clock', 'sessions', 'hardware', 'desktop']

  readonly whenReady = Promise.resolve()

  constructor(ctx: Context) {
    super(ctx, 'panelData')
  }

  clock(): ClockState {
    return this.ctx.clock.now()
  }

  sessions(): SessionInfo[] {
    return this.ctx.sessions.current()
  }

  hardware(): HardwareState {
    return this.ctx.hardware.state()
  }

  desktop(): DesktopState {
    return this.ctx.desktop.state()
  }

  refresh(): void {
    this.ctx.sessions.refresh()
    this.ctx.desktop.refresh()
  }

  icon(key: string): Promise<string | null> {
    return this.ctx.desktop.icon(key)
  }

  launch(path: string): Promise<{ ok: boolean; error?: string }> {
    return this.ctx.desktop.launch(path)
  }

  move(name: string, zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.move(name, zone, beforeName))
  }

  moveBatch(names: readonly string[], zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; moved: string[]; skipped: string[]; error?: string }> {
    return Promise.resolve(this.ctx.desktop.moveBatch(names, zone, beforeName))
  }

  resetLayout(): Promise<{ ok: boolean; cleared: number }> {
    return Promise.resolve(this.ctx.desktop.resetLayout())
  }
}
