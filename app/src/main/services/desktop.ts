import { Service } from 'cordis'
import type { Context } from 'cordis'
import path from 'node:path'
import type { DesktopItem, DesktopPlan, DesktopState, DesktopZone } from '../../shared/contract'
import { collectDesktopItems, desktopFingerprint, pathOfIconKey, planFingerprint } from '../desktop/scan'
import type { DesktopDirEntry, DesktopRoots } from '../desktop/scan'
import { planDesktop } from '../desktop/plan'
import { forgetItems, loadStore, moveItem, pinItem, renameItemInStore, resetFactory, serializeStore, unpinItem, type LayoutStore } from '../desktop/layout-store'
import { fileNameError, renameTarget } from '../desktop/filename'
import { watchDesktopRoots } from '../desktop/watch'
import { IconCache, type IconExtractor } from '../desktop/icons'
import { koffiClipboardFilesWrite, type ClipboardEffect } from '../desktop/clipboard-files'
import type { ScoreItem } from '../usage/score'
import { defaultDesktopRoots, defaultListDir, electronClipboardWrite, electronIconExtractor, electronTrashItem, explorerReveal, fsCopyEntry, fsEntryExists, fsRemoveEntry, fsRename, koffiClipboardFilesRead, readStoreText, shellOpen, writeStoreText, defaultWatchDesktopRoots, electronShortcutTarget, fsFileExists, type ClipboardFiles } from '../desktop/adapter'
import { duplicateName } from '../desktop/filename'
import { userDataPath } from '../paths'

/** 桌面承载依赖束：主进程真源 / 测试假源 / 数据面装配共用一个服务状态机（hardware sources 同法） */
export interface DesktopDeps {
  listDir(dir: string): DesktopDirEntry[]
  /** 图标提取（null = 不装图标面：数据面子进程装配——图标由面板主进程按快照条目预热） */
  extractIcon: ((filePath: string) => Promise<string | null>) | null
  open(filePath: string): Promise<string>
  /** 资源管理器定位并选中（工单24 reveal；fire-and-forget，explorer 自带窗口生命周期） */
  reveal(filePath: string): void
  /** 文本剪贴板写（工单24 复制路径；主进程 clipboard.writeText——面板永不激活，渲染层剪贴板 API 不可用） */
  copyText(text: string): void
  /** 回收站删除（工单27；生产 shell.trashItem——误删可找回）。'' 即成功，否则错误串（open 同语） */
  trash(filePath: string): Promise<string>
  /** 系统文件剪贴板写（工单29 复制/剪切；生产 koffi 直调 user32——CF_HDROP + Preferred
   * DropEffect，纯 native 在数据面子进程同样可用，无需主进程代理）。'' 即成功，否则错误串（open 同语） */
  writeClipboardFiles(paths: readonly string[], effect: ClipboardEffect): Promise<string>
  /** 重命名（工单28；生产 fs.promises.rename，纯 Node API——数据面直接执行，无主进程代理）。'' 即成功，否则错误串（open 同语） */
  rename(oldPath: string, newPath: string): Promise<string>
  /** 条目存在性（工单28 重命名的重名冲突校验；文件与目录都算——fs.rename 落既有名会静默覆写，须显式挡下） */
  entryExists(entryPath: string): boolean
  /** 桌面目录监听（fs.watch 化；返回停听函数） */
  watch(roots: DesktopRoots, onChange: () => void): () => void
  /** lnk 目标解析（频次映射用；解析不出返回 null） */
  readShortcutTarget(lnkPath: string): string | null
  /** 路径存在性（频次映射的 stem 回退守卫；盘上却解不出目标的 lnk 不回退） */
  fileExists(lnkPath: string): boolean
  /** 剪贴板文件读取（工单30 粘贴）：CF_HDROP 清单 + Preferred DropEffect 语义，null =
   * 无文件。主进程 clipboard 真源（离线环境返回 null 不触真剪贴板）；数据面子进程经
   * 协议代理（trash 同法）伸回主进程。 */
  readClipboardFiles(): Promise<ClipboardFiles | null>
  /** 递归复制条目（工单30 粘贴 copy 语义；文件与目录同款）。'' 即成功，否则错误串 */
  fsCopyEntry(srcPath: string, dstPath: string): Promise<string>
  /** 移动条目（工单30 粘贴 move 语义，生产 fs.promises.rename）。'' 即成功；跨卷失败由
   * 调用方（paste）回退 fsCopyEntry + fsRemoveEntry。 */
  fsMoveEntry(srcPath: string, dstPath: string): Promise<string>
  /** 删除条目（工单30 move 回退的删源半步；文件与目录树同款）。'' 即成功，否则错误串 */
  fsRemoveEntry(srcPath: string): Promise<string>
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
      reveal: options.deps?.reveal ?? explorerReveal,
      copyText: options.deps?.copyText ?? electronClipboardWrite,
      trash: options.deps?.trash ?? electronTrashItem,
      writeClipboardFiles: options.deps?.writeClipboardFiles ?? koffiClipboardFilesWrite,
      rename: options.deps?.rename ?? fsRename,
      entryExists: options.deps?.entryExists ?? fsEntryExists,
      watch: options.deps?.watch ?? defaultWatchDesktopRoots,
      readShortcutTarget: options.deps?.readShortcutTarget ?? electronShortcutTarget,
      fileExists: options.deps?.fileExists ?? fsFileExists,
      readClipboardFiles: options.deps?.readClipboardFiles ?? koffiClipboardFilesRead,
      fsCopyEntry: options.deps?.fsCopyEntry ?? fsCopyEntry,
      fsMoveEntry: options.deps?.fsMoveEntry ?? fsRename,
      fsRemoveEntry: options.deps?.fsRemoveEntry ?? fsRemoveEntry,
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

