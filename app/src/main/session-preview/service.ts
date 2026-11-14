/**
 * Agent 会话预览服务（工单381，spec #369 决策 20-24/27 —— 只读投影 + 打开期间 1Hz 刷新）。
 *
 * 数据源（严格只读，source storage 零写入）：
 *   - qodercn / zcode / kimicode / minimaxcode（工单382）：各自只读扫描器的预览行
 *     （真实标题原样透传；minimaxcode 只取身份/标题/项目/最近活跃，不读 DB status）；
 *   - dsh：面板内 ConversationSessionView（真实 label、busy、pendingPermission）。
 *
 * 生命周期：气泡关闭时零轮询（spec 决策 27「不用高频轮询维持静止画面」）；悬停展开后
 * 每 1000ms 重建一次投影并推送。单工具读取失败隔离——该工具本轮空集，其余工具照常。
 * 日志只记工具名/计数/原因，不记对话标题或正文（spec 决策 26）。
 */
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { ConversationSessionView, SessionPreviewState, SessionPreviewToolGroup } from '../../shared/contract'
import { defaultSessionRoots, SqlitePool } from '../scanners'
import type { SessionRoots } from '../scanners'
import { kimicodePreviewRows } from '../scanners/kimicode'
import { minimaxcodePreviewRows } from '../scanners/minimaxcode'
import { qoderPreviewRows } from '../scanners/qoder'
import { zcodePreviewRows } from '../scanners/zcode'
import { buildSessionPreviewGroups } from './projection'
import type { SessionPreviewInputs } from './projection'

/** 打开期间刷新节拍（spec 决策 24/27：1Hz 快照刷新） */
export const SESSION_PREVIEW_REFRESH_MS = 1000

export interface SessionPreviewRowInputs {
  qoder: SessionPreviewInputs['qoder']
  zcode: SessionPreviewInputs['zcode']
  kimicode: SessionPreviewInputs['kimicode']
  minimaxcode: SessionPreviewInputs['minimaxcode']
}

export interface SessionPreviewServiceDeps {
  /** 悬停锚点在场判据（桌面模式切换组可用——普通/Agent 两桌面均可；缺省 true） */
  available?: () => boolean
  /** DSH 会话视图来源（缺省 = 空集——不编造会话） */
  dshSessions?: () => ConversationSessionView[]
  /** 文件扫描行来源（离线测试注入假源；缺省 = 三工具只读扫描器） */
  readRows?: (roots: SessionRoots, nowMs: number) => SessionPreviewRowInputs
  now?: () => number
  log?: (event: Record<string, unknown>) => void
}

export interface SessionPreviewServiceOptions {
  enabled?: boolean
  /** 工具数据根（qoder/zcode/kimicode 键沿用 scanners 既有词汇；缺省本机真实根） */
  roots?: SessionRoots
  /** 存证口（生产装配接 DECK_EVENT_LOG；只记工具名/计数/原因，不记对话标题） */
  log?: (event: Record<string, unknown>) => void
  deps?: SessionPreviewServiceDeps
}

/** 缺省行读取：逐工具隔离——单工具失败保留其余三工具（ADR-0003 同语义）；
 * SQLite 族（zcode/minimaxcode）经池复用连接（工单477 束②，气泡打开期 1Hz 重建不再每秒重开）。 */
export function readPreviewRows(roots: SessionRoots, nowMs: number, log?: (e: Record<string, unknown>) => void, pool?: SqlitePool): SessionPreviewRowInputs {
  const safe = <T,>(tool: string, fn: () => T, fallback: T): T => {
    try {
      return fn()
    } catch (err) {
      log?.({ type: 'session-preview-scan-failed', tool, message: err instanceof Error ? err.message : String(err) })
      return fallback
    }
  }
  const root = (key: string): string => roots[key] ?? ''
  return {
    qoder: safe('qodercn', () => (root('qoder') ? qoderPreviewRows(root('qoder'), nowMs) : []), []),
    zcode: safe('zcode', () => (root('zcode') ? zcodePreviewRows(root('zcode'), nowMs, pool) : []), []),
    kimicode: safe('kimicode', () => (root('kimicode') ? kimicodePreviewRows(root('kimicode'), nowMs) : []), []),
    minimaxcode: safe('minimaxcode', () => (root('minimaxcode') ? minimaxcodePreviewRows(root('minimaxcode'), nowMs, pool) : []), []),
  }
}

