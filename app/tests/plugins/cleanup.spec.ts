import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PluginInstallManager } from '../../src/main/plugins/install'

/**
 * 工单346 插件数据清理 + 卸载发起者记账：
 * - 卸载事件补 actor（UI 桥 'user' / MCP 'dsh'，缺省 dsh——历史唯一调用方是 DSH）；
 * - 清理面 = 两类只增不减的遗留：换代备份残渣（plugins-backup/old-*，正常换代已自动
 *   送回收站，残渣=送站失败者）与脱离配置（<id>.json.detached，拒绝继承被脱离挂载）；
 * - 只删目标类（在册包与当前配置绝不动）、统一回收站（失败保留可重试，绝不永久删）、
 *   批量一笔账（plugin-cleanup-intent/outcome，opId 串全程）。
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deck-cleanup-${prefix}-`))
}

interface Harness {
  mgr: PluginInstallManager
  userRoot: string
  backupRoot: string
  configDir: string
  events: Record<string, unknown>[]
  trashCalls: string[]
  /** 注入：这些 ref（目录名/文件名）送回收站时失败 */
  failRefs: Set<string>
  dispose(): void
}

let seq = 0

function boot(opts: { trash?: 'ok' | 'none' } = {}): Harness {
  const userRoot = tmpDir('user')
  const stagingRoot = tmpDir('staging')
  const kernelRoot = tmpDir('kernel')
  const backupRoot = tmpDir('backup')
  const configDir = tmpDir('cfg')
  const events: Record<string, unknown>[] = []
  const trashCalls: string[] = []
  const failRefs = new Set<string>()
  const mgr = new PluginInstallManager({
    userRoot,
    stagingRoot,
    kernelRoots: [kernelRoot],
    sessionInfo: () => null,
    log: (event) => events.push(event),
    notify: () => { /* 测试经返回值读 */ },
    now: () => 1_700_000_000_000,
    opId: (() => { let n = 0; return () => `op-${++n}` })(),
    host: { rescan: () => {}, waitMount: () => Promise.resolve({ ok: true, message: null, unknown: false }) },
    mountBoundMs: 200,
    backupRoot,
    ...(opts.trash !== 'none'
      ? { trashItem: (dir: string) => {
          trashCalls.push(dir)
          if (failRefs.has(path.basename(dir))) return Promise.reject(new Error('回收站不可用（注入失败）'))
          try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力 */ }
          return Promise.resolve()
        } }
      : {}),
    pluginConfigFile: (id: string) => path.join(configDir, `${id}.json`),
  })
  const harness: Harness = {
    mgr, userRoot, backupRoot, configDir, events, trashCalls, failRefs,
    dispose() {
      mgr.dispose()
      for (const d of [userRoot, stagingRoot, kernelRoot, backupRoot, configDir]) fs.rmSync(d, { recursive: true, force: true })
    },
  }
  return harness
}

/** 在用户根落一个在册投放包（卸载/清理绝不许碰它） */
function writePackage(h: Harness, id = 'pkg-live'): void {
  fs.mkdirSync(path.join(h.userRoot, id), { recursive: true })
  fs.writeFileSync(path.join(h.userRoot, id, 'plugin.json'), JSON.stringify({ id, name: id, version: '1.0.0', entry: './card.js' }), 'utf8')
}

/** 造一个换代备份残渣目录（approveUpdate 同款命名：old-<pkgId>-<opId>，内含旧包目录内容） */
function writeBackup(h: Harness, pkgId: string, opTag: string, files: Record<string, string> = { 'plugin.json': '{}' }): string {
  const dir = path.join(h.backupRoot, `old-${pkgId}-${opTag}`)
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    fs.writeFileSync(path.join(dir, rel), text, 'utf8')
  }
  return dir
}

