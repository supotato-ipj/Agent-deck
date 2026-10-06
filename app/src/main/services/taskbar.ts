import { Service } from 'cordis'
import type { Context } from 'cordis'
import fs from 'node:fs'
import type { TaskbarButtonId, TaskbarDragDrop, TaskbarDragGroup, TaskbarRecommendation, TaskbarState, TaskbarSystemAction } from '../../shared/contract'
import { defaultTaskbar, saveConfig } from '../config'
import type { AppConfig } from '../config'
import { BridgeError } from './bridge'
import { normalizeExe, planLeftGroup } from '../taskbar/left-plan'
import type { TaskbarPinnedEntry, TaskbarWindowInput } from '../taskbar/left-plan'
import { loadTaskbarStore, migrateDockPinned, moveInOrder, parseDockPinnedNames, pinEntry, reorderPinned, serializeTaskbarStore, unpinEntry } from '../taskbar/layout-store'
import type { MigrationItem, TaskbarLayoutStore } from '../taskbar/layout-store'
import { applyRecommendationOrder } from '../taskbar/plan'
import { iconKeyOf } from '../desktop/scan'
import { readStoreText, writeStoreText } from '../desktop/adapter'
import { userDataPath } from '../paths'

export interface TaskbarServiceOptions {
  /** 初始开关（config.json taskbar.enabled 下发；缺省 = 默认开启） */
  enabled?: boolean
  /** 中组系统按钮隐藏名单初值（config.json taskbar.hiddenButtons 下发，工单54） */
  hiddenButtons?: TaskbarButtonId[]
  /** config.json 绝对路径（缺省 = 不落盘，仅内存态——离线测试省配置桩） */
  file?: string
  /** 已加载的 config（可变引用：写开关即整份回写该对象，settings 先例） */
  config?: AppConfig
  /** 栏布局存储文件（工单52；默认 userData/taskbar-layout.json） */
  storeFile?: string
  /** dock 迁移源（旧 dock 摆位存储；默认 userData/layout.json）。只读——dock 退役属工单59 */
  dockStoreFile?: string
  /** 依赖缝：真源缺省延迟绑定（离线测试注入假源后不触 FFI/Electron） */
  deps?: {
    /** 按键合成真源（缺省延迟绑定 taskbar/syskeys） */
    sendSystemKeys?: (action: TaskbarSystemAction) => boolean
    /**
     * 中组推荐位来源（工单54）：数据面快照推导（fuseScores 链路的产物），
     * 缺省空名单——离线测试注假源或经内核 panelData 装配。
     */
    recommendations?: () => TaskbarRecommendation[]
    /** 运行中窗口枚举（工单52；缺省延迟绑定 taskbar/windows；标题仅内存即时读取，ADR-0007 书面口子） */
    listWindows?: () => TaskbarWindowInput[]
    /** 自家 exe（其窗口不上栏；默认 process.execPath） */
    ownExe?: string
    /** 迁移解析用的桌面项池（缺省经数据面端口取最新快照条目） */
    desktopItems?: () => MigrationItem[]
    /** lnk 目标解析（缺省延迟绑定 desktop/adapter 的 Electron 真源） */
    resolveShortcutTarget?: (lnkPath: string) => string | null
    /** 存储读写（缺省 desktop/adapter 的 fs 真源——tmp+rename 原子写单一出处） */
    readStoreText?: (file: string) => string | null
    writeStoreText?: (file: string, text: string) => void
    /** 仅运行条目的图标键（缺省 statSync mtime 组 iconKeyOf；入参为归一后的 exe） */
    iconKeyForPath?: (exe: string) => string | null
  }
}

const SYSTEM_ACTIONS: readonly TaskbarSystemAction[] = ['start-menu', 'task-view']

/** 中组系统按钮合法 id（与 config.ts 的持久化校验同源口径） */
const BUTTON_IDS: readonly TaskbarButtonId[] = ['start', 'tasks']

/** 拖拽组别合法值（工单57） */
const DRAG_GROUPS: readonly TaskbarDragGroup[] = ['left', 'mid']

/** 推荐位名单逐条比对（name+path 都变才算变——显示名同拍变化也该触发重渲） */
function sameRecommendations(a: readonly TaskbarRecommendation[], b: readonly TaskbarRecommendation[]): boolean {
  return a.length === b.length && a.every((r, i) => r.name === b[i].name && r.display === b[i].display && r.path === b[i].path)
}

