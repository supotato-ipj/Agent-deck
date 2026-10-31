import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { PluginInstallManager, aggregateHashOf, listFileEntries, permissionGate, type InstallProposalView } from '../../src/main/plugins/install'
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
  backupRoot: string
  configDir: string
  events: Record<string, unknown>[]
  proposals: InstallProposalView[][]
  rescans: number
  mountMode: { mode: 'ok' | 'fail' | 'hang'; message?: string }
  releaseMount: (() => void) | null
  /** 工单335：回收站端口调用记录（路径按序） */
  trashCalls: string[]
  /** 工单335：停用/启用端口调用记录 */
  enabledCalls: Array<{ id: string; enabled: boolean }>
  /** 工单336：授权账端口调用记录（grant/revoke/clear 按序） */
  authCalls: Array<{ op: 'grant' | 'revoke' | 'clear'; id: string; permissions?: string[]; codeHash?: string; origins?: string[] }>
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

function boot(opts: {
  kernelPackages?: boolean
  preExistingStaging?: boolean
  /** 工单335：回收站端口行为（缺省 ok；'fail' = trash 拒绝注入；'none' = 不装配端口） */
  trash?: 'ok' | 'fail' | 'none'
  /** 工单335：不装配私有配置路径端口（旧数据继承面缺省） */
  noConfigPort?: boolean
  /** 工单335：不装配停用/启用端口 */
  noEnabledPort?: boolean
} = {}): Harness {
  const userRoot = tmpDir('user')
  const stagingRoot = tmpDir('staging')
  const kernelRoot = tmpDir('kernel')
  const workspace = tmpDir('ws')
  const backupRoot = tmpDir('backup')
  const configDir = tmpDir('cfg')
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
  const trashCalls: string[] = []
  const enabledCalls: Harness['enabledCalls'] = []
  const authCalls: Harness['authCalls'] = []
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
    backupRoot,
    ...(opts.trash !== 'none'
      ? { trashItem: (dir: string) => {
          trashCalls.push(dir)
          if (opts.trash === 'fail') return Promise.reject(new Error('回收站不可用（注入失败）'))
          // 真 shell.trashItem 语义：目录移出原位（进回收站）——成功即从用户根消失
          try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 尽力 */ }
          return Promise.resolve()
        } }
      : {}),
    ...(opts.noConfigPort ? {} : { pluginConfigFile: (id: string) => path.join(configDir, `${id}.json`) }),
    ...(opts.noEnabledPort
      ? {}
      : { setCardEnabled: (id: string, enabled: boolean) => {
          enabledCalls.push({ id, enabled })
          return { disabledCards: enabled ? [] : [id] }
        } }),
    authorization: {
      grant: (id, permissions, codeHash, origins) => { authCalls.push({ op: 'grant', id, permissions, codeHash, ...(origins && origins.length ? { origins } : {}) }) },
      revoke: (id) => { authCalls.push({ op: 'revoke', id }) },
      clear: (id) => { authCalls.push({ op: 'clear', id }) },
    },
  })
  const harness: Harness = {
    mgr, userRoot, stagingRoot, kernelRoot, workspace, backupRoot, configDir,
    events, proposals, get rescans() { return rescans }, mountMode,
    get releaseMount() { return releaseMount },
    trashCalls, enabledCalls, authCalls,
    dispose() {
      mgr.dispose()
      for (const d of [userRoot, stagingRoot, kernelRoot, workspace, backupRoot, configDir]) fs.rmSync(d, { recursive: true, force: true })
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

  it('network.request 通路已开放（#338）：提交走提案而非 permission_deferred', async () => {
    const src = path.join(h.workspace, 'media')
    writePluginDir(src, { ...GOOD_MANIFEST, id: 'net-pkg', permissions: ['network.request'], networkOrigins: ['http://127.0.0.1:47823'] })
    const out = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out).toMatchObject({ ok: true, status: 'pending-approval' })
  })

  it('permissionGate 对未来权限仍然拦（闸门为后续票保留）', () => {
    // 目录封闭意味着真实包走不到这里；直接喂一个未来权限串守住闸门语义
    const gate = permissionGate({
      id: 'future', name: 'F', version: '1.0.0', entry: './card.js', hostApiVersion: 1,
      permissions: ['media.read', 'future.permission'], optionalPermissions: [], networkOrigins: [], capabilities: [],
    })
    expect(gate).toMatchObject({ code: 'permission_deferred' })
    expect(String(gate?.message)).toContain('future.permission')
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

// ---------------------------------------------------------------------------
// 工单335：更新提案与代次（同族扩展）——update 提交/diff/no_change、待批旧代次不动、
// 批准=原子换代（备份→落位→有界激活→旧版回收站）、拒绝不影响旧代次。
// ---------------------------------------------------------------------------

/** 安装并批准一个包（后续 update/no_change/uninstall 测试的在册前提） */
async function installGood(h: Harness, id = 'dsh-hello', dirName = 'hello-pkg'): Promise<string> {
  const out = await submitGood(h, id, dirName)
  if (!out.ok) throw new Error(`前提安装失败：${JSON.stringify(out)}`)
  const decided = await h.mgr.approve(out.proposal.proposalId)
  if (!decided.ok) throw new Error(`前提批准失败：${JSON.stringify(decided)}`)
  return out.proposal.proposalId
}

/** 写一个「更新版」包目录（card.js 文本与版本变化） */
function writeUpdateDir(h: Harness, dirName: string, id: string, version = '1.1.0', cardText = 'export default { mount(host) { host.el.textContent = "hello v2" } }\n'): string {
  const src = path.join(h.workspace, dirName)
  writePluginDir(src, { ...GOOD_MANIFEST, id, version }, cardText)
  return src
}

describe('更新提案：提交（同族守卫 → diff → no_change → pending）', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('更新提交：提案 pending 带 update diff（files.changed/permissions delta/版本旧→新），旧代次字节原样在用户根', async () => {
    await installGood(h)
    const oldBytes = fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')
    const src = writeUpdateDir(h, 'upd-pkg', 'dsh-hello')
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out.ok).toBe(true)
    if (!out.ok || out.status !== 'pending-approval') throw new Error('形状不符')
    const p = out.proposal
    expect(p.status).toBe('pending')
    expect(p.pkg.id).toBe('dsh-hello')
    expect(p.pkg.version).toBe('1.1.0')
    expect(p.update).toBeTruthy()
    expect(p.update!.packageId).toBe('dsh-hello')
    expect(p.update!.oldVersion).toBe('1.0.0')
    expect(p.update!.newVersion).toBe('1.1.0')
    expect(p.update!.files.changed).toEqual(['card.js', 'plugin.json']) // card 文本 + manifest 版本都变了
    expect(p.update!.files.added).toEqual([])
    expect(p.update!.files.removed).toEqual([])
    expect(p.update!.permissions).toEqual({ added: [], removed: [] })
    expect(p.update!.oldHash).toMatch(/^[0-9a-f]{64}$/)
    expect(p.update!.newHash).toBe(p.hash)
    // 待批旧代次不动：用户根还是旧字节；新字节只在待装载区
    expect(fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')).toBe(oldBytes)
    expect(fs.readFileSync(path.join(h.stagingRoot, p.proposalId, 'card.js'), 'utf8')).toContain('hello v2')
    // 审计：更新意图在案
    const intent = h.events.find((e) => e.type === 'plugin-update-intent')
    expect(intent).toMatchObject({ opId: out.opId, pkgId: 'dsh-hello', version: '1.1.0' })
  })

  it('相同字节 → no_change：不制造提案、不重载（无 rescan）、无待装载区残留', async () => {
    await installGood(h)
    const beforeProposals = h.mgr.list().length
    // 与用户根在册字节完全一致（同版本同 card 文本——writeUpdateDir 缺省是 1.1.0 新文本，这里显式回同字节）
    const src = writeUpdateDir(h, 'same-pkg', 'dsh-hello', '1.0.0', GOOD_CARD)
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out).toMatchObject({ ok: true, status: 'no_change', packageId: 'dsh-hello' })
    expect(h.mgr.list().length).toBe(beforeProposals)
    expect(h.rescans).toBe(1) // 安装前提的那一次；no_change 不再触发
    expect(fs.readdirSync(h.stagingRoot)).toEqual([])
    expect(h.events.find((e) => e.type === 'plugin-update-nochange')).toMatchObject({ pkgId: 'dsh-hello' })
    expect(h.events.find((e) => e.type === 'plugin-update-intent')).toBeUndefined()
  })

  it('守卫：目标缺失 not_found / 内核档 not_manageable / 源 id≠目标 id_mismatch / 参数与来源同族', async () => {
    expect(await h.mgr.submitUpdate({ packageId: 'ghost', sourceDir: path.join(h.workspace, 'x') }, { sessionId: 'sess-1', backend: 'dsh' }))
      .toMatchObject({ ok: false, code: 'not_found' })
    h.dispose()
    const h2 = boot({ kernelPackages: true })
    try {
      await installGood(h2)
      writeUpdateDir(h2, 'k-branch', 'deck-app')
      expect(await h2.mgr.submitUpdate({ packageId: 'deck-app', sourceDir: path.join(h2.workspace, 'k-branch') }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'not_manageable' })
      const src = writeUpdateDir(h2, 'mm-branch', 'other-id')
      expect(await h2.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'id_mismatch' })
      expect(await h2.mgr.submitUpdate({ packageId: 'dsh-hello' }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'invalid_args' })
      expect(await h2.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: 'rel' }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'invalid_args' })
      expect(await h2.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: path.join(h2.workspace, 'nope') }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'invalid_source' })
      // 工作区越界同族：插件根内来源拒
      writeUpdateDir(h2, 'x', 'dsh-hello')
      // 用户根目录本身不可作为来源（插件根内）
      expect(await h2.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: path.join(h2.userRoot, 'dsh-hello') }, { sessionId: 'sess-1', backend: 'dsh' }))
        .toMatchObject({ ok: false, code: 'invalid_source' })
      expect(fs.readdirSync(h2.stagingRoot)).toEqual([])
    } finally {
      h2.dispose()
    }
  })

  it('更新新字节带 network.request（#338 已开放）→ 走更新提案，旧代次仍跑', async () => {
    await installGood(h)
    const src = path.join(h.workspace, 'perm-upd')
    writePluginDir(src, { ...GOOD_MANIFEST, id: 'dsh-hello', version: '1.1.0', permissions: ['network.request'], networkOrigins: ['http://127.0.0.1:47823'] })
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out).toMatchObject({ ok: true, status: 'pending-approval' })
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-hello', 'plugin.json'))).toBe(true)
  })
})

