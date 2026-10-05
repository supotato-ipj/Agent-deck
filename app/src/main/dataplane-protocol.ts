// 数据面协议（鼠标卡顿修复：周期采集整体移出主进程）：面板主进程与数据面
// utilityProcess 子进程之间的全部消息形态，以及子进程侧的 lnk 目标解析代理。
// 协议两侧共用本文件；消息经 utilityProcess postMessage 结构化克隆传递。
import type { DesktopRoots } from './desktop/scan'
import type { ClipboardFiles } from './desktop/adapter'
import type { ClockState, DesktopState, HardwareState, SessionInfo } from '../shared/contract'
import type { TrayWireEvent } from './trayhost/protocol'

/** 数据面子进程的快照段：面板主进程合并 weather/layout/settings/plugins 后成完整 PanelSnapshot（qoder 段随工单03 退役移除） */
export interface DataplaneSnapshot {
  clock: ClockState
  sessions: SessionInfo[]
  hardware: HardwareState
  desktop: DesktopState
}

/** 子进程启动参数——Electron API 在子进程一概不可用，路径全部由主进程解析后传入 */
export interface DataplaneInit {
  /** 桌面扫描根（app.getPath('desktop') 与公共桌面——OneDrive 重定向只有主进程能解析） */
  roots: DesktopRoots
  /** 摆位存储文件（userData/layout.json 的绝对路径） */
  storeFile: string
  /** 文档组满几行折列（config.desktop.docMaxRows） */
  docMaxRows: number
  /** 使用日志目录（userData/usage 的绝对路径） */
  usageDir: string
  /** 托盘 spike（工单48）：在场即起托盘宿主；corpusFile 收真实字节语料（JSONL） */
  traySpike?: { corpusFile: string }
}

/** 数据面受理的桥接方法（桌面承载的写路径，工单25 起含手钉管理、工单27 起含删除、
 * 工单28 起含重命名、工单30 起含粘贴与可贴态查询；读路径走每拍快照） */
export type DataplaneMethod = 'desktop/move' | 'desktop/move-batch' | 'desktop/pin' | 'desktop/unpin' | 'desktop/reset-layout' | 'desktop/trash' | 'desktop/rename' | 'desktop/paste' | 'desktop/clipboard-state'

/** 主进程 ⇄ 数据面子进程消息 */
export type DataplaneMessage =
  | { type: 'init'; init: DataplaneInit }
  | { type: 'ready'; snapshot: DataplaneSnapshot }
  | { type: 'snapshot'; data: DataplaneSnapshot }
  | { type: 'resolve-shortcuts'; paths: string[] }
  | { type: 'shortcuts'; targets: Record<string, string | null> }
  /** 回收站删除代理（工单27）：子进程请求主进程执行 shell.trashItem，id 关联回执 */
  | { type: 'trash-req'; id: number; paths: string[] }
  | { type: 'trash-res'; id: number; errors: Record<string, string> }
  /** 剪贴板读取代理（工单30）：子进程请求主进程读 clipboard（CF_HDROP + DropEffect），
   * id 关联回执；null = 剪贴板无文件 */
  | { type: 'clipboard-read-req'; id: number }
  | { type: 'clipboard-read-res'; id: number; files: ClipboardFiles | null }
  | { type: 'req'; id: number; method: DataplaneMethod; payload: unknown }
  | { type: 'res'; id: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'tray-event'; event: TrayWireEvent }
  | { type: 'tray-host'; event: Record<string, unknown> }

/** utilityProcess 子进程侧的 parentPort 形状（@types/node 无此成员，局部声明） */
export interface ParentPort {
  on(event: 'message', listener: (e: { data: DataplaneMessage }) => void): void
  postMessage(message: DataplaneMessage): void
}

/**
 * lnk 目标解析代理（子进程侧）：readShortcutLink 是 Electron 主进程 API，数据面用不了——
 * 解析请求凑批发往主进程，回复经 deliver 入缓存。未解析路径本轮返回 null（频次融合按
 * 无目标降级，下一拍重算自然收敛——与冷启动先验晚到的既有语义同款）；null 结果同样
 * 入缓存不重问。同拍凑批 + 在途去重，不让解析请求随 1Hz 重算翻倍。
 */
