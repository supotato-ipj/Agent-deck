import fs from 'node:fs'
import path from 'node:path'

/**
 * 授权账（工单336，ADR-0025「按包、按代码代次授予」）：敏感权限授权的持久化事实源。
 *
 * 授权绑定三元组 = 包 id + 权限集合 + 代码聚合哈希——三者任一漂移即不放行：
 * - 同 id 新代码（哈希不同）不继承旧批准（更新必须重新批准）；
 * - 权限集合变化（manifest 声明变化）不继承旧批准；
 * - 跨重启持久化（JSON 原子写：tmp + rename），面板重启后授权仍在。
 *
 * 撤销（可信 UI 真实用户手势）置 revokedAt——行保留做审计可见（何时授何时撤在案），
 * activeGrant 即刻为 null（Broker/宿主授权门同步查询本账，撤销与断供之间零窗口）。
 * 撤销后重新批准 = upsert 恢复（revokedAt 清空、新哈希生效）。
 *
 * 卸载 = 清账（重装同字节也重新批准——撤销不可被「卸载→重装」绕过）。
 * 零权限 grant = 删账（零权限包不需要授权，残留授权不虚挂）。
 *
 * 纯逻辑 + node:fs：无 Electron，Vitest 全覆盖（tmp 文件）。
 */

/** 账面单行（含已撤销行——审计可见面） */
export interface AuthorizationGrantRecord {
  packageId: string
  permissions: string[]
  /** 工单338：network.request 的精确 origin 授予集（无该权限 = 空清单；正典 origin 串） */
  networkOrigins: string[]
  /** 代码聚合哈希（批准时的待装载区/用户根同一份字节） */
  codeHash: string
  grantedAt: number
  revokedAt: number | null
}

interface LedgerFile {
  version: 1
  grants: AuthorizationGrantRecord[]
}

export interface AuthorizationLedgerOptions {
  /** 账文件路径（生产 = userData/plugin-authorizations.json；测试 = tmp） */
  file: string
  now(): number
  log(event: Record<string, unknown>): void
}

/** 在册授权查询形状（activeGrant 出口；不含账簿簿记字段） */
export interface ActiveGrant {
  permissions: string[]
  /** 工单338：network.request 授予的精确 origin 集合（无该权限 = 空清单） */
  networkOrigins: string[]
  codeHash: string
  grantedAt: number
}

function asStringArray(v: unknown): string[] | null {
  return Array.isArray(v) && v.every((p) => typeof p === 'string') ? (v as string[]) : null
}

/** 账行合法性：缺字段/形状坏的行裁剪丢弃（不虚挂残缺授权），合法行保留 */
function coerceGrant(raw: unknown): AuthorizationGrantRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.packageId !== 'string' || !r.packageId) return null
  const permissions = asStringArray(r.permissions)
  if (!permissions) return null
  // 工单338：origin 集缺省/形状坏按空清单（旧账行兼容——没有 network.request 的行本来就没 origin）
  const networkOrigins = asStringArray(r.networkOrigins) ?? []
  if (typeof r.codeHash !== 'string' || !r.codeHash) return null
  if (typeof r.grantedAt !== 'number') return null
  const revokedAt = typeof r.revokedAt === 'number' ? r.revokedAt : null
  return { packageId: r.packageId, permissions, networkOrigins, codeHash: r.codeHash, grantedAt: r.grantedAt, revokedAt }
}

export class PluginAuthorizationLedger {
  private readonly opts: AuthorizationLedgerOptions
  /** id → 账行（含已撤销行；Map 查表防原型链） */
  private readonly grants = new Map<string, AuthorizationGrantRecord>()

  constructor(opts: AuthorizationLedgerOptions) {
    this.opts = opts
    this.load()
  }

  /** 跨重启重载：坏档按空起步（不抛异常），形状坏行裁剪 */
  private load(): void {
    let raw: string
    try {
      raw = fs.readFileSync(this.opts.file, 'utf8')
    } catch {
      return // 文件不存在 = 首启动空账
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      this.opts.log({ type: 'plugin-authorization-ledger-corrupt', message: `账文件不可解析，按空账起步：${err instanceof Error ? err.message : String(err)}` })
      return
    }
    const body = (typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null)
    const rows = Array.isArray(body?.grants) ? body!.grants : []
    for (const row of rows) {
      const g = coerceGrant(row)
      if (g) this.grants.set(g.packageId, g)
    }
  }

  /** 原子落盘：tmp + rename（无半写残页） */
  private persist(): void {
    const body: LedgerFile = { version: 1, grants: [...this.grants.values()].sort((a, b) => (a.packageId < b.packageId ? -1 : 1)) }
    const tmp = `${this.opts.file}.tmp`
    fs.mkdirSync(path.dirname(this.opts.file), { recursive: true })
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', 'utf8')
    fs.renameSync(tmp, this.opts.file)
  }

  /**
   * 批准落账（install.ts 批准手势的记账回调）：upsert 幂等；permissions 空 = 删账
   * （零权限不需要授权）；撤销过的行复活（revokedAt 清空、新绑定生效）。
   */
  grant(packageId: string, permissions: string[], codeHash: string, networkOrigins: string[] = []): void {
    if (permissions.length === 0) {
      if (this.grants.delete(packageId)) this.persist()
      return
    }
    const prev = this.grants.get(packageId)
    const origins = permissions.includes('network.request') ? [...new Set(networkOrigins)] : []
    this.grants.set(packageId, {
      packageId,
      permissions: [...permissions],
      networkOrigins: origins,
      codeHash,
      grantedAt: this.opts.now(),
      revokedAt: null,
    })
    this.persist()
    this.opts.log({
      type: 'plugin-authorization-granted',
      pkgId: packageId,
      permissions: [...permissions],
      ...(origins.length ? { networkOrigins: origins } : {}),
      codeHash,
      ...(prev ? { replaced: true } : {}),
    })
  }

  /** 撤销（可信 UI 手势）：activeGrant 即刻为 null，行保留（revokedAt 审计可见） */
  revoke(packageId: string): { ok: true } | { ok: false; code: 'not_found' } {
    const row = this.grants.get(packageId)
    if (!row) return { ok: false, code: 'not_found' }
    row.revokedAt = this.opts.now()
    this.persist()
    this.opts.log({ type: 'plugin-authorization-revoked', pkgId: packageId, revokedAt: row.revokedAt })
    return { ok: true }
  }

  /** 在册授权查询（授权门同步事实源；撤销/缺失 = null） */
  activeGrant(packageId: string): ActiveGrant | null {
    const row = this.grants.get(packageId)
    if (!row || row.revokedAt !== null) return null
    return { permissions: row.permissions, networkOrigins: row.networkOrigins ?? [], codeHash: row.codeHash, grantedAt: row.grantedAt }
  }

  /** 卸载清账（重装同字节也重新批准——撤销不可被卸载→重装绕过） */
  clear(packageId: string): void {
    if (this.grants.delete(packageId)) this.persist()
  }

  /** 账全量（含已撤销行——UI/审计面按行读） */
  list(): AuthorizationGrantRecord[] {
    return [...this.grants.values()].sort((a, b) => (a.packageId < b.packageId ? -1 : 1))
  }
}
