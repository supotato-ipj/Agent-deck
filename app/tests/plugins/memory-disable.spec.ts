import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { PluginHostService } from '../../src/main/plugins/service'
import type { DroppedPackageInfo } from '../../src/shared/contract'
import { currentHostApiVersion } from '../../src/main/plugins/catalog'
import { PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES } from '../../src/main/plugins/budget'

/**
 * 内存哨兵停用补偿（工单344，单测矩阵 4）：停用后包账与包文件不动、错误码正确、
 * 不自动重挂——哨兵永远不会误删用户的资产（spec 用户故事 12 的兜底）。
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mem-disable-'))
}

function writePackage(root: string, manifest: Record<string, unknown>, entryText: string): string {
  const dir = path.join(root, String(manifest.id))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest), 'utf8')
  fs.writeFileSync(path.join(dir, String(manifest.entry ?? './card.js').replace(/^\.\//, '')), entryText, 'utf8')
  return dir
}

function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'hog-a', name: '内存 hog', version: '1.0.0', entry: './card.js',
    hostApiVersion: currentHostApiVersion(),
    ...over,
  }
}

const FACTS = { bytes: 150 * 1024 * 1024, thresholdBytes: PACKAGE_MARGINAL_MEMORY_BUDGET_BYTES, rounds: 3 }

async function boot(opts: { droppedRoots?: string[] } = {}) {
  const ctx = new Context()
  const activations: Array<{ id: string; generation: number }> = []
  const deactivations: string[] = []
  const events: Record<string, unknown>[] = []
  const droppedChanges: DroppedPackageInfo[][] = []
  ctx.plugin(PluginHostService, {
    roots: (opts.droppedRoots ?? []).map((dir) => ({ dir, tier: 'dropped' as const })),
    watch: false,
    droppedHost: {
      activate: (pkg) => activations.push({ id: pkg.id, generation: pkg.generation }),
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

describe('内存哨兵停用补偿（工单344）', () => {
  it('停用即拆上下文 + status=error（错误码在文案）+ 停用审计事件含读数/阈值/轮数——账不删、包文件不动', async () => {
    const root = tmpDir()
    const dir = writePackage(root, baseManifest(), 'export default {}')
    const { svc, ctx, activations, deactivations, events, dropped } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(1)
    expect(svc.disableDroppedPackageForMemory('hog-a', FACTS)).toBe(true)
    // 幂等 deactivate 走宿主端口（强制销毁渲染进程在生产宿主内）
    expect(deactivations).toEqual(['hog-a'])
    // 账不删：dropped 清单保留该包、错误态、错误文案带契约错误码
    const info = dropped().find((p) => p.id === 'hog-a')
    expect(info).toBeTruthy()
    expect(info?.status).toBe('error')
    expect(info?.error ?? '').toContain('package_memory_exceeded')
    expect(info?.generation).toBe(activations[0]?.generation) // 代次保留（记账可追溯）
    // 包文件不动
    expect(fs.existsSync(path.join(dir, 'plugin.json'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'card.js'))).toBe(true)
    // 停用审计事件：reason 与 permission-revoked 同构，载荷含读数/阈值/轮数
    const evt = events.find((e) => e.type === 'dropped-package-deactivated' && e.reason === 'memory-budget-exceeded')
    expect(evt).toMatchObject({ id: 'hog-a', bytes: FACTS.bytes, thresholdBytes: FACTS.thresholdBytes, rounds: 3 })
    await ctx.stop()
  })

  it('rescan 不救回：指纹未变保持 error、绝不重激活（不自动重挂）', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest(), 'export default {}')
    const { svc, ctx, activations, dropped } = await boot({ droppedRoots: [root] })
    expect(activations).toHaveLength(1)
    expect(svc.disableDroppedPackageForMemory('hog-a', FACTS)).toBe(true)
    const callsBefore = activations.length
    svc.rescan()
    svc.rescan()
    expect(activations).toHaveLength(callsBefore) // 不自动重挂
    const info = dropped().find((p) => p.id === 'hog-a')
    expect(info?.status).toBe('error')
    expect(info?.error ?? '').toContain('package_memory_exceeded')
    await ctx.stop()
  })

  it('改码换代 = 显式恢复：新代次重新激活、停用标记清零', async () => {
    const root = tmpDir()
    const dir = writePackage(root, baseManifest(), 'export default {}')
    const { svc, ctx, activations, dropped } = await boot({ droppedRoots: [root] })
    expect(svc.disableDroppedPackageForMemory('hog-a', FACTS)).toBe(true)
    // 用户改包代码（显式换代）
    fs.writeFileSync(path.join(dir, 'card.js'), 'export default { mount(){} }', 'utf8')
    svc.rescan()
    expect(activations).toHaveLength(2)
    expect(activations[1]?.generation).toBe(activations[0]!.generation + 1)
    expect(dropped().find((p) => p.id === 'hog-a')?.status).toBe('ok')
    await ctx.stop()
  })

  it('幂等：重复停用与对不在运行态的包停用如实返回 false、不重放事件', async () => {
    const root = tmpDir()
    writePackage(root, baseManifest(), 'export default {}')
    const { svc, ctx, deactivations, events } = await boot({ droppedRoots: [root] })
    expect(svc.disableDroppedPackageForMemory('hog-a', FACTS)).toBe(true)
    expect(svc.disableDroppedPackageForMemory('hog-a', FACTS)).toBe(false) // 已是 error 态
    expect(svc.disableDroppedPackageForMemory('ghost', FACTS)).toBe(false) // 不在册
    expect(deactivations).toEqual(['hog-a'])
    expect(events.filter((e) => e.type === 'dropped-package-deactivated' && e.reason === 'memory-budget-exceeded')).toHaveLength(1)
    await ctx.stop()
  })

  it('与既有预算门不串线：package_budget_exceeded 的 error（非哨兵停用）在腾出槽位后 rescan 自动补位（ADR-0027 原语义不变）', async () => {
    const root = tmpDir()
    writePackage(root, { ...baseManifest(), id: 'hog-a' }, 'export default {}')
    writePackage(root, { ...baseManifest(), id: 'hog-b' }, 'export default {}')
    writePackage(root, { ...baseManifest(), id: 'hog-c' }, 'export default {}')
    const ctx = new Context()
    const activations: string[] = []
    ctx.plugin(PluginHostService, {
      roots: [{ dir: root, tier: 'dropped' as const }],
      watch: false,
      install: { stagingRoot: tmpDir(), userRoot: tmpDir(), sessionInfo: () => null, maxLivePackages: 2 },
      droppedHost: { activate: (pkg) => activations.push(pkg.id), deactivate: () => {} },
      log: () => {},
    })
    await ctx.start()
    const svc = ctx.plugins as PluginHostService
    // 3 包 2 槽：一个被预算门拒（error，非哨兵停用）
    expect(svc.droppedInfo().filter((p) => p.status === 'ok')).toHaveLength(2)
    const rejected = svc.droppedInfo().find((p) => p.status === 'error' && (p.error ?? '').includes('package_budget_exceeded'))
    expect(rejected).toBeTruthy()
    // 腾出槽位 → 下轮 rescan 自动补位（预算门是「每轮重试」，与哨兵停用的「不救回」分野）
    fs.rmSync(path.join(root, 'hog-a'), { recursive: true, force: true })
    svc.rescan()
    expect(svc.droppedInfo().find((p) => p.id === rejected?.id)?.status).toBe('ok')
    await ctx.stop()
  })
})
