import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { DesktopItem, DesktopPlan, DesktopState, DesktopZone } from '../../shared/contract'
import { collectDesktopItems, desktopFingerprint, pathOfIconKey, planFingerprint } from '../desktop/scan'
import type { DesktopDirEntry, DesktopRoots } from '../desktop/scan'
import { planDesktop } from '../desktop/plan'
import { loadStore, moveItem, resetFactory, serializeStore, type LayoutStore } from '../desktop/layout-store'
import { watchDesktopRoots } from '../desktop/watch'
import { IconCache, type IconExtractor } from '../desktop/icons'
import type { ScoreItem } from '../usage/score'
import { defaultDesktopRoots, defaultListDir, electronIconExtractor, readStoreText, shellOpen, writeStoreText, defaultWatchDesktopRoots, electronShortcutTarget, fsFileExists } from '../desktop/adapter'
import { userDataPath } from '../paths'

/** 桌面承载依赖束：主进程真源 / 测试假源 / 数据面装配共用一个服务状态机（hardware sources 同法） */
export interface DesktopDeps {
  listDir(dir: string): DesktopDirEntry[]
  /** 图标提取（null = 不装图标面：数据面子进程装配——图标由面板主进程按快照条目预热） */
  extractIcon: ((filePath: string) => Promise<string | null>) | null
  open(filePath: string): Promise<string>
  /** 桌面目录监听（fs.watch 化；返回停听函数） */
  watch(roots: DesktopRoots, onChange: () => void): () => void
  /** lnk 目标解析（频次映射用；解析不出返回 null） */
  readShortcutTarget(lnkPath: string): string | null
  /** 路径存在性（频次映射的 stem 回退守卫；盘上却解不出目标的 lnk 不回退） */
  fileExists(lnkPath: string): boolean
  /** 摆位存储读写（text 层注入，纯逻辑 loadStore/serializeStore 在两侧共用） */
  readStoreText(file: string): string | null
  writeStoreText(file: string, text: string): void
  /** 使用频次来源（usage 服务；缺省无分数——推荐段按稳定名序） */
  iconScores(
    items: ScoreItem[],
    resolve: (lnkPath: string) => string | null,
    exists: (lnkPath: string) => boolean,
  ): Map<string, number>
}

export interface DesktopServiceOptions {
  roots?: DesktopRoots
  deps?: Partial<DesktopDeps>
  /** 摆位存储文件（默认 userData/layout.json） */
  storeFile?: string
  /** 文档组满几行折列（config 下发；默认 8 = Python 先例 DOC_MAX_ROWS） */
  docMaxRows?: number
}

/**
 * 桌面承载服务（工单05 扫描/图标/启动 + 工单06 编排/摆位/监听）：
 * 1Hz 随桥接 tick 扫描 + fs.watch 亚秒级增删同步；编排（归类 → 显式摆位覆盖分区 →
 * 栏位分配）随每次扫描重算；拖拽摆位与恢复出厂经 move/resetLayout 落盘。
 * 扫描意外失败沿用上一轮条目（桌面瞬时空白比短暂陈旧更伤；与会话「失败给空表」不同，
 * 会话的陈旧是僵尸会话、桌面的陈旧只是慢半拍）。
 */
export class DesktopService extends Service {
  private readonly roots: DesktopRoots
  private readonly deps: DesktopDeps
  private readonly icons: IconCache | null
  private readonly storeFile: string
  private readonly docMaxRows: number
  private store: LayoutStore
  /** lnk 目标缓存（键 = iconKey，mtime 变更即重解析） */
  private readonly targets = new Map<string, string | null>()
  private items: DesktopItem[] = []
  private plan: DesktopPlan = { dock: [], docs: [] }
  private fingerprint = ''