describe('更新批准：原子换代（备份 → 落位 → 有界激活 → 旧版回收站 → 补偿）', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('批准全链：新字节转正 + rescan + mount ok → activated；旧版送回收站（trash 端口收到备份路径）', async () => {
    await installGood(h)
    const src = writeUpdateDir(h, 'upd-pkg', 'dsh-hello')
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided).toMatchObject({ ok: true, status: 'activated' })
    if (!decided.ok) throw new Error('形状不符')
    expect(decided.warnings).toBeUndefined()
    // 新字节在用户根；待装载区清偿
    expect(fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')).toContain('hello v2')
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId))).toBe(false)
    // 旧版经备份送回收站：trash 调用指向 backupRoot 内备份；备份目录已消失
    expect(h.trashCalls).toHaveLength(1)
    expect(h.trashCalls[0]).toContain(path.basename(h.backupRoot))
    expect(fs.existsSync(h.trashCalls[0])).toBe(false)
    expect(h.rescans).toBeGreaterThanOrEqual(2)
    const outcome = h.events.find((e) => e.type === 'plugin-update-outcome')
    expect(outcome).toMatchObject({ opId: out.opId, outcome: 'activated' })
    const view = h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)
    expect(view?.status).toBe('activated')
  })

  it('回收站失败：更新仍 activated（换代已成功），备份保留在 backupRoot（绝不降级永久删除）+ warning + 审计', async () => {
    h.dispose()
    const h2 = boot({ trash: 'fail' })
    try {
      await installGood(h2)
      const src = writeUpdateDir(h2, 'upd-pkg', 'dsh-hello')
      const out = await h2.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
      if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
      const decided = await h2.mgr.approve(out.proposal.proposalId)
      expect(decided.ok).toBe(true)
      if (!decided.ok) throw new Error('形状不符')
      expect(decided.warnings?.some((w) => w.includes('回收站'))).toBe(true)
      // 备份保留：旧版字节仍在 backupRoot（文件级恢复面），没有被永久删除
      expect(h2.trashCalls).toHaveLength(1)
      expect(fs.existsSync(path.join(h2.trashCalls[0], 'card.js'))).toBe(true)
      expect(fs.readFileSync(path.join(h2.trashCalls[0], 'card.js'), 'utf8')).toContain('"hello"')
      const outcome = h2.events.find((e) => e.type === 'plugin-update-outcome')
      expect(outcome).toMatchObject({ outcome: 'activated', oldVersionTrashFailed: true })
    } finally {
      h2.dispose()
    }
  })

  it('激活确定失败：新包退出、旧版还原（rollback restored）、staging 清偿', async () => {
    await installGood(h)
    const src = writeUpdateDir(h, 'upd-pkg', 'dsh-hello')
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    h.mountMode.mode = 'fail'
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided.ok).toBe(false)
    if (decided.ok) throw new Error('形状不符')
    expect(decided.code).toBe('activation_failed')
    expect(decided.rollback).toBe('restored')
    // 旧字节还原在用户根；新字节无残留；备份清偿；回收站未被调用（旧版没死）
    expect(fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')).toContain('"hello"')
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId))).toBe(false)
    expect(fs.readdirSync(h.backupRoot)).toEqual([])
    expect(h.trashCalls).toHaveLength(0)
    const view = h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)
    expect(view?.status).toBe('failed')
    expect(view?.error?.code).toBe('activation_failed')
  })

  it('激活结果未知：stateUnknown、不猜补偿（新代次在位+备份保留）、不自动重试', async () => {
    await installGood(h)
    const src = writeUpdateDir(h, 'upd-pkg', 'dsh-hello')
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    h.mountMode.mode = 'hang'
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided.ok).toBe(false)
    if (decided.ok) throw new Error('形状不符')
    expect(decided.code).toBe('activation_unknown')
    expect(decided.stateUnknown).toBe(true)
    // 不猜补偿：新代次在位（实况以清单对账），备份保留（人工恢复面），回收站未调用
    expect(fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')).toContain('hello v2')
    expect(fs.readdirSync(h.backupRoot)).toHaveLength(1)
    expect(h.trashCalls).toHaveLength(0)
    const outcome = h.events.find((e) => e.type === 'plugin-update-outcome')
    expect(outcome).toMatchObject({ outcome: 'activation_unknown', stateUnknown: true })
  })

  it('拒绝：staging 清偿 + gate_denied 审计，旧代次字节原样（不影响旧代次）', async () => {
    await installGood(h)
    const oldBytes = fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')
    const src = writeUpdateDir(h, 'upd-pkg', 'dsh-hello')
    const out = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    const rejected = await h.mgr.reject(out.proposal.proposalId)
    expect(rejected).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(h.userRoot, 'dsh-hello', 'card.js'), 'utf8')).toBe(oldBytes)
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId))).toBe(false)
    expect(h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)?.status).toBe('rejected')
    // 更新提案的拒绝走同一 gate_denied 语义，结局落更新事件族（与意图同族对账；
    // 前提安装自有一条 plugin-install-outcome，这里按 proposalId 精确对账）
    expect(h.events.find((e) => e.type === 'plugin-update-outcome')).toMatchObject({ outcome: 'gate_denied', opId: out.opId })
    expect(h.events.filter((e) => e.type === 'plugin-update-outcome')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 工单335：卸载（回收站红线）——失败不降级永久删除；config 保留。
// ---------------------------------------------------------------------------

describe('卸载：回收站（失败明确报错，绝不永久删除）', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('卸载全链：trash 端口收到用户根目录 → 目录消失 + rescan + 审计意图/结局分离', async () => {
    await installGood(h)
    const target = path.join(h.userRoot, 'dsh-hello')
    expect(fs.existsSync(target)).toBe(true)
    const out = await h.mgr.uninstall({ packageId: 'dsh-hello' })
    expect(out.ok).toBe(true)
    expect(h.trashCalls).toEqual([target])
    expect(fs.existsSync(target)).toBe(false)
    expect(h.rescans).toBeGreaterThanOrEqual(2)
    const intent = h.events.find((e) => e.type === 'plugin-uninstall-intent')
    const outcome = h.events.find((e) => e.type === 'plugin-uninstall-outcome')
    expect(intent).toMatchObject({ pkgId: 'dsh-hello' })
    expect(outcome).toMatchObject({ opId: (intent as Record<string, unknown>)['opId'], outcome: 'uninstalled' })
  })

  it('回收站失败 → trash_failed 明确错误；目录原样在用户根（红线：不降级永久删除）', async () => {
    h.dispose()
    const h2 = boot({ trash: 'fail' })
    try {
      await installGood(h2)
      const target = path.join(h2.userRoot, 'dsh-hello')
      const out = await h2.mgr.uninstall({ packageId: 'dsh-hello' })
      expect(out.ok).toBe(false)
      if (out.ok) throw new Error('形状不符')
      expect(out.code).toBe('trash_failed')
      expect(out.message).toContain('回收站')
      expect(fs.existsSync(path.join(target, 'plugin.json'))).toBe(true)
      const outcome = h2.events.find((e) => e.type === 'plugin-uninstall-outcome')
      expect(outcome).toMatchObject({ outcome: 'trash_failed' })
      // 失败后同 id 重装（同字节）可以继续（数据未丢）
    } finally {
      h2.dispose()
    }
  })

  it('守卫：内核档 not_manageable / 缺失 not_found / 非法参数 invalid_args / 无端口 not_wired', async () => {
    expect(await h.mgr.uninstall({ packageId: 'ghost' })).toMatchObject({ ok: false, code: 'not_found' })
    expect(await h.mgr.uninstall({})).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await h.mgr.uninstall({ packageId: 'BAD ID' })).toMatchObject({ ok: false, code: 'invalid_args' })
    h.dispose()
    const h2 = boot({ kernelPackages: true })
    try {
      expect(await h2.mgr.uninstall({ packageId: 'deck-app' })).toMatchObject({ ok: false, code: 'not_manageable' })
      expect(await h2.mgr.uninstall({ packageId: 'app' })).toMatchObject({ ok: false, code: 'not_manageable' })
    } finally {
      h2.dispose()
    }
    const h3 = boot({ trash: 'none' })
    try {
      await installGood(h3)
      expect(await h3.mgr.uninstall({ packageId: 'dsh-hello' })).toMatchObject({ ok: false, code: 'not_wired' })
      expect(fs.existsSync(path.join(h3.userRoot, 'dsh-hello', 'plugin.json'))).toBe(true)
    } finally {
      h3.dispose()
    }
  })

  it('卸载保留私有配置：configDir 里 <id>.json 原样（解除挂载不碰配置）', async () => {
    await installGood(h)
    fs.writeFileSync(path.join(h.configDir, 'dsh-hello.json'), '{"greeting":"kept"}\n', 'utf8')
    expect(await h.mgr.uninstall({ packageId: 'dsh-hello' })).toMatchObject({ ok: true })
    expect(fs.readFileSync(path.join(h.configDir, 'dsh-hello.json'), 'utf8')).toBe('{"greeting":"kept"}\n')
  })
})