export class ProxyShortcutResolver {
  private readonly cache = new Map<string, string | null>()
  private readonly inflight = new Set<string>()
  private pending: string[] = []
  private flushScheduled = false

  constructor(private readonly ask: (paths: string[]) => void) {}

  /** 同步查询：命中缓存即回；未命中记入待问（凑批异步发出），本轮按 null 降级 */
  resolve(lnkPath: string): string | null {
    if (this.cache.has(lnkPath)) return this.cache.get(lnkPath) ?? null
    if (!this.inflight.has(lnkPath)) {
      this.inflight.add(lnkPath)
      this.pending.push(lnkPath)
    }
    if (!this.flushScheduled) {
      this.flushScheduled = true
      setImmediate(() => {
        this.flushScheduled = false
        if (this.pending.length === 0) return
        const paths = this.pending
        this.pending = []
        this.ask(paths)
      })
    }
    return null
  }

  /** 主进程回复入缓存（null = 解析不出，同样入缓存不重问） */
  deliver(targets: Record<string, string | null>): void {
    for (const [path, target] of Object.entries(targets)) {
      this.cache.set(path, target)
      this.inflight.delete(path)
    }
  }
}

/**
 * 回收站删除代理（子进程侧，工单27）：shell.trashItem 是 Electron 主进程 API，数据面
 * 用不了——删除请求按 id 发主进程执行，回复经 deliver 驱动 Promise（值 = 错误串，
 * '' = 成功，open 同语）。与 ProxyShortcutResolver 的差别在回执驱动 Promise 而非缓存：
 * 删除是低频写路径，不凑批也不允许「按 null 降级」——回执未到就挂起（子进程退出随
 * 进程消亡，主进程侧无半途丢失形态）。
 */
export class ProxyTrash {
  private readonly pending = new Map<number, (errors: Record<string, string>) => void>()
  private seq = 0

  constructor(private readonly ask: (id: number, paths: string[]) => void) {}

  /** 单文件删除请求（逐发不凑批）；resolve 值 = 错误串（'' = 成功） */
  trash(filePath: string): Promise<string> {
    return new Promise((resolve) => {
      const id = ++this.seq
      this.pending.set(id, (errors) => resolve(errors[filePath] ?? '回收站删除无回执'))
      this.ask(id, [filePath])
    })
  }

  /** 主进程回执驱动 Promise（未知 id = 迟到噪声，丢弃） */
  deliver(id: number, errors: Record<string, string>): void {
    const waiter = this.pending.get(id)
    if (!waiter) return
    this.pending.delete(id)
    waiter(errors)
  }
}

/**
 * 剪贴板读取代理（子进程侧，工单30）：clipboard.readBuffer 是 Electron 主进程 API，
 * 数据面用不了——读取请求按 id 发主进程执行，回复经 deliver 驱动 Promise。与
 * ProxyTrash 同形（低频按需读，不凑批、不缓存——剪贴板内容随外界变化，缓存即陈旧），
 * null 回执合法（剪贴板无文件）。
 */
export class ProxyClipboardRead {
  private readonly pending = new Map<number, (files: ClipboardFiles | null) => void>()
  private seq = 0

  constructor(private readonly ask: (id: number) => void) {}

  /** 一次读取请求；resolve 值 = 文件清单或 null（剪贴板无文件） */
  read(): Promise<ClipboardFiles | null> {
    return new Promise((resolve) => {
      const id = ++this.seq
      this.pending.set(id, resolve)
      this.ask(id)
    })
  }

  /** 主进程回执驱动 Promise（未知 id = 迟到噪声，丢弃） */
  deliver(id: number, files: ClipboardFiles | null): void {
    const waiter = this.pending.get(id)
    if (!waiter) return
    this.pending.delete(id)
    waiter(files)
  }
}