  constructor(ctx: Context, options: DesktopServiceOptions = {}) {
    super(ctx, 'desktop')
    this.roots = options.roots ?? defaultDesktopRoots()
    this.docMaxRows = options.docMaxRows ?? 8
    this.storeFile = options.storeFile ?? userDataPath('layout.json')
    // 图标面可选：数据面子进程没有 Electron app.getFileIcon，extractIcon 注入 null——
    // 扫描/编排照常，图标预热由主进程按快照条目自行做（工单：采集移出主进程）。
    const extractIcon: DesktopDeps['extractIcon'] =
      options.deps?.extractIcon === undefined ? electronIconExtractor : options.deps.extractIcon
    this.deps = {
      listDir: options.deps?.listDir ?? defaultListDir,
      extractIcon,
      open: options.deps?.open ?? shellOpen,
      watch: options.deps?.watch ?? defaultWatchDesktopRoots,
      readShortcutTarget: options.deps?.readShortcutTarget ?? electronShortcutTarget,
      fileExists: options.deps?.fileExists ?? fsFileExists,
      readStoreText: options.deps?.readStoreText ?? readStoreText,
      writeStoreText: options.deps?.writeStoreText ?? writeStoreText,
      iconScores: options.deps?.iconScores ?? (() => new Map()),
    }
    this.icons = extractIcon === null ? null : new IconCache(extractIcon)
    this.store = loadStore(this.deps.readStoreText(this.storeFile))
    const stopWatch = this.deps.watch(this.roots, () => this.refresh())
    ctx.on('dispose', stopWatch)
    // 首拍即扫描：原生图标在面板启动前已被守护进程隐藏，dock 必须随窗口首绘就位，
    // 不能等第一个 1Hz tick（那会是 ~1s 的无承载空窗）。
    this.refresh()
  }

  /** 一个扫描轮（生产由桥接 tick 1Hz 与 fs.watch 驱动；测试手动驱动） */
  refresh(): void {
    try {
      const scanned = collectDesktopItems(this.roots, this.deps.listDir(this.roots.user), this.deps.listDir(this.roots.common))
      this.items = applyZoneOverrides(scanned, this.store)
      this.plan = this.computePlan()
      this.fingerprint = desktopFingerprint(this.items) + '-' + planFingerprint(this.plan)
      if (this.icons) {
        for (const item of this.items) {
          if (this.icons.needsWork(item.iconKey)) void this.icons.fetch(item.iconKey, item.path)
        }
      }
    } catch (err) {
      console.warn(`deck-desktop: 本轮扫描失败，沿用上一轮条目：${err instanceof Error ? err.message : err}`)
    }
  }

  private computePlan(): DesktopPlan {
    const resolve = (lnk: string) => this.deps.readShortcutTarget(lnk)
    const scoreItems: ScoreItem[] = this.items.map((i) => ({
      display: i.display,
      kind: i.kind,
      path: i.path,
      target: i.kind === 'shortcut' ? this.targetOf(i) : null,
    }))
    const scores = this.deps.iconScores(scoreItems, resolve, this.deps.fileExists)
    return planDesktop(this.items, this.store.pinned, { dock: this.store.dock, docs: this.store.docs }, scores, {
      docMaxRows: this.docMaxRows,
    })
  }

  private targetOf(item: DesktopItem): string | null {
    if (!this.targets.has(item.iconKey)) {
      let target: string | null = null
      try {
        target = this.deps.readShortcutTarget(item.path)
      } catch {
        target = null
      }
      this.targets.set(item.iconKey, target)
    }
    return this.targets.get(item.iconKey) ?? null
  }

  state(): DesktopState {
    return { fingerprint: this.fingerprint, items: this.items, plan: this.plan }
  }

