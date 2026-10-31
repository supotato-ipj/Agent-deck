// DSH 安装/更新/卸载管线状态机（工单334 安装 / 工单335 更新·卸载·旧数据继承，
// ADR-0019 写入契约 / ADR-0025 批准面）：DSH 在会话工作区写源码 → 经确定性 MCP 操作提交
// （只收路径不收正文）→ 字节进待装载区（热插拔不可见）→ 严格校验 + 逐文件/聚合哈希 →
// 提案 pending → 可信内核 UI 真实用户手势批准/拒绝 → 批准复算哈希（同一份字节绑定）→
// 原子转正/换代进用户根 → rescan → 有界激活；确定失败补偿，结果未知不猜补偿、绝不自动重试。
//
// 工单335 同族扩展：update 提案（新代次进待装载区，**待批期间旧代次继续运行**，diff 与
// 权限变化进批准 UI 数据面；相同字节 → no_change 不重载不制造批准）→ 批准=原子换代
// （旧版入内部控制面备份 → 新代次落位 → 激活 → 旧版送回收站；回收站失败保留备份绝不
// 降级永久删除）；uninstall 走回收站（失败明确报错不降级）；旧数据继承是独立用户手势
// （卸载保留 `<id>.json` 但脱离挂载；同 id 重装提案带继承项；不继承 = detach 新配置起步，
// 数据不永久删除）；全部写操作走同一串行信号量（busy 唯一可重试码）。审计意图/结局分离。
//
// 工单336 首个敏感权限完整闭环：permission_deferred 边界对 media.read 打开——纯 media.read
// 包走批准（提案带权限清单，批准落**持久化授权账** id+权限集合+代码哈希；激活失败账回滚、
// 结果未知账保留；更新重批=换代账换哈希；卸载清账）；media.read 之外的敏感权限通道仍未
// 开放（permission_deferred，#337/#338 打开）。手动投放同闸门：手动落进用户根的敏感包由
// 服务层挂 manual 提案（批准=复算用户根哈希绑定→落账→rescan→有界激活；拒绝=文件不动、
// 包不执行；用户根文件是用户放的，清偿只走卸载回收站）。
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { classifyDroppedManifest, type DroppedManifest, type MigrationIssue } from './dropped-manifest'
import { PLUGIN_ID_RE } from './manifest'
import type { InstallProposalView, UpdateDiffView } from '../../shared/contract'

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

const BUSY_MESSAGE = '已有插件写操作在途（串行写）——等待当前操作结束后重试'

export interface InstallFileEntry {
  /** 包内相对路径（POSIX 分隔） */
  path: string
  sha256: string
  sizeBytes: number
}

// 提案视图类型单源在 shared/contract（批准 UI 与主进程同一词汇）；此处 re-export 供测试/内部引用
export type { InstallProposalView, UpdateDiffView } from '../../shared/contract'

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
  /**
   * 更新换代备份根（工单335，ADR-0019「内部控制面备份」）：批准换代前旧版先移入此处，
   * 激活成功后送回收站；回收站失败/无端口时备份**保留**（绝不降级永久删除）。
   * 缺省 = 待装载区同级 `<stagingRoot>-backup`（不在构造期孤儿清扫范围——备份不是提案孤儿）。
   */
  backupRoot?: string
  kernelRoots: string[]
  /** 会话工作区包含校验的事实源：sessionId → cwd（不采信调用参数自报工作区） */
  sessionInfo(sessionId: string): { cwd: string; label: string | null } | null
  log(event: Record<string, unknown>): void
  notify(): void
  now(): number
  opId(): string
  host: InstallManagerHost
  mountBoundMs: number
  /**
   * 回收站端口（工单335，生产 = Electron shell.trashItem）：卸载与更新旧版处置的**唯一**
   * 删除路径——失败即明确报错，绝不降级永久删除（票面红线）。缺省 = 卸载如实不可用。
   */
  trashItem?(dir: string): Promise<void>
  /**
   * 包私有配置文件路径（工单335 旧数据继承事实源，生产 = plugin-config 目录 `<id>.json`）：
   * 安装提案检测卸载残留 → 提案带继承项；批准时按独立手势决定保留（inherited）或
   * 脱离（fresh：rename 到 `<file>.detached`，不永久删除）。缺省 = 无继承面。
   */
  pluginConfigFile?(id: string): string
  /**
   * 停用/启用端口（工单335，生产 = SettingsService.setCardEnabled——ADR-0019「沿用既有
   * 方法名」，MCP 写工具接既有停用集缝，不另立账）。缺省 = 工具如实不可用。
   */
  setCardEnabled?(id: string, enabled: boolean): unknown
  /**
   * 授权账端口（工单336，生产 = PluginAuthorizationLedger）：批准敏感包时落账
   * （id+权限集合+代码哈希三元组，跨重启）；激活确定失败回滚（revoke）；卸载/权限摘除
   * 清账（clear）。缺省 = 无授权面（media.read 包批准时如实报不可用）。
   */
  authorization?: {
    grant(packageId: string, permissions: string[], codeHash: string): void
    revoke(packageId: string): void
    clear(packageId: string): void
  }
}

export interface InstallSubmitCtx {
  sessionId: string
  backend: string
}

export type InstallProposalDecision =
  | { ok: true; status: 'activated'; warnings?: string[] }
  | {
      ok: false
      code: 'hash_mismatch' | 'activation_failed' | 'activation_unknown' | 'not_found'
      message: string
      rollback?: 'removed' | 'restored'
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
      issues?: InstallIssue[]
      existing?: unknown
      retryable?: boolean
    }

export type UpdateSubmitResult =
  | { ok: true; status: 'pending-approval'; proposal: InstallProposalView; opId: string }
  | { ok: true; status: 'no_change'; packageId: string; opId: string }
  | {
      ok: false
      code:
        | 'invalid_args'
        | 'invalid_source'
        | 'invalid_package'
        | 'permission_deferred'
        | 'id_mismatch'
        | 'not_found'
        | 'not_manageable'
        | 'busy'
      message: string
      opId?: string
      issues?: InstallIssue[]
      retryable?: boolean
    }

export type UninstallResult =
  | { ok: true; opId: string }
  | {
      ok: false
      code: 'invalid_args' | 'not_found' | 'not_manageable' | 'busy' | 'not_wired' | 'trash_failed'
      message: string
      opId?: string
      retryable?: boolean
    }

