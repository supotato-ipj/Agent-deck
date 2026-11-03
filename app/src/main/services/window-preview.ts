// 窗口预览服务（工单379，spec #369 决策 15/16/27 + GLOSSARY「窗口预览」）：
// 胶囊展开的横向窗口预览的**纯服务半边**——条目投影、最小化内存缓存、失败回退图标+
// 标题、选择进入聚焦、关闭即释放与低频刷新。DWM 实时缩略图的注册/注销与预览窗承载在
// desktop/preview-window.ts（控制器），本服务只产出条目与生命周期事实。
//
// 时序纪律（决策 27 / 200ms 预算）：open() 只做同步投影 + 上行 open 事件——图标提取与
// PrintWindow 缓存抓取都在打开之后的拍里异步进行（缩略图可随后填入）；预览窗承载与
// DWM 注册在 open 事件之后开始。
//
// 隐私边界（决策 26 / ADR-0002）：条目携带标题与内存位图，只走窗内桥与预览窗 DOM；
// 存证日志只记计数/模式/原因，绝不记标题或图像（单元测试结构断言）。
import { Service } from 'cordis'
import type { Context, Inject } from 'cordis'
import type { DesktopMode, WindowPreviewItem, WindowPreviewState } from '../../shared/contract'
import type { TileWindowFacts } from '../desktop/tile-scope'
import { PreviewCache } from '../desktop/preview-cache'
import { projectPreviewItems } from '../desktop/preview-projection'

/** 预览打开期间的条目刷新拍（ms）：最小化/新窗/关窗的低频对账（决策 27「低频快照」） */
const DEFAULT_REFRESH_MS = 500

export interface WindowPreviewServiceOptions {
  /** 实验开关（config agentDesktop.enabled；缺省关——零预览） */
  enabled?: boolean
  /** 存证日志（只记计数/模式/原因——不含标题/图像，决策 26） */
  log?: (event: Record<string, unknown>) => void
  /** 打开期间刷新间隔（ms；0 = 不装定时器，测试手动 refresh） */
  refreshMs?: number
  deps?: {
    currentMode?: () => DesktopMode
    /** 主屏合格窗口事实（与胶囊计数同口径；标题只供上屏） */
    members?: () => TileWindowFacts[]
    /** 应用图标提取（异步；失败 null） */
    iconOf?: (exe: string) => Promise<string | null>
    /** 进入聚焦（选择条目后；真实最大化由聚焦服务承担） */
    enterFocus?: (hwnd: number) => { ok: boolean; state?: { focused: number | null } }
  }
}

export interface PreviewOpenResult {
  ok: boolean
  state: WindowPreviewState
}

/**
 * 窗口预览服务：open/close/toggle/select 单点收口。条目只在上屏面出现；缓存与图标
 * 都是内存结构，close() 全量释放（缩略图关系在控制器侧随关闭注销）。
 */
export class WindowPreviewService extends Service {
  static inject: Inject = {}

  private readonly enabledFlag: boolean
  private readonly refreshMs: number
  private readonly logEvent: (event: Record<string, unknown>) => void
  private readonly deps: {
    currentMode: () => DesktopMode
    members: () => TileWindowFacts[]
    iconOf: (exe: string) => Promise<string | null>
    enterFocus: (hwnd: number) => { ok: boolean; state?: { focused: number | null } }
  }

  private readonly cache = new PreviewCache()
  private items: WindowPreviewItem[] = []
  private openFlag = false
  /** 打开代次（异步填入/刷新只在当前代次生效——关开竞态不写陈旧帧） */
  private generation = 0
  private fillTimer: NodeJS.Timeout | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  /** DWM 实时关系数（控制器上行；诊断/验收「关闭即释放」断言） */
  private liveCount = 0
  /** 本代次图标键 → dataURL（关闭即释放；纯应用图标，不是窗口内容） */
  private iconCache = new Map<string, string | null>()
  private started = false