interface TaskbarDeps {
  sendSystemKeys: (action: TaskbarSystemAction) => boolean
  recommendations: () => TaskbarRecommendation[]
  listWindows: () => TaskbarWindowInput[]
  ownExe: string
  desktopItems: () => MigrationItem[]
  resolveShortcutTarget: (lnkPath: string) => string | null
  readStoreText: (file: string) => string | null
  writeStoreText: (file: string, text: string) => void
  iconKeyForPath: (exe: string) => string | null
}

/**
 * 任务栏插件（工单49/52/54，ADR-0007）：体系第一种非卡片形态的 cordis 主进程插件。
 * 本服务只管状态与动作——开关与系统按钮显隐（config.json 持久化 + taskbar/changed
 * 回推）、系统动作合成（开始菜单/任务视图）、中组推荐位名单（工单54：从数据面
 * 链路拉取，变化即回推）、左组编排（工单52：refresh 一轮 = 迁移就位 → 窗口枚举 →
 * planLeftGroup 纯函数编排 → 内容变化即推 taskbar/changed）。
 * 置顶窗口的创建/销毁是效果层，由生产装配（taskbar/window.ts 控制器）订阅
 * taskbar/changed 驱动，本服务不引 electron，离线契约测试经 createKernel 直装直测。
 * 隐私：窗口标题只活在内存态与桥事件载荷里（tooltip 即时呈现），落盘的栏布局
 * 存储只有 exe 身份与展示元数据——标题永不持久化（ADR-0002 红线的书面口子口径）。
 */
export class TaskbarService extends Service {
  static inject = ['panelData']

  private readonly file: string | null
  private readonly appConfig: AppConfig | null
  private readonly storeFile: string
  private readonly dockStoreFile: string
  private readonly deps: TaskbarDeps
  private current: TaskbarState
  private store: TaskbarLayoutStore = { version: 1, pinned: [], recommended: [] }
  /** 迁移/装载一次性闸门：栏布局读入（或迁移落盘）成功才置位，写失败下拍重试 */
  private layoutReady = false

  constructor(ctx: Context, options: TaskbarServiceOptions = {}) {
    super(ctx, 'taskbar')
    this.file = options.file ?? null
    this.appConfig = options.config ?? null
    this.storeFile = options.storeFile ?? userDataPath('taskbar-layout.json')
    this.dockStoreFile = options.dockStoreFile ?? userDataPath('layout.json')
    this.deps = {
      sendSystemKeys: options.deps?.sendSystemKeys
        ?? ((action) => (require('../taskbar/syskeys') as typeof import('../taskbar/syskeys')).sendSystemAction(action)),
      recommendations: options.deps?.recommendations ?? (() => []),
      listWindows: options.deps?.listWindows
        ?? (() => (require('../taskbar/windows') as typeof import('../taskbar/windows')).nativeTaskbarWindows()),
      ownExe: options.deps?.ownExe ?? process.execPath,
      desktopItems: options.deps?.desktopItems ?? (() => this.ctx.panelData.desktop().items),
      resolveShortcutTarget: options.deps?.resolveShortcutTarget
        ?? ((p) => (require('../desktop/adapter') as typeof import('../desktop/adapter')).electronShortcutTarget(p)),
      readStoreText: options.deps?.readStoreText ?? readStoreText,
      writeStoreText: options.deps?.writeStoreText ?? writeStoreText,
      iconKeyForPath: options.deps?.iconKeyForPath ?? ((exe) => {
        try {
          return iconKeyOf(exe, fs.statSync(exe).mtimeMs)
        } catch {
          return null // 竞态退出/权限缺席：无图标源，渲染层按无图降级
        }
      }),
    }
    this.current = {
      enabled: options.enabled ?? defaultTaskbar().enabled,
      hiddenButtons: [...(options.hiddenButtons ?? defaultTaskbar().hiddenButtons)],
      recommendations: [],
      left: [],
    }
    // 推荐位即时刷新（工单54）：数据面每拍快照即重拉一次，变化才回推（1Hz 拉取 ×
    // 逐条 diff——名单稳定时零事件零重渲）。离线内核无 dataplane/snapshot，契约测试
    // 手动驱动 refreshRecommendations（手动驱动采集轮同款纪律）。
    this.ctx.on('dataplane/snapshot', () => this.refreshRecommendations())
  }

