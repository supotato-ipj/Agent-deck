import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { PluginHostService, type PluginHostOptions } from '../../src/main/plugins/service'
import { PluginAuthorizationLedger } from '../../src/main/plugins/authorization-ledger'
import { aggregateHashOf } from '../../src/main/plugins/install'
import { currentHostApiVersion } from '../../src/main/plugins/catalog'

/**
 * 授权路由（工单336，ADR-0025）：rescan 每轮按授权账重评——账齐激活、无账待批、
 * 撤销即停（接 #335 停用缝）、哈希漂移不放行；手动投放同闸门（manual 提案挂载/
 * 摘除与批准后激活）。
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deck-svc-authz-${prefix}-`))
}

function writePackage(root: string, manifest: Record<string, unknown>, entryText = 'export default {}'): string {
  const dir = path.join(root, String(manifest.id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
  const entry = String(manifest.entry ?? './card.js')
  fs.writeFileSync(path.join(dir, entry.replace(/^\.\//, '')), entryText, 'utf8')
  return dir
}

function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dsh-media', name: 'DSH MEDIA', version: '1.0.0', entry: './card.js',
    hostApiVersion: currentHostApiVersion(),
    ...over,
  }
}

interface Harness {
  svc: PluginHostService
  ctx: Context
  droppedRoot: string
  userRoot: string
  stagingRoot: string
  ledger: PluginAuthorizationLedger
  ledgerFile: string
  activations: Array<{ id: string; generation: number }>
  deactivations: string[]
  events: Record<string, unknown>[]
  rescan(): void
  dropped(): Array<{ id: string; status: string }>
  dispose(): void
}

let seq = 0

async function boot(opts: { withLedger?: boolean } = {}): Promise<Harness> {
  const droppedRoot = tmpDir(`dropped-${++seq}`)
  const userRoot = tmpDir('user')
  const stagingRoot = tmpDir('staging')
  const backupRoot = tmpDir('backup')
  const ledgerFile = path.join(tmpDir('led'), 'plugin-authorizations.json')
  const ledger = new PluginAuthorizationLedger({ file: ledgerFile, now: () => 1_700_000_000_000, log: () => {} })
  const activations: Harness['activations'] = []
  const deactivations: string[] = []
  const events: Record<string, unknown>[] = []
  const ctx = new Context()
  const options: PluginHostOptions = {
    roots: [{ dir: droppedRoot, tier: 'dropped' }],
    watch: false,
    droppedHost: {
      activate: (pkg) => activations.push({ id: pkg.id, generation: pkg.generation }),
      deactivate: (id) => deactivations.push(id),
    },
    install: {
      stagingRoot,
      userRoot,
      backupRoot,
      sessionInfo: () => null,
      mountBoundMs: 60,
    },
    log: (event) => events.push(event),
    ...(opts.withLedger === false ? {} : { authorization: ledger }),
  }
  ctx.plugin(PluginHostService, options)
  await ctx.start()
  const svc = ctx.plugins as PluginHostService
  return {
    svc, ctx, droppedRoot, userRoot, stagingRoot, ledger, ledgerFile, activations, deactivations, events,
    rescan: () => svc.rescan(),
    dropped: () => svc.droppedInfo(),
    dispose() {
      for (const d of [droppedRoot, userRoot, stagingRoot, backupRoot, path.dirname(ledgerFile)]) {
        fs.rmSync(d, { recursive: true, force: true })
      }
    },
  }
}

describe('授权路由（工单336）：rescan 每轮按账重评', () => {
  let h: Harness
  beforeEach(async () => { h = await boot() })
  afterEach(() => { h.dispose() })

  it('media.read 包无账 → pending-approval 不激活 + manual 提案挂载（批准 UI 同词汇）', () => {
    writePackage(h.droppedRoot, baseManifest({ permissions: ['media.read'] }))
    h.rescan()
    expect(h.activations).toHaveLength(0)
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('pending-approval')
    const manual = h.svc.installs?.list().filter((p) => p.pkg.id === 'dsh-media' && p.source.backend === 'manual') ?? []
    expect(manual).toHaveLength(1)
    expect(manual[0].status).toBe('pending')
    expect(manual[0].pkg.permissions).toEqual(['media.read'])
  })

  it('账上绑定匹配（id+权限集合+代码哈希）→ 激活；重启语义同构（同字节重扫不重复激活）', () => {
    const dir = writePackage(h.droppedRoot, baseManifest({ permissions: ['media.read'] }))
    h.ledger.grant('dsh-media', ['media.read'], aggregateHashOf(dir))
    h.rescan()
    expect(h.activations).toHaveLength(1)
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('ok')
    // 指纹未变再扫：不重复激活（幂等）
    h.rescan()
    expect(h.activations).toHaveLength(1)
  })

  it('哈希漂移（同 id 新字节不在账）→ 不放行（pending-approval + 停）', () => {
    const dir = writePackage(h.droppedRoot, baseManifest({ permissions: ['media.read'] }))
    h.ledger.grant('dsh-media', ['media.read'], aggregateHashOf(dir))
    h.rescan()
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('ok')
    // 字节变化 = 同 id 新代码（不继承旧批准）——换代路径：旧代次停、新代次待批
    fs.writeFileSync(path.join(dir, 'card.js'), 'export default { /* v2 */ }', 'utf8')
    h.rescan()
    expect(h.activations).toHaveLength(1) // 无第二次激活
    expect(h.deactivations).toContain('dsh-media')
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('pending-approval')
    // 手动提案重新挂载（新字节等重新批准）
    const manual = h.svc.installs?.list().filter((p) => p.pkg.id === 'dsh-media' && p.status === 'pending' && p.source.backend === 'manual') ?? []
    expect(manual).toHaveLength(1)
  })

  it('撤销即停：账撤销 → rescan → deactivate(reason=permission-revoked) + 状态回 pending-approval', () => {
    const dir = writePackage(h.droppedRoot, baseManifest({ permissions: ['media.read'] }))
    h.ledger.grant('dsh-media', ['media.read'], aggregateHashOf(dir))
    h.rescan()
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('ok')
    const out = h.svc.revokeAuthorization('dsh-media')
    expect(out).toMatchObject({ ok: true })
    expect(h.deactivations).toContain('dsh-media')
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('pending-approval')
    const stopEvt = h.events.filter((e) => e.type === 'dropped-package-deactivated').at(-1)
    expect(stopEvt).toMatchObject({ id: 'dsh-media', reason: 'permission-revoked' })
    // 撤销后激活不复发（幂等重扫）
    const actAfter = h.activations.length
    h.rescan()
    expect(h.activations).toHaveLength(actAfter)
  })

  it('manual 提案批准 → 落账 → 下一轮 rescan 激活；包消失 → manual 提案摘除', async () => {
    const dir = writePackage(h.droppedRoot, baseManifest({ permissions: ['media.read'] }))
    h.rescan()
    const manual = h.svc.installs?.list().find((p) => p.pkg.id === 'dsh-media' && p.source.backend === 'manual')
    expect(manual).toBeTruthy()
    const decided = await h.svc.installs!.approve(manual!.proposalId)
    // mount 无宿主回报（假端口无 onMountOutcome）→ mountBoundMs 超时 = 结果未知（不猜）
    expect(decided).toMatchObject({ ok: false, code: 'activation_unknown', stateUnknown: true })
    // 账已落（结果未知不清账）→ 下一轮 rescan 真激活
    h.rescan()
    expect(h.activations.length).toBeGreaterThanOrEqual(1)
    expect(h.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('ok')
    // 包消失 → 记录摘除 + manual 提案摘除
    fs.rmSync(dir, { recursive: true, force: true })
    h.rescan()
    expect(h.dropped().some((p) => p.id === 'dsh-media')).toBe(false)
    expect(h.svc.installs?.list().some((p) => p.pkg.id === 'dsh-media' && p.source.backend === 'manual' && p.status === 'pending')).toBe(false)
  })

  it('authorizationGrants：账清单出口（含已撤销行）', () => {
    const dir = writePackage(h.droppedRoot, baseManifest({ permissions: ['media.read'] }))
    h.ledger.grant('dsh-media', ['media.read'], aggregateHashOf(dir))
    expect(h.svc.authorizationGrants()).toHaveLength(1)
    h.svc.revokeAuthorization('dsh-media')
    expect(h.svc.authorizationGrants()[0]).toMatchObject({ packageId: 'dsh-media', revokedAt: 1_700_000_000_000 })
  })

  it('无账面装配（authorization 缺省）→ 敏感包一律 pending-approval（#331 行为兜底）', async () => {
    h.dispose()
    const h2 = await boot({ withLedger: false })
    try {
      writePackage(h2.droppedRoot, baseManifest({ permissions: ['media.read'] }))
      h2.rescan()
      expect(h2.activations).toHaveLength(0)
      expect(h2.dropped().find((p) => p.id === 'dsh-media')?.status).toBe('pending-approval')
      expect(h2.svc.revokeAuthorization('dsh-media')).toMatchObject({ ok: false, code: 'not_wired' })
      expect(h2.svc.authorizationGrants()).toEqual([])
    } finally {
      h2.dispose()
    }
  })
})
