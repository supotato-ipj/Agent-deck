import { utilityProcess, type UtilityProcess } from 'electron'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { ClockState, DesktopState, DesktopZone, HardwareState } from '../../shared/contract'
import type { PanelDataPort } from './panel-data'
import type { DataplaneInit, DataplaneMessage, DataplaneMethod, DataplaneSnapshot } from '../dataplane-protocol'
import { electronClipboardWrite, electronIconExtractor, electronShortcutTarget, explorerReveal, shellOpen } from '../desktop/adapter'
import { IconCache } from '../desktop/icons'
import { pathOfIconKey } from '../desktop/scan'

/** 首拍等待上限：超时放行（面板以空数据面先起，子进程就绪后自然补拍），不拦桌面 */
const DEFAULT_READY_TIMEOUT_MS = 15_000

export interface DataplaneServiceOptions {
  /** utilityProcess 入口模块（dist/main/dataplane.js） */
  workerModule: string
  init: DataplaneInit
  /** 存证日志（可选，验收/排障） */
  log?: (event: Record<string, unknown>) => void
  /** 首拍等待上限（默认 15s） */
  readyTimeoutMs?: number
}

/**
 * 数据面宿主（生产装配的 panelData，鼠标卡顿修复：采集移出主进程）：
 * 会话/硬件/使用日志/桌面承载四个采集服务整体跑在 utilityProcess 子进程，
 * 主进程只留窗口/热区/桥接/插件宿主——采集阻塞不再波及输入管线。
 *
 * 本服务只做四件事：转发每拍快照（触发桥接推送）、预热图标（app.getFileIcon
 * 是主进程 API，按快照条目增量提取）、代理解析 lnk 目标（readShortcutLink 同理）、
 * 转发桌面承载写请求（move/reset；launch/reveal/copy-path/copy-paths 在主进程校验快照条目池后执行
 * ——shell.openPath 与 clipboard 是主进程 API，reveal 校验段认主进程快照池）。
 * 子进程崩溃按退避自动重启：摆位与使用日志都在盘上，重启即收敛，硬件历史环
 * 归零重来（展示性曲线，可接受的降级）。
 */
export class DataplaneService extends Service implements PanelDataPort {
  private child: UtilityProcess | null = null
  private latest: DataplaneSnapshot | null = null
  private readonly icons = new IconCache(electronIconExtractor)
  private readonly shortcuts = new Map<string, string | null>()
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private seq = 0
  private stopped = false
  private restartAttempt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private readonly readyResolve: () => void
  readonly whenReady: Promise<void>

  constructor(ctx: Context, private readonly options: DataplaneServiceOptions) {
    super(ctx, 'panelData')
    let resolveReady!: () => void
    this.whenReady = new Promise<void>((res) => {
      resolveReady = res
    })
    this.readyResolve = resolveReady
    ctx.on('dispose', () => this.shutdown())
    this.spawn('boot')
    const timeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const timeout = setTimeout(() => {
      if (this.latest === null) {
        this.options.log?.({ type: 'dataplane-ready-timeout', timeoutMs })
        resolveReady()
      }
    }, timeoutMs)
    void this.whenReady.then(() => clearTimeout(timeout))
  }

  private spawn(reason: string): void {
    this.child = utilityProcess.fork(this.options.workerModule, [], {
      serviceName: 'deck-dataplane',
      stdio: 'inherit',
    })
    this.options.log?.({ type: 'dataplane-spawn', pid: this.child.pid, reason })
    this.child.on('message', (msg: DataplaneMessage) => this.onMessage(msg))
    this.child.on('exit', (code: number) => this.onExit(code))
    this.child.postMessage({ type: 'init', init: this.options.init })
  }

