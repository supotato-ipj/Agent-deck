import fs from 'node:fs'
import path from 'node:path'

/**
 * 网络审计（工单338，ADR-0025「审计记录 origin/方法/结果/重定向目标，不含完整载荷」）：
 * 与媒体审计同构的两层账。
 *
 * - **完整记录**（仅可信 UI 面）：逐笔请求（包 / 权限 / origin / 方法 / 结果码 / 跨域重定向
 *   目标 / 时刻）落独立 JSONL（生产 = userData/network-audit.jsonl，与控制面审计分离），
 *   保留窗 90 天（载入即修剪、推进过期度复查）。
 * - **聚合桶**（可投影面）：键 = 包 + 权限 + 时间窗，计数分 request / redirect，被拒进
 *   denied，另记本窗出现过的 origin 集合。
 *
 * **脱敏红线**：不发请求头、不发正文、不发 query（URL 查询串可能携带敏感参数）、不发
 * 凭证——记录里只有 origin（scheme://host[:port]）与路径安全的元数据。跨域重定向只记
 * 目标 origin（不跟随、不转发）。
 *
 * 每笔请求发 `network-audit-aggregate` 事件（经注入 log 出口落 DECK_EVENT_LOG 权限审计族），
 * 事件里只有聚合桶。
 *
 * 纯逻辑 + node:fs：无 Electron，Vitest 全覆盖。
 */

/** 完整请求记录（仅可信 UI 面；不含请求头/正文/query） */
export interface NetworkAccessRecord {
  at: number
  packageId: string
  permission: string
  kind: 'request'
  origin: string
  method: string
  outcome: 'ok' | 'denied' | 'error'
  /** 结构化结果码（ok 时可选；error/denied 时在案） */
  code?: string
  /** HTTP 状态码（有响应时） */
  status?: number
  /** 跨域重定向目标 origin（不跟随；只记目标 origin，不记完整 URL） */
  redirectTo?: string
}

/** 聚合桶（可投影面；键 = 包+权限+窗口起点） */
export interface NetworkAuditBucket {
  packageId: string
  permission: string
  windowStart: number
  windowMs: number
  counts: { request: number; redirect: number }
  denied: number
  /** 本窗出现过的 origin（排序稳定；不含路径与 query） */
  origins: string[]
}

export interface NetworkAuditOptions {
  file: string
  windowMs?: number
  retentionMs?: number
  now(): number
  log(event: Record<string, unknown>): void
}

const DEFAULT_WINDOW_MS = 3_600_000
const DEFAULT_RETENTION_MS = 90 * 24 * 3_600_000

function coerceRecord(raw: unknown): NetworkAccessRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.at !== 'number') return null
  if (typeof r.packageId !== 'string' || !r.packageId) return null
  if (typeof r.permission !== 'string' || !r.permission) return null
  if (r.kind !== 'request') return null
  if (typeof r.origin !== 'string' || !r.origin) return null
  if (typeof r.method !== 'string' || !r.method) return null
  if (r.outcome !== 'ok' && r.outcome !== 'denied' && r.outcome !== 'error') return null
  return {
    at: r.at,
    packageId: r.packageId,
    permission: r.permission,
    kind: 'request',
    origin: r.origin,
    method: r.method,
    outcome: r.outcome,
    ...(typeof r.code === 'string' ? { code: r.code } : {}),
    ...(typeof r.status === 'number' ? { status: r.status } : {}),
    ...(typeof r.redirectTo === 'string' ? { redirectTo: r.redirectTo } : {}),
  }
}

export class NetworkAuditService {
  private readonly opts: NetworkAuditOptions
  private readonly windowMs: number
  private readonly retentionMs: number
  private records: NetworkAccessRecord[] = []
  private lastPruneAt = 0

