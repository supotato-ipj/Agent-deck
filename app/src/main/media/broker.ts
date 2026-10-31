import { MediaBridgeClient, type MediaBridgePort, type BridgeSessionSnapshot, type BridgeListData } from './bridge-client'
import type { MediaAuditService } from './audit'

/**
 * 媒体 Broker（工单336，ADR-0025 媒体节）：面板主进程内的权限/DTO/审计层。
 *
 * - **脱敏快照**：桥侧原始会话经**白名单投影**成 DTO（key/aumid/status/caps/timeline/
 *   media 八字段）——WinRT 概念、原生流、多余字段一律不出；字段串有界（截断）使快照
 *   序列化不超 media.read 的 snapshotBytes 上限（64KB）；status 归一封闭词表（未知值不出
 *   原串）。插件只见「快照代次变化」，不接触桥事件名与时延抖动（t329：事件只作重取
 *   触发器，UI 新鲜度靠 position+lastUpdatedTime 插值 + 面板兜底 tick）。
 * - **受控缩略图**：桥返回的 base64 字节副本按类型（png/jpeg/webp）与大小（≤2MB）校验，
 *   通过才转 dataURL 交获批包——校验拒付一个字节不出；会话键失效/桥缺席映射契约错误码。
 * - **授权门**：viewForPackage/thumbnailForPackage 每次调用同步查授权账（media.read 在账
 *   且未撤销才供货）——撤销即断供零窗口（账面撤销先于 rescan 停用缝发生）。
 * - **明确状态面**：无会话（available+空清单+无选中）、桥缺席（available=false，契约
 *   media_unavailable 语义）、会话退出（下轮刷新即消失）都是可表示状态。
 *
 * 桥进程边缘（MediaBridgePort）可注入 fake——vitest 全覆盖走 fake，真桥真机验（电池 C6）。
 */

/** 白名单脱敏会话 DTO（插件可见的全部媒体数据面） */
export interface SanitizedMediaSession {
  /** 带代次不透明会话键（aumid#gen；缩略图/控制按当下解析，失效如实报） */
  key: string
  aumid: string | null
  status: string
  caps: { play: boolean; pause: boolean; next: boolean; previous: boolean; stop: boolean }
  timeline: { positionMs: number; endTimeMs: number; minSeekMs: number; maxSeekMs: number; lastUpdatedTimeMs: number }
  media: {
    title: string
    artist: string
    albumTitle: string
    subtitle: string
    genres: string[]
    trackNumber: number
    albumTrackCount: number
    thumbPresent: boolean
  }
}

/** 媒体快照 DTO（脱敏；available=false = 桥缺席明确态） */
export interface MediaSnapshotDTO {
  generation: number
  available: boolean
  selectedKey: string | null
  sessions: SanitizedMediaSession[]
  /** 工单337：media.control 授权面（卡片据此降级渲染控制按钮） */
  controlGranted: boolean
}

export type MediaThumbnailResult =
  | { ok: true; contentType: string; bytes: number; dataUrl: string }
  | { ok: false; code: 'media_permission_denied' | 'media_thumbnail_rejected' | 'media_session_gone' | 'media_unavailable'; message: string }

/** 授权账端口（Broker 只依赖查询面——生产 = PluginAuthorizationLedger） */
export interface MediaAuthorizationPort {
  activeGrant(packageId: string): { permissions: readonly string[] } | null
}

/** 媒体控制结果（工单337）：结构化分域——权限拒绝/限流/会话消失/命令失败/桥缺席 */
export type MediaControlResult =
  | { ok: true; status?: string }
  | { ok: false; code: 'media_permission_denied' | 'media_rate_limited' | 'media_session_gone' | 'media_command_failed' | 'media_unavailable'; message: string }

export interface MediaBrokerOptions {
  bridge: MediaBridgePort
  /** 授权账（缺省 = 无授权面：任何包都拿不到媒体数据） */
  authorization?: MediaAuthorizationPort | null
  /** 媒体审计（缺省 = 只供货不记账——生产必须装配，测试可为 null） */
  audit?: MediaAuditService | null
  log(event: Record<string, unknown>): void
  now?(): number
  /** 事件重取瀑布收敛窗（ms；缺省 50——爆发式事件合并成一轮 list） */
  refreshSettleMs?: number
  /** 快照序列化上限（media.read limits.snapshotBytes；缺省 64KB） */
  snapshotBytesLimit?: number
  /** 缩略图字节上限（缺省 2MB，ADR-0025 受控缩略图） */
  thumbnailMaxBytes?: number
}

