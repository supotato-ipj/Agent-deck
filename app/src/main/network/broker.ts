import http from 'node:http'
import https from 'node:https'
import { originGranted, originOfRequestUrl } from './origin'
import type { NetworkAuditService } from './audit'

/**
 * 网络 Broker（工单338，ADR-0025 网络节）：面板主进程内的权限/上限/审计层。
 *
 * - **逐包 origin 授权**：每次请求前同步查授权账（network.request 在账、未撤销、且请求
 *   origin 精确命中授予集）——命中不了即 `network_permission_denied`，一个字节不出；
 *   撤销即断供零窗口（账撤销先于 rescan 停用缝）。
 * - **有界请求-响应**：只做 HTTP(S) 请求-响应（无 WebSocket/原始 TCP/永久流）；每包速率
 *   窗（requestsPerSecond）、并发上限（maxConcurrent）、单请求超时（timeoutMs）、响应
 *   字节上限（maxResponseBytes，超出按键截断并如实标记 truncated）。限流 / 权限拒绝 /
 *   目标失效是**不同错误码**。
 * - **不自动跟随重定向**：3xx 一律返回结构化 `network_redirect_blocked` + 目标 origin，
 *   由包显式决定是否对新 origin 单独请求（新 origin 同样要过授权门）。
 * - **宿主代理面**：包页自己的 fetch/XHR 仍被 session 级 webRequest + CSP 全拒；放行只经
 *   `deckHost.network.request` → 宿主 IPC → 本 Broker。
 * - **审计脱敏**：逐笔记录 origin/方法/结果码/状态/重定向目标，不含请求头、正文、query。
 *
 * 传输边缘（httpRequest）可注入——Vitest 用本地 http server 真测（无公网依赖），错误路径
 * 用 fake 端口覆盖。
 */

/** 请求说明（包侧可给的全部意图；其余一律由 Broker 决定） */
export interface NetworkRequestSpec {
  url: string
  method?: string
  /** 允许头白名单（accept / content-type）——其余头（authorization/cookie/host 等）直接丢弃 */
  headers?: Record<string, string>
  /** 文本请求体（GET/HEAD 忽略） */
  body?: string
  /**
   * 工单339：命名凭证（只给名字，不给值）——必须已由可信 UI 绑定到「本包 + 本 origin」，
   * 否则 `credential_unavailable`（不静默改用其他凭证）；注入头由凭证元数据决定。
   */
  credential?: string
}

export type NetworkErrorCode =
  | 'network_permission_denied'
  | 'network_rate_limited'
  | 'network_timeout'
  | 'network_redirect_blocked'
  | 'network_failed'
  /** 工单339：命名凭证明细面（不存在/未绑定本包本 origin/密文不可解）——与网络权限无关 */
  | 'credential_unavailable'

export type NetworkResult =
  | {
    ok: true
    status: number
    origin: string
    method: string
    contentType: string
    bytes: number
    truncated: boolean
    /** 文本类型（text/*、application/json、*+json 等）→ 文本正文 */
    text?: string
    /** 其余类型 → base64 字节副本 */
    base64?: string
  }
  | { ok: false; code: NetworkErrorCode; message: string; origin: string; method: string; status?: number; location?: string }

/** 命名凭证端口（工单339：只给「该包在该 origin 上可用的注入头」，不给枚举面） */
export interface CredentialResolverPort {
  resolve(packageId: string, credentialName: string, origin: string): { ok: true; headerName: string; value: string } | { ok: false; code: 'credential_unavailable'; message: string }
}

/** 授权账端口（Broker 只依赖查询面） */
export interface NetworkAuthorizationPort {
  activeGrant(packageId: string): { permissions: readonly string[]; networkOrigins?: readonly string[] } | null
}

export interface NetworkLimits {
  requestsPerSecond: number
  maxConcurrent: number
  timeoutMs: number
  maxResponseBytes: number
}

export interface NetworkRawReply {
  status: number
  headers: Record<string, string | string[] | undefined>
  /** 正文（有界；超出上限由传输层截断并置 truncated） */
  body: Buffer
  truncated: boolean
}

/** 传输端口（生产 = node http/https；测试 fake 覆盖错误路径） */
export interface NetworkTransportPort {
  send(spec: { url: URL; method: string; headers: Record<string, string>; body?: Buffer; timeoutMs: number; maxBytes: number }): Promise<NetworkRawReply>
}

export interface NetworkBrokerOptions {
  authorization?: NetworkAuthorizationPort | null
  /** 工单339：命名凭证解析（缺省 = 无凭证面，请求带 credential 一律 credential_unavailable） */
  credentials?: CredentialResolverPort | null
  audit?: NetworkAuditService | null
  log(event: Record<string, unknown>): void
  limits?: Partial<NetworkLimits>
  transport?: NetworkTransportPort
  now?(): number
}