// ---------------------------------------------------------------------------
// 工单335：旧数据继承状态机——同 id 重装（install 通道撞卸载残留配置）→ 提案带独立
// 批准项；继承是独立用户手势，不继承 = 新配置起步（detach，不永久删除）。
// ---------------------------------------------------------------------------

describe('旧数据继承：同 id 重装的独立手势', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  /** 前提：已装 → 写残留配置 → 卸载（残留即卸载保留物） */
  async function leftoverState(h: Harness): Promise<void> {
    await installGood(h)
    fs.writeFileSync(path.join(h.configDir, 'dsh-hello.json'), '{"greeting":"old"}\n', 'utf8')
    expect(await h.mgr.uninstall({ packageId: 'dsh-hello' })).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(h.configDir, 'dsh-hello.json'))).toBe(true)
  }

  it('同 id 重装：提案带 dataInheritance(pending)；无残留的全新安装不带该字段', async () => {
    await leftoverState(h)
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    expect(out.proposal.dataInheritance).toEqual({ decision: 'pending' })
    h.dispose()
    const h2 = boot()
    try {
      const fresh = await submitGood(h2)
      if (!fresh.ok) throw new Error('提交失败')
      expect(fresh.proposal.dataInheritance).toBeUndefined()
    } finally {
      h2.dispose()
    }
  })

  it('独立手势继承：decideInheritance(true) → 批准代码后 <id>.json 原样（旧数据可重新读取）', async () => {
    await leftoverState(h)
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    const decided = await h.mgr.decideInheritance(out.proposal.proposalId, true)
    expect(decided).toMatchObject({ ok: true, decision: 'inherited' })
    expect(h.mgr.list().find((p) => p.proposalId === out.proposal.proposalId)?.dataInheritance).toEqual({ decision: 'inherited' })
    expect(await h.mgr.approve(out.proposal.proposalId)).toMatchObject({ ok: true, status: 'activated' })
    expect(fs.readFileSync(path.join(h.configDir, 'dsh-hello.json'), 'utf8')).toBe('{"greeting":"old"}\n')
    expect(fs.existsSync(path.join(h.configDir, 'dsh-hello.json.detached'))).toBe(false)
    const evt = h.events.find((e) => e.type === 'plugin-config-inheritance')
    expect(evt).toMatchObject({ pkgId: 'dsh-hello', decision: 'inherited' })
  })

  it('独立手势不继承：decideInheritance(false) → 批准后 detach（<id>.json → .detached，新配置起步，数据不永久删）', async () => {
    await leftoverState(h)
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    expect(await h.mgr.decideInheritance(out.proposal.proposalId, false)).toMatchObject({ ok: true, decision: 'fresh' })
    expect(await h.mgr.approve(out.proposal.proposalId)).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(h.configDir, 'dsh-hello.json'))).toBe(false)
    expect(fs.readFileSync(path.join(h.configDir, 'dsh-hello.json.detached'), 'utf8')).toBe('{"greeting":"old"}\n')
    const evt = h.events.find((e) => e.type === 'plugin-config-inheritance')
    expect(evt).toMatchObject({ pkgId: 'dsh-hello', decision: 'fresh', defaulted: false })
  })

  it('未决默认 fresh：只批准代码不决继承 → detach + 审计 defaulted（读取须显式继承批准）', async () => {
    await leftoverState(h)
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    expect(await h.mgr.approve(out.proposal.proposalId)).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(h.configDir, 'dsh-hello.json'))).toBe(false)
    expect(fs.existsSync(path.join(h.configDir, 'dsh-hello.json.detached'))).toBe(true)
    const evt = h.events.find((e) => e.type === 'plugin-config-inheritance')
    expect(evt).toMatchObject({ pkgId: 'dsh-hello', decision: 'fresh', defaulted: true })
  })

  it('拒绝提案：残留配置原样（既不 detach 也不删）', async () => {
    await leftoverState(h)
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    await h.mgr.decideInheritance(out.proposal.proposalId, true)
    await h.mgr.reject(out.proposal.proposalId)
    expect(fs.readFileSync(path.join(h.configDir, 'dsh-hello.json'), 'utf8')).toBe('{"greeting":"old"}\n')
    expect(fs.existsSync(path.join(h.configDir, 'dsh-hello.json.detached'))).toBe(false)
    expect(h.events.find((e) => e.type === 'plugin-config-inheritance')).toBeUndefined()
  })

  it('守卫：已决提案/未知提案 not_found；无继承面提案 not_applicable', async () => {
    const out = await submitGood(h)
    if (!out.ok) throw new Error('提交失败')
    expect(await h.mgr.decideInheritance(out.proposal.proposalId, true)).toMatchObject({ ok: false, code: 'not_applicable' })
    expect(await h.mgr.decideInheritance('nope', true)).toMatchObject({ ok: false, code: 'not_found' })
  })
})