export class SessionPreviewService extends Service {
  private readonly enabledFlag: boolean
  private readonly roots: SessionRoots
  private readonly deps: SessionPreviewServiceDeps
  /** 会话 SQLite 连接池（工单477 束②）：气泡打开期 1Hz 重建复用只读连接，拆卸即清账 */
  private readonly pool = new SqlitePool()
  private openFlag = false
  private groups: SessionPreviewToolGroup[] = []
  private generatedAt = 0
  private refreshSeq = 0
  private timer: NodeJS.Timeout | null = null

  constructor(ctx: Context, options: SessionPreviewServiceOptions = {}) {
    super(ctx, 'sessionPreview')
    this.enabledFlag = options.enabled ?? true
    this.roots = options.roots ?? defaultSessionRoots()
    this.deps = { ...(options.deps ?? {}) }
    if (!this.deps.log && options.log) this.deps.log = options.log
    ctx.on('dispose', () => this.dispose())
    ctx.on('dispose', () => this.pool.closeAll())
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private log(event: Record<string, unknown>): void {
    this.deps.log?.(event)
  }

  private available(): boolean {
    if (!this.enabledFlag) return false
    return this.deps.available?.() ?? true
  }

  /** 重建投影（单工具失败隔离；不推送） */
  private rebuild(): void {
    const nowMs = this.now()
    this.generatedAt = nowMs
    if (!this.available()) {
      this.groups = []
      return
    }
    const rows = (this.deps.readRows ?? ((r, n) => readPreviewRows(r, n, (e) => this.log(e), this.pool)))(this.roots, nowMs)
    let dsh: ConversationSessionView[] = []
    try {
      dsh = this.deps.dshSessions?.() ?? []
    } catch (err) {
      this.log({ type: 'session-preview-scan-failed', tool: 'dsh', message: err instanceof Error ? err.message : String(err) })
    }
    this.groups = buildSessionPreviewGroups({ ...rows, dsh }, nowMs)
  }

  /** 当前只读投影（气泡页首帧自取；打开由悬停控制器驱动——src/main/session-preview/window.ts） */
  state(): SessionPreviewState {
    if (!this.available()) {
      return { available: false, open: false, groups: [], generatedAt: this.generatedAt || this.now() }
    }
    return { available: true, open: this.openFlag, groups: this.groups, generatedAt: this.generatedAt || this.now() }
  }

  isOpen(): boolean {
    return this.openFlag
  }

  /**
   * 打开气泡：重建投影 + 1Hz 刷新起拍。锚点不在场（实验开关关/平台能力不可用）时
   * 如实拒绝（ok:false）——不建空气泡。
   */
  open(): boolean {
    if (!this.available()) return false
    if (this.openFlag) return true
    this.openFlag = true
    this.refreshSeq = 0
    this.rebuild()
    this.log({ type: 'session-preview-open', groups: this.groups.length, cards: this.cardCount() })
    this.emitChanged()
    if (this.timer === null) {
      this.timer = setInterval(() => this.tick(), SESSION_PREVIEW_REFRESH_MS)
    }
    return true
  }

  private tick(): void {
    if (!this.openFlag) return
    if (!this.available()) {
      this.close('unavailable')
      return
    }
    this.rebuild()
    this.refreshSeq += 1
    this.log({ type: 'session-preview-refresh', seq: this.refreshSeq, groups: this.groups.length, cards: this.cardCount() })
    this.emitChanged()
  }

  /** 收起气泡（Esc / 点外 / 锚点离开宽限到期）：停表、清卡片、推送关闭态 */
  close(reason: string): boolean {
    if (!this.openFlag) return false
    this.openFlag = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    const cards = this.cardCount()
    this.groups = []
    this.generatedAt = this.now()
    this.log({ type: 'session-preview-close', reason, cards })
    this.emitChanged()
    return true
  }

  private cardCount(): number {
    return this.groups.reduce((n, g) => n + g.cards.length, 0)
  }

  private emitChanged(): void {
    this.ctx.emit('session-preview/changed', this.state())
  }

  dispose(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.openFlag = false
  }
}
