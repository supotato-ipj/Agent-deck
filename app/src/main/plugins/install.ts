// DSH 安装管线状态机（工单334，ADR-0019 写入契约上半身 / ADR-0025 批准面）：
// DSH 在会话工作区写源码 → 经确定性 MCP 操作提交（只收路径不收正文）→ 字节进待装载区
// （热插拔不可见）→ 严格校验 + 逐文件/聚合哈希 → 提案 pending → 可信内核 UI 真实用户手势
// 批准/拒绝 → 批准复算哈希（同一份字节绑定）→ 原子转正进用户根 → rescan → 有界激活；
// 确定失败补偿移除，结果未知不猜补偿、绝不自动重试。敏感权限包本票结构化拒绝
// permission_deferred（代次批准持久化归 #335）。审计意图/结局分离，零权限包零批准闸门例外
// 不成立——经 MCP 提交的一律走批准（手动投放的零权限包才投放即生效，ADR-0025）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { classifyDroppedManifest, type DroppedManifest, type MigrationIssue } from './dropped-manifest'

/** 提交字节上限（ADR-0019 待装载区纪律）：总量/单文件/文件数/深度/manifest 体积 */
const LIMIT_TOTAL_BYTES = 8 * 1024 * 1024
const LIMIT_FILE_BYTES = 2 * 1024 * 1024
const LIMIT_MANIFEST_BYTES = 64 * 1024
const LIMIT_FILE_COUNT = 256
const LIMIT_PATH_DEPTH = 8
/** 包内扩展名白名单：与投放协议可投递类型同源（assets.ts MIME 表）+ manifest 本体 */
const ALLOWED_EXTENSIONS = new Set(['.js', '.mjs', '.css', '.json', '.html', '.svg', '.png', '.woff2'])
const FORBIDDEN_ENTRIES = new Set(['node_modules', '.git'])
/** 保留包 id：与内核宿主标识冲突（assets.ts APP_HOST） */
const RESERVED_PACKAGE_IDS: ReadonlySet<string> = new Set(['app'])

export interface InstallFileEntry {
  /** 包内相对路径（POSIX 分隔） */
  path: string
  sha256: string
  sizeBytes: number
}

/** 提案视图（批准 UI / MCP plugins_list 投影数据面；终态留痕） */
export interface InstallProposalView {
  proposalId: string
  status: 'pending' | 'activated' | 'rejected' | 'failed'
  /** 提交时铸的操作 id：意图/结局分离存证的相关键（结局事件复用同一 opId） */
  opId: string
  pkg: { id: string; name: string; version: string; hostApiVersion: number; permissions: string[] }
  files: InstallFileEntry[]
  /** 聚合哈希：排序后 `${path}:${sha256}\n` 逐行串的 sha256（批准时同一份字节复算绑定） */
  hash: string
  source: { sessionId: string; backend: string; label: string | null }
  createdAt: number
  error: { code: string; message: string; stateUnknown?: boolean } | null
}

export interface MountOutcome {
  ok: boolean
  message: string | null
  unknown: boolean
}

export interface InstallManagerHost {
  rescan(): void
  waitMount(packageId: string, timeoutMs: number): Promise<MountOutcome>
}

export interface InstallManagerOptions {
  userRoot: string
  stagingRoot: string
  kernelRoots: string[]
  /** 会话工作区包含校验的事实源：sessionId → cwd（不采信调用参数自报工作区） */
  sessionInfo(sessionId: string): { cwd: string; label: string | null } | null
  log(event: Record<string, unknown>): void
  notify(): void
  now(): number
  opId(): string
  host: InstallManagerHost
  mountBoundMs: number
}

export interface InstallSubmitCtx {
  sessionId: string
  backend: string
}

export type InstallProposalDecision =
  | { ok: true; status: 'activated' }
  | {
      ok: false
      code: 'hash_mismatch' | 'activation_failed' | 'activation_unknown' | 'not_found'
      message: string
      rollback?: 'removed'
      stateUnknown?: boolean
    }

