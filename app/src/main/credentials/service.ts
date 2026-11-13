import { Service } from 'cordis'
import { CredentialStore, type CredentialCipherPort, type CredentialView, type OauthCredentialConfig } from './store'
import type { CredentialRefreshIo, CredentialRefreshResult, CredentialResolveResult } from '../network/broker'

/**
 * 命名凭证域服务（工单339/348）：面板主进程内的凭证库装配。
 *
 * - **可信 UI 面**（BridgeService 转发）：list/set/remove/bind/unbind——出口只有元数据，
 *   secret 永不回传（写入是单向的）；oauth 型也不回显 clientSecret。
 * - **运行时面**（NetworkBroker，工单348 异步双口）：resolve(packageId, name, origin, io?)
 *   缓存优先（oauth 首次无缓存时单飞取令牌）+ refresh(packageId, name, origin, io) 单飞
 *   强制刷新（复验三元组，与 resolve 同语义）。插件永远拿不到 secret 或令牌。
 * - **令牌缓存纯内存**（面板进程生命周期，重启即空）：access token 不落盘、不进日志/审计、
 *   不进 IPC 返回值——唯一出口是注入给已过凭证门的请求头（与静态 secret 同缝）。
 *   expires_in 记在缓存条目里但不参与任何判定（纯被动 401 触发，不做到期预刷）。
 * - **单飞按凭证名**：并发共享同一次发证调用；发证 HTTP 调用经宿主 IO（Broker 供给触发包的
 *   速率额度/超时/字节上限/审计归属），clientSecret 只在本域内存面短暂存在。
 * - 加密端口由装配层下发（生产 = safeStorage）；不可用 = 拒绝保存（不落明文）。
 * - 卸载清理经 install.credentials.clearBindingsFor（凭证本体保留）。
 */

export interface CredentialServiceOptions {
  /** 凭证库文件（生产 = userData/credentials.json；缺省 = 内存态空库，不落盘） */
  file?: string
  /** 加密端口（生产 = safeStorage；缺省 = 不可用——保存被拒，绝不落明文） */
  cipher?: CredentialCipherPort
  log?(event: Record<string, unknown>): void
}

/** 缺省加密端口：明确不可用（未装配真实加密能力时，凭证只读不写） */
const UNAVAILABLE_CIPHER: CredentialCipherPort = {
  available() { return false },
  encrypt() { throw new Error('加密能力不可用') },
  decrypt() { throw new Error('加密能力不可用') },
}

/** 单飞取令牌的内部结果（token 只在本域与注入头拼装处存在） */
type TokenFetch = { ok: true; token: string } | { ok: false; message: string }

export class CredentialService extends Service {
  readonly store: CredentialStore
  /** access token 纯内存缓存（name → 令牌 + expires_in 记账值；expires_in 不参与判定） */
  private readonly tokens = new Map<string, { token: string; expiresInSeconds: number | null }>()
  /** 按凭证名的取令牌单飞：并发共享同一次发证调用（同一起点、同一结果） */
  private readonly inflightTokens = new Map<string, Promise<TokenFetch>>()

  constructor(ctx: import('cordis').Context, options: CredentialServiceOptions = {}) {
    super(ctx, 'credentials')
    const log = options.log ?? (() => {})
    this.store = new CredentialStore({
      // 缺省文件落进程临时目录（离线装配/测试）；生产装配显式给 userData 路径
      file: options.file ?? `${process.cwd()}/.credentials-memory.json`,
      cipher: options.cipher ?? UNAVAILABLE_CIPHER,
      now: () => Date.now(),
      log,
    })
  }

  list(): CredentialView[] {
    return this.store.list()
  }

  set(name: string, secret: string, opts?: Parameters<CredentialStore['set']>[2]) {
    // 轮换/换型即清内存令牌缓存：新配置从零取令牌（不背旧令牌）
    this.tokens.delete(name)
    return this.store.set(name, secret, opts)
  }

  remove(name: string) {
    this.tokens.delete(name)
    return this.store.remove(name)
  }

  bind(packageId: string, credentialName: string, origin: string) {
    return this.store.bind(packageId, credentialName, origin)
  }

  unbind(packageId: string, credentialName: string, origin: string) {
    return this.store.unbind(packageId, credentialName, origin)
  }

