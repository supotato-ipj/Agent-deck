/**
 * 搜索引擎逻辑（工单07，listary_engine.py 的 TS 平移）：防抖、请求构造、
 * 响应解析、错误分类、限流退避——纯逻辑，不依赖网络与 Electron（离线可测）。
 * HTTP 传输在 client.ts（唯一 I/O）；引擎选择装配在 selector.ts。
 * Listary API 仅监听 127.0.0.1、只读、无 keep-alive，每次请求新建连接、用完即关。
 * 契约见 .scratch/listary-search/spec.md（规格源：Listary 7 应用内 HTTP API 对话框）。
 */
import type { SearchResultItem } from '../../shared/contract'

export const DEFAULT_DEBOUNCE_MS = 200
export const DEFAULT_LIMIT = 8
export const MAX_BACKOFF_MS = 5000
export const OFFLINE_RETRY_MS = 3000

export const BASE_HOST = '127.0.0.1'
export const BASE_PORT = 38431
export const SEARCH_PATH = '/api/v1/search'
export const HTTP_TIMEOUT_MS = 3000

/**
 * Everything 1.5a + http_server 插件（voidtools/http_server）：GET JSON 搜索后端。
 * 移植自 feat/fullscreen-hud a7bd4ad 的 Python 语义；响应归一化成 Listary ok 载荷
 * 形状——parseResponse/classifyFailure 与整个面板零改动。
 */
export const EVERYTHING_DEFAULT_PORT = 80
export const EVERYTHING_TIMEOUT_MS = 2000

/** 搜索引擎选择（config.json search.engine）：显式锁定 everything/listary；
 * auto = 一次可达性探测（探测语义在后续工单接入，过渡期回落 listary） */
export type SearchEngineChoice = 'auto' | 'everything' | 'listary'

export const ERR_RATE_LIMITED = 'TOO_MANY_REQUESTS'
export const ERR_UNAVAILABLE = 'SEARCH_UNAVAILABLE'

/** 引擎不可达（连接失败/超时）：classifyFailure 映射 offline 的唯一异常形态 */
export class ListaryNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ListaryNetworkError'
  }
}

/** 时间可注入的输入防抖：窗口内连续变更只放行最后一次，且不重发同词。 */
export class Debouncer {
  private pending: { query: string; at: number } | null = null
  private lastSent: string | null = null

  constructor(readonly windowMs = DEFAULT_DEBOUNCE_MS) {}

  feed(query: string, now: number): void {
    if (!query) {
      this.pending = null
      return
    }
    this.pending = { query, at: now }
  }

  due(now: number): string | null {
    if (!this.pending) return null
    const { query, at } = this.pending
    // 时钟差加微小容差，避免 0.30-0.10=0.199… 这类边界永不达标（Python 先例）
    if (now - at + 1e-9 < this.windowMs || query === this.lastSent) return null
    this.pending = null
    this.lastSent = query
    return query
  }

  /** 立即到期且允许重发同词（引擎离线/限流重试用）：绕过防抖窗口并清除同词去重。 */
  feedDue(query: string): void {
    if (!query) return
    this.pending = { query, at: -1e18 }
    this.lastSent = null
  }

  cancel(): void {
    this.pending = null
  }

  /** 退待机时调用：下次激活允许重发同一个词。 */
  reset(): void {
    this.pending = null
    this.lastSent = null
  }
}

export function buildRequest(query: string, limit = DEFAULT_LIMIT, offset = 0): { query: string; limit: number; offset: number } {
  return { query, limit, offset }
}

export interface SearchResults {
  total: number
  items: SearchResultItem[]
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** ok 载荷 → 结果模型；异常结构一律退化为空结果而非崩溃。 */
export function parseResponse(payload: unknown): SearchResults {
  const root = asRecord(payload)
  const data = root ? asRecord(root.data) : null
  if (!data) return { total: 0, items: [] }
  const items: SearchResultItem[] = []
  const rows = Array.isArray(data.results) ? data.results : []
  for (const row of rows) {
    const r = asRecord(row)
    if (!r) continue
    items.push({
      path: String(r.path ?? ''),
      name: String(r.name ?? ''),
      type: String(r.type ?? 'file'),
      sizeBytes: Number(r.size_bytes ?? 0) || 0,
      modifiedAt: String(r.modified_at ?? ''),
      score: Number(r.score ?? 0) || 0,
    })
  }
  return { total: Number(data.total ?? 0) || 0, items }
}

/**
 * Everything JSON → Listary ok 载荷形状（工单13，Python normalize_everything 平移）：
 * path+name 反斜杠拼全路径、type 非 folder 一律 file、size 字符串数字容错、
 * totalResults → data.total；坏行跳过、缺失字段补默认。非对象载荷抛 TypeError
 * （→ error，不冒充离线）。产物直接喂 parseResponse/classifyFailure，面板零改动。
 */
export function everythingNormalize(payload: unknown): unknown {
  const root = asRecord(payload)
  if (!root) throw new TypeError(`unexpected payload type: ${typeof payload}`)
  const results: Array<Record<string, unknown>> = []
  const rows = Array.isArray(root.results) ? root.results : []
  for (const row of rows) {
    const r = asRecord(row)
    if (!r) continue
    const path = String(r.path ?? '')
    const name = String(r.name ?? '')
    if (!path && !name) continue // 无名无径的行无展示价值，按坏行跳过
    const type = String(r.type ?? 'file')
    results.push({
      path: path && name ? `${path}\\${name}` : path || name,
      name,
      type: type === 'folder' ? 'folder' : 'file',
      size_bytes: Number(String(r.size ?? 0)) || 0,
    })
  }
  return { ok: true, data: { total: Number(root.totalResults ?? 0) || 0, results } }
}

export type FailureKind = 'offline' | 'rate_limited' | 'error'
/** 连接异常 / 错误载荷 → offline | rate_limited | error；ok 载荷返回 null。
 * offline 只表示「引擎不可达或未就绪」（网络失败 / SEARCH_UNAVAILABLE）；
 * 引擎在线但行为异常（非法 JSON、未知错误码）归 error，不冒充离线。 */
export function classifyFailure(failure: unknown): FailureKind | null {
  if (failure instanceof ListaryNetworkError) return 'offline'
  const rec = asRecord(failure)
  if (rec) {
    if (rec.ok) return null
    if (rec.error === ERR_RATE_LIMITED) return 'rate_limited'
    if (rec.error === ERR_UNAVAILABLE) return 'offline'
    return 'error'
  }
  return 'error'
}

/** 限流退避：0.5s 起步倍增，封顶 5s。attempt 从 1 计。 */
export function backoffDelay(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), MAX_BACKOFF_MS)
}