export type InstallSubmitResult =
  | { ok: true; status: 'pending-approval'; proposal: InstallProposalView; opId: string }
  | {
      ok: false
      code:
        | 'invalid_args'
        | 'invalid_source'
        | 'invalid_package'
        | 'permission_deferred'
        | 'id_conflict'
        | 'busy'
      message: string
      opId?: string
      issues?: MigrationIssue[]
      existing?: unknown
      retryable?: boolean
    }

/** 聚合哈希：目录内文件按相对路径排序，`${path}:${sha256}\n` 逐行串取 sha256（与提交清单同源） */
export function aggregateHashOf(dir: string): string {
  const files: Array<{ rel: string; buf: Buffer }> = []
  const walk = (cur: string, rel: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const childAbs = path.join(cur, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(childAbs, childRel)
      else files.push({ rel: childRel, buf: fs.readFileSync(childAbs) })
    }
  }
  walk(dir, '')
  const lines = files
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => `${f.rel}:${createHash('sha256').update(f.buf).digest('hex')}\n`)
    .join('')
  return createHash('sha256').update(lines).digest('hex')
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

interface WalkIssue {
  code: 'limit_file_size' | 'limit_total_size' | 'limit_file_count' | 'limit_path_depth' | 'extension_not_allowed' | 'forbidden_entry' | 'symlink_rejected' | 'unreadable_entry'
  message: string
}

export class PluginInstallManager {
  private readonly opts: InstallManagerOptions
  private readonly proposals = new Map<string, InstallProposalView>()
  /** 串行化信号量：submit 在任何在途操作期间拒绝（busy，唯一可重试码）；approve/reject 排队跟走 */
  private active = 0
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false