  constructor(opts: NetworkAuditOptions) {
    this.opts = opts
    this.windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS
    this.load()
  }

  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.opts.file, 'utf8')
    } catch {
      return
    }
    const loaded: NetworkAccessRecord[] = []
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
      this.opts.log({ type: 'network-audit-pruned', dropped: loaded.length - kept.length, kept: kept.length })
    }
    this.records = kept
    this.lastPruneAt = this.opts.now()
  }

  private rewrite(records: NetworkAccessRecord[]): void {
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
    fs.writeFileSync(this.opts.file, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8')
  }

  private windowStartOf(at: number): number {
    return Math.floor(at / this.windowMs) * this.windowMs
  }

  /** 记一笔请求：完整记录追加落盘 → 过保留窗复查（每窗一次）→ 返回聚合桶 + 落事件 */
  record(access: {
    packageId: string
    permission?: string
    origin: string
    method: string
    outcome: NetworkAccessRecord['outcome']
    code?: string
    status?: number
    redirectTo?: string
  }): NetworkAuditBucket {
    const rec: NetworkAccessRecord = {
      at: this.opts.now(),
      packageId: access.packageId,
      permission: access.permission ?? 'network.request',
      kind: 'request',
      origin: access.origin,
      method: access.method,
      outcome: access.outcome,
      ...(access.code ? { code: access.code } : {}),
      ...(typeof access.status === 'number' ? { status: access.status } : {}),
      ...(access.redirectTo ? { redirectTo: access.redirectTo } : {}),
    }
    try {
      fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
      fs.appendFileSync(this.opts.file, JSON.stringify(rec) + '\n', 'utf8')
    } catch (err) {
      this.opts.log({ type: 'network-audit-write-failed', message: err instanceof Error ? err.message : String(err) })
    }
    this.records.push(rec)
    if (this.opts.now() - this.lastPruneAt >= this.windowMs) {
      const cutoff = this.opts.now() - this.retentionMs
      const kept = this.records.filter((r) => r.at >= cutoff)
      if (kept.length !== this.records.length) {
        this.records = kept
        this.rewrite(kept)
        this.opts.log({ type: 'network-audit-pruned', dropped: this.records.length - kept.length, kept: kept.length })
      }
      this.lastPruneAt = this.opts.now()
    }
    const bucket = this.bucketOf(rec.packageId, rec.permission, rec.at)
    this.opts.log({
      type: 'network-audit-aggregate',
      packageId: bucket.packageId,
      permission: bucket.permission,
      windowStart: bucket.windowStart,
      windowMs: bucket.windowMs,
      counts: { ...bucket.counts },
      denied: bucket.denied,
      origins: [...bucket.origins],
    })
    return bucket
  }

  private bucketOf(packageId: string, permission: string, at: number): NetworkAuditBucket {
    const windowStart = this.windowStartOf(at)
    const bucket: NetworkAuditBucket = {
      packageId, permission, windowStart, windowMs: this.windowMs,
      counts: { request: 0, redirect: 0 }, denied: 0, origins: [],
    }
    const origins = new Set<string>()
    for (const r of this.records) {
      if (r.packageId !== packageId || r.permission !== permission) continue
      if (this.windowStartOf(r.at) !== windowStart) continue
      origins.add(r.origin)
      if (r.outcome === 'ok') bucket.counts.request += 1
      else if (r.code === 'network_redirect_blocked') bucket.counts.redirect += 1
      else bucket.denied += 1
    }
    bucket.origins = [...origins].sort()
    return bucket
  }

  aggregate(): NetworkAuditBucket[] {
    const byKey = new Map<string, NetworkAuditBucket>()
    for (const r of this.records) {
      const windowStart = this.windowStartOf(r.at)
      const key = `${r.packageId}|${r.permission}|${windowStart}`
      let bucket = byKey.get(key)
      if (!bucket) {
        bucket = { packageId: r.packageId, permission: r.permission, windowStart, windowMs: this.windowMs, counts: { request: 0, redirect: 0 }, denied: 0, origins: [] }
        byKey.set(key, bucket)
      }
      bucket.origins.push(r.origin)
      if (r.outcome === 'ok') bucket.counts.request += 1
      else if (r.code === 'network_redirect_blocked') bucket.counts.redirect += 1
      else bucket.denied += 1
    }
    for (const b of byKey.values()) b.origins = [...new Set(b.origins)].sort()
    return [...byKey.values()].sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : a.windowStart - b.windowStart))
  }
}