/** 契约上限（catalog permissions[network.request].limits 同源：5/s、并发 2、10s、2MB） */
const DEFAULT_LIMITS: NetworkLimits = { requestsPerSecond: 5, maxConcurrent: 2, timeoutMs: 10_000, maxResponseBytes: 2 * 1024 * 1024 }
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])
/** 允许包自带的请求头（其余一律丢弃——凭证注入归 #339，包不能自设 authorization/cookie） */
const ALLOWED_HEADERS = new Set(['accept', 'content-type'])

function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase()
  if (ct.startsWith('text/')) return true
  if (ct.includes('json') || ct.includes('xml') || ct.includes('javascript')) return true
  if (ct.includes('x-www-form-urlencoded')) return true
  return false
}

/** 生产传输：node http/https（redirect 不跟随；响应按键截断；超时即销毁） */
export function createNodeTransport(): NetworkTransportPort {
  return {
    send({ url, method, headers, body, timeoutMs, maxBytes }) {
      return new Promise<NetworkRawReply>((resolve, reject) => {
        const mod = url.protocol === 'https:' ? https : http
        let settled = false
        const done = (fn: () => void) => {
          if (settled) return
          settled = true
          fn()
        }
        const req = mod.request(url, { method, headers }, (res) => {
          const chunks: Buffer[] = []
          let total = 0
          let truncated = false
          res.on('data', (chunk: Buffer) => {
            if (truncated) return
            const room = maxBytes - total
            if (chunk.length > room) {
              if (room > 0) {
                chunks.push(chunk.subarray(0, room))
                total += room
              }
              truncated = true
              // 有界：达到上限即停止读取并销毁连接（不把无界响应读进内存）
              res.destroy()
              done(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated }))
              return
            }
            chunks.push(chunk)
            total += chunk.length
          })
          res.on('end', () => done(() => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), truncated })))
          res.on('error', (err) => done(() => reject(err)))
        })
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
        })
        req.on('error', (err) => done(() => reject(err)))
        if (body) req.write(body)
        req.end()
      })
    },
  }
}

export class NetworkBroker {
  private readonly opts: NetworkBrokerOptions
  private readonly limits: NetworkLimits
  private readonly transport: NetworkTransportPort
  private readonly rateWindows = new Map<string, number[]>()
  private readonly inflight = new Map<string, number>()

