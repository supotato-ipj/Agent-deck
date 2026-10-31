import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { PluginHostService, type PluginHostOptions } from '../../src/main/plugins/service'
import type { DroppedPackageInfo } from '../../src/shared/contract'
import { currentHostApiVersion } from '../../src/main/plugins/catalog'

/**
 * 投放档路由（工单331，ADR-0025/0019）：dropped 根的包走独立执行上下文路径，
 * **绝不进**内核快照 plugins 段（渲染层同上下文 import 路径退役，AC5）。
 * 宿主经 DroppedPackageHostPort 注入（Electron 接线在 package-host.ts，离线可测路由）。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-dropped-'))
}

/** 落一个投放包目录；entryText = null 时不写入口文件（造「入口资产缺失」坏包） */
function writePackage(root: string, manifest: Record<string, unknown>, entryText: string | null = 'export default {}'): string {
  const dir = path.join(root, String(manifest.id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
  if (entryText !== null) {
    const entry = String(manifest.entry ?? './card.js')
    fs.writeFileSync(path.join(dir, entry.replace(/^\.\//, '')), entryText, 'utf8')
  }
  return dir
}

function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'widget-a', name: '组件A', version: '1.0.0', entry: './card.js',
    hostApiVersion: currentHostApiVersion(),
    ...over,
  }
}

interface ActivateCall { id: string; dir: string; generation: number; permissions: string[] }

/** 起一台宿主：kernel 根 + dropped 根 + 假投放宿主端口 */
async function boot(opts: {
  kernelRoots?: string[]
  droppedRoots?: string[]
  disabledIds?: () => readonly string[]
} = {}) {
  const ctx = new Context()
  const activations: ActivateCall[] = []
  const deactivations: string[] = []
  const events: Record<string, unknown>[] = []
  const droppedChanges: DroppedPackageInfo[][] = []
  ctx.plugin(PluginHostService, {
    roots: [
      ...(opts.kernelRoots ?? []).map((dir) => ({ dir, tier: 'kernel' as const })),
      ...(opts.droppedRoots ?? []).map((dir) => ({ dir, tier: 'dropped' as const })),
    ],
    watch: false,
    disabledIds: opts.disabledIds ?? (() => []),
    droppedHost: {
      activate: (pkg) => activations.push({ ...pkg }),
      deactivate: (id) => deactivations.push(id),
    },
    log: (event) => events.push(event),
  })
  await ctx.start()
  ctx.on('dropped-plugins/changed', (list) => droppedChanges.push(list))
  const svc = ctx.plugins as PluginHostService
  return {
    ctx, svc, activations, deactivations, events, droppedChanges,
    dropped: () => svc.droppedInfo(),
  }
}

describe('投放档路由：dropped 根与内核路径分离（AC2/AC5）', () => {
  it('当前主版本零权限包 → 交给投放宿主激活；不进内核清单、不进 plugins/changed', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest())
    const { svc, ctx, activations } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(1)
    expect(activations[0]).toMatchObject({ id: 'widget-a', generation: 1, permissions: [] })
    expect(activations[0].dir).toBe(path.join(root, 'widget-a'))
    const dropped = svc.droppedInfo()
    expect(dropped).toHaveLength(1)
    expect(dropped[0]).toMatchObject({
      id: 'widget-a', status: 'ok',
      origin: 'deck-pkg://widget-a', hostApiVersion: currentHostApiVersion(),
    })
    // 内核路径零回归：快照 plugins 段不含投放包
    expect(svc.info().map((p) => p.id)).not.toContain('widget-a')
    await ctx.stop()
  })

  it('停用集对投放包生效：停用 → deactivate 且清单剔除；恢复 → 重新激活（AC1 停用/恢复）', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest())
    const disabled: string[] = []
    const { svc, activations, deactivations } = await boot({
      droppedRoots: [root],
      disabledIds: () => disabled,
    })
    expect(activations).toHaveLength(1)
    disabled.push('widget-a')
    svc.rescan()
    expect(deactivations).toEqual(['widget-a'])
    expect(svc.droppedInfo()).toHaveLength(0)
    disabled.length = 0
    svc.rescan()
    // 恢复：重新激活，代码代次不变（代码没变；上下文重建是另一回事）
    expect(activations).toHaveLength(2)
    expect(activations[1].generation).toBe(1)
    await Promise.resolve()
  })

  it('旧包（缺 hostApiVersion）→ 待迁移态 + 结构化迁移错误，不激活（AC5）', async () => {
    const root = tmpDir()
    const raw = baseManifest()
    delete raw.hostApiVersion
    writePackage(root, raw)
    const { svc, activations } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(0)
    const [info] = svc.droppedInfo()
    expect(info.status).toBe('pending-migration')
    expect(info.migrationIssues?.[0].code).toBe('host_api_version_missing')
    expect(info.migrationIssues?.[0].message).toContain('hostApiVersion')
    await Promise.resolve()
  })

  it('未知权限 → 待迁移态（permission_unknown）；已知敏感权限 → 待批准态不执行（AC1/AC5）', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest({ id: 'widget-bad', permissions: ['fs.raw'] }))
    writePackage(root, baseManifest({ id: 'widget-media', permissions: ['media.read'] }))
    const { svc, activations } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(0)
    const byId = new Map(svc.droppedInfo().map((p) => [p.id, p]))
    expect(byId.get('widget-bad')?.status).toBe('pending-migration')
    expect(byId.get('widget-bad')?.migrationIssues?.[0]).toMatchObject({ code: 'permission_unknown', unknown: ['fs.raw'] })
    expect(byId.get('widget-media')?.status).toBe('pending-approval')
    expect(byId.get('widget-media')?.migrationIssues).toBeNull()
    await Promise.resolve()
  })

  it('主版本不兼容 → 待迁移态（host_api_version_unsupported 带 expected/actual）', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest({ hostApiVersion: currentHostApiVersion() + 3 }))
    const { svc, activations } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(0)
    const [info] = svc.droppedInfo()
    expect(info.status).toBe('pending-migration')
    expect(info.migrationIssues?.[0]).toMatchObject({
      code: 'host_api_version_unsupported',
      expected: currentHostApiVersion(),
      actual: currentHostApiVersion() + 3,
    })
    await Promise.resolve()
  })

  it('结构坏 manifest → error 态（不是待迁移；沿用既有坏包语义）', async () => {
    const root = tmpDir()
    const raw = baseManifest()
    delete raw.name
    writePackage(root, raw)
    const { svc } = await boot({ droppedRoots: [root] })
    const [info] = svc.droppedInfo()
    expect(info.status).toBe('error')
    expect(info.error).toContain('name')
    await Promise.resolve()
  })

  it('入口资产缺失 → error 态（与内核档同口径：投递打不开的组件比不投递更糟）', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest(), null)
    const { svc } = await boot({ droppedRoots: [root] })
    const [info] = svc.droppedInfo()
    expect(info.status).toBe('error')
    expect(info.error).toContain('入口资产不存在')
    await Promise.resolve()
  })
})