  state(): TaskbarState {
    return {
      ...this.current,
      hiddenButtons: [...this.current.hiddenButtons],
      recommendations: [...this.current.recommendations],
      left: [...this.current.left],
    }
  }

  /** 开关：先写盘后提交内存态（settings 同款顺序——写失败即抛，三者一致）；
   * 同值幂等空转（不重写盘、不重推事件）。config.json 的 taskbar 段只持开关与
   * 按钮显隐，左组条目是运行态、永不进 config。 */
  setEnabled(enabled: boolean): TaskbarState {
    if (typeof enabled !== 'boolean') {
      throw new BridgeError(`taskbar.enabled 须为布尔值，收到 ${String(enabled)}`)
    }
    if (enabled === this.current.enabled) return this.state()
    this.persist({ enabled })
    this.current = { ...this.current, enabled }
    this.ctx.emit('taskbar/changed', this.state())
    return this.state()
  }

  /** 中组系统按钮显隐（工单54）：右键菜单动作落点。同态幂等空转；未知 id 抛
   * BridgeError（契约违规不静默吞掉）。先写盘后提交内存态（setEnabled 同款顺序）。 */
  setButtonHidden(id: TaskbarButtonId, hidden: boolean): TaskbarState {
    if (!BUTTON_IDS.includes(id)) {
      throw new BridgeError(`未知任务栏按钮: ${String(id)}`)
    }
    if (typeof hidden !== 'boolean') {
      throw new BridgeError(`taskbar.set-button-hidden.hidden 须为布尔值，收到 ${String(hidden)}`)
    }
    const has = this.current.hiddenButtons.includes(id)
    if (hidden === has) return this.state()
    const hiddenButtons = hidden
      ? [...this.current.hiddenButtons, id]
      : this.current.hiddenButtons.filter((b) => b !== id)
    this.persist({ hiddenButtons })
    this.current = { ...this.current, hiddenButtons }
    this.ctx.emit('taskbar/changed', this.state())
    return this.state()
  }

  /** 推荐位重拉（工单54）：数据面快照驱动 / 契约测试手动驱动；变化才回推 taskbar/changed。
   * 名单经可见性管线（工单57）：手钉条目不占推荐位 + 用户显式序压过分数序。 */
  refreshRecommendations(): void {
    let next: TaskbarRecommendation[]
    try {
      next = this.visibleRecommendations()
    } catch {
      return // 来源未就绪（数据面首拍前）按上次名单继续持有
    }
    if (sameRecommendations(this.current.recommendations, next)) return
    this.current = { ...this.current, recommendations: next }
    this.ctx.emit('taskbar/changed', this.state())
  }