/** 造一个脱离配置文件（settleInheritance 同款命名：<pkgId>.json.detached） */
function writeDetached(h: Harness, pkgId: string, text = '{"legacy":true}'): string {
  const file = path.join(h.configDir, `${pkgId}.json.detached`)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

describe('卸载发起者记账（工单346）：actor 进审计事件', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('actor=user（UI 桥路径）→ intent/outcome 都带 actor', async () => {
    writePackage(h)
    const out = await h.mgr.uninstall({ packageId: 'pkg-live', actor: 'user' })
    expect(out.ok).toBe(true)
    const intent = h.events.find((e) => e.type === 'plugin-uninstall-intent')
    const outcome = h.events.find((e) => e.type === 'plugin-uninstall-outcome')
    expect(intent).toMatchObject({ actor: 'user' })
    expect(outcome).toMatchObject({ actor: 'user' })
  })

  it('缺省 actor（MCP 历史路径）→ 记 dsh', async () => {
    writePackage(h)
    const out = await h.mgr.uninstall({ packageId: 'pkg-live' })
    expect(out.ok).toBe(true)
    const intent = h.events.find((e) => e.type === 'plugin-uninstall-intent')
    const outcome = h.events.find((e) => e.type === 'plugin-uninstall-outcome')
    expect(intent).toMatchObject({ actor: 'dsh' })
    expect(outcome).toMatchObject({ actor: 'dsh' })
  })
})

describe('插件数据清理（工单346）：列条目', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('两类遗留各列一条：kind/ref/pkgId/bytes/modifiedAt 齐', () => {
    writeBackup(h, 'pkg-a', 'op-3')
    writeDetached(h, 'pkg-b')
    const res = h.mgr.listCleanup()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entries).toHaveLength(2)
    const backup = res.entries.find((e) => e.kind === 'backup')
    const detached = res.entries.find((e) => e.kind === 'detached')
    expect(backup).toMatchObject({ ref: 'old-pkg-a-op-3', pkgId: 'pkg-a' })
    expect(backup?.bytes).toBeGreaterThan(0)
    expect(backup?.modifiedAt).toBeGreaterThan(0)
    expect(detached).toMatchObject({ ref: 'pkg-b.json.detached', pkgId: 'pkg-b' })
    expect(detached?.bytes).toBeGreaterThan(0)
  })

  it('只列目标类：非 old-* 目录、当前配置 <id>.json、在册包目录都不出列', () => {
    writeBackup(h, 'pkg-a', 'op-3')
    writeDetached(h, 'pkg-b')
    // 干扰项：备份根下的普通目录 / 配置根下的在用配置 / 用户根在册包
    fs.mkdirSync(path.join(h.backupRoot, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(h.backupRoot, 'notes', 'x.txt'), 'x')
    fs.writeFileSync(path.join(h.configDir, 'pkg-live.json'), '{"current":true}')
    writePackage(h)
    const res = h.mgr.listCleanup()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entries.map((e) => e.ref).sort()).toEqual(['old-pkg-a-op-3', 'pkg-b.json.detached'])
  })

  it('两类都没有 → 空清单（不报错）', () => {
    const res = h.mgr.listCleanup()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.entries).toEqual([])
  })
})

