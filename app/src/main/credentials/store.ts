import fs from 'node:fs'
import path from 'node:path'
import { originOfDeclaration } from '../network/origin'

/**
 * 命名凭证（工单339，ADR-0025「凭证只发给精确匹配目标」）：加密保存 + 显式绑定 + 注入。
 *
 * 红线（票面）：
 * - **插件不能读回、枚举或继承其他登录态**：本模块的出口只有「元数据」与「解析后的注入头」；
 *   secret 解密后只在请求构造处短暂存在，永不进 IPC 返回值、日志或审计。
 * - **只在已获批且精确匹配 origin 的请求中注入**：binding = 包 + 凭证名 + origin 三元组；
 *   请求面 origin 与绑定 origin 不精确相等 = 不注入（`credential_unavailable`，不静默改用
 *   其他凭证、不撤销网络权限）。
 * - **同一凭证可显式绑定多个插件并可逐包撤销**：bindings 是多对多，unbind 只动指定三元组。
 * - **轮换不触发代码重批**：轮换只换密文，绑定与授权账（codeHash/grantedAt）不动。
 * - **卸载只移除授权和绑定，凭证本体保留至用户显式删除**：clearBindingsFor(packageId)。
 *
 * 加密走注入端口（生产 = Electron safeStorage/DPAPI；测试 = 可逆假密码器）。加密不可用时
 * **拒绝保存**（绝不落明文兜底）。
 *
 * 纯逻辑 + node:fs：无 Electron，Vitest 全覆盖。
 */

/** 加密端口（生产 = safeStorage：encryptString → base64；不可用 = available() false） */
export interface CredentialCipherPort {
  available(): boolean
  /** 明文 → base64 密文 */
  encrypt(plain: string): string
  /** base64 密文 → 明文（坏密文抛错） */
  decrypt(cipher: string): string
}

export interface CredentialRecord {
  name: string
  /** 注入头名（小写；缺省 authorization） */
  headerName: string
  /** 值前缀（缺省 "Bearer "——与 secret 拼成头值） */
  valuePrefix: string
  /** 密文（base64；明文永不落盘） */
  cipher: string
  createdAt: number
  rotatedAt: number | null
}

export interface CredentialBinding {
  packageId: string
  credentialName: string
  /** 精确 origin（正典串） */
  origin: string
  boundAt: number
}

/** 可信 UI 视图（只有元数据；不含密文、不含明文） */
export interface CredentialView {
  name: string
  headerName: string
  valuePrefix: string
  createdAt: number
  rotatedAt: number | null
  bindings: Array<{ packageId: string; origin: string; boundAt: number }>
}

export type CredentialFailure =
  | { ok: false; code: 'credential_invalid'; message: string }
  | { ok: false; code: 'credential_unavailable'; message: string }
  | { ok: false; code: 'credential_store_unavailable'; message: string }

export type CredentialResult = { ok: true } | CredentialFailure

export interface CredentialStoreOptions {
  file: string
  cipher: CredentialCipherPort
  now(): number
  log(event: Record<string, unknown>): void
}

interface StoreFile {
  version: 1
  credentials: CredentialRecord[]
  bindings: CredentialBinding[]
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
const HEADER_RE = /^[a-z0-9-]{1,64}$/
const SECRET_MAX = 4096
const PREFIX_MAX = 64

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function coerceCredential(raw: unknown): CredentialRecord | null {
  if (!isRecord(raw)) return null
  if (typeof raw.name !== 'string' || !NAME_RE.test(raw.name)) return null
  if (typeof raw.cipher !== 'string' || !raw.cipher) return null
  if (typeof raw.createdAt !== 'number') return null
  return {
    name: raw.name,
    headerName: typeof raw.headerName === 'string' && HEADER_RE.test(raw.headerName) ? raw.headerName : 'authorization',
    valuePrefix: typeof raw.valuePrefix === 'string' ? raw.valuePrefix.slice(0, PREFIX_MAX) : 'Bearer ',
    cipher: raw.cipher,
    createdAt: raw.createdAt,
    rotatedAt: typeof raw.rotatedAt === 'number' ? raw.rotatedAt : null,
  }
}

function coerceBinding(raw: unknown): CredentialBinding | null {
  if (!isRecord(raw)) return null
  if (typeof raw.packageId !== 'string' || !raw.packageId) return null
  if (typeof raw.credentialName !== 'string' || !raw.credentialName) return null
  if (typeof raw.origin !== 'string' || !raw.origin) return null
  if (typeof raw.boundAt !== 'number') return null
  return { packageId: raw.packageId, credentialName: raw.credentialName, origin: raw.origin, boundAt: raw.boundAt }
}

export class CredentialStore {
  private readonly opts: CredentialStoreOptions
  private credentials = new Map<string, CredentialRecord>()
  private bindings: CredentialBinding[] = []