  /**
   * 栏上拖拽落位（工单57）：组内换位（左组手钉段内 / 中组推荐位内）与跨组拖拽
   * （中→左 = 升为手钉，左→中 = 解除手钉回推荐池）。裁决全部进 layout-store 纯函数，
   * 本方法只做校验、编排与持久化：先落盘再提交内存态（setEnabled 同款顺序——写失败
   * 即抛，盘/内存/事件三者一致），同态幂等空转不重写不重推。
   */
  dragDrop(drop: TaskbarDragDrop): { ok: boolean; error?: string } {
    if (typeof drop !== 'object' || drop === null || !DRAG_GROUPS.includes(drop.from) || !DRAG_GROUPS.includes(drop.to)) {
      throw new BridgeError(`未知任务栏拖拽组: ${String((drop as TaskbarDragDrop | null)?.from)} → ${String((drop as TaskbarDragDrop | null)?.to)}`)
    }
    if (typeof drop.id !== 'string' || !drop.id) {
      throw new BridgeError(`任务栏拖拽条目身份须为非空字符串，收到 ${String(drop.id)}`)
    }
    if (drop.before !== null && typeof drop.before !== 'string') {
      throw new BridgeError(`任务栏拖拽落点须为字符串或 null，收到 ${String(drop.before)}`)
    }
    if (!this.current.enabled) return { ok: false, error: '任务栏已禁用，栏面不可拖拽' }
    this.ensureLayout()
    if (drop.from === 'left' && drop.to === 'left') {
      const next = reorderPinned(this.store, drop.id, drop.before)
      if (next === this.store) {
        // 同一引用 = 空转：非手钉条目（仅运行）不可换位 → ok:false；自落点幂等 → ok:true 不重推
        return this.store.pinned.some((p) => normalizeExe(p.exe) === normalizeExe(drop.id))
          ? { ok: true }
          : { ok: false, error: '仅手钉条目可在左组拖拽换位（仅运行条目是运行态，不可摆位）' }
      }
      this.commitStore(next)
      return { ok: true }
    }
    if (drop.from === 'mid' && drop.to === 'mid') {
      let visible: TaskbarRecommendation[]
      try {
        visible = this.visibleRecommendations()
      } catch {
        return { ok: false, error: '推荐位来源未就绪，稍后再试' }
      }
      const names = visible.map((r) => r.name)
      if (!names.includes(drop.id)) return { ok: false, error: '拖拽条目不在中组推荐位（名单外名字）' }
      const ordered = moveInOrder(names, drop.id, drop.before)
      if (ordered.length === names.length && ordered.every((n, i) => n === names[i])) return { ok: true } // 幂等空转
      this.commitStore({ ...this.store, recommended: ordered })
      return { ok: true }
    }
    throw new BridgeError(`不支持的任务栏拖拽组合: ${drop.from} → ${drop.to}`)
  }

  /**
   * 左组一个编排轮（工单52；生产由内核 1Hz 定时器驱动——应用启动/退出 1–2 秒内
   * 反映到左组；离线契约测试手动驱动）。禁用态空转：栏窗已销，不枚举窗口。
   * 迁移随首轮就位：栏布局存储缺位时把旧 dock 手钉名单迁入（顺序保持），
   * 落盘成功才算迁移完成。
   */
  refresh(): void {
    if (!this.current.enabled) return
    this.ensureLayout()
    let windows: TaskbarWindowInput[]
    try {
      const own = normalizeExe(this.deps.ownExe)
      windows = this.deps.listWindows().filter((w) => normalizeExe(w.exe) !== own)
    } catch (err) {
      // 枚举失败沿用上一轮（desktop 扫描同款纪律：慢半拍优于瞬时空白）
      console.warn(`deck-taskbar: 本轮窗口枚举失败，沿用上一轮左组：${err instanceof Error ? err.message : err}`)
      return
    }
    const left = planLeftGroup(this.store.pinned, windows, (exe) => this.deps.iconKeyForPath(exe))
    if (JSON.stringify(left) === JSON.stringify(this.current.left)) return
    this.current = { ...this.current, left }
    this.ctx.emit('taskbar/changed', this.state())
  }