describe('崩溃错误态（AC3：不自动重挂、换代才重建）', () => {
  it('markDroppedCrashed → crashed 态 + 崩溃事件；rescan 指纹未变不重新激活', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest())
    const { svc, activations, events } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(1)
    svc.markDroppedCrashed('widget-a', 'crashed')
    expect(svc.droppedInfo()[0].status).toBe('crashed')
    expect(events.some((e) => e.type === 'dropped-package-crashed' && e.id === 'widget-a')).toBe(true)
    // 看门狗/设置变化触发 rescan：指纹未变 → 不复活
    svc.rescan()
    expect(activations).toHaveLength(1)
    expect(svc.droppedInfo()[0].status).toBe('crashed')
    await Promise.resolve()
  })

  it('崩溃后代码内容变化（新代次）→ 换代重建：deactivate 旧 + activate 新代次', async () => {
    const root = tmpDir()
    const dir = writePackage(root, baseManifest())
    const { svc, activations, deactivations } = await boot({ droppedRoots: [root] })
    svc.markDroppedCrashed('widget-a', 'oom')
    fs.writeFileSync(path.join(dir, 'card.js'), 'export default { v: 2 }', 'utf8')
    svc.rescan()
    expect(deactivations).toEqual(['widget-a'])
    expect(activations).toHaveLength(2)
    expect(activations[1].generation).toBe(2)
    expect(svc.droppedInfo()[0].status).toBe('ok')
    await Promise.resolve()
  })
})