  constructor(opts: NetworkBrokerOptions) {
    this.opts = opts
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
    this.transport = opts.transport ?? createNodeTransport()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** 按包速率窗（滚动 1s，上限 requestsPerSecond） */
  private rateOk(packageId: string): boolean {
    const now = this.now()
    const win = (this.rateWindows.get(packageId) ?? []).filter((ts) => now - ts < 1000)
    if (win.length >= this.limits.requestsPerSecond) {
      this.rateWindows.set(packageId, win)
      return false
    }
    win.push(now)
    this.rateWindows.set(packageId, win)
    return true
  }

  private audit(rec: {
    packageId: string
    origin: string
    method: string
    outcome: 'ok' | 'denied' | 'error'
    code?: string
    status?: number
    redirectTo?: string
  }): void {
    try {
      this.opts.audit?.record(rec)
    } catch { /* 审计失败不连累请求 */ }
  }

  async requestForPackage(packageId: string, spec: NetworkRequestSpec): Promise<NetworkResult> {
    const rawUrl = typeof spec?.url === 'string' ? spec.url : ''
    const method = String(spec?.method ?? 'GET').trim().toUpperCase() || 'GET'
    const originCheck = originOfRequestUrl(rawUrl)
    if (!originCheck.ok) {
      const origin = (() => {
        try { return new URL(rawUrl).origin } catch { return '(invalid)' }
      })()
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_failed' })
      return { ok: false, code: 'network_failed', message: originCheck.message, origin, method }
    }
    const origin = originCheck.origin
    // 授权门：network.request 在账 + 精确 origin 命中（未授权 origin 默认拒绝）
    const grant = this.opts.authorization?.activeGrant(packageId) ?? null
    if (!grant || !grant.permissions.includes('network.request') || !originGranted(grant.networkOrigins, origin)) {
      this.audit({ packageId, origin, method, outcome: 'denied', code: 'network_permission_denied' })
      return { ok: false, code: 'network_permission_denied', message: `origin 未获授权（network.request 缺失或 ${origin} 不在授予集）——请求不付`, origin, method }
    }
    if (!ALLOWED_METHODS.has(method)) {
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_failed' })
      return { ok: false, code: 'network_failed', message: `方法不支持：${method}（允许 GET/POST/PUT/PATCH/DELETE/HEAD）`, origin, method }
    }
    // 并发上限（与权限拒绝分域的限额错误）
    const live = this.inflight.get(packageId) ?? 0
    if (live >= this.limits.maxConcurrent) {
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_rate_limited' })
      return { ok: false, code: 'network_rate_limited', message: `并发上限（${this.limits.maxConcurrent}）已满——稍后重试`, origin, method }
    }
    if (!this.rateOk(packageId)) {
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_rate_limited' })
      return { ok: false, code: 'network_rate_limited', message: `超过每包速率上限（${this.limits.requestsPerSecond}/s）——稍后重试`, origin, method }
    }
    // 头白名单（其余丢弃：包不能自设凭证/主机头）
    const headers: Record<string, string> = { accept: '*/*' }
    const requestedHeaders = (spec?.headers ?? {}) as Record<string, unknown>
    for (const [k, v] of Object.entries(requestedHeaders)) {
      if (!ALLOWED_HEADERS.has(k.toLowerCase())) continue
      if (typeof v === 'string') headers[k.toLowerCase()] = v.slice(0, 1024)
    }
    // 工单339：命名凭证注入——在包自带头被白名单丢弃之后做（包不能覆盖/窥探注入头）；
    // 只在管理面已批准绑定「本包 + 本 origin」时注入，否则结构化 credential_unavailable。
    const credentialName = typeof spec?.credential === 'string' ? spec.credential : ''
    if (credentialName) {
      const resolved = this.opts.credentials?.resolve(packageId, credentialName, origin) ?? null
      if (!resolved || resolved.ok !== true) {
        const message = resolved ? resolved.message : '凭证面未装配'
        // 审计只记「凭证不可用」这一结果，不记凭证名细节以外的任何内容（无 secret）
        this.audit({ packageId, origin, method, outcome: 'error', code: 'credential_unavailable' })
        return { ok: false, code: 'credential_unavailable', message, origin, method }
      }
      headers[resolved.headerName] = resolved.value
    }
    const bodyText = typeof spec?.body === 'string' ? spec.body : undefined
    const body = bodyText !== undefined && method !== 'GET' && method !== 'HEAD' ? Buffer.from(bodyText, 'utf8') : undefined
    if (body) headers['content-length'] = String(body.length)

    this.inflight.set(packageId, live + 1)
    let reply: NetworkRawReply
    try {
      reply = await this.transport.send({
        url: new URL(rawUrl),
        method,
        headers,
        ...(body ? { body } : {}),
        timeoutMs: this.limits.timeoutMs,
        maxBytes: this.limits.maxResponseBytes,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const timedOut = /超时|timeout|ETIMEDOUT|aborted/i.test(message)
      const code: NetworkErrorCode = timedOut ? 'network_timeout' : 'network_failed'
      this.audit({ packageId, origin, method, outcome: 'error', code })
      return { ok: false, code, message: `请求未完成：${message}`, origin, method }
    } finally {
      const left = (this.inflight.get(packageId) ?? 1) - 1
      if (left <= 0) this.inflight.delete(packageId)
      else this.inflight.set(packageId, left)
    }

    // 3xx：不自动跟随（跨 origin 尤其）——结构化返回目标 origin，新 origin 需单独授权
    if (reply.status >= 300 && reply.status < 400) {
      const rawLocation = reply.headers.location
      const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
      let redirectOrigin = ''
      try {
        redirectOrigin = location ? new URL(location, rawUrl).origin : ''
      } catch { redirectOrigin = '' }
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_redirect_blocked', status: reply.status, ...(redirectOrigin ? { redirectTo: redirectOrigin } : {}) })
      return {
        ok: false,
        code: 'network_redirect_blocked',
        message: `重定向不自动跟随（HTTP ${reply.status}${redirectOrigin ? ` → ${redirectOrigin}` : ''}）：如需访问该 origin，请单独发起请求并先取得授权`,
        origin,
        method,
        status: reply.status,
        ...(location ? { location: String(location).slice(0, 512) } : {}),
      }
    }

    const contentTypeRaw = reply.headers['content-type']
    const contentType = (Array.isArray(contentTypeRaw) ? contentTypeRaw[0] : contentTypeRaw) ?? ''
    this.audit({ packageId, origin, method, outcome: 'ok', status: reply.status })
    const base: Omit<Extract<NetworkResult, { ok: true }>, 'text' | 'base64'> = {
      ok: true,
      status: reply.status,
      origin,
      method,
      contentType,
      bytes: reply.body.length,
      truncated: reply.truncated,
    }
    return isTextual(contentType)
      ? { ...base, text: reply.body.toString('utf8') }
      : { ...base, base64: reply.body.toString('base64') }
  }
}