  constructor(ctx: Context, options: WindowPreviewServiceOptions = {}) {
    super(ctx, 'windowPreview')
    this.enabledFlag = options.enabled ?? false
    this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS
    this.logEvent = options.log ?? (() => undefined)
    this.deps = {
      currentMode: options.deps?.currentMode ?? (() => 'unmanaged'),
      members: options.deps?.members ?? (() => []),
      iconOf: options.deps?.iconOf ?? (async () => null),
      enterFocus: options.deps?.enterFocus ?? (() => ({ ok: false })),
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    // 切出 Agent 桌面：预览不再有意义——收窗并释放（普通档零预览）
    this.ctx.on('workspace/changed', (state) => {
      if (state.current !== 'agent') this.close('desktop')
    })
    // 平铺账变化（最小化/新窗/关窗）→ 低频对账条目（不开高频轮询维持静止画面）
    this.ctx.on('tiling/changed', () => this.refresh())
    // 控制器上行：DWM 注册失败的条目回退为图标+标题（预览始终可用）
    this.ctx.on('window-preview/live-failed', (payload) => this.onLiveFailed(payload.hwnd))
    // 控制器上行：当前 DWM 关系数（诊断）
    this.ctx.on('window-preview/live-registered', (payload) => {
      this.liveCount = payload.count
    })
  }

  protected stop(): void {
    this.close('dispose')
    this.iconCache.clear()
  }

  private available(): boolean {
    return this.enabledFlag
  }

  private active(): boolean {
    return this.available() && this.deps.currentMode() === 'agent'
  }

  /** 只读投影（桥 preview/get-state 与回推共用） */
  state(): WindowPreviewState {
    return {
      available: this.available(),
      current: this.deps.currentMode(),
      open: this.openFlag,
      items: this.openFlag ? this.items.map((x) => ({ ...x })) : [],
    }
  }

  /** 展开预览：同步投影 + 上行 open；图标与缓存抓取随后填入（200ms 可交互预算） */
  open(): PreviewOpenResult {
    if (!this.active()) return { ok: false, state: this.state() }
    if (this.openFlag) return { ok: true, state: this.state() }
    this.generation += 1
    this.openFlag = true
    this.items = this.buildItems()
    this.logEvent({
      type: 'preview-open',
      count: this.items.length,
      modes: countModes(this.items),
    })
    this.push()
    this.startRefreshTimer()
    this.scheduleFill(this.generation)
    return { ok: true, state: this.state() }
  }

  /** 收起预览：释放缓存/图标/关系计数（DWM 关系由控制器随关闭注销） */
  close(reason: string): void {
    if (!this.openFlag) return
    this.generation += 1
    this.openFlag = false
    const released = this.cache.size()
    this.cache.clear()
    this.iconCache.clear()
    this.liveCount = 0
    this.stopTimers()
    this.items = []
    this.logEvent({ type: 'preview-close', reason, cachedReleased: released })
    this.push()
  }

  /** 胶囊主体点击：非聚焦态展开/收起（聚焦态的「退出聚焦」由桥接层先判焦点） */
  toggle(): { ok: boolean; open: boolean } {
    if (this.openFlag) {
      this.close('toggle')
      return { ok: true, open: false }
    }
    const r = this.open()
    return { ok: r.ok, open: r.state.open }
  }

  /**
   * 选择条目：先让目标真实最大化进入聚焦（此刻预览窗还是前台，本进程有权激活目标），
   * 再收起预览（隐藏已处于后台的预览窗不会抢回焦点）。聚焦不成立时保留预览。
   */
  select(hwnd: number): { ok: boolean; focused: number | null } {
    if (!this.openFlag) return { ok: false, focused: null }
    if (!this.items.some((x) => x.hwnd === hwnd)) return { ok: false, focused: null }
    const r = this.deps.enterFocus(hwnd)
    if (!r.ok) return { ok: false, focused: null }
    this.close('select')
    this.logEvent({ type: 'preview-select', hwnd, focused: true })
    return { ok: true, focused: r.state?.focused ?? hwnd }
  }

  /** 低频对账（打开期间 500ms / tiling 变化触发）：模式与条目变化才推 */
  refresh(): void {
    if (!this.openFlag) return
    const next = this.buildItems()
    if (sameItems(this.items, next)) return
    this.items = next
    this.logEvent({ type: 'preview-refresh', count: next.length, modes: countModes(next) })
    this.push()
  }

  /** 诊断（验收用）：open / DWM 关系数 / 内存缓存条数——不含标题或图像 */
  diag(): { open: boolean; live: number; cached: number } {
    return { open: this.openFlag, live: this.liveCount, cached: this.cache.size() }
  }

  /** 控制器上行：某条目的 DWM 实时注册失败 → 回退图标+标题 */
  private onLiveFailed(hwnd: number): void {
    if (!this.openFlag) return
    const item = this.items.find((x) => x.hwnd === hwnd)
    if (!item || item.mode !== 'live') return
    item.mode = 'icon'
    item.image = null
    this.logEvent({ type: 'preview-live-failed', hwnd })
    this.push()
  }

  /**
   * 条目投影（保留上一轮已填的图标/缓存帧，并**保持既有条目序**）：最小化/关窗会改变
   * z 序，若按 z 重排，条目会在用户眼皮底下跳位、指针下的条目也会换人（真机轮实证）。
   * 已在场的条目原位保留，新成员追加队尾。
   */
  private buildItems(): WindowPreviewItem[] {
    const seeds = projectPreviewItems(this.deps.members(), (hwnd) => this.cache.has(hwnd))
    const byHwnd = new Map(seeds.map((s) => [s.hwnd, s] as const))
    const ordered: typeof seeds = []
    for (const item of this.items) {
      const seed = byHwnd.get(item.hwnd)
      if (!seed) continue
      ordered.push(seed)
      byHwnd.delete(item.hwnd)
    }
    for (const seed of seeds) {
      if (byHwnd.has(seed.hwnd)) ordered.push(seed)
    }
    const prev = new Map(this.items.map((x) => [x.hwnd, x] as const))
    return ordered.map((seed) => {
      const old = prev.get(seed.hwnd)
      const image = seed.mode === 'cached' ? this.cache.peek(seed.hwnd)?.dataUrl ?? null : null
      return {
        hwnd: seed.hwnd,
        title: seed.title,
        icon: old?.icon ?? this.iconCache.get(seed.exe) ?? null,
        mode: seed.mode,
        image,
      }
    })
  }

  /** 打开后的异步填入：应用图标（先可交互、图标随后到） */
  private scheduleFill(gen: number): void {
    if (this.fillTimer) clearTimeout(this.fillTimer)
    this.fillTimer = setTimeout(() => {
      this.fillTimer = null
      void this.fillIcons(gen)
    }, 0)
  }

  /**
   * 最近缓存帧上行（工单379，决策 15）：预览窗控制器在实时缩略图上屏稳定后，对预览窗
   * 条目区做一次屏幕取景（DWM 实时内容已在屏上），逐条裁成内存帧交给本服务。
   *
   * 为什么不在主进程用 PrintWindow 抓外部窗：真机实证 PrintWindow(PW_RENDERFULLCONTENT)
   * 对 WPF 窗可**无限期阻塞主线程**（探针中 30s 冻结面板，capture-test 复现挂死）——
   * 主进程不能对第三方窗做同步跨进程绘制。屏幕取景由预览窗口承载（DWM 已渲染），
   * 不会挂主线程，且缓存内容 = 用户刚看到的最近画面。
   */
  rememberFrames(frames: readonly { hwnd: number; dataUrl: string; width: number; height: number }[]): void {
    if (!this.openFlag || !frames.length) return
    let stored = 0
    for (const frame of frames) {
      if (!this.items.some((x) => x.hwnd === frame.hwnd)) continue
      if (!frame.dataUrl) continue
      this.cache.remember(frame.hwnd, { dataUrl: frame.dataUrl, width: frame.width, height: frame.height })
      stored += 1
    }
    this.logEvent({ type: 'preview-cache', frames: stored })
  }

  private async fillIcons(gen: number): Promise<void> {
    const members = this.membersByHwnd(this.deps.members())
    const uniqueExes = new Map<string, number[]>()
    for (const item of this.items) {
      const exe = members.get(item.hwnd)?.exe ?? ''
      if (!exe) continue
      const list = uniqueExes.get(exe) ?? []
      list.push(item.hwnd)
      uniqueExes.set(exe, list)
    }
    for (const [exe, hwnds] of uniqueExes) {
      let icon = this.iconCache.get(exe)
      if (icon === undefined) {
        try {
          icon = await this.deps.iconOf(exe)
        } catch {
          icon = null
        }
        this.iconCache.set(exe, icon)
      }
      if (gen !== this.generation || !this.openFlag || !icon) continue
      let changed = false
      for (const hwnd of hwnds) {
        const item = this.items.find((x) => x.hwnd === hwnd)
        if (item && item.icon !== icon) {
          item.icon = icon
          changed = true
        }
      }
      if (changed) this.push()
    }
  }

  private membersByHwnd(facts: TileWindowFacts[]): Map<number, TileWindowFacts> {
    return new Map(facts.map((f) => [f.hwnd, f] as const))
  }

  private startRefreshTimer(): void {
    this.stopRefreshTimer()
    if (this.refreshMs <= 0) return
    this.refreshTimer = setInterval(() => this.refresh(), this.refreshMs)
  }

  private stopRefreshTimer(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
  }

  private stopTimers(): void {
    if (this.fillTimer) {
      clearTimeout(this.fillTimer)
      this.fillTimer = null
    }
    this.stopRefreshTimer()
  }

  private push(): void {
    this.ctx.emit('preview/changed', this.state())
  }
}

function countModes(items: readonly WindowPreviewItem[]): { live: number; cached: number; icon: number } {
  const out = { live: 0, cached: 0, icon: 0 }
  for (const x of items) out[x.mode] += 1
  return out
}

function sameItems(a: readonly WindowPreviewItem[], b: readonly WindowPreviewItem[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.hwnd !== y.hwnd || x.mode !== y.mode || x.title !== y.title || x.icon !== y.icon || x.image !== y.image) return false
  }
  return true
}