  /** 图标（经内核契约 desktop/icon）：缓存命中即回，未知键按缓存键反解路径提取。
   * 数据面装配（无图标面）不会被问到——桥接的 desktop/icon 走主进程宿主；保守给 null。 */
  async icon(key: string): Promise<string | null> {
    if (!this.icons) return null
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

  /** 拖拽摆位：name 必须在池内；beforeName 须为目标分区当前条目（null = 末尾）。落盘并即时重编排。
   * 手钉条目在应用区内不可拖（栏位由手钉清单决定，拖了也会弹回——显式拒绝而非无声失效；
   * 跨区拖出手钉仍允许，那是「把它挪去文档区」的明确意图）。 */
  move(name: string, zone: DesktopZone, beforeName: string | null): { ok: boolean; error?: string } {
    const item = this.items.find((i) => i.name === name)
    if (!item) return { ok: false, error: '桌面项不在当前扫描池内' }
    if (zone === 'app' && this.store.pinned.includes(name)) {
      return { ok: false, error: '手钉条目的应用区栏位由手钉清单决定（layout.json 的 pinned 列表）' }
    }
    if (beforeName !== null) {
      const error = this.anchorError(beforeName, zone)
      if (error) return { ok: false, error }
      if (beforeName === name) return { ok: false, error: '不能以自身为参照' }
    }
    this.store = moveItem(this.store, name, zone, beforeName)
    this.persist()
    this.refresh()
    return { ok: true }
  }

  /** 批量拖拽摆位（工单22）：names 按选区插入序整组迁移到落点，落点分区即目标分区。
   * 手钉条目不可动——批量语境下一律跳过并如实回报 skipped（批量是「整理一批」，
   * 手钉的稳定栏位是前提；挪手钉是单条明确意图，走单选拖拽的跨区通道），池外名字
   * （选择与落点之间的外部删除竞态）同样跳过。参照校验整批一道：落点本身无效时
   * 一个都不摆。通过校验的条目逐项落摆位存储——同锚点依序插回天然保持组内相对序
   * （每组依次插到参照之前）——最后落盘并即时重编排一次。 */
  moveBatch(
    names: readonly string[],
    zone: DesktopZone,
    beforeName: string | null,
  ): { ok: boolean; moved: string[]; skipped: string[]; error?: string } {
    if (!names.length) return { ok: false, moved: [], skipped: [], error: '批量摆位名单为空' }
    if (beforeName !== null) {
      const error = this.anchorError(beforeName, zone)
      if (error) return { ok: false, moved: [], skipped: [], error }
      if (names.includes(beforeName)) return { ok: false, moved: [], skipped: [], error: '参照条目在被拖组内' }
    }
    const pool = new Set(this.items.map((i) => i.name))
    const moved: string[] = []
    const skipped: string[] = []
    for (const name of names) {
      if (moved.includes(name)) continue // 名单重复：选区是集合，防御性去重
      if (!pool.has(name) || this.store.pinned.includes(name)) {
        skipped.push(name)
        continue
      }
      this.store = moveItem(this.store, name, zone, beforeName)
      moved.push(name)
    }
    if (moved.length) {
      this.persist()
      this.refresh()
    }
    return { ok: true, moved, skipped }
  }

  /** 参照校验共通段（move 与 moveBatch）：参照须在池内且在目标分区，返回首个错误或 null */
  private anchorError(beforeName: string, zone: DesktopZone): string | null {
    const anchor = this.items.find((i) => i.name === beforeName)
    if (!anchor) return '参照条目不在当前扫描池内'
    if (anchor.zone !== zone) return '参照条目不在目标分区'
    return null
  }

  /** 恢复出厂布局：清除全部显式摆位（手钉保留），即时重编排。返回清除的摆位数。 */
  resetLayout(): { ok: boolean; cleared: number } {
    const cleared = this.store.dock.length + this.store.docs.length
    this.store = resetFactory(this.store)
    this.persist()
    this.refresh()
    return { ok: true, cleared }
  }

  /** 测试观察缝：当前存储内容 */
  storeForTest(): LayoutStore {
    return { version: 1, pinned: [...this.store.pinned], dock: [...this.store.dock], docs: [...this.store.docs] }
  }

  private persist(): void {
    try {
      this.deps.writeStoreText(this.storeFile, serializeStore(this.store))
    } catch (err) {
      console.warn(`deck-desktop: 摆位落盘失败（内存编排继续）：${err instanceof Error ? err.message : err}`)
    }
  }
}

/** 显式摆位覆盖归类分区：dock 名单里的条目入应用区、docs 名单里的入文档区（跨区拖拽即换区） */
function applyZoneOverrides(items: DesktopItem[], store: LayoutStore): DesktopItem[] {
  const dock = new Set(store.dock)
  const docs = new Set(store.docs)
  return items.map((i) =>
    dock.has(i.name) ? { ...i, zone: 'app' as const } : docs.has(i.name) ? { ...i, zone: 'doc' as const } : i,
  )
}