export type SetEnabledResult =
  | { ok: true; state: unknown }
  | { ok: false; code: 'invalid_args' | 'busy' | 'not_wired' | 'write_failed'; message: string; retryable?: boolean }

export type InheritanceDecisionResult =
  | { ok: true; decision: 'inherited' | 'fresh' }
  | { ok: false; code: 'not_found' | 'not_applicable'; message: string }

/** 聚合哈希的文件清单来源：目录内全部常规文件按相对路径排序，逐个 sha256 */
export function listFileEntries(dir: string): InstallFileEntry[] {
  const files: InstallFileEntry[] = []
  const walk = (cur: string, rel: string): void => {
    for (const e of fs.readdirSync(cur, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name))) {
      const childAbs = path.join(cur, e.name)
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(childAbs, childRel)
      else files.push({ path: childRel, sha256: sha256(fs.readFileSync(childAbs)), sizeBytes: fs.statSync(childAbs).size })
    }
  }
  walk(dir, '')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** 聚合哈希：目录内文件按相对路径排序，`${path}:${sha256}\n` 逐行串取 sha256（与提交清单同源） */
export function aggregateHashOf(dir: string): string {
  const lines = listFileEntries(dir)
    .map((f) => `${f.path}:${f.sha256}\n`)
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

/** 安装管线 issue：形状复用 MigrationIssue（code/message），码域并入字节守卫各码（ADR-0019） */
export type InstallIssueCode = MigrationIssue['code']
  | 'limit_file_size' | 'limit_total_size' | 'limit_file_count' | 'limit_path_depth'
  | 'extension_not_allowed' | 'forbidden_entry' | 'symlink_rejected' | 'unreadable_entry'
export interface InstallIssue {
  code: InstallIssueCode
  message: string
}

/** 来源守卫失败（submit/submitUpdate 同族）：错误信封共用码域 */
interface SourceGuardFail {
  code: 'invalid_args' | 'invalid_source'
  message: string
}

/** 待装载区拷贝失败（字节守卫/结构缺失）：错误信封共用码域 */
interface StageFail {
  code: 'invalid_source' | 'invalid_package'
  message: string
  issues?: InstallIssue[]
}

/**
 * 敏感权限边界（工单336 首个敏感权限完整闭环）：本票只开 media.read 通路——
 * 声明的权限**全部** = media.read 的包走批准（提案带权限清单，批准落授权账）；
 * 混入任何其他敏感权限（media.control/network.request，通道归 #337/#338）仍结构化拒绝
 * permission_deferred。返回 null = 可走批准；返回信封 = 拒绝（含清偿语义的调用方责任）。
 */
function permissionGate(manifest: DroppedManifest): { code: 'permission_deferred'; message: string } | null {
  const blocked = manifest.permissions.filter((p) => p !== 'media.read')
  if (blocked.length === 0) return null
  return {
    code: 'permission_deferred',
    message: `含批准通道未开放的敏感权限 [${blocked.join(', ')}] 的包暂不接受提交（media.read 通路已开放，其余敏感权限随后续票落地）`,
  }
}

export class PluginInstallManager {
  private readonly opts: InstallManagerOptions
  private readonly proposals = new Map<string, InstallProposalView>()
  /** 手动提案的包目录（proposalId → 用户根包目录；批准=复算该目录哈希绑定） */
  private readonly manualDirs = new Map<string, string>()
  /** 手动提案按包 id 幂等：pkgId → proposalId（重复注册替换旧提案） */
  private readonly manualByPkg = new Map<string, string>()
  /** 更新提案的旧代次权限清单（proposalId → oldPermissions；换代失败还原账时用） */
  private readonly updateOldPerms = new Map<string, string[]>()
  /** 串行化信号量：submit/update/uninstall/setEnabled 在途互斥（busy，唯一可重试码）；approve/reject/decideInheritance 排队跟走 */
  private active = 0
  private tail: Promise<unknown> = Promise.resolve()
  private disposed = false
  private readonly backupRoot: string

  constructor(opts: InstallManagerOptions) {
    this.opts = opts
    this.backupRoot = opts.backupRoot ?? `${opts.stagingRoot}-backup`
    // 孤儿清偿（红线「不留待装载区孤儿」）：面板重启 = 全部在途提案作废，构造期清扫。
    // 备份根**不在清扫范围**——备份是成功换代/回收站失败的文件级恢复面，不是提案孤儿。
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
    this.proposals.clear()
    this.manualDirs.clear()
    this.manualByPkg.clear()
    this.updateOldPerms.clear()
    try {
      fs.rmSync(this.opts.stagingRoot, { recursive: true, force: true })
    } catch { /* 尽力 */ }
  }

  list(): InstallProposalView[] {
    return [...this.proposals.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** 真实用户手势（可信内核 UI）：批准 = 同一份字节复算哈希 → 原子转正/换代 → 有界激活 */
  approve(proposalId: string): Promise<InstallProposalDecision> {
    return this.enqueue(async () => this.approveInner(proposalId))
  }

  /**
   * 手动提案挂载（工单336 手动投放同闸门）：手动落进用户根的敏感包由服务层（rescan）
   * 经此挂成 pending 提案——批准 UI 与 MCP 提交同一份提案词汇，批准前包不执行。
   * 同 id 幂等替换（重复 rescan 不重复挂条）；返回新提案视图。
   */
  registerManualProposal(args: { pkg: InstallProposalView['pkg']; dir: string; files: InstallFileEntry[]; hash: string }): InstallProposalView {
    const prev = this.manualByPkg.get(args.pkg.id)
    if (prev) {
      this.proposals.delete(prev)
      this.manualDirs.delete(prev)
    }
    const opId = this.opts.opId()
    const proposalId = `prop-manual-${opId}`
    const proposal: InstallProposalView = {
      proposalId,
      opId,
      status: 'pending',
      pkg: { ...args.pkg, permissions: [...args.pkg.permissions] },
      files: args.files.map((f) => ({ ...f })),
      hash: args.hash,
      source: { sessionId: '', backend: 'manual', label: null },
      createdAt: this.opts.now(),
      error: null,
      manual: true,
    }
    this.proposals.set(proposalId, proposal)
    this.manualDirs.set(proposalId, args.dir)
    this.manualByPkg.set(args.pkg.id, proposalId)
    this.opts.log({ type: 'plugin-manual-proposal', proposalId, opId, pkgId: args.pkg.id, permissions: [...args.pkg.permissions], hash: args.hash })
    this.opts.notify()
    return proposal
  }

  /** 手动提案摘除（包从用户根消失/卸载后由服务层调用；id 不符的迟到调用如实忽略） */
  dropManualProposal(packageId: string, proposalId?: string): void {
    const current = this.manualByPkg.get(packageId)
    if (!current) return
    if (proposalId && current !== proposalId) return
    this.proposals.delete(current)
    this.manualDirs.delete(current)
    this.manualByPkg.delete(packageId)
    this.opts.notify()
  }

  /** 在册 pending 手动提案 id（服务层幂等挂载的判据；已决/不存在 = null） */
  pendingManualProposalId(packageId: string): string | null {
    const current = this.manualByPkg.get(packageId)
    if (!current) return null
    const p = this.proposals.get(current)
    return p && p.status === 'pending' ? current : null
  }

  /** 真实用户手势：拒绝 = 待装载区副本清偿 + gate_denied 审计（用户根从未出现/旧代次不动） */
  reject(proposalId: string): Promise<{ ok: boolean; code?: 'not_found' }> {
    return this.enqueue(async () => this.rejectInner(proposalId))
  }

  /** 真实用户手势（工单335，独立于代码批准）：旧数据继承裁决——继承/不继承各自成手势 */
  decideInheritance(proposalId: string, inherit: boolean): Promise<InheritanceDecisionResult> {
    return this.enqueue(async () => {
      const proposal = this.proposals.get(proposalId)
      if (!proposal || proposal.status !== 'pending') {
        return { ok: false as const, code: 'not_found' as const, message: `提案不存在或已决（${proposalId}）` }
      }
      if (!proposal.dataInheritance) {
        return { ok: false as const, code: 'not_applicable' as const, message: '该提案没有旧数据继承面（未撞见卸载残留配置）' }
      }
      proposal.dataInheritance.decision = inherit ? 'inherited' : 'fresh'
      this.opts.notify()
      return { ok: true as const, decision: proposal.dataInheritance.decision }
    })
  }

  submit(args: { sourceDir?: unknown }, ctx: InstallSubmitCtx): Promise<InstallSubmitResult> {
    // 写入口互斥（busy 唯一可重试码）；approve/reject/decideInheritance 只排队不互斥
    if (this.active > 0 || this.disposed) return Promise.resolve(this.busyResult())
    this.active += 1
    const run = this.tail.then(() => this.submitInner(args, ctx), () => this.submitInner(args, ctx))
    this.tail = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.active -= 1 })
  }

  /** 工单335 更新提交：目标=用户根在册包；相同字节 → no_change；否则提案 pending（旧代次不动） */
  submitUpdate(args: { packageId?: unknown; sourceDir?: unknown }, ctx: InstallSubmitCtx): Promise<UpdateSubmitResult> {
    if (this.active > 0 || this.disposed) return Promise.resolve(this.busyResultUpdate())
    this.active += 1
    const run = this.tail.then(() => this.submitUpdateInner(args, ctx), () => this.submitUpdateInner(args, ctx))
    this.tail = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.active -= 1 })
  }

  /** 工单335 卸载：回收站唯一删除路径；失败明确报错，绝不降级永久删除（票面红线） */
  uninstall(args: { packageId?: unknown }): Promise<UninstallResult> {
    if (this.active > 0 || this.disposed) return Promise.resolve(this.busyResultUninstall())
    this.active += 1
    const run = this.tail.then(() => this.uninstallInner(args), () => this.uninstallInner(args))
    this.tail = run.then(() => undefined, () => undefined)
    return run.finally(() => { this.active -= 1 })
  }

  /** 工单335 停用/启用：串行内接 settings 停用集缝（ADR-0019 沿用既有方法名，不另立账） */
  setEnabled(args: { packageId?: unknown; enabled?: unknown }): Promise<SetEnabledResult> {
    if (this.active > 0 || this.disposed) return Promise.resolve(this.busyResultSetEnabled())
    this.active += 1
    const run = this.tail.then(() => this.setEnabledInner(args), () => this.setEnabledInner(args))
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
    return { ok: false, code: 'busy', message: BUSY_MESSAGE, retryable: true }
  }
  private busyResultUpdate(): UpdateSubmitResult {
    return { ok: false, code: 'busy', message: BUSY_MESSAGE, retryable: true }
  }
  private busyResultUninstall(): UninstallResult {
    return { ok: false, code: 'busy', message: BUSY_MESSAGE, retryable: true }
  }
  private busyResultSetEnabled(): SetEnabledResult {
    return { ok: false, code: 'busy', message: BUSY_MESSAGE, retryable: true }
  }

  // ------------------------------------------------------------------
  // 来源守卫与待装载区（submit / submitUpdate 同族共用）
  // ------------------------------------------------------------------

  /** 来源守卫：形状 → 会话在册 → 存在/目录 → 越界（插件根/待装载区）→ 工作区包含 */
  private guardSource(sourceDirRaw: unknown, ctx: InstallSubmitCtx): { ok: true; sourceDir: string } | { ok: false; fail: SourceGuardFail } {
    if (typeof sourceDirRaw !== 'string' || !sourceDirRaw.trim() || !path.isAbsolute(sourceDirRaw)) {
      return { ok: false, fail: { code: 'invalid_args', message: 'sourceDir 必须是绝对路径（MCP 只收路径不收正文）' } }
    }
    const session = this.opts.sessionInfo(ctx?.sessionId ?? '')
    if (!session) {
      return { ok: false, fail: { code: 'invalid_args', message: `未知会话（sessionId=${String(ctx?.sessionId)}）——安装只能由在册会话经其通道发起` } }
    }
    const sourceDir = path.resolve(sourceDirRaw)
    let st: fs.Stats
    try {
      st = fs.statSync(sourceDir)
    } catch {
      return { ok: false, fail: { code: 'invalid_source', message: `sourceDir 不存在或不可达：${sourceDir}` } }
    }
    if (!st.isDirectory()) {
      return { ok: false, fail: { code: 'invalid_source', message: `sourceDir 不是目录：${sourceDir}` } }
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
        return { ok: false, fail: { code: 'invalid_source', message: `sourceDir 落在插件根/待装载区内（${root}）——提交来源必须是会话工作区` } }
      }
    }
    // 会话工作区包含校验：realpath 后必须在调用会话 cwd 内（通道绑定身份，不采信自报）
    let realCwd = session.cwd
    try { realCwd = fs.realpathSync(session.cwd) } catch { /* cwd 不存在按原路径 */ }
    if (!isInside(realSource, realCwd)) {
      return { ok: false, fail: { code: 'invalid_source', message: `sourceDir 不在会话工作区内（${realCwd}）——DSH 只能提交自己工作区里的包` } }
    }
    return { ok: true, sourceDir }
  }

  /** 字节拷贝进待装载区 + 逐条目守卫（上限/扩展名/禁入项/符号链接/manifest 在根） */
  private stageCopy(sourceDir: string, proposalId: string): { ok: true; stagedDir: string; files: InstallFileEntry[] } | { ok: false; fail: StageFail } {
    const stagedDir = path.join(this.opts.stagingRoot, proposalId)
    const cleanupStaging = (): void => {
      try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    }
    const issues: InstallIssue[] = []
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
      return { ok: false, fail: { code: 'invalid_package', message: `包字节不合格（${issues.length} 项），详见 issues`, issues: [...issues] } }
    }
    try {
      fs.mkdirSync(this.opts.stagingRoot, { recursive: true })
      fs.cpSync(sourceDir, stagedDir, { recursive: true, verbatimSymlinks: false })
    } catch (err) {
      cleanupStaging()
      return { ok: false, fail: { code: 'invalid_source', message: `待装载区拷贝失败：${err instanceof Error ? err.message : String(err)}` } }
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
    walkStaged(stagedDir, '')
    if (files.length > LIMIT_FILE_COUNT) {
      issues.push({ code: 'limit_file_count', message: `文件数超限（>${LIMIT_FILE_COUNT}）` })
    }
    if (issues.length > 0) {
      cleanupStaging()
      return { ok: false, fail: { code: 'invalid_package', message: `包字节不合格（${issues.length} 项），详见 issues`, issues: [...issues] } }
    }
    if (files.length === 0 || !files.some((f) => f.path === 'plugin.json')) {
      cleanupStaging()
      return { ok: false, fail: { code: 'invalid_package', message: '包缺 plugin.json（manifest 必须在包根）', issues: [{ code: 'manifest_invalid', message: 'plugin.json 缺失' }] } }
    }
    return { ok: true, stagedDir, files }
  }

  // ------------------------------------------------------------------
  // 提交（安装）：守卫 → 待装载区 → 严格校验 → 哈希 → 提案 pending
  // ------------------------------------------------------------------

  private async submitInner(args: { sourceDir?: unknown }, ctx: InstallSubmitCtx): Promise<InstallSubmitResult> {
    const opId = this.opts.opId()
    const guarded = this.guardSource(args?.sourceDir, ctx)
    if (!guarded.ok) {
      return { ok: false, ...guarded.fail, opId }
    }

    const proposalId = `prop-${opId}`
    const staged = this.stageCopy(guarded.sourceDir, proposalId)
    if (!staged.ok) {
      return { ok: false, ...staged.fail, opId }
    }
    const cleanupStaging = (): void => {
      try { fs.rmSync(staged.stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    }

    // 严格校验（ADR-0019 同一分类器）：结构错 → 缺主版本 → 不兼容 → 未知权限
    let manifestRaw: unknown
    try {
      manifestRaw = JSON.parse(fs.readFileSync(path.join(staged.stagedDir, 'plugin.json'), 'utf8'))
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
    // 敏感权限边界（工单336）：media.read 通路开放（提案带权限清单走批准）；
    // media.read 之外的敏感权限通道未开放 → 结构化拒绝 + 副本清偿
    const gate = permissionGate(manifest)
    if (gate) {
      cleanupStaging()
      return {
        ok: false, code: gate.code, message: gate.message, opId,
        issues: [{ code: 'permission_unknown', message: `${gate.message}——零权限包不受此限` }],
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
      return { ok: false, code: 'id_conflict', message: `包 id「${manifest.id}」在用户插件根已存在（更新走 update 提交，不重复安装）`, opId, existing: { where: 'user', id: manifest.id, dir: userTarget } }
    }

    // 旧数据继承面（工单335，ADR-0025）：撞见卸载残留的私有配置 → 提案带独立批准项
    const configFile = this.opts.pluginConfigFile?.(manifest.id)
    const hasLeftover = configFile ? fs.existsSync(configFile) : false

    // 提案在册（pending）+ 审计意图；结局等真实用户手势
    const hash = aggregateHashOf(staged.stagedDir)
    const proposal: InstallProposalView = {
      proposalId,
      opId,
      status: 'pending',
      pkg: { id: manifest.id, name: manifest.name, version: manifest.version, hostApiVersion: manifest.hostApiVersion, permissions: [...manifest.permissions] },
      files: staged.files,
      hash,
      source: { sessionId: ctx.sessionId, backend: ctx.backend, label: this.opts.sessionInfo(ctx.sessionId)?.label ?? null },
      createdAt: this.opts.now(),
      error: null,
      ...(hasLeftover ? { dataInheritance: { decision: 'pending' as const } } : {}),
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
      permissions: [...manifest.permissions],
      hash,
      files: staged.files.length,
      ...(hasLeftover ? { dataInheritance: true } : {}),
    })
    this.opts.notify()
    return { ok: true, status: 'pending-approval', proposal, opId }
  }

  // ------------------------------------------------------------------
  // 更新提交（工单335）：目标在册 → 同族守卫/拷贝 → diff → no_change / 提案 pending
  //（待批期间旧代次继续运行——用户根字节全程不动）
  // ------------------------------------------------------------------

  private async submitUpdateInner(args: { packageId?: unknown; sourceDir?: unknown }, ctx: InstallSubmitCtx): Promise<UpdateSubmitResult> {
    const opId = this.opts.opId()
    const packageId = args?.packageId
    if (typeof packageId !== 'string' || !PLUGIN_ID_RE.test(packageId)) {
      return { ok: false, code: 'invalid_args', message: `packageId 须为合法包 id（小写主机名字符集）：${String(packageId)}`, opId }
    }
    // 目标守卫先于来源拷贝（fail fast，不为不可达目标搬字节）：内核/第一方档与缺失目标
    if (RESERVED_PACKAGE_IDS.has(packageId)) {
      return { ok: false, code: 'not_manageable', message: `包 id「${packageId}」是保留标识（内核宿主名）`, opId }
    }
    for (const kernelRoot of this.opts.kernelRoots) {
      if (fs.existsSync(path.join(kernelRoot, packageId, 'plugin.json'))) {
        return { ok: false, code: 'not_manageable', message: `包「${packageId}」是内核/第一方档插件（不可经控制面更新）`, opId }
      }
    }
    const userTarget = path.join(this.opts.userRoot, packageId)
    if (!fs.existsSync(path.join(userTarget, 'plugin.json'))) {
      return { ok: false, code: 'not_found', message: `用户插件根中不存在包「${packageId}」（更新目标是用户根在册包）`, opId }
    }
    // 旧代次 manifest（diff 事实源）：分类未通过 = 不是可管理的更新目标
    let oldManifest: DroppedManifest
    try {
      const classifiedOld = classifyDroppedManifest(JSON.parse(fs.readFileSync(path.join(userTarget, 'plugin.json'), 'utf8')))
      if (!classifiedOld.ok) throw new Error(classifiedOld.issues.map((i) => i.message).join('；'))
      oldManifest = classifiedOld.manifest
    } catch (err) {
      return { ok: false, code: 'not_manageable', message: `目标包 manifest 分类未通过（${err instanceof Error ? err.message : String(err)}）`, opId }
    }

    const guarded = this.guardSource(args?.sourceDir, ctx)
    if (!guarded.ok) {
      return { ok: false, ...guarded.fail, opId }
    }
    const proposalId = `prop-${opId}`
    const staged = this.stageCopy(guarded.sourceDir, proposalId)
    if (!staged.ok) {
      return { ok: false, ...staged.fail, opId }
    }
    const cleanupStaging = (): void => {
      try { fs.rmSync(staged.stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    }

    // 新代次严格校验（同一分类器 + 敏感权限边界）
    let manifestRaw: unknown
    try {
      manifestRaw = JSON.parse(fs.readFileSync(path.join(staged.stagedDir, 'plugin.json'), 'utf8'))
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
    const gate = permissionGate(manifest)
    if (gate) {
      cleanupStaging()
      return {
        ok: false, code: gate.code, message: gate.message, opId,
        issues: [{ code: 'permission_unknown', message: `${gate.message}——零权限包不受此限` }],
      }
    }
    // 不允许改名（ADR-0019）：改名 = uninstall + install，两次闸门
    if (manifest.id !== packageId) {
      cleanupStaging()
      return { ok: false, code: 'id_mismatch', message: `源 manifest id「${manifest.id}」≠ 目标包 id「${packageId}」——更新不允许改名`, opId }
    }

    // 相同字节 → no_change：不重载、不制造批准、无待装载区残留
    const newHash = aggregateHashOf(staged.stagedDir)
    const oldHash = aggregateHashOf(userTarget)
    if (newHash === oldHash) {
      cleanupStaging()
      this.opts.log({ type: 'plugin-update-nochange', opId, pkgId: packageId, hash: newHash })
      return { ok: true, status: 'no_change', packageId, opId }
    }

    // 旧→新 diff（批准 UI 数据面）：文件三态 + 权限变化 + 版本旧→新
    const oldEntries = listFileEntries(userTarget)
    const newEntries = staged.files
    const oldByPath = new Map(oldEntries.map((f) => [f.path, f]))
    const newByPath = new Map(newEntries.map((f) => [f.path, f]))
    const added = newEntries.filter((f) => !oldByPath.has(f.path)).map((f) => f.path)
    const removed = oldEntries.filter((f) => !newByPath.has(f.path)).map((f) => f.path)
    const changed = newEntries.filter((f) => {
      const o = oldByPath.get(f.path)
      return o && o.sha256 !== f.sha256
    }).map((f) => f.path)
    const permAdded = manifest.permissions.filter((p) => !oldManifest.permissions.includes(p))
    const permRemoved = oldManifest.permissions.filter((p) => !manifest.permissions.includes(p))
    const update: UpdateDiffView = {
      packageId,
      oldVersion: oldManifest.version,
      newVersion: manifest.version,
      oldHash,
      newHash,
      permissions: { added: permAdded, removed: permRemoved },
      files: { added, removed, changed },
    }

    const proposal: InstallProposalView = {
      proposalId,
      opId,
      status: 'pending',
      pkg: { id: manifest.id, name: manifest.name, version: manifest.version, hostApiVersion: manifest.hostApiVersion, permissions: [...manifest.permissions] },
      files: staged.files,
      hash: newHash,
      source: { sessionId: ctx.sessionId, backend: ctx.backend, label: this.opts.sessionInfo(ctx.sessionId)?.label ?? null },
      createdAt: this.opts.now(),
      error: null,
      update,
    }
    // 换代失败还原账的事实源：旧代次权限清单（工单336 账还原旧哈希时同权还原权限集合）
    this.updateOldPerms.set(proposalId, [...oldManifest.permissions])
    this.proposals.set(proposalId, proposal)
    this.opts.log({
      type: 'plugin-update-intent',
      opId,
      proposalId,
      sessionId: ctx.sessionId,
      backend: ctx.backend,
      pkgId: packageId,
      version: manifest.version,
      oldVersion: oldManifest.version,
      hash: newHash,
      oldHash,
      files: staged.files.length,
    })
    this.opts.notify()
    return { ok: true, status: 'pending-approval', proposal, opId }
  }

  // ------------------------------------------------------------------
  // 批准：哈希绑定 → 原子转正/换代 → 有界激活 → 补偿/结果未知
  // ------------------------------------------------------------------

  private async approveInner(proposalId: string): Promise<InstallProposalDecision> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false, code: 'not_found', message: `提案不存在或已决（${proposalId}）` }
    }
    // 手动提案（工单336 手动投放同闸门）：字节已在用户根，批准=复算用户根哈希绑定
    if (proposal.manual) {
      const dir = this.manualDirs.get(proposalId) ?? path.join(this.opts.userRoot, proposal.pkg.id)
      return this.approveManual(proposal, dir)
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
    if (proposal.update) return this.approveUpdate(proposal, stagedDir, userTarget)
    return this.approveInstall(proposal, stagedDir, userTarget)
  }

  /**
   * 授权账落账（工单336）：转正后、rescan 激活前——账齐服务层才激活（按账重评授权）。
   * 无授权面且包带敏感权限 = 批准面不完整，如实失败（转正不发生后的清偿由调用方处理）。
   */
  private grantAuthorization(packageId: string, permissions: string[], hash: string): boolean {
    if (permissions.length === 0) return true
    if (!this.opts.authorization) return false
    this.opts.authorization.grant(packageId, permissions, hash)
    return true
  }

  /** 安装批准（工单334 原语义 + 工单335 旧数据继承结算） */
  private async approveInstall(proposal: InstallProposalView, stagedDir: string, userTarget: string): Promise<InstallProposalDecision> {
    // 旧数据继承结算（工单335，先于转正——包永远观察不到未授权的旧配置）：
    // 继承是独立用户手势；未决默认 fresh（detach，不永久删除），继承 = 残留文件原样保留
    const inheritFail = this.settleInheritance(proposal)
    if (inheritFail) return this.failProposal(proposal, 'activation_failed', inheritFail)
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
    // 授权账落账（工单336）：转正后、rescan 激活前——账齐服务层才激活。账面哈希=提案哈希
    // =转正字节同一份；落账失败（未装配授权面）=激活面不完整，按激活失败清偿。
    if (!this.grantAuthorization(proposal.pkg.id, proposal.pkg.permissions, proposal.hash)) {
      try { fs.rmSync(userTarget, { recursive: true, force: true }) } catch { /* 尽力 */ }
      return this.failProposal(proposal, 'activation_failed', '未装配授权账面——敏感包批准无法落账（转正目录已补偿移除）')
    }
    this.opts.host.rescan()
    // 有界激活：mount 结果三态——ok / 确定失败（补偿移除+账回滚）/ 结果未知（不猜补偿，不自动重试）
    const mount = await this.boundedMount(proposal.pkg.id)
    if (mount.ok) {
      proposal.status = 'activated'
      this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activated', hash: proposal.hash })
      this.opts.notify()
      return { ok: true, status: 'activated' }
    }
    if (mount.unknown) {
      // 结果未知：转正目录保留（实况以 plugins_list 对账），账保留，不猜补偿、不自动重试
      proposal.status = 'failed'
      proposal.error = { code: 'activation_unknown', message: mount.message ?? '激活结果未知（mount 等待超时）——转正目录保留，实况以插件清单对账；不自动重试', stateUnknown: true }
      try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
      this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, message: proposal.error.message })
      this.opts.notify()
      return { ok: false, code: 'activation_unknown', message: proposal.error.message, stateUnknown: true }
    }
    // 确定失败：补偿移除 + 授权账回滚 + 再 rescan（rollback:'removed'）
    if (proposal.pkg.permissions.length > 0) this.opts.authorization?.revoke(proposal.pkg.id)
    try { fs.rmSync(userTarget, { recursive: true, force: true }) } catch { /* 尽力 */ }
    try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    this.opts.host.rescan()
    proposal.status = 'failed'
    proposal.error = { code: 'activation_failed', message: mount.message ?? '激活失败——已补偿移除转正目录' }
    this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_failed', rollback: 'removed', message: proposal.error.message })
    this.opts.notify()
    return { ok: false, code: 'activation_failed', message: proposal.error.message, rollback: 'removed' }
  }

  /**
   * 旧数据继承结算（工单335）：返回 null = 已结算；返回字符串 = detach 失败（批准不发生）。
   * 继承（inherited）= 残留 `<id>.json` 原样保留（包重新可读旧数据，ADR-0025「经独立批准
   * 后才能重新读取」）；fresh（显式拒绝或未决默认）= rename 到 `<id>.json.detached`——
   * 新配置起步而数据不永久删除（删除归内核 UI 的独立「重置」动作，ADR-0019）。
   */
  private settleInheritance(proposal: InstallProposalView): string | null {
    const di = proposal.dataInheritance
    if (!di) return null
    const file = this.opts.pluginConfigFile?.(proposal.pkg.id)
    const defaulted = di.decision === 'pending'
    const decision: 'inherited' | 'fresh' = di.decision === 'inherited' ? 'inherited' : 'fresh'
    if (decision === 'fresh' && file && fs.existsSync(file)) {
      const detached = `${file}.detached`
      try {
        if (fs.existsSync(detached)) fs.rmSync(detached, { force: true }) // 更早一轮已拒绝继承的数据被本轮拒绝替代
        fs.renameSync(file, detached)
      } catch (err) {
        return `旧配置脱离失败（${err instanceof Error ? err.message : String(err)}）——转正不发生（包不得读到未授权的旧数据）`
      }
    }
    di.decision = decision
    this.opts.log({ type: 'plugin-config-inheritance', proposalId: proposal.proposalId, opId: proposal.opId, pkgId: proposal.pkg.id, decision, defaulted })
    return null
  }

  /**
   * 更新批准（工单335，ADR-0019 update 换入）：暂停观察不可行（watch 同源 rescan 承接），
   * 原子换代 = 旧版入内部控制面备份 → 新代次落位 → rescan → 有界激活 → 旧版送回收站。
   * 落位失败还原旧版（rollback restored）；还原失败/激活超时 = 结果未知不猜补偿
   * （新代次在位实况以清单对账，备份保留为人工恢复面）；回收站失败备份保留（红线）。
   */
  private async approveUpdate(proposal: InstallProposalView, stagedDir: string, userTarget: string): Promise<InstallProposalDecision> {
    const backupDir = path.join(this.backupRoot, `old-${proposal.pkg.id}-${proposal.opId}`)
    // 1) 旧版入备份（换代未开始，失败即安全——staged 副本清偿，用户根原样）
    try {
      fs.mkdirSync(this.backupRoot, { recursive: true })
      fs.renameSync(userTarget, backupDir)
    } catch (err) {
      return this.failProposal(proposal, 'activation_failed', `旧版备份失败（${err instanceof Error ? err.message : String(err)}）——换代未发生`)
    }
    // 2) 新代次落位（EXDEV 回落同族）；落位失败还原旧版
    try {
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
      try {
        fs.renameSync(backupDir, userTarget)
      } catch (restoreErr) {
        // 还原也失败：结果未知，保留备份与审计，不猜补偿
        const message = `新代次落位失败且旧版还原失败（${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}）——结果未知，备份保留于 ${backupDir}`
        proposal.status = 'failed'
        proposal.error = { code: 'activation_failed', message, stateUnknown: true }
        this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, backupPath: backupDir, message })
        this.opts.notify()
        return { ok: false, code: 'activation_unknown', message, stateUnknown: true }
      }
      return this.failProposal(proposal, 'activation_failed', `新代次落位失败（已还原旧版）：${err instanceof Error ? err.message : String(err)}`, { rollback: 'restored' })
    }
    // 3) 授权账换代（工单336）：新权限集合+新哈希落账（批准更新=重新批准，同 id 新代码
    // 不继承旧批准）；摘除敏感权限的更新=清账（零权限不需要授权）。落账失败（未装配授权
    // 而新代次带敏感权限）= 换代面不完整，走旧版还原（账随字节还原）。
    const newPerms = proposal.pkg.permissions
    if (newPerms.length === 0) this.opts.authorization?.clear(proposal.pkg.id)
    else if (!this.grantAuthorization(proposal.pkg.id, newPerms, proposal.hash)) {
      try {
        fs.renameSync(backupDir, userTarget)
      } catch (restoreErr) {
        const message = `授权落账失败且旧版还原失败（${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}）——结果未知，备份保留于 ${backupDir}`
        proposal.status = 'failed'
        proposal.error = { code: 'activation_failed', message, stateUnknown: true }
        this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, backupPath: backupDir, message })
        this.opts.notify()
        return { ok: false, code: 'activation_unknown', message, stateUnknown: true }
      }
      return this.failProposal(proposal, 'activation_failed', '未装配授权账面——敏感更新无法落账（已还原旧版）', { rollback: 'restored' })
    }
    this.opts.host.rescan()
    const mount = await this.boundedMount(proposal.pkg.id)
    if (mount.ok) {
      proposal.status = 'activated'
      const warnings: string[] = []
      // 旧版送回收站（ADR-0019）：失败保留备份，绝不降级永久删除（票面红线）
      if (this.opts.trashItem) {
        try {
          await this.opts.trashItem(backupDir)
        } catch (err) {
          warnings.push(`旧版回收站失败（${err instanceof Error ? err.message : String(err)}）——备份保留于 ${backupDir}，未降级永久删除`)
          this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activated', hash: proposal.hash, oldVersionTrashFailed: true, backupPath: backupDir })
          this.opts.notify()
          return { ok: true, status: 'activated', warnings }
        }
      } else {
        warnings.push(`未装配回收站面——旧版备份保留于 ${backupDir}（未降级永久删除）`)
        this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activated', hash: proposal.hash, oldVersionTrashFailed: true, backupPath: backupDir })
        this.opts.notify()
        return { ok: true, status: 'activated', warnings }
      }
      this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activated', hash: proposal.hash })
      this.opts.notify()
      return { ok: true, status: 'activated' }
    }
    if (mount.unknown) {
      // 结果未知：新代次在位（实况以清单对账）+ 备份保留（人工恢复面），不猜补偿、不自动重试
      proposal.status = 'failed'
      proposal.error = { code: 'activation_unknown', message: mount.message ?? '激活结果未知（mount 等待超时）——新代次在位、旧版备份保留；实况以插件清单对账；不自动重试', stateUnknown: true }
      this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, backupPath: backupDir, message: proposal.error.message })
      this.opts.notify()
      return { ok: false, code: 'activation_unknown', message: proposal.error.message, stateUnknown: true }
    }
    // 确定失败：新包退出、旧版还原（rollback:'restored'）+ 授权账随字节还原旧代次
    try { fs.rmSync(userTarget, { recursive: true, force: true }) } catch { /* 尽力 */ }
    try {
      fs.renameSync(backupDir, userTarget)
    } catch (restoreErr) {
      const message = `激活失败且旧版还原失败（${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}）——结果未知，备份保留于 ${backupDir}`
      proposal.status = 'failed'
      proposal.error = { code: 'activation_failed', message, stateUnknown: true }
      this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, backupPath: backupDir, message })
      this.opts.notify()
      return { ok: false, code: 'activation_unknown', message, stateUnknown: true }
    }
    // 账还原旧代次（工单336）：旧包授权连续，不因换代失败停摆
    const oldPerms = this.updateOldPerms.get(proposal.proposalId) ?? []
    if (oldPerms.length > 0) this.opts.authorization?.grant(proposal.pkg.id, oldPerms, proposal.update?.oldHash ?? '')
    else this.opts.authorization?.clear(proposal.pkg.id)
    this.opts.host.rescan()
    proposal.status = 'failed'
    proposal.error = { code: 'activation_failed', message: mount.message ?? '激活失败——已还原旧版（rollback restored）' }
    this.opts.log({ type: 'plugin-update-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_failed', rollback: 'restored', message: proposal.error.message })
    this.opts.notify()
    return { ok: false, code: 'activation_failed', message: proposal.error.message, rollback: 'restored' }
  }

  /**
   * 手动提案批准（工单336 手动投放同闸门）：字节已在用户根——同一份字节绑定=复算用户根
   * 哈希；落账 → rescan（服务层按账激活）→ 有界激活。确定失败回滚账（包不执行、文件不动
   * ——文件是用户放的，清偿只走卸载回收站）；结果未知账保留（实况以清单对账）。
   */
  private async approveManual(proposal: InstallProposalView, dir: string): Promise<InstallProposalDecision> {
    let currentHash: string
    try {
      currentHash = aggregateHashOf(dir)
    } catch (err) {
      return this.failProposal(proposal, 'hash_mismatch', `用户根包目录不可读：${err instanceof Error ? err.message : String(err)}`)
    }
    if (currentHash !== proposal.hash) {
      return this.failProposal(proposal, 'hash_mismatch', '用户根字节与提案哈希不一致（同一份字节绑定失败）——批准不发生、账不落、包不执行')
    }
    if (!this.grantAuthorization(proposal.pkg.id, proposal.pkg.permissions, proposal.hash)) {
      return this.failProposal(proposal, 'activation_failed', '未装配授权账面——敏感包批准无法落账（包不执行）')
    }
    this.opts.host.rescan()
    const mount = await this.boundedMount(proposal.pkg.id)
    if (mount.ok) {
      proposal.status = 'activated'
      this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activated', hash: proposal.hash, manual: true })
      this.opts.notify()
      return { ok: true, status: 'activated' }
    }
    if (mount.unknown) {
      proposal.status = 'failed'
      proposal.error = { code: 'activation_unknown', message: mount.message ?? '激活结果未知（mount 等待超时）——账保留，实况以插件清单对账；不自动重试', stateUnknown: true }
      this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_unknown', stateUnknown: true, manual: true, message: proposal.error.message })
      this.opts.notify()
      return { ok: false, code: 'activation_unknown', message: proposal.error.message, stateUnknown: true }
    }
    // 确定失败：授权账回滚（包不执行）；用户根文件不动（手动投放文件是用户放的）
    if (proposal.pkg.permissions.length > 0) this.opts.authorization?.revoke(proposal.pkg.id)
    proposal.status = 'failed'
    proposal.error = { code: 'activation_failed', message: mount.message ?? '激活失败——授权已回滚（包不执行，文件原样保留）' }
    this.opts.log({ type: 'plugin-install-outcome', opId: proposal.opId, proposalId: proposal.proposalId, pkgId: proposal.pkg.id, outcome: 'activation_failed', manual: true, message: proposal.error.message })
    this.opts.notify()
    return { ok: false, code: 'activation_failed', message: proposal.error.message }
  }

  /** mount 等待套管理器时限（mountBoundMs）：宿主端口不回 → 结果未知（不猜） */
  private boundedMount(packageId: string): Promise<MountOutcome> {    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<MountOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, message: `激活等待超时（${this.opts.mountBoundMs}ms）——结果未知`, unknown: true }), this.opts.mountBoundMs)
    })
    return Promise.race([
      this.opts.host.waitMount(packageId, this.opts.mountBoundMs),
      timeout,
    ]).finally(() => { if (timer) clearTimeout(timer) })
  }

  private failProposal(
    proposal: InstallProposalView,
    code: 'hash_mismatch' | 'activation_failed',
    message: string,
    extra: { rollback?: 'removed' | 'restored' } = {},
  ): InstallProposalDecision {
    proposal.status = 'failed'
    proposal.error = { code, message }
    const stagedDir = path.join(this.opts.stagingRoot, proposal.proposalId)
    try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    const isUpdate = Boolean(proposal.update)
    const rollback = extra.rollback ?? (code === 'activation_failed' ? 'removed' : undefined)
    this.opts.log({
      type: isUpdate ? 'plugin-update-outcome' : 'plugin-install-outcome',
      opId: proposal.opId,
      proposalId: proposal.proposalId,
      pkgId: proposal.pkg.id,
      outcome: code,
      ...(rollback ? { rollback } : {}),
      message,
    })
    this.opts.notify()
    return { ok: false, code, message, ...(rollback ? { rollback } : {}) }
  }

  // ------------------------------------------------------------------
  // 拒绝：副本清偿 + gate_denied（更新提案结局落更新事件族，与意图同族对账）
  // ------------------------------------------------------------------

  private async rejectInner(proposalId: string): Promise<{ ok: boolean; code?: 'not_found' }> {
    const proposal = this.proposals.get(proposalId)
    if (!proposal || proposal.status !== 'pending') {
      return { ok: false, code: 'not_found' }
    }
    const stagedDir = path.join(this.opts.stagingRoot, proposalId)
    try { fs.rmSync(stagedDir, { recursive: true, force: true }) } catch { /* 尽力 */ }
    proposal.status = 'rejected'
    this.opts.log({
      type: proposal.update ? 'plugin-update-outcome' : 'plugin-install-outcome',
      opId: proposal.opId,
      proposalId,
      pkgId: proposal.pkg.id,
      outcome: 'gate_denied',
      hash: proposal.hash,
    })
    this.opts.notify()
    return { ok: true }
  }

  // ------------------------------------------------------------------
  // 卸载（工单335）：回收站唯一删除路径；config 原样保留（解除挂载不碰配置）
  // ------------------------------------------------------------------

  private async uninstallInner(args: { packageId?: unknown }): Promise<UninstallResult> {
    const opId = this.opts.opId()
    const packageId = args?.packageId
    if (typeof packageId !== 'string' || !PLUGIN_ID_RE.test(packageId)) {
      return { ok: false, code: 'invalid_args', message: `packageId 须为合法包 id（小写主机名字符集）：${String(packageId)}`, opId }
    }
    if (RESERVED_PACKAGE_IDS.has(packageId)) {
      return { ok: false, code: 'not_manageable', message: `包 id「${packageId}」是保留标识（内核宿主名）`, opId }
    }
    for (const kernelRoot of this.opts.kernelRoots) {
      if (fs.existsSync(path.join(kernelRoot, packageId, 'plugin.json'))) {
        return { ok: false, code: 'not_manageable', message: `包「${packageId}」是内核/第一方档插件（不可经控制面卸载，只能停用）`, opId }
      }
    }
    const target = path.join(this.opts.userRoot, packageId)
    if (!fs.existsSync(path.join(target, 'plugin.json'))) {
      return { ok: false, code: 'not_found', message: `用户插件根中不存在包「${packageId}」`, opId }
    }
    if (!this.opts.trashItem) {
      return { ok: false, code: 'not_wired', message: '本面板未装配回收站面——卸载不可用（写尚未开始）', opId }
    }
    this.opts.log({ type: 'plugin-uninstall-intent', opId, pkgId: packageId, dir: target })
    try {
      await this.opts.trashItem(target)
    } catch (err) {
      // 红线：回收站失败 = 整个卸载失败，绝不降级永久删除
      const message = `回收站失败：${err instanceof Error ? err.message : String(err)}——目录原样保留（不降级永久删除）`
      this.opts.log({ type: 'plugin-uninstall-outcome', opId, pkgId: packageId, outcome: 'trash_failed', message })
      return { ok: false, code: 'trash_failed', message, opId }
    }
    this.opts.log({ type: 'plugin-uninstall-outcome', opId, pkgId: packageId, outcome: 'uninstalled' })
    // 授权账清除（工单336）：重装同字节也重新批准——撤销不可被「卸载→重装」绕过
    this.opts.authorization?.clear(packageId)
    this.opts.host.rescan()
    return { ok: true, opId }
  }

  // ------------------------------------------------------------------
  // 停用/启用（工单335）：串行内接 settings 停用集缝
  // ------------------------------------------------------------------

  private async setEnabledInner(args: { packageId?: unknown; enabled?: unknown }): Promise<SetEnabledResult> {
    const opId = this.opts.opId()
    const packageId = args?.packageId
    const enabled = args?.enabled
    if (typeof packageId !== 'string' || !PLUGIN_ID_RE.test(packageId)) {
      return { ok: false, code: 'invalid_args', message: `packageId 须为合法包 id（小写主机名字符集）：${String(packageId)}` }
    }
    if (typeof enabled !== 'boolean') {
      return { ok: false, code: 'invalid_args', message: `enabled 须为布尔值：${String(enabled)}` }
    }
    if (!this.opts.setCardEnabled) {
      return { ok: false, code: 'not_wired', message: '本面板未装配停用/启用面（settings 停用集未接线）' }
    }
    try {
      const state = await this.opts.setCardEnabled(packageId, enabled)
      this.opts.log({ type: 'plugin-set-enabled', opId, pkgId: packageId, enabled })
      return { ok: true, state }
    } catch (err) {
      return { ok: false, code: 'write_failed', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
