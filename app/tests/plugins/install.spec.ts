import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PluginInstallManager, aggregateHashOf, type InstallProposalView } from '../../src/main/plugins/install'
import { currentHostApiVersion } from '../../src/main/plugins/catalog'

/**
 * DSH 安装管线状态机（工单334，ADR-0019 写入契约 / ADR-0025 批准面）：
 * 提交 → 校验 → 待批 → 批准（哈希绑定同一份字节）→ 原子转正 → 有界激活；
 * 每步失败注入 + 补偿完备性（无半装残留、无待装载区孤儿）+ 审计形状（意图/结局分离）。
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `deck-install-${prefix}-`))
}

const GOOD_MANIFEST = {
  id: 'dsh-hello', name: 'DSH HELLO', version: '1.0.0', entry: './card.js',
  hostApiVersion: currentHostApiVersion(), capabilities: ['clock'],
}
const GOOD_CARD = 'export default { mount(host) { host.el.textContent = "hello" } }\n'

interface Harness {
  mgr: PluginInstallManager
  userRoot: string
  stagingRoot: string
  kernelRoot: string
  workspace: string
  events: Record<string, unknown>[]
  proposals: InstallProposalView[][]
  rescans: number
  mountMode: { mode: 'ok' | 'fail' | 'hang'; message?: string }
  releaseMount: (() => void) | null
  dispose(): void
}

function writePluginDir(dir: string, manifest: unknown, cardText: string = GOOD_CARD, extraFiles: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2), 'utf8')
  const m = typeof manifest === 'string' ? {} : (manifest as Record<string, unknown>)
  if (typeof m.entry === 'string') {
    fs.writeFileSync(path.join(dir, String(m.entry).replace(/^\.\//, '')), cardText, 'utf8')
  }
  for (const [rel, text] of Object.entries(extraFiles)) {
    const target = path.join(dir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, text, 'utf8')
  }
}

let seq = 0

function boot(opts: { kernelPackages?: boolean; preExistingStaging?: boolean } = {}): Harness {
  const userRoot = tmpDir('user')
  const stagingRoot = tmpDir('staging')
  const kernelRoot = tmpDir('kernel')
  const workspace = tmpDir('ws')
  if (opts.kernelPackages) {
    writePluginDir(path.join(kernelRoot, 'deck-app'), { id: 'deck-app', name: '内置', version: '1', entry: './card.js' })
  }
  if (opts.preExistingStaging) {
    writePluginDir(path.join(stagingRoot, 'orphan-proposal'), GOOD_MANIFEST)
  }
  const events: Record<string, unknown>[] = []
  const proposals: InstallProposalView[][] = []
  let rescans = 0
  const mountMode: Harness['mountMode'] = { mode: 'ok' }
  let releaseMount: (() => void) | null = null
  const ctx = { userRoot, stagingRoot, kernelRoot, workspace, events, proposals, rescans, mountMode, releaseMount: releaseMount as Harness['releaseMount'] }

  const info = `#${++seq}`
  const mgr = new PluginInstallManager({
    userRoot,
    stagingRoot,
    kernelRoots: [kernelRoot],
    sessionInfo: (sessionId) => (sessionId === 'sess-1' ? { cwd: workspace, label: `会话${info}` } : null),
    log: (event) => events.push(event),
    notify: () => { /* 测试经 list() 读 */ },
    now: () => 1_700_000_000_000,
    opId: (() => { let n = 0; return () => `op-${++n}` })(),
    host: {
      rescan: () => { rescans++ },
      waitMount: (id, timeoutMs) => {
        void id; void timeoutMs
        if (mountMode.mode === 'ok') return Promise.resolve({ ok: true, message: null, unknown: false })
        if (mountMode.mode === 'fail') return Promise.resolve({ ok: false, message: mountMode.message ?? 'mount failed', unknown: false })
        return new Promise((resolve) => { releaseMount = () => resolve({ ok: true, message: null, unknown: false }) })
      },
    },
    mountBoundMs: 200,
  })
  const harness: Harness = {
    mgr, userRoot, stagingRoot, kernelRoot, workspace,
    events, proposals, get rescans() { return rescans }, mountMode,
    get releaseMount() { return releaseMount },
    dispose() {
      mgr.dispose()
      for (const d of [userRoot, stagingRoot, kernelRoot, workspace]) fs.rmSync(d, { recursive: true, force: true })
    },
  }
  return harness
}