  constructor(opts: InstallManagerOptions) {
    this.opts = opts
    // 孤儿清偿（红线「不留待装载区孤儿」）：面板重启 = 全部在途提案作废，构造期清扫
    try {
      if (fs.existsSync(opts.stagingRoot)) {
        for (const e of fs.readdirSync(opts.stagingRoot)) {
          fs.rmSync(path.join(opts.stagingRoot, e), { recursive: true, force: true })
        }
      }
    } catch (err) {
      opts.log({ type: 'plugin-install-sweep-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  dispose(): void {
    this.disposed = true
    try {
      fs.rmSync(this.opts.stagingRoot, { recursive: true, force: true })
    } catch { /* 尽力 */ }
  }

  list(): InstallProposalView[] {
    return [...this.proposals.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 真实用户手势（可信内核 UI）：批准 = 同一份字节复算哈希 → 原子转正 → 有界激活 */
  approve(proposalId: string): Promise<InstallProposalDecision> {
    return this.enqueue(async () => this.approveInner(proposalId))
  }

  /** 真实用户手势：拒绝 = 待装载区副本清偿 + gate_denied 审计（用户根从未出现） */
  reject(proposalId: string): Promise<{ ok: boolean; code?: 'not_found' }> {
    return this.enqueue(async () => this.rejectInner(proposalId))
  }

  submit(args: { sourceDir?: unknown }, ctx: InstallSubmitCtx): Promise<InstallSubmitResult> {
    // submit 在途互斥（busy 唯一可重试码）；approve/reject 只排队不互斥
    if (this.active > 0 || this.disposed) return Promise.resolve(this.busyResult())
    this.active += 1
    const run = this.tail.then(() => this.submitInner(args, ctx), () => this.submitInner(args, ctx))
    this.tail = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.active -= 1 })
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    this.active += 1
    const run = this.tail.then(fn, fn)
    this.tail = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.active -= 1 })
  }

  private busyResult(): InstallSubmitResult {
    return { ok: false, code: 'busy', message: '已有安装操作在途（串行写）——等待当前操作结束后重试', retryable: true }
  }

  // ------------------------------------------------------------------
  // 提交：守卫 → 待装载区 → 严格校验 → 哈希 → 提案 pending
  // ------------------------------------------------------------------

  private async submitInner(args: { sourceDir?: unknown }, ctx: InstallSubmitCtx): Promise<InstallSubmitResult> {
    const opId = this.opts.opId()
    const sourceDirRaw = args?.sourceDir
    if (typeof sourceDirRaw !== 'string' || !sourceDirRaw.trim() || !path.isAbsolute(sourceDirRaw)) {
      return { ok: false, code: 'invalid_args', message: 'sourceDir 必须是绝对路径（MCP 只收路径不收正文）', opId }
    }
    const session = this.opts.sessionInfo(ctx?.sessionId ?? '')
    if (!session) {
      return { ok: false, code: 'invalid_args', message: `未知会话（sessionId=${String(ctx?.sessionId)}）——安装只能由在册会话经其通道发起`, opId }
    }
    const sourceDir = path.resolve(sourceDirRaw)
    let st: fs.Stats
    try {
      st = fs.statSync(sourceDir)
    } catch {
      return { ok: false, code: 'invalid_source', message: `sourceDir 不存在或不可达：${sourceDir}`, opId }
    }
    if (!st.isDirectory()) {
      return { ok: false, code: 'invalid_source', message: `sourceDir 不是目录：${sourceDir}`, opId }
    }
    let realSource = sourceDir
    try {
      realSource = fs.realpathSync(sourceDir)
    } catch { /* realpath 失败按原路径继续守卫 */ }
    // 越界守卫：插件根（用户/内核）与待装载区内一律不收（不是合法的会话工作区来源）
    for (const root of [this.opts.userRoot, this.opts.stagingRoot, ...this.opts.kernelRoots]) {
      let realRoot = root
      try { realRoot = fs.realpathSync(root) } catch { continue }
      if (isInside(realSource, realRoot)) {
        // 待装载区是面板私域：落进来的散落目录由本管理器清偿（不留孤儿）；插件根里的来源不动
        if (isInside(realSource, this.opts.stagingRoot) || root === this.opts.stagingRoot) {
          try { fs.rmSync(sourceDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
        }
        return { ok: false, code: 'invalid_source', message: `sourceDir 落在插件根/待装载区内（${root}）——提交来源必须是会话工作区`, opId }
      }
    }
    // 会话工作区包含校验：realpath 后必须在调用会话 cwd 内（通道绑定身份，不采信自报）
    let realCwd = session.cwd
    try { realCwd = fs.realpathSync(session.cwd) } catch { /* cwd 不存在按原路径 */ }
    if (!isInside(realSource, realCwd)) {
      return { ok: false, code: 'invalid_source', message: `sourceDir 不在会话工作区内（${realCwd}）——DSH 只能提交自己工作区里的包`, opId }
    }

    // 字节拷贝进待装载区（热插拔不可见）：上限/扩展名/禁入项/符号链接逐项守卫
    const proposalId = `prop-${opId}`
    const stagingDir = path.join(this.opts.stagingRoot, proposalId)
    const cleanupStaging = (): void => {
      try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    }
    const issues: MigrationIssue[] = []
    // 符号链接守卫（拷贝前 lstat 预walk）：cpSync 默认解引用，事后查拷贝产物打不中——
    // 源树里任何 symlink/junction 条目即拒，绝不把链外字节拷进待装载区
    const scanSymlinks = (cur: string, rel: string): void => {
      for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
        if (e.isSymbolicLink()) {
          issues.push({ code: 'symlink_rejected', message: `包内不允许符号链接条目：${rel ? `${rel}/${e.name}` : e.name}` })
          continue
        }
        if (e.isDirectory()) scanSymlinks(path.join(cur, e.name), rel ? `${rel}/${e.name}` : e.name)
      }
    }
    scanSymlinks(sourceDir, '')
    if (issues.length > 0) {
      return { ok: false, code: 'invalid_package', message: `包字节不合格（${issues.length} 项），详见 issues`, opId, issues }
    }
    try {
      fs.mkdirSync(this.opts.stagingRoot, { recursive: true })
      fs.cpSync(sourceDir, stagingDir, { recursive: true, verbatimSymlinks: false })
    } catch (err) {
      cleanupStaging()
      return { ok: false, code: 'invalid_source', message: `待装载区拷贝失败：${err instanceof Error ? err.message : String(err)}`, opId }
    }
    // 逐条目守卫（尺寸/扩展名/禁入项/深度）——拷贝产物即提交字节
    const files: InstallFileEntry[] = []
    let totalBytes = 0
    const walkStaged = (cur: string, rel: string): void => {
      for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
        const childAbs = path.join(cur, e.name)
        const childRel = rel ? `${rel}/${e.name}` : e.name
        if (e.isSymbolicLink()) {
          issues.push({ code: 'symlink_rejected', message: `包内不允许符号链接条目：${childRel}` })
          continue
        }
        if (e.isDirectory()) {
          if (FORBIDDEN_ENTRIES.has(e.name)) {
            issues.push({ code: 'forbidden_entry', message: `包内不允许目录 ${e.name}（${childRel}）` })
            continue
          }
          const depth = childRel.split('/').length
          if (depth > LIMIT_PATH_DEPTH) {
            issues.push({ code: 'limit_path_depth', message: `目录深度超限（>${LIMIT_PATH_DEPTH}）：${childRel}` })
            continue
          }
          walkStaged(childAbs, childRel)
          continue
        }
        if (FORBIDDEN_ENTRIES.has(e.name)) {
          issues.push({ code: 'forbidden_entry', message: `包内不允许条目 ${e.name}（${childRel}）` })
          continue
        }
        if (childRel.split('/').length > LIMIT_PATH_DEPTH) {
          issues.push({ code: 'limit_path_depth', message: `路径深度超限（>${LIMIT_PATH_DEPTH}）：${childRel}` })
          continue
        }
        let buf: Buffer
        try {
          buf = fs.readFileSync(childAbs)
        } catch (err) {
          issues.push({ code: 'unreadable_entry', message: `条目不可读：${childRel}（${err instanceof Error ? err.message : String(err)}）` })
          continue
        }
        // 尺寸检查先于扩展名：超限条目两项 issue 同现（不因扩展名跳过尺寸审计）
        if (buf.length > LIMIT_FILE_BYTES || (childRel === 'plugin.json' && buf.length > LIMIT_MANIFEST_BYTES)) {
          issues.push({ code: 'limit_file_size', message: `文件超限（>${childRel === 'plugin.json' ? LIMIT_MANIFEST_BYTES : LIMIT_FILE_BYTES} 字节）：${childRel}` })
          continue
        }
        const ext = path.extname(e.name).toLowerCase()
        if (!ALLOWED_EXTENSIONS.has(ext)) {
          issues.push({ code: 'extension_not_allowed', message: `扩展名不在白名单：${childRel}（${ext || '无扩展名'}）` })
          continue
        }
        totalBytes += buf.length
        if (totalBytes > LIMIT_TOTAL_BYTES) {
          issues.push({ code: 'limit_total_size', message: `包总量超限（>${LIMIT_TOTAL_BYTES} 字节）` })
          return
        }
        files.push({ path: childRel, sha256: sha256(buf), sizeBytes: buf.length })
      }
    }
    walkStaged(stagingDir, '')
    if (files.length > LIMIT_FILE_COUNT) {
      issues.push({ code: 'limit_file_count', message: `文件数超限（>${LIMIT_FILE_COUNT}）` })
    }
    if (issues.length > 0) {
      cleanupStaging()
      return { ok: false, code: 'invalid_package', message: `包字节不合格（${issues.length} 项），详见 issues`, opId, issues }
    }
    if (files.length === 0 || !files.some((f) => f.path === 'plugin.json')) {
      cleanupStaging()
      return { ok: false, code: 'invalid_package', message: '包缺 plugin.json（manifest 必须在包根）', opId, issues: [{ code: 'manifest_invalid', message: 'plugin.json 缺失' }] }
    }

    // 严格校验（ADR-0019 同一分类器）：结构错 → 缺主版本 → 不兼容 → 未知权限
    let manifestRaw: unknown
    try {
      manifestRaw = JSON.parse(fs.readFileSync(path.join(stagingDir, 'plugin.json'), 'utf8'))
    } catch (err) {
      cleanupStaging()
      return {
        ok: false, code: 'invalid_package', message: 'plugin.json 不是合法 JSON', opId,
        issues: [{ code: 'manifest_invalid', message: `plugin.json 解析失败：${err instanceof Error ? err.message : String(err)}` }],
      }
    }
    const classified = classifyDroppedManifest(manifestRaw)
    if (!classified.ok) {
      cleanupStaging()
      return { ok: false, code: 'invalid_package', message: `manifest 校验未通过（${classified.issues.length} 项）`, opId, issues: classified.issues }
    }
    const manifest: DroppedManifest = classified.manifest
    // 敏感权限包：本票零权限边界（代次批准持久化归 #335）——结构化拒绝，副本清偿
    if (manifest.permissions.length > 0) {
      cleanupStaging()
      return {
        ok: false, code: 'permission_deferred', message: `含敏感权限 [${manifest.permissions.join(', ')}] 的包暂不接受安装提交（权限代次批准持久化在后续票落地）——零权限包不受此限`, opId,
        issues: [{ code: 'permission_unknown', message: '敏感权限包走代次批准通道（未开放）' }],
      }
    }
    // id 冲突：保留 id / 内核根在册 / 用户根已有——副本清偿
    if (RESERVED_PACKAGE_IDS.has(manifest.id)) {
      cleanupStaging()
      return { ok: false, code: 'id_conflict', message: `包 id「${manifest.id}」是保留标识（内核宿主名）`, opId, existing: { where: 'reserved', id: manifest.id } }
    }
    for (const kernelRoot of this.opts.kernelRoots) {
      const candidate = path.join(kernelRoot, manifest.id)
      if (fs.existsSync(path.join(candidate, 'plugin.json'))) {
        cleanupStaging()
        return { ok: false, code: 'id_conflict', message: `包 id「${manifest.id}」与内核档插件冲突（${candidate}）`, opId, existing: { where: 'kernel', id: manifest.id, dir: candidate } }
      }
    }
    const userTarget = path.join(this.opts.userRoot, manifest.id)
    if (fs.existsSync(path.join(userTarget, 'plugin.json'))) {
      cleanupStaging()
      return { ok: false, code: 'id_conflict', message: `包 id「${manifest.id}」在用户插件根已存在（同 id 重装/旧数据继承走 #335 的独立生命周期）`, opId, existing: { where: 'user', id: manifest.id, dir: userTarget } }
    }

    // 提案在册（pending）+ 审计意图；结局等真实用户手势
    const hash = aggregateHashOf(stagingDir)
    const proposal: InstallProposalView = {
      proposalId,
      opId,
      status: 'pending',
      pkg: { id: manifest.id, name: manifest.name, version: manifest.version, hostApiVersion: manifest.hostApiVersion, permissions: [...manifest.permissions] },
      files,
      hash,
      source: { sessionId: ctx.sessionId, backend: ctx.backend, label: session.label },
      createdAt: this.opts.now(),
      error: null,
    }
    this.proposals.set(proposalId, proposal)
    this.opts.log({
      type: 'plugin-install-intent',
      opId,
      proposalId,
      sessionId: ctx.sessionId,
      backend: ctx.backend,
      pkgId: manifest.id,
      version: manifest.version,
      hash,
      files: files.length,
    })
    this.opts.notify()
    return { ok: true, status: 'pending-approval', proposal, opId }
  }

  // ------------------------------------------------------------------
  // 批准：哈希绑定 → 原子转正 → 有界激活 → 补偿/结果未知
  // ------------------------------------------------------------------

  private async approveInner(proposalId: string): Promise<InstallProposalDecision> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false, code: 'not_found', message: `提案不存在或已决（${proposalId}）` }
    }
    const stagedDir = path.join(this.opts.stagingRoot, proposalId)
    // 同一份字节绑定：批准复算待装载区哈希 = 提案哈希，不一致即拒（转正不发生）
    let stagedHash: string
    try {
      stagedHash = aggregateHashOf(stagedDir)
    } catch (err) {
      return this.failProposal(proposal, 'hash_mismatch', `待装载区副本不可读：${err instanceof Error ? err.message : String(err)}`)
    }
    if (stagedHash !== proposal.hash) {
      return this.failProposal(proposal, 'hash_mismatch', '待装载区字节与提案哈希不一致（同一份字节绑定失败）——副本清偿，转正不发生')
    }
    const userTarget = path.join(this.opts.userRoot, proposal.pkg.id)
    // 原子转正：rename 进用户根（EXDEV 回落拷贝+验哈希+删源）
    try {
      fs.mkdirSync(this.opts.userRoot, { recursive: true })
      try {
        fs.renameSync(stagedDir, userTarget)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code !== 'EXDEV') throw err
        fs.cpSync(stagedDir, userTarget, { recursive: true })
        if (aggregateHashOf(userTarget) !== proposal.hash) throw new Error('EXDEV 拷贝后哈希不一致')
        fs.rmSync(stagedDir, { recursive: true, force: true })
      }
    } catch (err) {
      return this.failProposal(proposal, 'activation_failed', `转正失败：${err instanceof Error ? err.message : String(err)}`)
    }
    this.opts.host.rescan()
    // 有界激活：mount 结果三态——ok / 确定失败（补偿移除）/ 结果未知（不猜补偿，不自动重试）
    const mount = await this.boundedMount(proposal.pkg.id)
    if (mount.ok) {
      proposal.status = 'activated'
      this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId, pkgId: proposal.pkg.id, outcome: 'activated', hash: proposal.hash })
      this.opts.notify()
      return { ok: true, status: 'activated' }
    }
    if (mount.unknown) {
      // 结果未知：转正目录保留（实况以 plugins_list 对账），不猜补偿、不自动重试
      proposal.status = 'failed'
      proposal.error = { code: 'activation_unknown', message: mount.message ?? '激活结果未知（mount 等待超时）——转正目录保留，实况以插件清单对账；不自动重试', stateUnknown: true }
      try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
      this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, message: proposal.error.message })
      this.opts.notify()
      return { ok: false, code: 'activation_unknown', message: proposal.error.message, stateUnknown: true }
    }
    // 确定失败：补偿移除 + 再 rescan（rollback:'removed'）
    try { fs.rmSync(userTarget, { recursive: true, force: true }) } catch { /* 尽力 */ }
    try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    this.opts.host.rescan()
    proposal.status = 'failed'
    proposal.error = { code: 'activation_failed', message: mount.message ?? '激活失败——已补偿移除转正目录' }
    this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId, pkgId: proposal.pkg.id, outcome: 'activation_failed', rollback: 'removed', message: proposal.error.message })
    this.opts.notify()
    return { ok: false, code: 'activation_failed', message: proposal.error.message, rollback: 'removed' }
  }

  /** mount 等待套管理器时限（mountBoundMs）：宿主端口不回 → 结果未知（不猜） */
  private boundedMount(packageId: string): Promise<MountOutcome> {
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<MountOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, message: `激活等待超时（${this.opts.mountBoundMs}ms）——结果未知`, unknown: true }), this.opts.mountBoundMs)
    })
    return Promise.race([
      this.opts.host.waitMount(packageId, this.opts.mountBoundMs),
      timeout,
    ]).finally(() => { if (timer) clearTimeout(timer) })
  }

  private failProposal(proposal: InstallProposalView, code: 'hash_mismatch' | 'activation_failed', message: string): InstallProposalDecision {
    proposal.status = 'failed'
    proposal.error = { code, message }
    const stagedDir = path.join(this.opts.stagingRoot, proposal.proposalId)
    try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: code, message })
    this.opts.notify()
    return { ok: false, code, message, ...(code === 'activation_failed' ? { rollback: 'removed' as const } : {}) }
  }

  // ------------------------------------------------------------------
  // 拒绝：副本清偿 + gate_denied
  // ------------------------------------------------------------------

  private async rejectInner(proposalId: string): Promise<{ ok: boolean; code?: 'not_found' }> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false, code: 'not_found' }
    }
    const stagedDir = path.join(this.opts.stagingRoot, proposalId)
    try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    proposal.status = 'rejected'
    this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId, pkgId: proposal.pkg.id, outcome: 'gate_denied', hash: proposal.hash })
    this.opts.notify()
    return { ok: true }
  }
}
