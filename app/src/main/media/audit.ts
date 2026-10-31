import fs from 'node:fs'
import path from 'node:path'

/**
 * 媒体审计（工单336，ADR-0025「媒体读取按包、权限和时间窗聚合审计，完整记录仅用户可见
 * 并保留 90 天」）：两层账。
 *
 * - **聚合桶**（可投影面）：键 = 包 + 权限 + 时间窗（默认 1h），计数按读取种类分列
 *   （snapshot / thumbnail），被拒与不可用的读取进 denied 计数（审计对失败读取不静默）。
 *   桶形状只有计数与键——**不含任何媒体元数据**（无曲名/无会话键/无 WinRT 概念）。
 * - **完整记录**（仅可信 UI 面）：逐笔存取（包/权限/种类/会话键/结果/时刻）落独立 JSONL
 *   （生产 = userData/media-audit.jsonl，**与控制面审计 DECK_EVENT_LOG 分离**），保留窗
 *   90 天（载入即修剪、推进过期度复查；修剪落事件留痕）。
 *
 * 每笔存取发 `media-audit-aggregate` 事件（经注入 log 出口落 DECK_EVENT_LOG 的权限审计
 * 族——事件里只有聚合桶，无完整记录内容）。
 *
 * 纯逻辑 + node:fs：无 Electron，Vitest 全覆盖。
 */

/** 完整存取记录（仅可信 UI 面；sessionKey = 带代次不透明会话键，snapshot 读取为 null） */
export interface MediaAccessRecord {
  at: number
  packageId: string
  permission: string
  kind: 'snapshot' | 'thumbnail' | `control:${string}`
  sessionKey?: string | null
  outcome: 'ok' | 'denied' | 'unavailable' | 'rate_limited'
}

/** 聚合桶（可投影面；键 = 包+权限+窗口起点，计数按种类分列） */
export interface MediaAuditBucket {
  packageId: string
  permission: string
  /** 窗口起点（ms epoch；对齐 windowMs） */
  windowStart: number
  windowMs: number
  counts: { snapshot: number; thumbnail: number } & Partial<Record<`control:${string}`, number>>
  /** 被拒（denied）与不可用（unavailable）的读取合计 */
  denied: number
}

export interface MediaAuditOptions {
  /** 完整记录文件（JSONL；生产 = userData/media-audit.jsonl） */
  file: string
  /** 聚合时间窗宽（ms；默认 1h） */
  windowMs?: number
  /** 完整记录保留窗（ms；默认 90 天——票面硬约束） */
  retentionMs?: number
  now(): number
  log(event: Record<string, unknown>): void
}

const DEFAULT_WINDOW_MS = 3_600_000
const DEFAULT_RETENTION_MS = 90 * 24 * 3_600_000

function coerceRecord(raw: unknown): MediaAccessRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.at !== 'number') return null
  if (typeof r.packageId !== 'string' || !r.packageId) return null
  if (typeof r.permission !== 'string' || !r.permission) return null
  if (r.kind !== 'snapshot' && r.kind !== 'thumbnail') return null
  if (r.outcome !== 'ok' && r.outcome !== 'denied' && r.outcome !== 'unavailable') return null
  const sessionKey = typeof r.sessionKey === 'string' ? r.sessionKey : null
  return { at: r.at, packageId: r.packageId, permission: r.permission, kind: r.kind, sessionKey, outcome: r.outcome }
}

export class MediaAuditService {
  private readonly opts: MediaAuditOptions
  private readonly windowMs: number
  private readonly retentionMs: number
  /** 完整记录（保留窗内的内存镜像；聚合桶按需现算——桶是投影不是账本） */
  private records: MediaAccessRecord[] = []
  private lastPruneAt = 0

  constructor(opts: MediaAuditOptions) {
    this.opts = opts
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS
    this.load()
  }