  private onExit(code: number): void {
    if (this.stopped) return
    this.child = null
    const error = new Error('数据面子进程退出，请求失败')
    for (const waiter of this.pending.values()) waiter.reject(error)
    this.pending.clear()
    this.options.log?.({ type: 'dataplane-exit', code })
    const backoffMs = Math.min(30_000, 1000 * 2 ** this.restartAttempt)
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => this.spawn('restart'), backoffMs)
  }

  private onMessage(msg: DataplaneMessage): void {
    if (msg.type === 'ready' || msg.type === 'snapshot') {
      this.latest = msg.type === 'ready' ? msg.snapshot : msg.data
      this.restartAttempt = 0
      this.readyResolve()
      for (const item of this.latest.desktop.items) {
        if (this.icons.needsWork(item.iconKey)) void this.icons.fetch(item.iconKey, item.path)
      }
      // 经事件解耦通知桥接层推送（直取 ctx.bridge 会构成与 panelData 的循环依赖，
      // 绕过 inject 声明则每拍触发 cordis 未注册访问警告——事件是 cordis 的正解）
      this.ctx.emit('dataplane/snapshot')
    } else if (msg.type === 'resolve-shortcuts') {
      const targets: Record<string, string | null> = {}
      for (const p of msg.paths) {
        if (!this.shortcuts.has(p)) this.shortcuts.set(p, electronShortcutTarget(p))
        targets[p] = this.shortcuts.get(p) ?? null
      }
      this.child?.postMessage({ type: 'shortcuts', targets })
    } else if (msg.type === 'res') {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      if (msg.ok) waiter.resolve(msg.result)
      else waiter.reject(new Error(msg.error ?? '数据面请求失败'))
    }
  }

  private shutdown(): void {
    this.stopped = true
    if (this.restartTimer !== null) clearTimeout(this.restartTimer)
    this.child?.kill()
    this.child = null
  }

  private call(method: DataplaneMethod, payload: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.child === null) {
        reject(new Error('数据面子进程不在场'))
        return
      }
      const id = ++this.seq
      this.pending.set(id, { resolve, reject })
      this.child.postMessage({ type: 'req', id, method, payload })
    })
  }

  // —— PanelDataPort ——

  clock(): ClockState {
    return this.latest?.clock ?? { iso: new Date().toISOString(), epochMs: Date.now() }
  }

  sessions() {
    return this.latest?.sessions ?? []
  }

  hardware(): HardwareState {
    return this.latest?.hardware ?? {
      gauges: { cpu: 0, memory: 0, memory_gb: '-- GB/-- GB' },
      history: { cpu: [], dl: [], up: [], gpu: [] },
    }
  }

  desktop(): DesktopState {
    return this.latest?.desktop ?? { fingerprint: '', items: [], plan: { dock: [], docs: [] } }
  }

  refresh(): void {
    /* 采样由子进程自驱动；主进程无本地采集 */
  }

  icon(key: string): Promise<string | null> {
    return this.icons.fetch(key, pathOfIconKey(key))
  }

  /** 扫描池护栏共通段（launch/reveal/copy-path/copy-paths）：主进程手里的最新快照条目池——渲染层
   * 可见的条目即本池成员（同一份数据），拒绝任意路径执行的防线不变。 */
  private poolGuardError(path: string): string | null {
    return this.desktop().items.some((i) => i.path === path) ? null : '桌面项不在当前扫描池内'
  }

  async launch(path: string): Promise<{ ok: boolean; error?: string }> {
    const guard = this.poolGuardError(path)
    if (guard) return { ok: false, error: guard }
    // open（shell.openPath）是主进程 API。
    const error = await shellOpen(path)
    return error ? { ok: false, error } : { ok: true }
  }

  /** 资源管理器定位并选中（工单24 reveal）：launch 同款主进程校验 + 执行
   * （explorer /select, 是纯 Node spawn，但校验段认的是主进程快照池，与 launch 同位）。 */
  reveal(path: string): Promise<{ ok: boolean; error?: string }> {
    const guard = this.poolGuardError(path)
    if (guard) return Promise.resolve({ ok: false, error: guard })
    explorerReveal(path)
    return Promise.resolve({ ok: true })
  }

  /** 复制完整路径进文本剪贴板（工单24）：launch 同款主进程校验；剪贴板是主进程 API
   * （面板永不激活，渲染层 navigator.clipboard 因文档无焦点不可用）。 */
  copyPath(path: string): Promise<{ ok: boolean; error?: string }> {
    const guard = this.poolGuardError(path)
    if (guard) return Promise.resolve({ ok: false, error: guard })
    electronClipboardWrite(path)
    return Promise.resolve({ ok: true })
  }

  /** 复制多条完整路径进文本剪贴板（工单26 多选菜单）：多行 \n 分隔（行序 = 名单序），
   * copyPath 同款主进程校验——任一池外即整份拒绝（剪贴板不写半份名单）。 */
  copyPaths(paths: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    if (!paths.length) return Promise.resolve({ ok: false, error: '复制路径名单为空' })
    for (const path of paths) {
      const guard = this.poolGuardError(path)
      if (guard) return Promise.resolve({ ok: false, error: guard })
    }
    electronClipboardWrite(paths.join('\n'))
    return Promise.resolve({ ok: true })
  }

  move(name: string, zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; error?: string }> {
    return this.call('desktop/move', { name, zone, beforeName }) as Promise<{ ok: boolean; error?: string }>
  }

  moveBatch(names: readonly string[], zone: DesktopZone, beforeName: string | null): Promise<{ ok: boolean; moved: string[]; skipped: string[]; error?: string }> {
    return this.call('desktop/move-batch', { names, zone, beforeName }) as Promise<{ ok: boolean; moved: string[]; skipped: string[]; error?: string }>
  }

  pin(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.call('desktop/pin', { name }) as Promise<{ ok: boolean; error?: string }>
  }

  unpin(name: string): Promise<{ ok: boolean; error?: string }> {
    return this.call('desktop/unpin', { name }) as Promise<{ ok: boolean; error?: string }>
  }

  resetLayout(): Promise<{ ok: boolean; cleared: number }> {
    return this.call('desktop/reset-layout', null) as Promise<{ ok: boolean; cleared: number }>
  }
}