  /** 扫描池护栏共通段（launch/reveal/copyPath/copyPaths/trash + clipboardCopy/clipboardCut，
   * 工单24 起共用、工单29 增至七处）：路径不在当前池内即拒绝——拒绝任意路径执行/定位/
   * 落剪贴板/删除的同一道防线，错误语也同源。 */
  private poolGuardError(filePath: string): string | null {
    return this.items.some((i) => i.path === filePath) ? null : '桌面项不在当前扫描池内'
  }

  /** 扫描池护栏按名版（pin/unpin，工单25；move/moveBatch 的名字校验同语，工单28 rename 加入） */
  private poolNameError(name: string): string | null {
    return this.items.some((i) => i.name === name) ? null : '桌面项不在当前扫描池内'
  }

  /** 双击启动：path 必须在当前扫描池内（拒绝任意路径执行），open 语义 '' 即成功 */
  async launch(filePath: string): Promise<{ ok: boolean; error?: string }> {
    const guard = this.poolGuardError(filePath)
    if (guard) return { ok: false, error: guard }
    const error = await this.deps.open(filePath)
    return error ? { ok: false, error } : { ok: true }
  }

  /** 右键「打开所在位置」（工单24）：资源管理器定位并选中该文件（explorer /select,，
   * 搜索 reveal 同款机制）。path 必须在当前扫描池内（launch 同款护栏）；定位本身
   * fire-and-forget——explorer 自带窗口生命周期，失败静默不打断面板。 */
  reveal(filePath: string): { ok: boolean; error?: string } {
    const guard = this.poolGuardError(filePath)
    if (guard) return { ok: false, error: guard }
    this.deps.reveal(filePath)
    return { ok: true }
  }

  /** 右键「复制路径」（工单24）：完整路径进文本剪贴板。path 必须在当前扫描池内——
   * 剪贴板内容也只出自桌面项池（与 launch/reveal 同护栏）。 */
  copyPath(filePath: string): { ok: boolean; error?: string } {
    const guard = this.poolGuardError(filePath)
    if (guard) return { ok: false, error: guard }
    this.deps.copyText(filePath)
    return { ok: true }
  }