// ---------------------------------------------------------------------------
// 工单335：写全局串行（busy 与其他错误可区分）+ 停用/启用端口编排。
// ---------------------------------------------------------------------------

describe('写串行与停用/启用', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('在途写期间 submitUpdate / uninstall / setEnabled → busy（retryable）；decideInheritance 排队跟走', async () => {
    await installGood(h)
    h.mountMode.mode = 'hang'
    const src = writeUpdateDir(h, 'upd-pkg', 'dsh-hello')
    const upd = await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!upd.ok || upd.status !== 'pending-approval') throw new Error('提交失败')
    const approveP = h.mgr.approve(upd.proposal.proposalId)
    // approve 在途（hang）：写入口一律 busy，且与其他错误可区分（retryable 唯一）
    expect(await h.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' }))
      .toMatchObject({ ok: false, code: 'busy', retryable: true })
    expect(await h.mgr.uninstall({ packageId: 'dsh-hello' })).toMatchObject({ ok: false, code: 'busy', retryable: true })
    expect(await h.mgr.setEnabled({ packageId: 'dsh-hello', enabled: false })).toMatchObject({ ok: false, code: 'busy', retryable: true })
    // decideInheritance 排队（不互斥、不 busy）：手势照常入队；落点在批准结算后——
    // 提案届时已决，如实 not_found（迟到的继承手势不被静默吞掉，也不 busy）
    const diP = h.mgr.decideInheritance(upd.proposal.proposalId, false)
    h.mountMode.mode = 'ok'
    h.releaseMount?.()
    expect(await approveP).toMatchObject({ ok: true })
    expect(await diP).toMatchObject({ ok: false, code: 'not_found' })
    // 本链无残留配置（无继承面）——detach 断言归「旧数据继承」describe
  })

  it('setEnabled：串行内调端口（参数原样达）；无端口 not_wired；批准面不受影响', async () => {
    await installGood(h)
    expect(await h.mgr.setEnabled({ packageId: 'dsh-hello', enabled: false })).toMatchObject({ ok: true })
    expect(h.enabledCalls).toEqual([{ id: 'dsh-hello', enabled: false }])
    expect(await h.mgr.setEnabled({ packageId: 'dsh-hello', enabled: true })).toMatchObject({ ok: true })
    expect(await h.mgr.setEnabled({ packageId: 'x!', enabled: false })).toMatchObject({ ok: false, code: 'invalid_args' })
    expect(await h.mgr.setEnabled({ packageId: 'dsh-hello', enabled: 'no' })).toMatchObject({ ok: false, code: 'invalid_args' })
    h.dispose()
    const h2 = boot({ noEnabledPort: true })
    try {
      expect(await h2.mgr.setEnabled({ packageId: 'dsh-hello', enabled: false })).toMatchObject({ ok: false, code: 'not_wired' })
    } finally {
      h2.dispose()
    }
  })

  it('在途写期间新 submit → busy（uninstall↔submit 互斥同源信号量）', async () => {
    h.dispose()
    const h2 = boot()
    try {
      await installGood(h2)
      h2.mountMode.mode = 'hang'
      const src = writeUpdateDir(h2, 'upd-pkg', 'dsh-hello')
      const upd = await h2.mgr.submitUpdate({ packageId: 'dsh-hello', sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
      if (!upd.ok || upd.status !== 'pending-approval') throw new Error('提交失败')
      const approveP = h2.mgr.approve(upd.proposal.proposalId)
      const another = path.join(h2.workspace, 'other-pkg')
      writePluginDir(another, { ...GOOD_MANIFEST, id: 'dsh-other' })
      expect(await h2.mgr.submit({ sourceDir: another }, { sessionId: 'sess-1', backend: 'dsh' })).toMatchObject({ ok: false, code: 'busy' })
      h2.mountMode.mode = 'ok'
      h2.releaseMount?.()
      expect(await approveP).toMatchObject({ ok: true })
    } finally {
      h2.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// 工单336：media.read 敏感通路打开（首个敏感权限完整闭环）——
// 提交不再 permission_deferred → 提案带权限清单 → 批准落授权账（id+权限集合+代码哈希）
// → 激活失败账回滚；更新重批（换代账换哈希）；混入未开放权限仍拒；
// 手动投放同闸门（manual 提案：批准=复算用户根哈希→落账→rescan）。
// ---------------------------------------------------------------------------

describe('media.read 通路（工单336）：提交与批准落账', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  const MEDIA_MANIFEST = { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] }

  function submitMedia(dirName = 'media-pkg', version = '1.0.0') {
    const src = path.join(h.workspace, dirName)
    writePluginDir(src, { ...MEDIA_MANIFEST, version })
    return h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
  }

  it('media.read 包提交 → 提案 pending 带权限清单（不再 permission_deferred），staging 纪律不变', async () => {
    const out = await submitMedia()
    expect(out.ok).toBe(true)
    if (!out.ok || out.status !== 'pending-approval') throw new Error('形状不符')
    expect(out.proposal.pkg.permissions).toEqual(['media.read'])
    expect(fs.existsSync(path.join(h.stagingRoot, out.proposal.proposalId, 'plugin.json'))).toBe(true)
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-media'))).toBe(false)
    const intent = h.events.find((e) => e.type === 'plugin-install-intent')
    expect(intent).toMatchObject({ pkgId: 'dsh-media', permissions: ['media.read'] })
  })

  it('media.read + network.request 混包（#338 两通路都开放）→ 提案带两权限与 origin 清单', async () => {
    const src = path.join(h.workspace, 'mix')
    writePluginDir(src, { ...GOOD_MANIFEST, id: 'dsh-mix', permissions: ['media.read', 'network.request'], networkOrigins: ['http://127.0.0.1:47823'] })
    const out = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(out).toMatchObject({ ok: true, status: 'pending-approval' })
    if (!out.ok || !out.proposal) return
    expect(out.proposal.pkg).toMatchObject({ permissions: ['media.read', 'network.request'], networkOrigins: ['http://127.0.0.1:47823'] })
  })

  it('批准 → 授权账落账（id+permissions+聚合哈希三元组）→ 转正激活', async () => {
    const out = await submitMedia()
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    const hash = out.proposal.hash
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided).toMatchObject({ ok: true, status: 'activated' })
    expect(h.authCalls).toEqual([{ op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: hash }])
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-media', 'plugin.json'))).toBe(true)
  })

  it('哈希绑定：账上哈希 = 提案哈希 = 转正后用户根同一份字节', async () => {
    const out = await submitMedia()
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    const beforeHash = out.proposal.hash
    fs.writeFileSync(path.join(h.stagingRoot, out.proposal.proposalId, 'card.js'), 'export default {} // tampered\n', 'utf8')
    await h.mgr.approve(out.proposal.proposalId)
    // 哈希绑定失败 → 转正不发生 → 账不落（无空转授权）
    expect(h.authCalls).toEqual([])
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-media'))).toBe(false)
    expect(beforeHash).toBeTruthy()
  })

  it('激活确定失败：补偿移除转正目录 + 授权账回滚（revoke 不留无执行面的授权）', async () => {
    h.mountMode.mode = 'fail'
    const out = await submitMedia()
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided).toMatchObject({ ok: false, code: 'activation_failed', rollback: 'removed' })
    expect(h.authCalls).toEqual([
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: out.proposal.hash },
      { op: 'revoke', id: 'dsh-media' },
    ])
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-media'))).toBe(false)
  })

  it('激活结果未知：转正目录保留 + 授权账保留（实况以清单对账，不猜补偿）', async () => {
    h.mountMode.mode = 'hang'
    const out = await submitMedia()
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    const decided = await h.mgr.approve(out.proposal.proposalId)
    expect(decided).toMatchObject({ ok: false, code: 'activation_unknown', stateUnknown: true })
    expect(h.authCalls).toEqual([{ op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: out.proposal.hash }])
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-media', 'plugin.json'))).toBe(true)
  })

  it('拒绝 → 账不落（gate_denied，副本清偿）', async () => {
    const out = await submitMedia()
    if (!out.ok || out.status !== 'pending-approval') throw new Error('提交失败')
    await h.mgr.reject(out.proposal.proposalId)
    expect(h.authCalls).toEqual([])
    expect(fs.readdirSync(h.stagingRoot)).toEqual([])
  })

  it('零权限包批准不落账（授权只对敏感包存在）', async () => {
    await installGood(h)
    expect(h.authCalls).toEqual([])
  })
})

describe('media.read 通路（工单336）：更新重批与卸载清账', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  it('已授权包更新：media.read 新字节提案（diff 权限不变）→ 批准落新哈希账（同 id 新代码不继承旧批准）', async () => {
    // 前提：media.read 包已安装授权
    const src0 = path.join(h.workspace, 'm0')
    writePluginDir(src0, { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] })
    const sub0 = await h.mgr.submit({ sourceDir: src0 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!sub0.ok || sub0.status !== 'pending-approval') throw new Error('前提提交失败')
    expect(await h.mgr.approve(sub0.proposal.proposalId)).toMatchObject({ ok: true })
    const oldHash = sub0.proposal.hash

    // 更新：新字节（card v2），权限不变
    const src1 = path.join(h.workspace, 'm1')
    writePluginDir(src1, { ...GOOD_MANIFEST, id: 'dsh-media', version: '1.1.0', permissions: ['media.read'] }, 'export default { mount(host) { host.el.textContent = "v2" } }\n')
    const upd = await h.mgr.submitUpdate({ packageId: 'dsh-media', sourceDir: src1 }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(upd.ok).toBe(true)
    if (!upd.ok || upd.status !== 'pending-approval') throw new Error('更新提交失败')
    expect(upd.proposal.pkg.permissions).toEqual(['media.read'])
    expect(upd.proposal.update?.permissions).toEqual({ added: [], removed: [] })
    expect(await h.mgr.approve(upd.proposal.proposalId)).toMatchObject({ ok: true, status: 'activated' })
    // 账换代：grant 两次（旧哈希 → 新哈希），无 revoke（换代全程授权连续）
    expect(h.authCalls).toEqual([
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: oldHash },
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: upd.proposal.hash },
    ])
  })

  it('更新新字节带 network.request → 更新提案 pending（权限变化进 diff，旧代次跑着）', async () => {
    const src0 = path.join(h.workspace, 'm0')
    writePluginDir(src0, { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] })
    const sub0 = await h.mgr.submit({ sourceDir: src0 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!sub0.ok || sub0.status !== 'pending-approval') throw new Error('前提提交失败')
    await h.mgr.approve(sub0.proposal.proposalId)
    const src1 = path.join(h.workspace, 'm1')
    writePluginDir(src1, { ...GOOD_MANIFEST, id: 'dsh-media', version: '1.1.0', permissions: ['media.read', 'network.request'], networkOrigins: ['http://127.0.0.1:47823'] })
    const upd = await h.mgr.submitUpdate({ packageId: 'dsh-media', sourceDir: src1 }, { sessionId: 'sess-1', backend: 'dsh' })
    expect(upd).toMatchObject({ ok: true, status: 'pending-approval' })
    if (!upd.ok || upd.status !== 'pending-approval') return
    expect(upd.proposal.update?.permissions.added).toContain('network.request')
  })

  it('更新换代激活失败：还原旧版 + 账还原旧哈希（旧包授权连续，不因换代失败停摆）', async () => {
    const src0 = path.join(h.workspace, 'm0')
    writePluginDir(src0, { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] })
    const sub0 = await h.mgr.submit({ sourceDir: src0 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!sub0.ok || sub0.status !== 'pending-approval') throw new Error('前提提交失败')
    await h.mgr.approve(sub0.proposal.proposalId)
    const src1 = path.join(h.workspace, 'm1')
    writePluginDir(src1, { ...GOOD_MANIFEST, id: 'dsh-media', version: '1.1.0', permissions: ['media.read'] })
    const upd = await h.mgr.submitUpdate({ packageId: 'dsh-media', sourceDir: src1 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!upd.ok || upd.status !== 'pending-approval') throw new Error('更新提交失败')
    h.mountMode.mode = 'fail'
    const decided = await h.mgr.approve(upd.proposal.proposalId)
    expect(decided).toMatchObject({ ok: false, code: 'activation_failed', rollback: 'restored' })
    expect(h.authCalls).toEqual([
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: sub0.proposal.hash },
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: upd.proposal.hash },
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: sub0.proposal.hash },
    ])
    expect(fs.existsSync(path.join(h.userRoot, 'dsh-media', 'plugin.json'))).toBe(true)
  })

  it('更新把敏感权限摘除（media.read→零权限）→ 批准后清账（零权限不需要授权）', async () => {
    const src0 = path.join(h.workspace, 'm0')
    writePluginDir(src0, { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] })
    const sub0 = await h.mgr.submit({ sourceDir: src0 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!sub0.ok || sub0.status !== 'pending-approval') throw new Error('前提提交失败')
    await h.mgr.approve(sub0.proposal.proposalId)
    const src1 = path.join(h.workspace, 'm1')
    writePluginDir(src1, { ...GOOD_MANIFEST, id: 'dsh-media', version: '2.0.0', permissions: [] })
    const upd = await h.mgr.submitUpdate({ packageId: 'dsh-media', sourceDir: src1 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!upd.ok || upd.status !== 'pending-approval') throw new Error('更新提交失败')
    expect(upd.proposal.update?.permissions).toEqual({ added: [], removed: ['media.read'] })
    await h.mgr.approve(upd.proposal.proposalId)
    expect(h.authCalls).toEqual([
      { op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: sub0.proposal.hash },
      { op: 'clear', id: 'dsh-media' },
    ])
  })

  it('卸载 → 授权账清除（重装同字节也重新批准——撤销不可被卸载重装绕过）', async () => {
    const src0 = path.join(h.workspace, 'm0')
    writePluginDir(src0, { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] })
    const sub0 = await h.mgr.submit({ sourceDir: src0 }, { sessionId: 'sess-1', backend: 'dsh' })
    if (!sub0.ok || sub0.status !== 'pending-approval') throw new Error('前提提交失败')
    await h.mgr.approve(sub0.proposal.proposalId)
    const un = await h.mgr.uninstall({ packageId: 'dsh-media' })
    expect(un).toMatchObject({ ok: true })
    expect(h.authCalls.at(-1)).toEqual({ op: 'clear', id: 'dsh-media' })
  })
})