  /** 系统动作：合成按键触发原生系统 UI。合成被拒（UIPI 等）回报 ok:false 而非抛——
   * 渲染层点击语义不需 try/catch；未知动作是契约违规，抛 BridgeError。 */
  systemAction(action: TaskbarSystemAction): { ok: boolean; error?: string } {
    if (!SYSTEM_ACTIONS.includes(action)) {
      throw new BridgeError(`未知任务栏系统动作: ${String(action)}`)
    }
    try {
      return { ok: this.deps.sendSystemKeys(action) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /** 测试观察缝：当前栏布局存储内容（工单52/57） */
  storeForTest(): TaskbarLayoutStore {
    return { version: 1, pinned: [...this.store.pinned], recommended: [...this.store.recommended] }
  }

  /**
   * 栏布局装载/迁移（工单52，一次性）：存储在场即读入（自愈解析）；缺位则首跑迁移——
   * 旧 dock 手钉名单经桌面项池解析为 exe 身份（顺序保持）落盘为栏布局。迁移只读
   * dock 摆位存储（dock 退役属工单59）；写失败不置位，下一拍重试（迁移不丢手钉）。
   */
  private ensureLayout(): void {
    if (this.layoutReady) return
    const text = this.deps.readStoreText(this.storeFile)
    if (text !== null) {
      this.store = loadTaskbarStore(text)
      this.layoutReady = true
      return
    }
    const pinned: TaskbarPinnedEntry[] = migrateDockPinned(
      parseDockPinnedNames(this.deps.readStoreText(this.dockStoreFile)),
      this.deps.desktopItems(),
      this.deps.resolveShortcutTarget,
    )
    this.store = { version: 1, pinned, recommended: [] }
    try {
      this.deps.writeStoreText(this.storeFile, serializeTaskbarStore(this.store))
      this.layoutReady = true
    } catch (err) {
      console.warn(`deck-taskbar: 栏布局迁移落盘失败（下一拍重试）：${err instanceof Error ? err.message : err}`)
    }
  }

  /**
   * 拖拽落位的存储提交（工单57）：先落盘（写失败即抛——盘/内存/事件三者一致，
   * setEnabled 同款顺序）再换内存引用并整态重排回推一帧。
   */
  private commitStore(next: TaskbarLayoutStore): void {
    this.deps.writeStoreText(this.storeFile, serializeTaskbarStore(next))
    this.store = next
    this.recompose()
  }

  /**
   * 落位后的整态重排（工单57）：左组重编排 + 推荐位可见性管线，两路各自容错
   * （窗口枚举/推荐位来源失败沿用上一轮对应段，不拖垮另半），收尾统一回推一帧
   * taskbar/changed——一次拖拽一帧，渲染层一次重渲到位。
   */
  private recompose(): void {
    try {
      const own = normalizeExe(this.deps.ownExe)
      const windows = this.deps.listWindows().filter((w) => normalizeExe(w.exe) !== own)
      this.current = { ...this.current, left: planLeftGroup(this.store.pinned, windows, (exe) => this.deps.iconKeyForPath(exe)) }
    } catch { /* 枚举失败沿用上一轮左组（refresh 同款纪律） */ }
    try {
      this.current = { ...this.current, recommendations: this.visibleRecommendations() }
    } catch { /* 来源未就绪沿用上一轮推荐位（refreshRecommendations 同款纪律） */ }
    this.ctx.emit('taskbar/changed', this.state())
  }

  /**
   * 推荐位可见性管线（工单57）：原始名单 → 手钉条目滤除（中→左升手钉后不占中组位；
   * 解除手钉即随下拍管线回池）→ 用户显式序套用（序内按名单次、序外保持分数序）。
   * 手钉判重以 exe 身份（快捷方式经 resolve 取目标，迁移同款解析）；池外名字无法
   * 判重按不重复保留（宁可暂留不误杀栏位）。
   */
  private visibleRecommendations(): TaskbarRecommendation[] {
    const pinnedKeys = new Set(this.store.pinned.map((p) => normalizeExe(p.exe)))
    const visible = this.deps.recommendations().filter((r) => {
      const exe = this.resolveItemExe(r.name)
      return exe === null || !pinnedKeys.has(exe)
    })
    return applyRecommendationOrder(visible, this.store.recommended)
  }

  /** 桌面项 name → 归一 exe 身份（迁移同款解析；池外/解析不出 → null = 无法判重） */
  private resolveItemExe(name: string): string | null {
    const item = this.deps.desktopItems().find((i) => i.name === name)
    if (!item) return null
    const exe = item.kind === 'shortcut' ? (this.deps.resolveShortcutTarget(item.path) ?? item.path) : item.path
    return normalizeExe(exe)
  }

  /** 整份回写 config.json 的 taskbar 段（enabled + hiddenButtons 同段共写）并同步可变引用 */
  private persist(next?: Partial<Pick<TaskbarState, 'enabled' | 'hiddenButtons'>>): void {
    if (!this.appConfig || !this.file) return
    const taskbar = {
      enabled: next?.enabled ?? this.current.enabled,
      hiddenButtons: next?.hiddenButtons ?? [...this.current.hiddenButtons],
    }
    saveConfig(this.file, { ...this.appConfig, taskbar })
    this.appConfig.taskbar = taskbar
  }

  /** 插件卸载路径（cordis 生命周期）：运行期卸载后不会再有 taskbar/changed——
   * 以 enabled:false 终态补发一帧，效果层（窗口控制器）经既有「禁用即销窗」
   * 路径销窗，窗口不残留（工单49 code-review 补缺）。 */
  protected stop(): void {
    this.ctx.emit('taskbar/changed', { ...this.current, enabled: false })
  }
}
