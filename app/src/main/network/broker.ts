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
 * - **重定向有界跟随（工单347）**：同 origin（`URL.origin` 精确相等，复用 origin.ts 口径）
 *   的 3xx 由 Broker 有界代为跟随——仅 GET/HEAD，最多 `maxRedirects` 跳（缺省 3，可按包收紧
 *   不可放宽）；每跳重过授权门、计一个速率额度、一条审计、独立 timeoutMs，凭证按「同包 +
 *   本 origin」重新解析注入；整链占 1 个并发槽。跨 origin 与无可用 location 的 3xx 不跟随，
 *   一律结构化 `network_redirect_blocked` + 目标 origin，由包显式决定是否单独请求（新 origin
 *   同样要过授权门）；跳满上限仍在 3xx → 结构化 `network_redirect_limit`（带最后已知 location）。
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
  /** 工单347：同 origin 跟随跳满 maxRedirects 上限仍在 3xx——停止跟随并带最后已知 location */
  | 'network_redirect_limit'
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
    /** 工单347：同 origin 跟随跳数（0 基，0 = 未跳）；链细节只进审计不进包结果 */
    redirects: number
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
  /** 工单347：同 origin 3xx 自动跟随上限（仅 GET/HEAD；0 基 redirects 计数的最大值），缺省 3 */
  maxRedirects: number
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
  /**
   * 工单345：每包限额覆写切片（包 id → 限额键 → 值，config.plugins.limits 的
   * network.request 切片）。构造期逐键 min(基线, 覆写) 生效——覆写只会收紧，放宽
   * 与非法值在此被数学钳制（配置面已先行结构化拒绝，这里是执行面双保险）。
   */
  packageLimits?: Record<string, Record<string, number>>
  transport?: NetworkTransportPort
  now?(): number
}

/** 契约上限（catalog permissions[network.request].limits 同源：5/s、并发 2、10s、2MB、跟随 3 跳） */
const DEFAULT_LIMITS: NetworkLimits = { requestsPerSecond: 5, maxConcurrent: 2, timeoutMs: 10_000, maxResponseBytes: 2 * 1024 * 1024, maxRedirects: 3 }
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