  /** 右键多选「复制路径」（工单26）：整集完整路径多行进文本剪贴板，每行一个完整路径、
   * 以 \n 分隔（贴给终端/对话逐行可用），行序 = 名单序（选区插入序）。逐条校验池内，
   * 任一池外即整份拒绝（copyPath 同语；剪贴板不写半份名单）。 */
  copyPaths(filePaths: readonly string[]): { ok: boolean; error?: string } {
    if (!filePaths.length) return { ok: false, error: '复制路径名单为空' }
    for (const filePath of filePaths) {
      const guard = this.poolGuardError(filePath)
      if (guard) return { ok: false, error: guard }
    }
    this.deps.copyText(filePaths.join('\n'))
    return { ok: true }
  }

  /** 删除进回收站（工单27，单项菜单【删除】与多选菜单【删除全部】共用一道契约）：
   * paths 全部在池内才执行（copyPaths 同款护栏，不删半份名单）；逐项经依赖束回收站源
   * （生产 shell.trashItem，误删可找回），失败如实回报不做提权——任一失败 ok=false 且
   * error 带明细（菜单层据此提示）。成功条目同拍清除摆位存储三名单（防同名复活莫名
   * 归位）并落盘 + 即时重编排一次；全部失败不动存储。 */
  async trash(filePaths: readonly string[]): Promise<{ ok: boolean; trashed: string[]; failed: string[]; error?: string }> {
    if (!filePaths.length) return { ok: false, trashed: [], failed: [], error: '删除名单为空' }
    for (const filePath of filePaths) {
      const guard = this.poolGuardError(filePath)
      if (guard) return { ok: false, trashed: [], failed: [], error: guard }
    }
    const nameOf = new Map(this.items.map((i) => [i.path, i.name]))
    const trashed: string[] = []
    const failed: string[] = []
    const details: string[] = []
    for (const filePath of filePaths) {
      const name = nameOf.get(filePath)!
      const error = await this.deps.trash(filePath)
      if (error) {
        failed.push(name)
        details.push(`${name}：${error}`)
      } else {
        trashed.push(name)
      }
    }
    if (trashed.length) {
      this.store = forgetItems(this.store, trashed)
      this.persist()
      this.refresh()
    }
    return failed.length
      ? { ok: false, trashed, failed, error: details.join('；') }
      : { ok: true, trashed, failed: [] }
  }

  /** 写系统文件剪贴板（工单29 单项/多选菜单【复制】【剪切】共用一道实现，两种 effect）：
   * paths 全部在池内才执行（copyPaths 同款整份护栏，剪贴板不写半份名单），空名单拒绝。
   * 整份绝对路径有序列表（序 = 名单序 = 选区插入序）+ effect（copy/move）交依赖束——
   * CF_HDROP + Preferred DropEffect 单事务写入。剪切不成都不动摆位：写剪贴板只声明
   * 意图，文件仍在原地（真桌面同款），摆位清除发生在粘贴移走或 trash 时。 */
  async clipboardCopy(filePaths: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    return this.writeClipboardTo(filePaths, 'copy')
  }

  async clipboardCut(filePaths: readonly string[]): Promise<{ ok: boolean; error?: string }> {
    return this.writeClipboardTo(filePaths, 'move')
  }