/** 提交一个合格包（在会话工作区下落盘 → submit） */
async function submitGood(h: Harness, id = 'dsh-hello', dirName = 'hello-pkg'): Promise<Awaited<ReturnType<PluginInstallManager['submit']>>> {
  const src = path.join(h.workspace, dirName)
  writePluginDir(src, { ...GOOD_MANIFEST, id })
  return h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
}

describe('安装管线：提交（守卫 → 待装载区 → 严格校验 → 哈希 → 提案）', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('合格零权限包：提案 pending + 字节进待装载区 + 用户根不动 + 审计意图在案', async () => {
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok || out.status !== 'pending-approval') throw new Error('形状不符')
    expect(out.proposal.status).toBe('pending')
    expect(out.proposal.pkg.id).toBe('dsh-hello')
    expect(out.proposal.pkg.permissions).toEqual([])
    expect(out.proposal.files.map((f) => f.path).sort()).toEqual(['card.js', 'plugin.json'])
    for (const f of out.proposal.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(f.sizeBytes).toBeGreaterThan(0)
    }
    expect(out.proposal.hash).toMatch(/^[0-9a-f]{64}$/)
    // 待装载区纪律：staging 有副本（proposalId 命名），用户根无目录
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId, 'plugin.json'))).toBe(true)
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello'))).toBe(false)
    // 审计：意图在案（含 opId/来源/哈希），结局尚未发生
    const intent = h.events.find((e) => e.type === 'plugin-install-intent')
    expect(intent).toBeTruthy()
    expect(intent!['opId']).toBe(out.opId)
    expect(intent!['sessionId']).toBe('sess-1')
    expect(intent!['hash']).toBe(out.proposal.hash)
    expect(h.events.find((e) => e.type === 'plugin-install-outcome')).toBeUndefined()
    // 提案可读（批准 UI 数据面）
    expect(h.mgr.list().map((p) => p.proposalId)).toContain(out.proposal.proposalId)
  })

  it('同一份字节：文件哈希与聚合哈希可独立复算（绑定面可验证）', async () => {
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('提交失败')
    const lines = [...out.proposal.files]
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((f) => `${f.path}:${f.sha256}\n`).join('')
    const expectAgg = createHash('sha256').update(lines).digest('hex')
    expect(out.proposal.hash).toBe(expectAgg)
    // aggregateHashOf 工具函数与管线同源
    const staged = path.join(h.stagingRoot, out.proposal.proposalId)
    expect(aggregateHashOf(staged)).toBe(expectAgg)
  })

  it('sourceDir 形状守卫：缺失/相对路径/不存在/不是目录 → invalid_args / invalid_source', async () => {
    const noArg = await h.mgr.submit({}, { sessionId: 'sess-1', backend: 'dsh' })
    expect(noArg).toMatchObject({ ok: false, code: 'invalid_args' })
    const rel = await h.mgr.submit({ sourceDir: 'hello' }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(rel).toMatchObject({ ok: false, code: 'invalid_args' })
    const missing = await h.mgr.submit({ sourceDir: path.join(h.workspace, 'nope') }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(missing).toMatchObject({ ok: false, code: 'invalid_source' })
    const file = path.join(h.workspace, 'afile.txt')
    fs.writeFileSync(file, 'x', 'utf8')
    const notDir = await h.mgr.submit({ sourceDir: file }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(notDir).toMatchObject({ ok: false, code: 'invalid_source' })
    expect(h.mgr.list()).toEqual([])
  })

  it('越界守卫：插件根/待装载区/内核根内与未知会话 → invalid_source，不留副本', async () => {
    const inUser = path.join(h.userRoot, 'pkg-in-user')
    writePluginDir(inUser, GOOD_MANIFEST)
    const inStaging = path.join(h.stagingRoot, 'pkg-in-staging')
    writePluginDir(inStaging, GOOD_MANIFEST)
    const inKernel = path.join(h.kernelRoot, 'pkg-in-kernel')
    writePluginDir(inKernel, GOOD_MANIFEST)
    for (const src of [inUser, inStaging, inKernel]) {
      const out = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_source' })
    }
    const unknownSession = await h.mgr.submit(
      { sourceDir: path.join(h.workspace, 'x') }, { sessionId: 'sess-other', backend: 'dsh' })
    expect(unknownSession).toMatchObject({ ok: false, code: 'invalid_args' })
    // 工作区包含校验：会话工作区之外的合法目录也拒（DSH 只许交自己工作区的字节）
    const outside = tmpDir('outside')
    try {
      writePluginDir(path.join(outside, 'pkg'), GOOD_MANIFEST)
      const out = await h.mgr.submit({ sourceDir: path.join(outside, 'pkg') }, { sessionId: 'sess-1', backend: 'dsh' })
      expect(out).toMatchObject({ ok: false, code: 'invalid_source' })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
    expect(fs.readdirSync(h.stagingRoot)).toEqual([])
  })

  it('坏 manifest（非法 JSON）→ invalid_package + 结构化 issues + 副本清偿', async () => {
    const src = path.join(h.workspace, 'bad')
    writePluginDir(src, '{ "id": not json')
    const out = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('形状不符')
    expect(out.code).toBe('invalid_package')
    expect(out.issues?.length).toBeGreaterThan(0)
    expect(out.issues![0].code).toBe('manifest_invalid')
    expect(fs.readdirSync(h.stagingRoot)).toEqual([])
  })

  it('迁移问题 manifest（缺 hostApiVersion）→ invalid_package + 迁移码', async () => {
    const src = path.join(h.workspace, 'old')
    writePluginDir(src, { id: 'old-pkg', name: '旧包', version: '1', entry: './card.js' })
    const out = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok).toBe(false)
    if (out.ok) throw new Error('形状不符')
    expect(out.code).toBe('invalid_package')
    expect(out.issues?.some((i) => i.code === 'host_api_version_missing')).toBe(true)
    expect(fs.existsSync(path.join(h.userRoot, 'old-pkg'))).toBe(false)
  })

  it('含敏感权限的包 → permission_deferred（代次批准持久化归 #335，本票零权限边界）+ 副本清偿', async () => {
    const src = path.join(h.workspace, 'media')
    writePluginDir(src, { ...GOOD_MANIFEST, id: 'media-pkg', permissions: ['media.read'] })
    const out = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out).toMatchObject({ ok: false, code: 'permission_deferred' })
    expect(fs.readdirSync(h.stagingRoot)).toEqual([])
  })

  it('id 冲突：内核根在册 id / 保留 id app / 用户根已有 id → id_conflict + 副本清偿', async () => {
    h.dispose()
    const h2 = boot({ kernelPackages: true })
    try {
      writePluginDir(path.join(h2.workspace, 'p1'), { ...GOOD_MANIFEST, id: 'deck-app' })
      expect(await h2.mgr.submit({ sourceDir: path.join(h2.workspace, 'p1') }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'id_conflict' })
      writePluginDir(path.join(h2.workspace, 'p2'), { ...GOOD_MANIFEST, id: 'app' })
      const reserved = await h2.mgr.submit({ sourceDir: path.join(h2.workspace, 'p2') }, { sessionId: 'sess-1', backend: 'dsh' })
      expect(reserved).toMatchObject({ ok: false, code: 'id_conflict' })
      expect(reserved.ok === false && (reserved as { existing?: unknown }).existing !== undefined).toBe(true)
      // 用户根已有同 id
      writePluginDir(path.join(h2.userRoot, 'dsh-hello'), GOOD_MANIFEST)
      writePluginDir(path.join(h2.workspace, 'p3'), GOOD_MANIFEST)
      expect(await h2.mgr.submit({ sourceDir: path.join(h2.workspace, 'p3') }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'id_conflict' })
      expect(fs.readdirSync(h2.stagingRoot)).toEqual([])
    } finally {
      h2.dispose()
    }
  })

  it('包格式上限：超限单文件/超总量/文件数/非法扩展名/node_modules/深度 → invalid_package issues', async () => {
    const big = path.join(h.workspace, 'big')
    writePluginDir(big, GOOD_MANIFEST, GOOD_CARD, { 'blob.bin': 'x'.repeat(3 * 1024 * 1024) })
    let out = await h.mgr.submit({ sourceDir: big }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok === false && out.code === 'invalid_package' && out.issues?.some((i) => i.code === 'limit_file_size')).toBe(true)

    const ext = path.join(h.workspace, 'ext')
    writePluginDir(ext, GOOD_MANIFEST, GOOD_CARD, { 'run.exe': 'MZ' })
    out = await h.mgr.submit({ sourceDir: ext }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok === false && out.issues?.some((i) => i.code === 'extension_not_allowed')).toBe(true)

    const nm = path.join(h.workspace, 'nm')
    writePluginDir(nm, GOOD_MANIFEST, GOOD_CARD, { 'node_modules/left-pad/index.js': 'x' })
    out = await h.mgr.submit({ sourceDir: nm }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok === false && out.issues?.some((i) => i.code === 'forbidden_entry')).toBe(true)

    const deep = path.join(h.workspace, 'deep')
    writePluginDir(deep, GOOD_MANIFEST, GOOD_CARD, { 'a/b/c/d/e/f/g/h/i.js': 'x' })
    out = await h.mgr.submit({ sourceDir: deep }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok === false && out.issues?.some((i) => i.code === 'limit_path_depth')).toBe(true)

    // 符号链接：包内任何 symlink/junction 条目即拒（拷贝前 lstat 预walk，不追出去拷）——
    // Windows 无符号链接特权（EPERM），夹具用 directory junction（Node 同报 isSymbolicLink）
    const sym = path.join(h.workspace, 'sym')
    writePluginDir(sym, GOOD_MANIFEST, GOOD_CARD)
    fs.symlinkSync(h.workspace, path.join(sym, 'link'), 'junction')
    out = await h.mgr.submit({ sourceDir: sym }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok === false && out.issues?.some((i) => i.code === 'symlink_rejected')).toBe(true)

    expect(fs.readdirSync(h.stagingRoot)).toEqual([])
  })
})

