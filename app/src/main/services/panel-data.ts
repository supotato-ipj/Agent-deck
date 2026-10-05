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
  /** 资源管理器定位并选中（工单24 reveal；同步校验 + fire-and-forget 执行） */
  reveal(path: string): Promise<{ ok: boolean; error?: string }>
  /** 复制完整路径进文本剪贴板（工单24） */
  copyPath(path: string): Promise<{ ok: boolean; error?: string }>
  /** 复制多条完整路径进文本剪贴板，多行 \n 分隔（工单26 多选菜单） */
  copyPaths(paths: readonly string[]): Promise<{ ok: boolean; error?: string }>
  /** 选中项写入系统文件剪贴板，copy 语义（工单29；CF_HDROP + Preferred DropEffect） */
  clipboardCopy(paths: readonly string[]): Promise<{ ok: boolean; error?: string }>
  /** 选中项以剪切语义写入系统文件剪贴板（工单29；effect=move，粘贴为搬移） */
  clipboardCut(paths: readonly string[]): Promise<{ ok: boolean; error?: string }>
  /** 删除进回收站，成功条目同拍清除摆位（工单27） */
  trash(paths: readonly string[]): Promise<{ ok: boolean; trashed: string[]; failed: string[]; error?: string }>
  /** 原地重命名，成功同拍迁移摆位（工单28） */
  rename(name: string, to: string): Promise<{ ok: boolean; to?: string; error?: string }>
  /** 粘贴剪贴板文件进用户桌面根，无池护栏、部分失败信封（工单30） */
  paste(): Promise<{ ok: boolean; pasted: string[]; failed: string[]; error?: string }>
  /** 只读可粘贴态查询（工单30 菜单置灰依据） */
  clipboardState(): Promise<{ pasteable: boolean }>
  move(name: string, zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; error?: string }>
  moveBatch(names: readonly string[], zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; moved: string[]; skipped: string[]; error?: string }>
  /** 钉到应用区（工单25）：进手钉清单前段并即时重编排 */
  pin(name: string): Promise<{ ok: boolean; error?: string }>
  /** 取消手钉（工单25）：从手钉清单移除并即时重编排 */
  unpin(name: string): Promise<{ ok: boolean; error?: string }>
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

  reveal(path: string): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.reveal(path))
  }

  copyPath(path: string): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.copyPath(path))
  }

  copyPaths(paths: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.copyPaths(paths))
  }

  clipboardCopy(paths: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    return this.ctx.desktop.clipboardCopy(paths)
  }

  clipboardCut(paths: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    return this.ctx.desktop.clipboardCut(paths)
  }

  trash(paths: readonly string[]): Promise<{ ok: boolean; trashed: string[]; failed: string[]; error?: string }> {
    return this.ctx.desktop.trash(paths)
  }

  rename(name: string, to: string): Promise<{ ok: boolean; to?: string; error?: string }> {
    return this.ctx.desktop.rename(name, to)
  }

  paste(): Promise<{ ok: boolean; pasted: string[]; failed: string[]; error?: string }> {
    return this.ctx.desktop.paste()
  }

  clipboardState(): Promise<{ pasteable: boolean }> {
    return this.ctx.desktop.clipboardState()
  }

  move(name: string, zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.move(name, zone, beforeName))
  }

  moveBatch(names: readonly string[], zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; moved: string[]; skipped: string[]; error?: string }> {
    return Promise.resolve(this.ctx.desktop.moveBatch(names, zone, beforeName))
  }

  pin(name: string): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.pin(name))
  }

  unpin(name: string): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve(this.ctx.desktop.unpin(name))
  }

  resetLayout(): Promise<{ ok: boolean; cleared: number }> {
    return Promise.resolve(this.ctx.desktop.resetLayout())
  }
}