/** 工单345：覆写值只许收紧——合法正数取 min(基线, 覆写)，其余（缺/非法/放宽）回落基线 */
function clampTighter(raw: unknown, base: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), base) : base
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
  /** 工单345：每包生效限额（构造期 min(基线, 覆写) 一次性算定；配置不热更，重启生效） */
  private readonly packageLimits: Map<string, NetworkLimits>
  private readonly transport: NetworkTransportPort
  private readonly rateWindows = new Map<string, number[]>()
  private readonly inflight = new Map<string, number>()

  constructor(opts: NetworkBrokerOptions) {
    this.opts = opts
    this.limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) }
    this.packageLimits = new Map()
    for (const [pkgId, raw] of Object.entries(opts.packageLimits ?? {})) {
      this.packageLimits.set(pkgId, {
        requestsPerSecond: clampTighter(raw.requestsPerSecond, this.limits.requestsPerSecond),
        maxConcurrent: clampTighter(raw.maxConcurrent, this.limits.maxConcurrent),
        timeoutMs: clampTighter(raw.timeoutMs, this.limits.timeoutMs),
        maxResponseBytes: clampTighter(raw.maxResponseBytes, this.limits.maxResponseBytes),
        // 工单347：maxRedirects 纳入覆写面第五键——min 钳制，可收紧不可放宽
        maxRedirects: clampTighter(raw.maxRedirects, this.limits.maxRedirects),
      })
    }
    this.transport = opts.transport ?? createNodeTransport()
  }

  /** 本包生效限额（未覆写包 = 基线；覆写包 = 构造期 min(基线, 覆写)） */
  private limitsFor(packageId: string): NetworkLimits {
    return this.packageLimits.get(packageId) ?? this.limits
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /** 按包速率窗（滚动 1s，上限 requestsPerSecond 生效值） */
  private rateOk(packageId: string): boolean {
    const now = this.now()
    const win = (this.rateWindows.get(packageId) ?? []).filter((ts) => now - ts < 1000)
    if (win.length >= this.limitsFor(packageId).requestsPerSecond) {
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
    // 并发上限（与权限拒绝分域的限额错误；生效值随包收紧，工单345）
    const effective = this.limitsFor(packageId)
    const live = this.inflight.get(packageId) ?? 0
    if (live >= effective.maxConcurrent) {
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_rate_limited' })
      return { ok: false, code: 'network_rate_limited', message: `并发上限（${effective.maxConcurrent}）已满——稍后重试`, origin, method }
    }
    if (!this.rateOk(packageId)) {
      this.audit({ packageId, origin, method, outcome: 'error', code: 'network_rate_limited' })
      return { ok: false, code: 'network_rate_limited', message: `超过每包速率上限（${effective.requestsPerSecond}/s）——稍后重试`, origin, method }
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
    /** 工单347：当前已注入的凭证头名（同 origin 跟随逐跳重新解析前先摘旧头，包不能覆盖注入面） */
    let injectedHeaderName = ''
    if (credentialName) {
      const resolved = this.opts.credentials?.resolve(packageId, credentialName, origin) ?? null
      if (!resolved || resolved.ok !== true) {
        const message = resolved ? resolved.message : '凭证面未装配'
        // 审计只记「凭证不可用」这一结果，不记凭证名细节以外的任何内容（无 secret）
        this.audit({ packageId, origin, method, outcome: 'error', code: 'credential_unavailable' })
        return { ok: false, code: 'credential_unavailable', message, origin, method }
      }
      headers[resolved.headerName] = resolved.value
      injectedHeaderName = resolved.headerName
    }
    const bodyText = typeof spec?.body === 'string' ? spec.body : undefined
    const body = bodyText !== undefined && method !== 'GET' && method !== 'HEAD' ? Buffer.from(bodyText, 'utf8') : undefined
    if (body) headers['content-length'] = String(body.length)

    this.inflight.set(packageId, live + 1)
    try {
      // 工单347：同 origin 有界跟随循环——串行跟随，整链占上面这 1 个并发槽；每跳一次
      // transport.send（独立 timeoutMs）、重过授权门、计一个速率额度、一条审计，凭证按
      // 「同包 + 本 origin」重新解析注入（同 origin 必命中同一绑定）。
      let currentUrl = new URL(rawUrl)
      let redirects = 0
      for (;;) {
        let reply: NetworkRawReply
        try {
          reply = await this.transport.send({
            url: currentUrl,
            method,
            headers,
            ...(body ? { body } : {}),
            timeoutMs: effective.timeoutMs,
            maxBytes: effective.maxResponseBytes,
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const timedOut = /超时|timeout|ETIMEDOUT|aborted/i.test(message)
          const code: NetworkErrorCode = timedOut ? 'network_timeout' : 'network_failed'
          this.audit({ packageId, origin: currentUrl.origin, method, outcome: 'error', code })
          return { ok: false, code, message: `请求未完成：${message}`, origin: currentUrl.origin, method }
        }

        // 3xx 分类：无可用 location / 跨 origin（origin 精确相等判定，复用 origin.ts 口径）/
        // 非 GET·HEAD → 结构化拦截（现状不变）；同 origin + GET/HEAD → 有界跟随；跳满上限
        // 仍在 3xx → network_redirect_limit。
        if (reply.status >= 300 && reply.status < 400) {
          const rawLocation = reply.headers.location
          const location = Array.isArray(rawLocation) ? rawLocation[0] : rawLocation
          let nextUrl: URL | null = null
          if (location) {
            try {
              // 相对 location 按当前跳 URL 解析；下一跳用 origin.ts 同一口径校验
              // （http(s)、无 userinfo）——过不了即当作无可用目标，维持拦截
              const candidate = new URL(String(location), currentUrl)
              nextUrl = originOfRequestUrl(candidate.href).ok ? candidate : null
            } catch { nextUrl = null }
          }
          const hopOrigin = currentUrl.origin
          if (nextUrl !== null && nextUrl.origin === hopOrigin && (method === 'GET' || method === 'HEAD')) {
            // —— 跟随路径：先算预算，再逐跳过门 ——
            if (redirects >= effective.maxRedirects) {
              this.audit({ packageId, origin: hopOrigin, method, outcome: 'error', code: 'network_redirect_limit', status: reply.status, redirectTo: nextUrl.origin })
              return {
                ok: false,
                code: 'network_redirect_limit',
                message: `同 origin 重定向跳数超上限（${effective.maxRedirects}）仍在 3xx（HTTP ${reply.status} → ${nextUrl.origin}）：已停止跟随`,
                origin: hopOrigin,
                method,
                status: reply.status,
                ...(location ? { location: String(location).slice(0, 512) } : {}),
              }
            }
            // 每跳重过授权门（撤销即断链，零窗口）
            const hopGrant = this.opts.authorization?.activeGrant(packageId) ?? null
            if (!hopGrant || !hopGrant.permissions.includes('network.request') || !originGranted(hopGrant.networkOrigins, hopOrigin)) {
              this.audit({ packageId, origin: hopOrigin, method, outcome: 'denied', code: 'network_permission_denied' })
              return { ok: false, code: 'network_permission_denied', message: `origin 未获授权（network.request 缺失或 ${hopOrigin} 不在授予集）——跟随链断供`, origin: hopOrigin, method }
            }
            // 每跳计一个速率额度（站内跳转也是真实请求，没有免费出口）
            if (!this.rateOk(packageId)) {
              this.audit({ packageId, origin: hopOrigin, method, outcome: 'error', code: 'network_rate_limited' })
              return { ok: false, code: 'network_rate_limited', message: `超过每包速率上限（${effective.requestsPerSecond}/s）——稍后重试`, origin: hopOrigin, method }
            }
            // 凭证按「同包 + 本 origin」重新 resolve；先摘旧注入头（包不能覆盖/窥探注入头）
            if (credentialName) {
              if (injectedHeaderName) delete headers[injectedHeaderName]
              const resolved = this.opts.credentials?.resolve(packageId, credentialName, hopOrigin) ?? null
              if (!resolved || resolved.ok !== true) {
                const message = resolved ? resolved.message : '凭证面未装配'
                this.audit({ packageId, origin: hopOrigin, method, outcome: 'error', code: 'credential_unavailable' })
                return { ok: false, code: 'credential_unavailable', message, origin: hopOrigin, method }
              }
              headers[resolved.headerName] = resolved.value
              injectedHeaderName = resolved.headerName
            }
            // 中间跳审计：outcome ok + 状态码 + redirectTo = 下一跳 origin（账面按行天然成链）
            this.audit({ packageId, origin: hopOrigin, method, outcome: 'ok', status: reply.status, redirectTo: nextUrl.origin })
            currentUrl = nextUrl
            redirects += 1
            continue
          }
          // —— 拦截路径（现状不变）：跨 origin / 非 GET·HEAD / 无可用 location ——
          const redirectOrigin = nextUrl?.origin ?? ''
          this.audit({ packageId, origin: hopOrigin, method, outcome: 'error', code: 'network_redirect_blocked', status: reply.status, ...(redirectOrigin ? { redirectTo: redirectOrigin } : {}) })
          return {
            ok: false,
            code: 'network_redirect_blocked',
            message: `重定向不自动跟随（HTTP ${reply.status}${redirectOrigin ? ` → ${redirectOrigin}` : ''}）：如需访问该 origin，请单独发起请求并先取得授权`,
            origin: hopOrigin,
            method,
            status: reply.status,
            ...(location ? { location: String(location).slice(0, 512) } : {}),
          }
        }

        // 终点（非 3xx）：成功结果——同一结果形状只多 redirects 计数（链细节只进审计）
        const contentTypeRaw = reply.headers['content-type']
        const contentType = (Array.isArray(contentTypeRaw) ? contentTypeRaw[0] : contentTypeRaw) ?? ''
        this.audit({ packageId, origin: currentUrl.origin, method, outcome: 'ok', status: reply.status })
        const base: Omit<Extract<NetworkResult, { ok: true }>, 'text' | 'base64'> = {
          ok: true,
          status: reply.status,
          origin: currentUrl.origin,
          method,
          contentType,
          bytes: reply.body.length,
          truncated: reply.truncated,
          redirects,
        }
        return isTextual(contentType)
          ? { ...base, text: reply.body.toString('utf8') }
          : { ...base, base64: reply.body.toString('base64') }
      }
    } finally {
      const left = (this.inflight.get(packageId) ?? 1) - 1
      if (left <= 0) this.inflight.delete(packageId)
      else this.inflight.set(packageId, left)
    }
  }
}