/** 桥 status → 封闭词表（未知值 = UNKNOWN，不透传原串） */
const STATUS_WORDS = new Set(['CLOSED', 'OPENED', 'PAUSED', 'PLAYING', 'STOPPED', 'CHANGING'])
const THUMB_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const FIELD_STRING_MAX = 256
const GENRES_MAX = 8
/** media.read 契约上限（catalog limits.snapshotBytes 同源） */
const DEFAULT_SNAPSHOT_BYTES = 64 * 1024
const DEFAULT_THUMB_MAX_BYTES = 2 * 1024 * 1024

function asString(v: unknown, max = FIELD_STRING_MAX): string {
  if (typeof v !== 'string') return ''
  return v.length > max ? v.slice(0, max) : v
}

function asNumber(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function asBool(v: unknown): boolean {
  return v === true
}

/** 白名单投影：桥会话 → 脱敏 DTO（只取登记字段，其余一律丢弃） */
function sanitizeSession(raw: BridgeSessionSnapshot): SanitizedMediaSession {
  const media = (raw.media ?? {}) as Record<string, unknown>
  const timeline = (raw.timeline ?? {}) as Record<string, number>
  const caps = (raw.caps ?? {}) as Record<string, boolean>
  const rawGenres = Array.isArray(media.genres) ? media.genres.filter((g): g is string => typeof g === 'string') : []
  const status = typeof raw.status === 'string' && STATUS_WORDS.has(raw.status.toUpperCase()) ? raw.status.toUpperCase() : 'UNKNOWN'
  return {
    key: asString(raw.key, 300),
    aumid: typeof raw.aumid === 'string' && raw.aumid ? asString(raw.aumid, 300) : null,
    status,
    caps: {
      play: asBool(caps.play),
      pause: asBool(caps.pause),
      next: asBool(caps.next),
      previous: asBool(caps.previous),
      stop: asBool(caps.stop),
    },
    timeline: {
      positionMs: asNumber(timeline.positionMs),
      endTimeMs: asNumber(timeline.endTimeMs),
      minSeekMs: asNumber(timeline.minSeekMs),
      maxSeekMs: asNumber(timeline.maxSeekMs),
      lastUpdatedTimeMs: asNumber(timeline.lastUpdatedTimeMs),
    },
    media: {
      title: asString(media.title),
      artist: asString(media.artist),
      albumTitle: asString(media.albumTitle),
      subtitle: asString(media.subtitle),
      genres: rawGenres.slice(0, GENRES_MAX).map((g) => asString(g, 64)),
      trackNumber: asNumber(media.trackNumber),
      albumTrackCount: asNumber(media.albumTrackCount),
      thumbPresent: asBool(media.thumbPresent),
    },
  }
}

export class MediaBroker {
  private readonly opts: MediaBrokerOptions
  private readonly snapshotBytesLimit: number
  private readonly thumbnailMaxBytes: number
  private generation = 0
  private current: MediaSnapshotDTO = { generation: 0, available: false, selectedKey: null, sessions: [], controlGranted: false }
  private refreshTimer: NodeJS.Timeout | null = null
  private refreshing = false
  private refreshQueued = false
  private readonly snapshotListeners = new Set<(snap: MediaSnapshotDTO) => void>()
  private started = false

  constructor(opts: MediaBrokerOptions) {
    this.opts = opts
    this.snapshotBytesLimit = opts.snapshotBytesLimit ?? DEFAULT_SNAPSHOT_BYTES
    this.thumbnailMaxBytes = opts.thumbnailMaxBytes ?? DEFAULT_THUMB_MAX_BYTES
  }

  start(): void {
    if (this.started) return
    this.started = true
    this.opts.bridge.start()
    this.opts.bridge.onEvent(() => this.scheduleRefresh())
    this.opts.bridge.onAvailability((available) => {
      if (available) {
        this.scheduleRefresh()
      } else {
        this.opts.log({ type: 'media-bridge-down' })
        this.current = { generation: this.current.generation, available: false, selectedKey: null, sessions: [], controlGranted: false }
        this.notifySnapshot()
      }
    })
  }

  stop(): void {
    this.started = false
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = null
    this.opts.bridge.stop()
  }

  /** 当前脱敏快照（插件可见同形状；宿主投喂与诊断读数同源） */
  snapshot(): MediaSnapshotDTO {
    return this.current
  }

  /** 快照变化订阅（宿主据此向获批包重推 media 段；面板兜底 tick 另行） */
  onSnapshot(cb: (snap: MediaSnapshotDTO) => void): () => void {
    this.snapshotListeners.add(cb)
    return () => { this.snapshotListeners.delete(cb) }
  }

  private notifySnapshot(): void {
    for (const l of [...this.snapshotListeners]) {
      try { l(this.current) } catch { /* 监听器异常不连累 Broker */ }
    }
  }

  /** 事件 → 重取快照（t329：事件只作触发器；爆发式时延在瀑布里收敛成一轮 list） */
  private scheduleRefresh(): void {
    if (!this.started) return
    if (this.refreshing) {
      this.refreshQueued = true
      return
    }
    if (this.refreshTimer) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshNow()
    }, this.opts.refreshSettleMs ?? 50)
  }

  private async refreshNow(): Promise<void> {
    this.refreshing = true
    try {
      const out = await this.opts.bridge.list()
      if (!out.ok) {
        // 桥不可用/回复形状不符：available=false 明确态（不猜旧数据）
        this.opts.log({ type: 'media-list-failed', error: out.error })
        this.current = { generation: this.current.generation, available: false, selectedKey: null, sessions: [], controlGranted: false }
        this.notifySnapshot()
        return
      }
      this.adoptList(out.data)
    } finally {
      this.refreshing = false
      if (this.refreshQueued) {
        this.refreshQueued = false
        this.scheduleRefresh()
      }
    }
  }

  private adoptList(data: BridgeListData): void {
    const sessions = data.sessions
      .filter((s) => typeof s?.key === 'string' && s.key)
      .map(sanitizeSession)
    // 快照体积上限（media.read limits.snapshotBytes）：白名单+截断已结构性有界，
    // 仍超限的极端输入按会话逐个丢弃至合规（少给而非不给）
    let payload = this.buildSnapshot(true, data.currentKey, sessions)
    while (JSON.stringify(payload).length > this.snapshotBytesLimit && payload.sessions.length > 0) {
      payload = this.buildSnapshot(true, data.currentKey, payload.sessions.slice(0, -1))
    }
    this.generation += 1
    this.current = { ...payload, generation: this.generation }
    // 快照落账（工单336 排障：面板内 Broker 实际视图此前无观测点）
    this.opts.log({ type: 'media-snapshot-refreshed', generation: this.generation, sessions: payload.sessions.length, keys: payload.sessions.map((s) => s.key).join(','), selectedKey: payload.selectedKey })
    this.notifySnapshot()
  }

  private buildSnapshot(available: boolean, selectedKey: string | null, sessions: SanitizedMediaSession[]): MediaSnapshotDTO {
    // 默认选择策略（t329 拍板）：currentKey 非空优先 → 否则第一个会话 → null（UI 显式未选中）
    const selected = selectedKey && sessions.some((s) => s.key === selectedKey)
      ? selectedKey
      : sessions.length > 0 ? sessions[0].key : null
    return { generation: this.current.generation, available, selectedKey: selected, sessions, controlGranted: this.current.controlGranted ?? false }
  }

  /**
   * 授权门 + 快照投影：media.read 在账且未撤销 → media 段数据（宿主 capabilities 交集
   * 后投喂）；未授权 = null（宿主不投 media 段——投影之外是「不存在」）。同步查账，
   * 撤销即断供零窗口。
   */
  viewForPackage(packageId: string): { media: MediaSnapshotDTO } | null {
    const grant = this.opts.authorization?.activeGrant(packageId) ?? null
    this.opts.log({ type: 'media-view-probe', packageId, grantPerms: grant ? [...grant.permissions] : null, sessions: this.current.sessions.length, available: this.current.available })
    if (!grant || !grant.permissions.includes('media.read')) return null
    this.auditRecord(packageId, 'snapshot', null, 'ok')
    // 工单337：控制授权面随 DTO 投喂（卡片据此降级渲染——无 media.control = 只读态）
    const controlGranted = grant.permissions.includes('media.control')
    return { media: { ...this.current, controlGranted } }
  }

  /**
   * 媒体控制（工单337，media.control 可选权限）：授权门（denied 记账）→ 按包限流
   * （契约 commandsPerSecond=5，滚动窗）→ 桥 control（能力位检查+投递+真实结果复核在桥内）。
   * 错误分域：权限拒绝 / 限流 / 会话消失 / 命令失败——各不同码（ADR-0025）。
   */
  async controlForPackage(packageId: string, key: string, action: string): Promise<MediaControlResult> {
    const grant = this.opts.authorization?.activeGrant(packageId) ?? null
    if (!grant || !grant.permissions.includes('media.control')) {
      this.auditRecord(packageId, `control:${action}`, key, 'denied')
      return { ok: false, code: 'media_permission_denied', message: 'media.control 未授权（控制不付）' }
    }
    if (!this.controlRateOk(packageId)) {
      this.auditRecord(packageId, `control:${action}`, key, 'rate_limited')
      return { ok: false, code: 'media_rate_limited', message: '控制命令超过每包速率上限（5/s）——稍后重试' }
    }
    if (!this.opts.bridge.control) {
      this.auditRecord(packageId, `control:${action}`, key, 'unavailable')
      return { ok: false, code: 'media_unavailable', message: '桥面无 control 通道（桥未装配）' }
    }
    const out = await this.opts.bridge.control(key, action)
    if (!out.ok) {
      const gone = /gone|失效|invalid/i.test(out.error)
      const unsupported = /不支持|unsupported|not.*support/i.test(out.error)
      const code = gone ? 'media_session_gone' : unsupported ? 'media_command_failed' : 'media_unavailable'
      this.auditRecord(packageId, `control:${action}`, key, 'unavailable')
      return { ok: false, code, message: `控制未生效：${out.error}` }
    }
    this.auditRecord(packageId, `control:${action}`, key, 'ok')
    // 控制命令本身就是重取快照的触发器（t329：桥事件时延爆发式 17ms-6.4s，只等事件会让
    // 「控制→卡片状态翻转」迟到甚至落空）——投递复核已在桥内完成，这里随即重读 list。
    this.scheduleRefresh()
    const data = (out.data ?? {}) as { status?: unknown; statusAfter?: unknown }
    const rawStatus = data.statusAfter ?? data.status
    const status = typeof rawStatus === 'string' && STATUS_WORDS.has(rawStatus.toUpperCase()) ? rawStatus.toUpperCase() : undefined
    return { ok: true, status }
  }

  /** 按包控制限流（滚动 1s 窗，上限 5——契约 commandsPerSecond 同源） */
  private readonly controlWindows = new Map<string, number[]>()
  private controlRateOk(packageId: string): boolean {
    const now = Date.now()
    const win = (this.controlWindows.get(packageId) ?? []).filter((ts) => now - ts < 1000)
    if (win.length >= 5) { this.controlWindows.set(packageId, win); return false }
    win.push(now)
    this.controlWindows.set(packageId, win)
    return true
  }

  /**
   * 受控缩略图：授权门（denied 记账）→ 桥取字节副本（base64 已是复制值，无原生流）→
   * 类型（png/jpeg/webp）与大小（≤2MB）校验 → dataURL。校验拒付一个字节不出。
   */
  async thumbnailForPackage(packageId: string, key: string): Promise<MediaThumbnailResult> {
    const grant = this.opts.authorization?.activeGrant(packageId) ?? null
    if (!grant || !grant.permissions.includes('media.read')) {
      this.auditRecord(packageId, 'thumbnail', key, 'denied')
      return { ok: false, code: 'media_permission_denied', message: 'media.read 未授权（缩略图不付）' }
    }
    const out = await this.opts.bridge.thumb(key)
    if (!out.ok) {
      this.auditRecord(packageId, 'thumbnail', key, 'unavailable')
      const gone = /gone|失效|invalid/i.test(out.error)
      return gone
        ? { ok: false, code: 'media_session_gone', message: `目标媒体会话已消失：${out.error}` }
        : { ok: false, code: 'media_unavailable', message: `系统媒体会话不可用：${out.error}` }
    }
    const { contentType, readBytes, bytesBase64 } = out.data
    if (!THUMB_CONTENT_TYPES.has(contentType) || readBytes > this.thumbnailMaxBytes || readBytes <= 0) {
      this.auditRecord(packageId, 'thumbnail', key, 'unavailable')
      this.opts.log({ type: 'media-thumbnail-rejected', pkgId: packageId, contentType, readBytes })
      return { ok: false, code: 'media_thumbnail_rejected', message: `缩略图校验未通过（类型 ${contentType}、${readBytes} 字节）——一个字节不出` }
    }
    this.auditRecord(packageId, 'thumbnail', key, 'ok')
    return { ok: true, contentType, bytes: readBytes, dataUrl: `data:${contentType};base64,${bytesBase64}` }
  }

  /** 审计（缺省 = 不记账——生产装配必须给 MediaAuditService） */
  private auditRecord(packageId: string, kind: 'snapshot' | 'thumbnail' | `control:${string}`, sessionKey: string | null, outcome: 'ok' | 'denied' | 'unavailable' | 'rate_limited'): void {
    try {
      this.opts.audit?.record({ packageId, permission: kind.startsWith('control:') ? 'media.control' : 'media.read', kind, sessionKey, outcome })
    } catch { /* 审计失败不连累供货 */ }
  }
}

/** 生产桥客户端工厂（bridge-client 同文件导出的进程实现；装配层用） */
export function createProductionBridge(exePath: string, log: (event: Record<string, unknown>) => void): MediaBridgePort {
  return new MediaBridgeClient({ exePath, log })
}