describe('插件数据清理（工单346）：送回收站（批量一笔账）', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('两类各一条全清：回收站收到正确路径、条目消失、在册包与当前配置原样、事件成对', async () => {
    writeBackup(h, 'pkg-a', 'op-3')
    const detachedFile = writeDetached(h, 'pkg-b')
    writePackage(h)
    fs.writeFileSync(path.join(h.configDir, 'pkg-live.json'), '{"current":true}')

    const out = await h.mgr.cleanup({
      entries: [
        { kind: 'backup', ref: 'old-pkg-a-op-3' },
        { kind: 'detached', ref: 'pkg-b.json.detached' },
      ],
    })
    expect(out.ok).toBe(true)
    // 回收站路径各就位（备份根内目录、配置根内文件）
    expect(h.trashCalls).toEqual([path.join(h.backupRoot, 'old-pkg-a-op-3'), detachedFile])
    // 条目消失；在册包与当前配置绝不动
    expect(fs.existsSync(path.join(h.backupRoot, 'old-pkg-a-op-3'))).toBe(false)
    expect(fs.existsSync(detachedFile)).toBe(false)
    expect(fs.existsSync(path.join(h.userRoot, 'pkg-live', 'plugin.json'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(h.configDir, 'pkg-live.json'), 'utf8'))).toEqual({ current: true })
    // 审计：intent/outcome 成对、opId 串全程、批量一笔账、bytes 为正
    const intent = h.events.find((e) => e.type === 'plugin-cleanup-intent')
    const outcome = h.events.find((e) => e.type === 'plugin-cleanup-outcome')
    expect(intent).toMatchObject({ actor: 'user', entries: [{ kind: 'backup', ref: 'old-pkg-a-op-3' }, { kind: 'detached', ref: 'pkg-b.json.detached' }] })
    expect(outcome).toMatchObject({ actor: 'user', outcome: 'cleaned', opId: intent?.['opId'] })
    expect(Number(outcome?.['bytes'])).toBeGreaterThan(0)
  })

  it('部分失败：失败条目保留可重试、结局 trash_failed、明细进事件；成功条目已清', async () => {
    writeBackup(h, 'pkg-a', 'op-3')
    writeDetached(h, 'pkg-b')
    h.failRefs.add('old-pkg-a-op-3') // 注入：备份条目送站失败

    const out = await h.mgr.cleanup({
      entries: [
        { kind: 'backup', ref: 'old-pkg-a-op-3' },
        { kind: 'detached', ref: 'pkg-b.json.detached' },
      ],
    })
    expect(out).toMatchObject({ ok: false, code: 'trash_failed' })
    // 失败条目原样保留（未降级永久删除）；成功条目已清
    expect(fs.existsSync(path.join(h.backupRoot, 'old-pkg-a-op-3'))).toBe(true)
    expect(fs.existsSync(path.join(h.configDir, 'pkg-b.json.detached'))).toBe(false)
    const outcome = h.events.find((e) => e.type === 'plugin-cleanup-outcome')
    expect(outcome).toMatchObject({ outcome: 'trash_failed', actor: 'user' })
    expect(outcome?.['cleanedRefs']).toEqual(['pkg-b.json.detached'])
  })

  it('恶意/非法 ref 一律拒绝且零回收站调用：路径穿越、绝对路径、错前后缀、非法 kind、非数组', async () => {
    writeBackup(h, 'pkg-a', 'op-3')
    const bad: unknown[] = [
      { kind: 'backup', ref: '../evil' },
      { kind: 'backup', ref: '..\\evil' },
      { kind: 'backup', ref: 'D:\\evil' },
      { kind: 'backup', ref: 'pkg-a' },
      { kind: 'detached', ref: 'pkg-a.json' },
      { kind: 'other', ref: 'old-pkg-a-op-3' },
      'not-an-object',
    ]
    for (const entries of [[bad[0]], [bad[1]], [bad[2]], [bad[3]], [bad[4]], [bad[5]], [bad[6]], bad, []]) {
      const out = await h.mgr.cleanup({ entries: entries as never })
      expect(out).toMatchObject({ ok: false, code: 'invalid_args' })
    }
    expect(h.trashCalls).toEqual([])
    expect(fs.existsSync(path.join(h.backupRoot, 'old-pkg-a-op-3'))).toBe(true)
  })

  it('不存在的 ref（清单已过期）→ not_found，零删除', async () => {
    const out = await h.mgr.cleanup({ entries: [{ kind: 'backup', ref: 'old-ghost-op-9' }] })
    expect(out).toMatchObject({ ok: false, code: 'not_found' })
    expect(h.trashCalls).toEqual([])
  })
})
