import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { DesktopState } from '../../shared/contract'
import { collectDesktopItems, desktopFingerprint, pathOfIconKey } from '../desktop/scan'
import type { DesktopDirEntry, DesktopRoots } from '../desktop/scan'
import { IconCache, type IconExtractor } from '../desktop/icons'
import { defaultDesktopRoots, defaultListDir, electronIconExtractor, shellOpen } from '../desktop/adapter'

/** 桌面承载依赖束：主进程真源 / 测试假源共用一个服务状态机（hardware sources 同法） */
export interface DesktopDeps {
  listDir(dir: string): DesktopDirEntry[]
  extractIcon(filePath: string): Promise<string | null>
  open(filePath: string): Promise<string>
}

export interface DesktopServiceOptions {
  roots?: DesktopRoots
  deps?: Partial<DesktopDeps>
}

/**
 * 桌面承载服务（工单05）：1Hz 随桥接 tick 扫描用户桌面 + 公共桌面（合并去重），
 * 条目池随快照下发；图标按键（path|mtime）懒提取并缓存；双击启动限当前扫描池内路径。
 * 扫描意外失败沿用上一轮条目（桌面瞬时空白比短暂陈旧更伤；与会话「失败给空表」不同，
 * 会话的陈旧是僵尸会话、桌面的陈旧只是慢半拍）。
 */
export class DesktopService extends Service {
  private readonly roots: DesktopRoots
  private readonly deps: DesktopDeps
  private readonly icons: IconCache
  private items: DesktopState['items'] = []
  private fingerprint = ''

  constructor(ctx: Context, options: DesktopServiceOptions = {}) {
    super(ctx, 'desktop')
    this.roots = options.roots ?? defaultDesktopRoots()
    this.deps = {
      listDir: options.deps?.listDir ?? defaultListDir,
      extractIcon: options.deps?.extractIcon ?? electronIconExtractor,
      open: options.deps?.open ?? shellOpen,
    }
    this.icons = new IconCache(this.deps.extractIcon)
    // 首拍即扫描：原生图标在面板启动前已被守护进程隐藏，dock 必须随窗口首绘就位，
    // 不能等第一个 1Hz tick（那会是 ~1s 的无承载空窗）。
    this.refresh()
  }

  /** 一个扫描轮（生产由桥接 tick 1Hz 驱动；测试手动驱动） */
  refresh(): void {
    try {
      const items = collectDesktopItems(this.roots, this.deps.listDir(this.roots.user), this.deps.listDir(this.roots.common))
      this.items = items
      this.fingerprint = desktopFingerprint(items)
      for (const item of items) {
        if (this.icons.needsWork(item.iconKey)) void this.icons.fetch(item.iconKey, item.path)
      }
    } catch (err) {
      console.warn(`deck-desktop: 本轮扫描失败，沿用上一轮条目：${err instanceof Error ? err.message : err}`)
    }
  }

  state(): DesktopState {
    return { fingerprint: this.fingerprint, items: this.items }
  }

  /** 图标（经内核契约 desktop/icon）：缓存命中即回，未知键按缓存键反解路径提取 */
  async icon(key: string): Promise<string | null> {
    return this.icons.fetch(key, pathOfIconKey(key))
  }

  /** 双击启动：path 必须在当前扫描池内（拒绝任意路径执行），open 语义 '' 即成功 */
  async launch(filePath: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.items.some((i) => i.path === filePath)) {
      return { ok: false, error: '桌面项不在当前扫描池内' }
    }
    const error = await this.deps.open(filePath)
    return error ? { ok: false, error } : { ok: true }
  }
}