describe('安装管线：批准（哈希绑定 → 原子转正 → 有界激活 → 补偿）', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('批准全链：复算哈希 → 转正（用户根出现）→ rescan → mount ok → activated + 审计结局', async () => {
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('提交失败')
    const proposalId = out.proposal.proposalId
    const decided = await h.mgr.approve(proposalId)
    expect(decided).toMatchObject({ ok: true, status: 'activated' })
    // 转正：用户根有包目录，待装载区副本消失（同一份字节移入）
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello', 'plugin.json'))).toBe(true)
    expect(fs.existsSync(path.join(h.stagingRoot, proposalId))).toBe(false)
    expect(h.rescans).toBeGreaterThanOrEqual(1)
    const view = h.mgr.list().find((p) => p.proposalId === proposalId)
    expect(view?.status).toBe('activated')
    const outcome = h.events.find((e) => e.type === 'plugin-install-outcome')
    expect(outcome).toMatchObject({ opId: out.opId, proposalId, outcome: 'activated' })
  })

  it('哈希绑定：待装载区字节在批准前被篡改 → hash_mismatch，转正不发生、副本清偿', async () => {
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('提交失败')
    const proposalId = out.proposal.proposalId
    fs.writeFileSync(path.join(h.stagingRoot, proposalId, 'card.js'), 'export default {} // tampered\n', 'utf8')
    const decided = await h.mgr.approve(proposalId)
    expect(decided).toMatchObject({ ok: false, code: 'hash_mismatch' })
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello'))).toBe(false)
    expect(fs.existsSync(path.join(h.stagingRoot, proposalId))).toBe(false)
    const view = h.mgr.list().find((p) => p.proposalId === proposalId)
    expect(view?.status).toBe('failed')
    expect(h.rescans).toBe(0)
  })

  it('激活确定失败：mount failed → 用户根补偿移除 + 再 rescan + activation_failed(rollback removed)', async () => {
    h.mountMode.mode = 'fail'
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('提交失败')
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided.ok).toBe(false)
    if (decided.ok) throw new Error('形状不符')
    expect(decided.code).toBe('activation_failed')
    expect(decided.rollback).toBe('removed')
    // 补偿完备：用户根无残留、待装载区无孤儿
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello'))).toBe(false)
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId))).toBe(false)
    expect(h.rescans).toBe(2) // 转正后一次 + 补偿后一次
    const outcome = h.events.find((e) => e.type === 'plugin-install-outcome')
    expect(outcome).toMatchObject({ outcome: 'activation_failed', rollback: 'removed' })
    const view = h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)
    expect(view?.status).toBe('failed')
    expect(view?.error?.code).toBe('activation_failed')
  })

  it('激活结果未知：mount 超时 → stateUnknown、不猜补偿（目录保留）、审计 activation_unknown、不自动重试', async () => {
    h.mountMode.mode = 'hang'
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('提交失败')
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided.ok).toBe(false)
    if (decided.ok) throw new Error('形状不符')
    expect(decided.code).toBe('activation_unknown')
    expect(decided.stateUnknown).toBe(true)
    // 结果未知：不猜补偿——转正目录保留（实况以 plugins_list 对账），不自动重试
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello', 'plugin.json'))).toBe(true)
    const outcome = h.events.find((e) => e.type === 'plugin-install-outcome')
    expect(outcome).toMatchObject({ outcome: 'activation_unknown', stateUnknown: true })
    expect(h.events.filter((e) => e.type === 'plugin-install-intent')).toHaveLength(1)
    const view = h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)
    expect(view?.status).toBe('failed')
    expect(view?.error?.stateUnknown).toBe(true)
  })

  it('拒绝：待装载区副本清偿 + gate_denied 审计 + 提案 rejected，用户根从未出现', async () => {
    const out = await submitGood(h)
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('提交失败')
    const rejected = await h.mgr.reject(out.proposal.proposalId)
    expect(rejected).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId))).toBe(false)
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello'))).toBe(false)
    expect(h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)?.status).toBe('rejected')
    expect(h.events.find((e) => e.type === 'plugin-install-outcome')).toMatchObject({ outcome: 'gate_denied' })
  })

  it('批准/拒绝未知或不Pending提案 → not_found（幂等拒绝已决提案）', async () => {
    expect(await h.mgr.approve('nope')).toMatchObject({ ok: false, code: 'not_found' })
    expect(await h.mgr.reject('nope')).toMatchObject({ ok: false, code: 'not_found' })
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    await h.mgr.reject(out.proposal.proposalId)
    expect(await h.mgr.approve(out.proposal.proposalId)).toMatchObject({ ok: false, code: 'not_found' })
  })
})