  /** 跨重启重载：坏行跳过、超保留窗行修剪（硬约束在载入即兑现） */
  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.opts.file, 'utf8')
    } catch {
      return // 首启动无账
    }
    const loaded: MediaAccessRecord[] = []
    for (const line of raw.split('\n')) {
      const t = line.trim()
      if (!t) continue
      try {
        const rec = coerceRecord(JSON.parse(t))
        if (rec) loaded.push(rec)
      } catch { /* 坏行跳过 */ }
    }
    const cutoff = this.opts.now() - this.retentionMs
    const kept = loaded.filter((r) => r.at >= cutoff)
    if (kept.length !== loaded.length) {
      this.rewrite(kept)
      this.opts.log({ type: 'media-audit-pruned', dropped: loaded.length - kept.length, kept: kept.length })
    }
    this.records = kept
    this.lastPruneAt = this.opts.now()
  }

  /** 全量重写（只在修剪时发生；日常追加走 append 不重写） */
  private rewrite(records: MediaAccessRecord[]): void {
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
    fs.writeFileSync(this.opts.file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8')
  }

  /** 窗口起点对齐（固定窗口不随首次读取漂移） */
  private windowStartOf(at: number): number {
    return Math.floor(at / this.windowMs) * this.windowMs
  }

  /**
   * 记一笔存取：完整记录追加落盘 → 过保留窗复查（每窗一次）→ 返回当前聚合桶 +
   * 落 `media-audit-aggregate` 事件（DECK_EVENT_LOG 权限审计族出口，只有桶形状）。
   */
  record(access: { packageId: string; permission: string; kind: MediaAccessRecord['kind']; sessionKey?: string | null; outcome: MediaAccessRecord['outcome'] }): MediaAuditBucket {
    const rec: MediaAccessRecord = {
      at: this.opts.now(),
      packageId: access.packageId,
      permission: access.permission,
      kind: access.kind,
      sessionKey: access.sessionKey ?? null,
      outcome: access.outcome,
    }
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
      fs.appendFileSync(this.opts.file, JSON.stringify(rec) + '\n', 'utf8')
    } catch (err) {
      this.opts.log({ type: 'media-audit-write-failed', message: err instanceof Error ? err.message : String(err) })
    }
    this.records.push(rec)
    // 过保留窗复查：至多每窗一次全量修剪（90 天硬约束的推进兑现）
    if (this.opts.now() - this.lastPruneAt >= this.windowMs) {
      const cutoff = this.opts.now() - this.retentionMs
      const kept = this.records.filter((r) => r.at >= cutoff)
      if (kept.length !== this.records.length) {
        this.records = kept
        this.rewrite(kept)
        this.opts.log({ type: 'media-audit-pruned', dropped: this.records.length - kept.length, kept: kept.length })
      }
      this.lastPruneAt = this.opts.now()
    }
    const bucket = this.bucketOf(rec.packageId, rec.permission, rec.at)
    this.opts.log({
      type: 'media-audit-aggregate',
      packageId: bucket.packageId,
      permission: bucket.permission,
      windowStart: bucket.windowStart,
      windowMs: bucket.windowMs,
      counts: { ...bucket.counts },
      denied: bucket.denied,
    })
    return bucket
  }

  /** 单键当前桶（record 的返回值语义；无记录 = 空桶） */
  private bucketOf(packageId: string, permission: string, at: number): MediaAuditBucket {
    const windowStart = this.windowStartOf(at)
    const bucket: MediaAuditBucket = {
      packageId, permission, windowStart, windowMs: this.windowMs,
      counts: { snapshot: 0, thumbnail: 0 }, denied: 0,
    }
    for (const r of this.records) {
      if (r.packageId !== packageId || r.permission !== permission) continue
      if (this.windowStartOf(r.at) !== windowStart) continue
      if (r.outcome === 'ok') {
        if (r.kind.startsWith('control:')) {
          const ck = r.kind as 'control:play'
          bucket.counts[ck] = (bucket.counts[ck] ?? 0) + 1
        } else {
          bucket.counts[r.kind] += 1
        }
      }
      else bucket.denied += 1
    }
    return bucket
  }

  /** 全量聚合投影（可投影面：只有键与计数；按窗口起点排序稳定） */
  aggregate(): MediaAuditBucket[] {
    const byKey = new Map<string, MediaAuditBucket>()
    for (const r of this.records) {
      const windowStart = this.windowStartOf(r.at)
      const key = `${r.packageId}|${r.permission}|${windowStart}`
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { packageId: r.packageId, permission: r.permission, windowStart, windowMs: this.windowMs, counts: { snapshot: 0, thumbnail: 0 }, denied: 0 }
        byKey.set(key, bucket)
      }
      if (r.outcome === 'ok') {
        if (r.kind.startsWith('control:')) {
          const ck = r.kind as 'control:play'
          bucket.counts[ck] = (bucket.counts[ck] ?? 0) + 1
        } else {
          bucket.counts[r.kind] += 1
        }
      }
      else bucket.denied += 1
    }
    return [...byKey.values()].sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : a.windowStart - b.windowStart))
  }
}