  constructor(opts: CredentialStoreOptions) {
    this.opts = opts
    this.load()
  }

  /** 跨重启重载：坏行跳过；绑定指向不存在的凭证 = 孤儿绑定，载入即丢（不虚挂） */
  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.opts.file, 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.opts.log({ type: 'credential-store-corrupt', message: `凭证文件不可解析，按空库起步：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    if (!isRecord(parsed)) return
    for (const c of Array.isArray(parsed.credentials) ? parsed.credentials : []) {
      const cred = coerceCredential(c)
      if (cred) this.credentials.set(cred.name, cred)
    }
    const seen = new Set<string>()
    for (const b of Array.isArray(parsed.bindings) ? parsed.bindings : []) {
      const bind = coerceBinding(b)
      if (!bind) continue
      if (!this.credentials.has(bind.credentialName)) continue
      const key = `${bind.packageId}|${bind.credentialName}|${bind.origin}`
      if (seen.has(key)) continue
      seen.add(key)
      this.bindings.push(bind)
    }
  }

  /** 原子落盘（tmp + rename）：密文与元数据一起写，明文永不出内存 */
  private persist(): void {
    const body: StoreFile = {
      version: 1,
      credentials: [...this.credentials.values()].sort((a, b) => (a.name < b.name ? -1 : 1)),
      bindings: [...this.bindings].sort((a, b) => `${a.packageId}|${a.credentialName}|${a.origin}` < `${b.packageId}|${b.credentialName}|${b.origin}` ? -1 : 1),
    }
    const tmp = `${this.opts.file}.tmp`
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
    // Windows：杀毒/索引服务可能短暂占用目标文件（EPERM/EBUSY）——短退避重试，原子性不变
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, this.opts.file)
        return
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (attempt >= 2 || (code !== 'EPERM' && code !== 'EBUSY')) throw err
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
      }
    }
  }

  /** 可信 UI 视图：只有元数据与绑定（无密文/明文） */
  list(): CredentialView[] {
    return [...this.credentials.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((c) => ({
        name: c.name,
        headerName: c.headerName,
        valuePrefix: c.valuePrefix,
        createdAt: c.createdAt,
        rotatedAt: c.rotatedAt,
        bindings: this.bindings
          .filter((b) => b.credentialName === c.name)
          .map((b) => ({ packageId: b.packageId, origin: b.origin, boundAt: b.boundAt }))
          .sort((a, b) => (a.packageId < b.packageId ? -1 : a.packageId > b.packageId ? 1 : a.origin < b.origin ? -1 : 1)),
      }))
  }

  has(name: string): boolean {
    return this.credentials.has(name)
  }

  /** 新建或轮换（同名 = 轮换：密文换新、绑定/创建时间语义分开记） */
  set(name: string, secret: string, opts?: { headerName?: string; valuePrefix?: string }): CredentialResult {
    if (!NAME_RE.test(name)) {
      return { ok: false, code: 'credential_invalid', message: `凭证名非法（小写字母数字与 ._-，1-64 字符）：${String(name).slice(0, 64)}` }
    }
    if (typeof secret !== 'string' || secret.length === 0 || secret.length > SECRET_MAX) {
      return { ok: false, code: 'credential_invalid', message: `secret 必须是 1-${SECRET_MAX} 字符的字符串` }
    }
    const headerName = (opts?.headerName ?? 'authorization').toLowerCase()
    if (!HEADER_RE.test(headerName)) {
      return { ok: false, code: 'credential_invalid', message: `headerName 非法（小写字母数字与 -）：${String(headerName).slice(0, 64)}` }
    }
    if (headerName === 'host' || headerName === 'content-length') {
      return { ok: false, code: 'credential_invalid', message: `headerName 不允许：${headerName}` }
    }
    const valuePrefix = (opts?.valuePrefix ?? 'Bearer ').slice(0, PREFIX_MAX)
    if (!this.opts.cipher.available()) {
      return { ok: false, code: 'credential_store_unavailable', message: '系统加密能力不可用（safeStorage/DPAPI 未就绪）——拒绝保存，绝不落明文兜底' }
    }
    const cipher = this.opts.cipher.encrypt(secret)
    const prev = this.credentials.get(name)
    const now = this.opts.now()
    this.credentials.set(name, {
      name,
      headerName,
      valuePrefix,
      cipher,
      createdAt: prev ? prev.createdAt : now,
      rotatedAt: prev ? now : null,
    })
    this.persist()
    this.opts.log({ type: prev ? 'credential-rotated' : 'credential-created', name, headerName })
    return { ok: true }
  }

  /** 显式删除（唯一销毁凭证本体的手势；连带清掉全部绑定） */
  remove(name: string): CredentialResult {
    if (!this.credentials.has(name)) return { ok: false, code: 'credential_unavailable', message: `凭证不存在：${name}` }
    this.credentials.delete(name)
    this.bindings = this.bindings.filter((b) => b.credentialName !== name)
    this.persist()
    this.opts.log({ type: 'credential-deleted', name })
    return { ok: true }
  }

  /** 显式绑定（可信 UI 手势）：包 + 凭证 + 精确 origin；重复绑定幂等 */
  bind(packageId: string, credentialName: string, origin: string): CredentialResult {
    if (typeof packageId !== 'string' || !packageId) {
      return { ok: false, code: 'credential_invalid', message: 'bind 需要 packageId' }
    }
    if (!this.credentials.has(credentialName)) {
      return { ok: false, code: 'credential_unavailable', message: `凭证不存在：${credentialName}` }
    }
    const check = originOfDeclaration(origin)
    if (!check.ok) {
      return { ok: false, code: 'credential_invalid', message: `绑定 origin 必须是纯 origin：${check.message}` }
    }
    const exists = this.bindings.some((b) => b.packageId === packageId && b.credentialName === credentialName && b.origin === check.origin)
    if (!exists) {
      this.bindings.push({ packageId, credentialName, origin: check.origin, boundAt: this.opts.now() })
      this.persist()
      this.opts.log({ type: 'credential-bound', name: credentialName, pkgId: packageId, origin: check.origin })
    }
    return { ok: true }
  }

  /** 逐包撤销绑定（只动指定三元组；其他包/其他 origin 不受影响） */
  unbind(packageId: string, credentialName: string, origin: string): CredentialResult {
    const check = originOfDeclaration(origin)
    const originKey = check.ok ? check.origin : origin
    const before = this.bindings.length
    this.bindings = this.bindings.filter((b) => !(b.packageId === packageId && b.credentialName === credentialName && b.origin === originKey))
    if (this.bindings.length === before) {
      return { ok: false, code: 'credential_unavailable', message: `绑定不存在：${packageId} → ${credentialName} @ ${originKey}` }
    }
    this.persist()
    this.opts.log({ type: 'credential-unbound', name: credentialName, pkgId: packageId, origin: originKey })
    return { ok: true }
  }

  /** 包的全部绑定（卸载清理面；凭证本体保留） */
  bindingsFor(packageId: string): CredentialBinding[] {
    return this.bindings.filter((b) => b.packageId === packageId)
  }

  /** 卸载：移除该包的全部绑定（凭证本体保留至用户显式删除） */
  clearBindingsFor(packageId: string): void {
    const before = this.bindings.length
    this.bindings = this.bindings.filter((b) => b.packageId !== packageId)
    if (this.bindings.length !== before) {
      this.persist()
      this.opts.log({ type: 'credential-bindings-cleared', pkgId: packageId, removed: before - this.bindings.length })
    }
  }

  /**
   * 请求时解析（网络 Broker 唯一入口）：凭证在册 + 该包在**该 origin**上有绑定 → 注入头；
   * 否则 `credential_unavailable`（凭证不存在与未绑定同一出口——不给枚举信号；绝不静默
   * 改用其他凭证）。
   */
  resolve(packageId: string, credentialName: string, origin: string): { ok: true; headerName: string; value: string } | { ok: false; code: 'credential_unavailable'; message: string } {
    const cred = this.credentials.get(credentialName)
    if (!cred) {
      return { ok: false, code: 'credential_unavailable', message: `凭证不可用：${credentialName}（不存在或已删除）` }
    }
    const bound = this.bindings.some((b) => b.packageId === packageId && b.credentialName === credentialName && b.origin === origin)
    if (!bound) {
      return { ok: false, code: 'credential_unavailable', message: `凭证不可用：${credentialName} 未绑定到 ${packageId} @ ${origin}` }
    }
    if (!this.opts.cipher.available()) {
      return { ok: false, code: 'credential_unavailable', message: '系统加密能力不可用——凭证无法解密注入' }
    }
    let secret: string
    try {
      secret = this.opts.cipher.decrypt(cred.cipher)
    } catch (err) {
      this.opts.log({ type: 'credential-decrypt-failed', name: credentialName, message: err instanceof Error ? err.message : String(err) })
      return { ok: false, code: 'credential_unavailable', message: `凭证不可用：${credentialName}（密文无法解密）` }
    }
    return { ok: true, headerName: cred.headerName, value: `${cred.valuePrefix}${secret}` }
  }
}