  private async writeClipboardTo(
    filePaths: readonly string[],
    effect: ClipboardEffect,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!filePaths.length) return { ok: false, error: effect === 'copy' ? '复制名单为空' : '剪切名单为空' }
    for (const filePath of filePaths) {
      const guard = this.poolGuardError(filePath)
      if (guard) return { ok: false, error: guard }
    }
    const error = await this.deps.writeClipboardFiles(filePaths, effect)
    return error ? { ok: false, error } : { ok: true }
  }

  /** 原地重命名（工单28 单项菜单【重命名】）：name 按名校验在池内（pin 同款护栏），
   * to（标签输入框原文）经纯逻辑推导盘面目标名（快捷方式/网址自动补回原扩展）并做
   * Win32 合法性校验。重名冲突显式拒绝（entryExists 依赖——fs.rename 落既有名会被
   * MoveFileEx 静默覆写，不是真桌面语义）；与现名仅大小写有别的改名对冲突校验豁免
   * （NTFS 大小写不敏感，目标就是自身）；与现名全同 = 幂等空转。成功同拍迁移摆位
   * 存储三名单（renameItemInStore，按名键控的位置不丢）并落盘 + 即时重编排一次；
   * 校验失败与依赖失败都不动存储不落盘（原名还原归渲染层）。响应 to = 盘面最终名。 */
  async rename(name: string, to: string): Promise<{ ok: boolean; to?: string; error?: string }> {
    const guard = this.poolNameError(name)
    if (guard) return { ok: false, error: guard }
    const item = this.items.find((i) => i.name === name)!
    const target = renameTarget(item, to)
    const invalid = fileNameError(target)
    if (invalid) return { ok: false, error: invalid }
    if (target === item.name) return { ok: true, to: target } // 未改名：不落盘不发依赖
    const caseOnly = target.toLowerCase() === item.name.toLowerCase()
    if (!caseOnly && this.deps.entryExists(path.join(path.dirname(item.path), target))) {
      return { ok: false, error: `目标名已存在：${target}` }
    }
    const error = await this.deps.rename(item.path, path.join(path.dirname(item.path), target))
    if (error) return { ok: false, error }
    this.store = renameItemInStore(this.store, name, target)
    this.persist()
    this.refresh()
    return { ok: true, to: target }
  }

  /** 粘贴（工单30 分区空白菜单【粘贴】）：读剪贴板文件清单（readClipboardFiles——koffi
   * 真源（真机修复版，写向同款 native 路线），数据面经协议代理）逐项落用户桌面根（roots.user）。剪切语义
   * （Preferred DropEffect=move）逐项 rename、落败（跨卷 EXDEV 等）回退复制+删源，否则
   * 递归复制（文件夹同款）。目标名冲突不弹框：explorer 同款「x - 副本」「x - 副本 2」
   * 递增取空位（duplicateName 纯函数 + entryExists 盘面实况，先贴出的名字立即算占用）。
   * 无池护栏——源路径不在扫描池是常态（剪贴板来自桌面之外的任意位置），只对落点
   * roots.user 负责。部分失败语义照 trash：失败条目如实回报、成功条目保留；不动摆位
   * 存储（落进来的新名字无摆位包袱，落盘本身会触发 watch→refresh→归类编排自然接管）。 */
  async paste(): Promise<{ ok: boolean; pasted: string[]; failed: string[]; error?: string }> {
    let clip: ClipboardFiles | null
    try {
      clip = await this.deps.readClipboardFiles()
    } catch (err) {
      return { ok: false, pasted: [], failed: [], error: err instanceof Error ? err.message : String(err) }
    }
    if (!clip || !clip.paths.length) return { ok: false, pasted: [], failed: [], error: '剪贴板没有可粘贴的文件' }
    const pasted: string[] = []
    const failed: string[] = []
    const details: string[] = []
    for (const src of clip.paths) {
      const base = path.basename(src)
      try {
        // 目录与否向源目录清单求证（副本后缀缀位：文件在扩展前、目录在名尾）；清单
        // 缺席（源已消失等）按文件处理——fs 落败走部分失败回报
        const isDir = this.deps.listDir(path.dirname(src)).some((e) => e.name === base && e.isDirectory)
        const target = duplicateName(
          { name: base, isDirectory: isDir },
          (candidate) => this.deps.entryExists(path.join(this.roots.user, candidate)),
        )
        const dst = path.join(this.roots.user, target)
        const error = clip.effect === 'move' ? await this.pasteMove(src, dst) : await this.deps.fsCopyEntry(src, dst)
        if (error) {
          failed.push(base)
          details.push(`${base}：${error}`)
        } else {
          pasted.push(target)
        }
      } catch (err) {
        failed.push(base)
        details.push(`${base}：${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return failed.length
      ? { ok: false, pasted, failed, error: details.join('；') }
      : { ok: true, pasted, failed: [] }
  }

  /** 单条移动：rename 优先、落败回退复制+删源（跨卷）。复制成功但删源失败 = 条目失败
   * （源未清，与真桌面跨卷移动失败同观感）；删源成功才算贴成。 */
  private async pasteMove(src: string, dst: string): Promise<string> {
    const moved = await this.deps.fsMoveEntry(src, dst)
    if (!moved) return ''
    const copied = await this.deps.fsCopyEntry(src, dst)
    if (copied) return copied
    return this.deps.fsRemoveEntry(src)
  }

  /** 只读可粘贴态查询（工单30 菜单置灰）：剪贴板含文件即可贴。读取失败按不可贴——
   * 查询是开层前置，失败宁可置灰不让菜单误可用。 */
  async clipboardState(): Promise<{ pasteable: boolean }> {
    try {
      const clip = await this.deps.readClipboardFiles()
      return { pasteable: !!clip && clip.paths.length > 0 }
    } catch {
      return { pasteable: false }
    }
  }

  /** 拖拽摆位：name 必须在池内；beforeName 须为目标分区当前条目（null = 末尾）。落盘并即时重编排。
   * 手钉条目在应用区内不可拖（栏位由手钉清单决定，拖了也会弹回——显式拒绝而非无声失效）；
   * 跨区拖出仍允许且连同取消手钉（工单25）：「把它挪去文档区」是明确意图，拖出即离 dock、
   * 不再滞留手钉身份——否则手钉覆盖会让拖拽无声失效（显式拒绝而非无声失效的同一原则）。 */
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
    if (this.store.pinned.includes(name)) this.store = unpinItem(this.store, name) // 仅跨区（app 目标已被拒）
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

  /** 钉到应用区（工单25）：name 进手钉清单前段（已在清单则移到最前），占据 dock 前段栏位
   * 不被推荐顶替。name 必须在池内（move 同款护栏）；显式摆位名单不动——取消手钉时按其
   * 裁决归位。落盘并即时重编排。 */
  pin(name: string): { ok: boolean; error?: string } {
    const guard = this.poolNameError(name)
    if (guard) return { ok: false, error: guard }
    this.store = pinItem(this.store, name)
    this.persist()
    this.refresh()
    return { ok: true }
  }

  /** 取消手钉（工单25）：name 从手钉清单移除，条目回归归类与显式摆位裁决（文档类回文档区）。
   * name 必须在池内；手钉清单本就不含时幂等空转（菜单条件显隐下不可达，防御性放行）。
   * 落盘并即时重编排。 */
  unpin(name: string): { ok: boolean; error?: string } {
    const guard = this.poolNameError(name)
    if (guard) return { ok: false, error: guard }
    this.store = unpinItem(this.store, name)
    this.persist()
    this.refresh()
    return { ok: true }
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

/** 显式摆位与手钉覆盖归类分区（工单25 起手钉也是承载分区身份）：手钉或 dock 名单里的
 * 条目入应用区（手钉优先于 docs 名单——钉到应用区对文档区摆位条目同样生效，其摆位在
 * 手钉期间遮蔽、取消后恢复）、docs 名单里的入文档区（跨区拖拽即换区）。 */
function applyZoneOverrides(items: DesktopItem[], store: LayoutStore): DesktopItem[] {
  const pinned = new Set(store.pinned)
  const dock = new Set(store.dock)
  const docs = new Set(store.docs)
  return items.map((i) =>
    pinned.has(i.name) || dock.has(i.name)
      ? { ...i, zone: 'app' as const }
      : docs.has(i.name)
        ? { ...i, zone: 'doc' as const }
        : i,
  )
}