describe('手动投放同闸门（工单336）：manual 提案', () => {
  let h: Harness
  beforeEach(() => { h = boot() })
  afterEach(() => { h.dispose() })

  const MEDIA_MANIFEST = { ...GOOD_MANIFEST, id: 'dsh-media', permissions: ['media.read'] }

  function seedManual(): { dir: string } {
    const dir = path.join(h.userRoot, 'dsh-media')
    writePluginDir(dir, MEDIA_MANIFEST)
    return { dir }
  }

  function registerSeeded(dir: string) {
    return h.mgr.registerManualProposal({
      pkg: { id: 'dsh-media', name: 'DSH MEDIA', version: '1.0.0', hostApiVersion: currentHostApiVersion(), permissions: ['media.read'], optionalPermissions: [], networkOrigins: [] },
      dir, files: listFileEntries(dir), hash: aggregateHashOf(dir),
    })
  }

  it('registerManualProposal：提案 pending，files/hash 取自用户根在册字节，source.backend=manual', () => {
    const { dir } = seedManual()
    const hash = aggregateHashOf(dir)
    const proposal = registerSeeded(dir)
    expect(proposal.status).toBe('pending')
    expect(proposal.source.backend).toBe('manual')
    expect(proposal.files.map((f) => f.path).sort()).toEqual(['card.js', 'plugin.json'])
    expect(proposal.hash).toBe(hash)
    expect(h.mgr.list().some((p) => p.proposalId === proposal.proposalId)).toBe(true)
  })

  it('manual 提案批准：复算用户根哈希绑定 → 落账 → rescan → 有界激活', async () => {
    const { dir } = seedManual()
    const hash = aggregateHashOf(dir)
    const proposal = registerSeeded(dir)
    const rescansBefore = h.rescans
    const decided = await h.mgr.approve(proposal.proposalId)
    expect(decided).toMatchObject({ ok: true, status: 'activated' })
    expect(h.authCalls).toEqual([{ op: 'grant', id: 'dsh-media', permissions: ['media.read'], codeHash: hash }])
    expect(h.rescans).toBe(rescansBefore + 1)
  })

  it('manual 提案批准前字节被改 → hash_mismatch（转正不发生、账不落、包不执行）', async () => {
    const { dir } = seedManual()
    const proposal = registerSeeded(dir)
    fs.writeFileSync(path.join(dir, 'card.js'), 'export default {} // tampered\n', 'utf8')
    const decided = await h.mgr.approve(proposal.proposalId)
    expect(decided).toMatchObject({ ok: false, code: 'hash_mismatch' })
    expect(h.authCalls).toEqual([])
  })

  it('manual 提案拒绝：用户根文件不动（用户放的文件不删），包不执行，gate_denied 审计', async () => {
    const { dir } = seedManual()
    const proposal = registerSeeded(dir)
    const rejected = await h.mgr.reject(proposal.proposalId)
    expect(rejected).toMatchObject({ ok: true })
    expect(fs.existsSync(path.join(dir, 'plugin.json'))).toBe(true)
    expect(h.authCalls).toEqual([])
    expect(h.events.find((e) => e.type === 'plugin-install-outcome')).toMatchObject({ outcome: 'gate_denied', proposalId: proposal.proposalId })
  })

  it('dropManualProposal：包消失（卸载/移除）后在册 manual 提案同步摘除', () => {
    const { dir } = seedManual()
    const proposal = registerSeeded(dir)
    h.mgr.dropManualProposal('dsh-media', proposal.proposalId)
    expect(h.mgr.list().some((p) => p.proposalId === proposal.proposalId)).toBe(false)
  })

  it('同 id 二次手动提案：幂等替换（不重复挂条）', () => {
    const { dir } = seedManual()
    registerSeeded(dir)
    registerSeeded(dir)
    expect(h.mgr.list().filter((p) => p.pkg.id === 'dsh-media' && p.source.backend === 'manual')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// network.request 通路（工单338）：提案带 origin 清单 → 批准按 origin 子集落账
// （越声明面的项丢弃）→ 账行 origin 集是网络 Broker 的唯一放行依据。
// ---------------------------------------------------------------------------
describe('network.request 通路（工单338）：origin 参数面随批准落账', () => {
  it('批准缺省 = 声明 origin 全授（落账带 origin 清单）', async () => {
    const h = boot()
    try {
      const src = path.join(h.workspace, 'net')
      writePluginDir(src, { ...GOOD_MANIFEST, id: 'dsh-net', permissions: ['network.request'], networkOrigins: ['http://127.0.0.1:47823', 'https://example.com'] })
      const sub = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
      if (!sub.ok || sub.status !== 'pending-approval') throw new Error('提交失败')
      const decided = await h.mgr.approve(sub.proposal.proposalId)
      expect(decided).toMatchObject({ ok: true, status: 'activated' })
      const grant = h.authCalls.find((c) => c.op === 'grant')
      expect(grant).toMatchObject({ id: 'dsh-net', permissions: ['network.request'], origins: ['http://127.0.0.1:47823', 'https://example.com'] })
    } finally { h.dispose() }
  })

  it('批准给 origin 子集 → 只落子集；越声明面的项被丢弃', async () => {
    const h = boot()
    try {
      const src = path.join(h.workspace, 'net2')
      writePluginDir(src, { ...GOOD_MANIFEST, id: 'dsh-net2', permissions: ['network.request'], networkOrigins: ['http://127.0.0.1:47823', 'https://example.com'] })
      const sub = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
      if (!sub.ok || sub.status !== 'pending-approval') throw new Error('提交失败')
      const decided = await h.mgr.approve(sub.proposal.proposalId, { grantOrigins: ['http://127.0.0.1:47823', 'http://evil.test'] })
      expect(decided).toMatchObject({ ok: true, status: 'activated' })
      const grant = h.authCalls.find((c) => c.op === 'grant')
      expect(grant?.origins).toEqual(['http://127.0.0.1:47823'])
    } finally { h.dispose() }
  })

  it('没授 network.request（权限只在可选集且未勾选）→ 不落 origin 清单', async () => {
    const h = boot()
    try {
      const src = path.join(h.workspace, 'net3')
      writePluginDir(src, { ...GOOD_MANIFEST, id: 'dsh-net3', permissions: ['media.read'], optionalPermissions: ['network.request'], networkOrigins: ['http://127.0.0.1:47823'] })
      const sub = await h.mgr.submit({ sourceDir: src }, { sessionId: 'sess-1', backend: 'dsh' })
      if (!sub.ok || sub.status !== 'pending-approval') throw new Error('提交失败')
      const decided = await h.mgr.approve(sub.proposal.proposalId)
      expect(decided).toMatchObject({ ok: true, status: 'activated' })
      const grant = h.authCalls.find((c) => c.op === 'grant')
      expect(grant).toMatchObject({ permissions: ['media.read'] })
      expect(grant?.origins ?? []).toEqual([])
    } finally { h.dispose() }
  })
})