describe('生命周期事件与清单推送（验收磁带的断言来源）', () => {
  it('激活/停用/恢复/迁移全程落结构化事件（DECK_EVENT_LOG 可断言）', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest({ id: 'evt-a' }))
    const rawOld = baseManifest({ id: 'evt-old' })
    delete rawOld.hostApiVersion
    writePackage(root, rawOld)
    const disabled: string[] = []
    const { svc, events } = await boot({ droppedRoots: [root], disabledIds: () => disabled })
    expect(events.some((e) => e.type === 'dropped-package-activated' && e.id === 'evt-a')).toBe(true)
    expect(events.some((e) => e.type === 'dropped-package-migration' && e.id === 'evt-old')).toBe(true)
    disabled.push('evt-a')
    svc.rescan()
    expect(events.some((e) => e.type === 'dropped-package-deactivated' && e.id === 'evt-a')).toBe(true)
  })

  it('dropped-plugins/changed 随清单变化推送，承载同一份 DroppedPackageInfo', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest())
    const { svc, droppedChanges } = await boot({ droppedRoots: [root] })
    expect(svc.droppedInfo()).toHaveLength(1) // 构造期首扫已在册
    // 订阅后再变化：新增一包 → 事件推送且承载两包清单
    writePackage(root, baseManifest({ id: 'widget-b', name: '组件B' }))
    svc.rescan()
    expect(droppedChanges.length).toBeGreaterThan(0)
    const last = droppedChanges.at(-1) ?? []
    expect(last.map((p) => p.id)).toEqual(['widget-a', 'widget-b'])
    expect(last[0]).toMatchObject({ status: 'ok', origin: 'deck-pkg://widget-a' })
  })
})

describe('同 id 冲突与档位语义', () => {
  it('kernel 根先到先得：dropped 根同 id 包被忽略（内核档不被投放副本遮蔽），清单只进内核侧', async () => {
    const kernelRoot = tmpDir()
    const droppedRoot = tmpDir()
    fs.mkdirSync(path.join(kernelRoot, 'clock'), { recursive: true })
    fs.writeFileSync(path.join(kernelRoot, 'clock', 'plugin.json'), JSON.stringify(baseManifest({ id: 'clock', name: '时钟' })), 'utf8')
    fs.writeFileSync(path.join(kernelRoot, 'clock', 'card.js'), 'export default {}', 'utf8')
    writePackage(droppedRoot, baseManifest({ id: 'clock' }))
    const { svc, activations } = await boot({ kernelRoots: [kernelRoot], droppedRoots: [droppedRoot] })
    expect(activations).toHaveLength(0)
    expect(svc.info().map((p) => p.id)).toEqual(['clock'])
    expect(svc.droppedInfo()).toHaveLength(0)
    await Promise.resolve()
  })

  it('空 dropped 根 → 空清单不抛（目录可晚于面板创建）', async () => {
    const { svc } = await boot({ droppedRoots: [path.join(tmpDir(), 'not-yet')] })
    expect(svc.droppedInfo()).toEqual([])
    await Promise.resolve()
  })
})
