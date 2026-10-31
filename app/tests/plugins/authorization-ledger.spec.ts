import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginAuthorizationLedger } from '../../src/main/plugins/authorization-ledger'

/**
 * 授权账（工单336，ADR-0025 按包/按代码代次授予）：授权绑定 id+权限集合+代码哈希，
 * 跨重启持久化；撤销即停的账面事实源（Broker/宿主授权门同步查询，撤销与断供零窗口）。
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deck-authz-${prefix}-`))
}

let dir: string
let file: string

beforeEach(() => {
  dir = tmpDir('led')
  file = path.join(dir, 'plugin-authorizations.json')
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function boot(): PluginAuthorizationLedger {
  return new PluginAuthorizationLedger({
    file,
    now: () => 1_700_000_000_000,
    log: () => {},
  })
}

describe('授权账：批准落账（绑定 id+权限集合+代码哈希）', () => {
  it('grant 后 activeGrant 返回绑定三元组（permissions + codeHash + grantedAt）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-aaa')
    const g = led.activeGrant('dsh-media')
    expect(g).toEqual({ permissions: ['media.read'], codeHash: 'hash-aaa', grantedAt: 1_700_000_000_000 })
  })

  it('grant 幂等 upsert：同 id 再批覆盖旧权限集合与哈希（更新重批沿换代）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-1')
    led.grant('dsh-media', ['media.read'], 'hash-2')
    expect(led.activeGrant('dsh-media')?.codeHash).toBe('hash-2')
    expect(led.list()).toHaveLength(1)
  })

  it('零权限 grant = 删账（零权限包不需要授权，残留授权不虚挂）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-1')
    led.grant('dsh-media', [], 'hash-2')
    expect(led.activeGrant('dsh-media')).toBeNull()
    expect(led.list()).toHaveLength(0)
  })

  it('grant 落审计事件（含绑定三元组）', () => {
    const events: Record<string, unknown>[] = []
    const led = new PluginAuthorizationLedger({ file, now: () => 1, log: (e) => events.push(e) })
    led.grant('dsh-media', ['media.read'], 'hash-1')
    expect(events.some((e) => e.type === 'plugin-authorization-granted' && e.pkgId === 'dsh-media' && e.codeHash === 'hash-1')).toBe(true)
  })
})

describe('授权账：撤销（撤销即停的账面事实源）', () => {
  it('revoke 后 activeGrant 即刻为 null（撤销与断供零窗口）；list 保留撤销行（审计可见）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-1')
    const out = led.revoke('dsh-media')
    expect(out).toEqual({ ok: true })
    expect(led.activeGrant('dsh-media')).toBeNull()
    const row = led.list().find((r) => r.packageId === 'dsh-media')
    expect(row).toBeTruthy()
    expect(row!.revokedAt).toBe(1_700_000_000_000)
  })

  it('revoke 不存在的授权 → not_found 明确错误', () => {
    expect(boot().revoke('no-such')).toEqual({ ok: false, code: 'not_found' })
  })

  it('撤销后重新批准 = 恢复在册（revokedAt 清空，新哈希生效）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-1')
    led.revoke('dsh-media')
    led.grant('dsh-media', ['media.read'], 'hash-2')
    expect(led.activeGrant('dsh-media')).toMatchObject({ codeHash: 'hash-2' })
    expect(led.list()[0].revokedAt).toBeNull()
  })

  it('revoke 落审计事件', () => {
    const events: Record<string, unknown>[] = []
    const led = new PluginAuthorizationLedger({ file, now: () => 1, log: (e) => events.push(e) })
    led.grant('dsh-media', ['media.read'], 'hash-1')
    led.revoke('dsh-media')
    expect(events.some((e) => e.type === 'plugin-authorization-revoked' && e.pkgId === 'dsh-media')).toBe(true)
  })
})

describe('授权账：跨重启持久化', () => {
  it('grant → 新实例（同文件）重载 → activeGrant 匹配（跨重启授权仍在）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-persist')
    const reborn = boot()
    expect(reborn.activeGrant('dsh-media')).toEqual({ permissions: ['media.read'], codeHash: 'hash-persist', grantedAt: 1_700_000_000_000 })
  })

  it('撤销状态同样跨重启（重启不能复活已撤销授权）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-1')
    led.revoke('dsh-media')
    const reborn = boot()
    expect(reborn.activeGrant('dsh-media')).toBeNull()
    expect(reborn.list()[0].revokedAt).toBe(1_700_000_000_000)
  })

  it('账文件原子写：落盘内容是合法 JSON 且含绑定字段（无半写残页）', () => {
    const led = boot()
    led.grant('dsh-media', ['media.read'], 'hash-1')
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.version).toBe(1)
    expect(parsed.grants[0]).toMatchObject({ packageId: 'dsh-media', permissions: ['media.read'], codeHash: 'hash-1' })
  })

  it('坏账文件（不可解析）→ 账按空起步，不抛异常（跨重启坏档防御）', () => {
    fs.writeFileSync(file, '{ not json', 'utf8')
    const led = boot()
    expect(led.list()).toHaveLength(0)
    expect(led.activeGrant('dsh-media')).toBeNull()
  })

  it('账文件行漂移（数组缺字段）→ 容忍裁剪到合法形状（不虚挂残缺授权）', () => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, grants: [
      { packageId: 'ok-media', permissions: ['media.read'], codeHash: 'h1', grantedAt: 5, revokedAt: null },
      { packageId: 'bad-row' },
      { packageId: 'bad-perms', permissions: 'media.read', codeHash: 'h2', grantedAt: 5, revokedAt: null },
    ] }), 'utf8')
    const led = boot()
    expect(led.list()).toHaveLength(1)
    expect(led.activeGrant('ok-media')?.codeHash).toBe('h1')
  })
})