  /**
   * 网络 Broker 的解析口（工单348 异步）：静态回注入头值；oauth 缓存优先——首次无缓存且
   * 供给宿主 IO 时单飞取令牌。未绑定/不存在/取令牌失败 = credential_unavailable。
   */
  async resolve(packageId: string, credentialName: string, origin: string, io?: CredentialRefreshIo): Promise<CredentialResolveResult> {
    const r = this.store.resolve(packageId, credentialName, origin)
    if (!r.ok) return r
    if (r.kind === 'static') return { ok: true, headerName: r.headerName, value: r.value, refreshable: false }
    const cached = this.tokens.get(credentialName)
    if (cached) return { ok: true, headerName: r.headerName, value: `${r.valuePrefix}${cached.token}`, refreshable: true }
    if (!io) {
      return { ok: false, code: 'credential_unavailable', message: `凭证不可用：${credentialName}（oauth 首次取令牌需要宿主 IO——速率/审计面）` }
    }
    const fetched = await this.fetchSingleFlight(credentialName, r.config, io)
    if (!fetched.ok) return { ok: false, code: 'credential_unavailable', message: fetched.message }
    return { ok: true, headerName: r.headerName, value: `${r.valuePrefix}${fetched.token}`, refreshable: true }
  }

  /** 网络 Broker 的强制刷新口（工单348）：单飞取新令牌；三元组复验与 resolve 同语义 */
  async refresh(packageId: string, credentialName: string, origin: string, io: CredentialRefreshIo): Promise<CredentialRefreshResult> {
    const r = this.store.resolve(packageId, credentialName, origin)
    if (!r.ok) return r
    if (r.kind === 'static') {
      return { ok: false, code: 'credential_unavailable', message: `凭证不可用：${credentialName}（静态型无刷新面——401 照旧透传）` }
    }
    const fetched = await this.fetchSingleFlight(credentialName, r.config, io)
    if (!fetched.ok) return { ok: false, code: 'credential_unavailable', message: fetched.message }
    return { ok: true, headerName: r.headerName, value: `${r.valuePrefix}${fetched.token}` }
  }

  /** 卸载清理（凭证本体保留） */
  clearBindingsFor(packageId: string): void {
    this.store.clearBindingsFor(packageId)
  }

  /** 按凭证名单飞：并发撞同一名 = 共享同一次发证调用（同一起点、同一结果） */
  private fetchSingleFlight(name: string, config: OauthCredentialConfig, io: CredentialRefreshIo): Promise<TokenFetch> {
    const existing = this.inflightTokens.get(name)
    if (existing) return existing
    const p = this.fetchToken(name, config, io).finally(() => {
      this.inflightTokens.delete(name)
    })
    this.inflightTokens.set(name, p)
    return p
  }

  /**
   * 发证调用（client_credentials，RFC 6749 体参式）：POST form-urlencoded
   * grant_type/client_id/client_secret（+可选 scope）；响应非 2xx、截断、非 JSON 或缺
   * access_token = 刷新失败。每次真实 HTTP 调用经 io.audit 记一行（origin=发证地址、
   * outcome、状态码）——绝无令牌、绝无 client_secret。
   */
  private async fetchToken(name: string, config: OauthCredentialConfig, io: CredentialRefreshIo): Promise<TokenFetch> {
    const tokenOrigin = new URL(config.tokenEndpoint).origin
    // 占触发包速率额度（单飞共享时只有发起者占）；额度拒 = 调用不发起（零 HTTP、零审计行）
    if (!io.consumeRate()) {
      return { ok: false, message: `刷新失败：速率额度不足——${name} 的发证调用未发起（稍后重试）` }
    }
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_id: config.clientId, client_secret: config.clientSecret })
    if (config.scope) form.set('scope', config.scope)
    const body = Buffer.from(form.toString(), 'utf8')
    let reply
    try {
      reply = await io.send({
        url: new URL(config.tokenEndpoint),
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(body.length) },
        body,
        timeoutMs: io.timeoutMs,
        maxBytes: io.maxBytes,
      })
    } catch (err) {
      io.audit({ origin: tokenOrigin, outcome: 'error' })
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, message: `刷新失败：发证调用未完成（${message}）` }
    }
    const okStatus = reply.status >= 200 && reply.status < 300
    let token: string | null = null
    let expiresInSeconds: number | null = null
    if (okStatus && !reply.truncated) {
      try {
        const parsed = JSON.parse(reply.body.toString('utf8')) as Record<string, unknown>
        if (typeof parsed.access_token === 'string' && parsed.access_token) token = parsed.access_token
        // expires_in 记下但不参与判定（纯被动 401 触发；不做到期预刷）
        if (typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)) expiresInSeconds = parsed.expires_in
      } catch { /* 非 JSON 响应体 = 刷新失败 */ }
    }
    if (token === null) {
      io.audit({ origin: tokenOrigin, outcome: 'error', ...(reply.status ? { status: reply.status } : {}) })
      const detail = okStatus ? '（HTTP 2xx 但响应缺 access_token）' : `（HTTP ${reply.status || '无响应'}）`
      return { ok: false, message: `刷新失败：发证服务未发令牌 ${detail}` }
    }
    io.audit({ origin: tokenOrigin, outcome: 'ok', status: reply.status })
    this.tokens.set(name, { token, expiresInSeconds })
    return { ok: true, token }
  }
}