describe('安装管线：串行化与孤儿清偿', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('并发提交：在途写期间第二发 → busy（唯一可重试码），不产生第二提案', async () => {
    const out1P = submitGood(h, 'dsh-one', 'one')
    // 第一发在 waitMount(hang) 中……submit 本身不等 mount——busy 窗口在 submit 的拷贝/校验段。
    // 用受控挂起找不到 submit 内部缝；改为直接验证：approve 在途（hang）期间新 submit → busy。
    const out1 = await out1P
    if (!out1.ok) throw new Error('提交失败')
    h.mountMode.mode = 'hang'
    const approveP = h.mgr.approve(out1.proposal.proposalId)
    const src2 = path.join(h.workspace, 'two')
    writePluginDir(src2, { ...GOOD_MANIFEST, id: 'dsh-two' })
    const out2 = await h.mgr.submit({ sourceDir: src2 }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out2).toMatchObject({ ok: false, code: 'busy' })
    expect(out2.ok === false && out2.retryable).toBe(true)
    h.mountMode.mode = 'ok'
    h.releaseMount?.()
    expect(await approveP).toMatchObject({ ok: true })
  })

  it('孤儿清偿：构造期清扫既有待装载区残留；dispose 清偿在途提案副本', async () => {
    h.dispose()
    const h2 = boot({ preExistingStaging: true })
    try {
      expect(fs.readdirSync(h2.stagingRoot)).toEqual([])
      const out = await submitGood(h2)
      if (!out.ok) throw new Error('提交失败')
      expect(fs.existsSync(path.join(h2.stagingRoot, out.proposal.proposalId))).toBe(true)
      h2.mgr.dispose()
      expect(fs.existsSync(h2.stagingRoot)).toBe(false)
    } finally {
      h2.dispose()
    }
  })
})
