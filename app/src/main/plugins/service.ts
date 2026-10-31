import fs from 'node:fs'
import path from 'node:path'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import type { DroppedPackageInfo, DroppedPackageMigrationIssue, DroppedPackageState, PluginInfo, PluginManifest } from '../../shared/contract'
import { PLUGIN_SCHEME } from './assets'
import { classifyDroppedManifest, type DroppedManifest, type MigrationIssue } from './dropped-manifest'
import { PluginInstallManager, aggregateHashOf, listFileEntries, type InstallProposalView, type MountOutcome } from './install'
import { authorizeDroppedPackage, authorizeDroppedPackageWithGrant } from './authorization'
import { isPermissionChannelOpen } from './permission-channels'
import { MAX_LIVE_DROPPED_PACKAGES } from './budget'
import type { PluginAuthorizationLedger } from './authorization-ledger'
import { MANIFEST_FILE, PLUGIN_ID_RE, readManifest } from './manifest'
import { listPluginDirs, watchPluginRoots } from './watch'

/**
 * 桌面组件宿主（工单10 插件体系）：插件目录即安装位，放入即被识别。
 *
 * 宿主只做四件事，边界刻意收窄：
 * 1. 扫根 → 读 plugin.json → manifest 契约校验（纯逻辑在 manifest.ts）
 * 2. 为每个插件登记一个实例，走 cordis 子集生命周期：装载 ready() / 卸载 dispose()
 * 3. 目录看门狗（fs.watch）触发重扫，变更以 `plugins/changed` 推给渲染层
 * 4. 快照段 `plugins` 携带清单，entry 已解析成可直接 import 的协议 URL
 *
 * 前端资产的读盘与投喂都在主进程（渲染层 contextIsolation + sandbox 不变）：
 * 插件文件永远不经渲染层触碰，资产经 deck-plugin:// 协议下发。
 * 插件拿到的快照按 manifest 的 capabilities 裁剪，裁剪在渲染层做（只有它能组装视图）。
 */

/** 未声明 order 的插件排在显式声明之后 */
export const DEFAULT_PLUGIN_ORDER = 1000

/** id 的合法字符集，与 manifest 校验同源（错误条目的兜底 id 也要守这条） */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/** 插件生命周期契约（cordis 3.x 圈定的子集：装载钩子 + 拆卸钩子 + ctx 注入） */
export interface PluginInstance {
  readonly info: PluginInfo
  readonly manifest: PluginManifest
  /** 插件目录绝对路径（协议资产根） */
  readonly dir: string
  /** 装载：插件侧主进程资源在此建立（ctx 即内核上下文，依赖注入自此可用） */
  ready(ctx: Context): void | Promise<void>
  /** 卸载：释放 ready 建立的一切 */
  dispose(): void | Promise<void>
}

/**
 * 插件根档位标记（工单331，ADR-0019/0025）：信任档由包根决定，不由 manifest 或调用参数自报。
 * kernel = 内核/第一方根（受信内部桥，既有渲染层装载路径）；dropped = 用户根（投放档，
 * 独立执行上下文路径）。bare string 根归 kernel（向后兼容既有调用与测试）。
 */
export interface PluginRootDescriptor {
  dir: string
  tier: 'kernel' | 'dropped'
}

/**
 * 投放宿主端口（工单331）：dropped 档的上下文拉起/拆除由 Electron 侧实现
 * （package-host.ts），宿主服务只做路由与状态记账——离线测试注入假端口。
 */
export interface DroppedPackageHostPort {
  /** 拉起独立执行上下文（零权限包；调用即激活，无批准闸门） */
  activate(pkg: { id: string; dir: string; generation: number; permissions: string[]; manifest: DroppedManifest }): void
  /** 拆除该包的独立上下文（停用/换代/降级为迁移态时） */
  deactivate(id: string): void
  /** 挂载结果回报（工单334 有界激活事实源；缺省 = 宿主不回报，waitMountOutcome 走超时未知态） */
  onMountOutcome?(cb: (info: { id: string; ok: boolean; message: string | null }) => void): void
}

export interface PluginHostOptions {
  /**
   * 插件根目录，按序扫描；同 id 先到先得（内核根在前，投放根永不被遮蔽方反超）。
   * 元素可以是 bare string（= kernel 档，向后兼容）或档位标记描述符。
   */
  roots: Array<string | PluginRootDescriptor>
  /**
   * 投放宿主端口（工单331）：dropped 根的包经此拉起/拆除独立上下文；
   * 缺省 = 无投放根语义为「不激活」（离线装配未接投放宿主时不拉上下文）。
   */
  droppedHost?: DroppedPackageHostPort
  /**
   * DSH 安装管线（工单334，ADR-0019/0025）：提交→待批→批准→转正→有界激活。
   * 工单335 增更新/卸载/停用端口：备份根、回收站（卸载与旧版处置唯一删除路径）、
   * 私有配置路径（旧数据继承事实源）、停用集缝（settings）。
   * 缺省 = 不装配安装面（离线装配 install 方法如实不可用）。
   */
  install?: {
    stagingRoot: string
    userRoot: string
    /** 更新换代备份根（工单335；缺省 = 待装载区同级 `<stagingRoot>-backup`） */
    backupRoot?: string
    /** 会话工作区包含校验的事实源（对话域会话 cwd；不采信自报） */
    sessionInfo(sessionId: string): { cwd: string; label: string | null } | null
    mountBoundMs?: number
    /** 回收站端口（工单335，生产 = Electron shell.trashItem；失败不降级永久删除） */
    trashItem?(dir: string): Promise<void>
    /** 包私有配置文件路径（工单335 旧数据继承事实源，生产 = plugin-config `<id>.json`） */
    pluginConfigFile?(id: string): string
    /** 停用/启用端口（工单335，生产 = SettingsService.setCardEnabled） */
    setCardEnabled?(id: string, enabled: boolean): unknown
    /** 命名凭证端口（工单339 卸载清理：只清绑定，凭证本体保留） */
    credentials?: { clearBindingsFor(packageId: string): void }
    /**
     * 同时在场投放包上限（工单341 资源预算；缺省 = budget.ts 常量）。超出即显式拒绝
     * （status=error + dropped-package-budget-exceeded），不静默丢弃。
     */
    maxLivePackages?: number
  }
  /**
   * 结构化事件出口（工单331）：投放包生命周期事实（激活/停用/迁移/崩溃）落 DECK_EVENT_LOG，
   * 供验收磁带与审计断言；缺省静默。
   */
  log?: (event: Record<string, unknown>) => void
  /**
   * 停用集读取缝（工单101 卡片显隐开关）：返回当前停用的插件包 id 列表，清单装配时剔除。
   * 读缝而非拷贝：设置服务改写 config.plugins.disabled 后无需重建宿主，重扫即生效；
   * 缺省恒空 = 全启用（离线装配不接设置域）。
   */
  disabledIds?: () => readonly string[]
  /**
   * 授权账（工单336，ADR-0025 按包/按代码代次授予）：敏感权限授权的持久化事实源。
   * rescan **每轮**按账重评授权（撤销即停接停用缝、哈希漂移不放行、批准后 rescan 激活）；
   * 安装管线批准落账经 install.authorization 端口（同一账实例）。缺省 = 无授权面
   * （敏感包一律 pending-approval，#331 行为兜底）。
   */
  authorization?: PluginAuthorizationLedger
  /** 目录看门狗（默认开；离线测试可关，改用显式 rescan 驱动） */
  watch?: boolean
  /** 看门狗风暴合并窗口（ms） */
  settleMs?: number
  /** 实例工厂（测试注入以观测生命周期；生产用默认实现） */
  createInstance?: (ctx: Context, manifest: PluginManifest, dir: string, info: PluginInfo) => PluginInstance
}

/** 一轮扫描的结果单元 */
interface Scanned {
  id: string
  dir: string
  manifest: PluginManifest | null
  error: string | null
  /** 资产指纹：manifest 原文 + 入口文件 mtime/size——任一变动即视为换了一代资产 */
  fingerprint: string
}

/** 投放档在册记账（工单331）：状态机 + 指纹 + 代次 */
interface DroppedRecord {
  id: string
  dir: string
  /** 分类通过的 manifest（零权限/权限全在目录内且主版本兼容）；结构坏时为 null */
  manifest: DroppedManifest | null
  /** 待迁移问题清单（pending-migration 态）；其余态 null */
  issues: MigrationIssue[] | null
  /** 结构错/资产缺失原因（error 态）；其余态 null */
  error: string | null
  fingerprint: string
  generation: number
  status: DroppedPackageState
  permissions: string[]
}

/** 坏插件的兜底 id：目录名清洗成合法主机名，让用户看得懂是哪个插件坏了 */
function fallbackId(dir: string): string {
  const base = path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]/g, '-').replace(/^[^a-z0-9]+/, '')
  return base === '' ? 'broken' : base
}

/** 从 manifest 原文提取合法 id（迁移态记账用：包结构坏但 id 可辨时清单仍指名道姓） */
function extractManifestId(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const id = (raw as Record<string, unknown>).id
  return typeof id === 'string' && PLUGIN_ID_RE.test(id) ? id : null
}

function statOf(file: string): string {
  try {
    const s = fs.statSync(file)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return 'missing'
  }
}

function fingerprintOf(dir: string, manifest: PluginManifest): string {
  return `${JSON.stringify(manifest)}|${statOf(path.join(dir, manifest.entry.replace(/^\.\//, '')))}`
}

/** 清单排序：order 小者在前，同 order 按 id 字典序（结果稳定，不随扫描顺序抖动） */
function byMountOrder(a: PluginInfo, b: PluginInfo): number {
  return (a.order - b.order) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export class PluginHostService extends Service {
  private readonly kernelRoots: string[]
  private readonly droppedRoots: string[]
  private readonly droppedHost: DroppedPackageHostPort | null
  /** 授权账（工单336）：撤销即停/哈希漂移不放行/批准激活的每轮重评事实源 */
  private readonly authorization: PluginAuthorizationLedger | null
  private readonly log: (event: Record<string, unknown>) => void
  private readonly disabledIds: () => readonly string[]
  private readonly watchEnabled: boolean
  private readonly settleMs: number | undefined
  /** 工单341 资源预算：同时在场投放包上限（工单测试可注入；缺省 = budget.ts 常量） */
  private readonly maxLivePackages: number | undefined
  private readonly factory: NonNullable<PluginHostOptions['createInstance']>
  /** 在装实例：id → 实例（Map 查表，防原型链——09 踩坑 1 的纪律） */
  private readonly live = new Map<string, PluginInstance>()
  /** 资产指纹与代号：id → (fingerprint, revision) */
  private readonly generations = new Map<string, { fingerprint: string; revision: number }>()
  private listing: PluginInfo[] = []
  /**
   * 投放档在册条目：id → 状态记账（工单331）。与内核档分离——投放包不进内核清单，
   * 渲染层同上下文 import 路径对其不存在（ADR-0025 断裂迁移）。
   */
  private readonly dropped = new Map<string, DroppedRecord>()
  private droppedListing: DroppedPackageInfo[] = []
  private stopped = false
  /** DSH 安装管线（工单334）：缺省 null（未装配安装面） */
  readonly installs: PluginInstallManager | null
  /** 有界激活等待表（工单334）：包 id → 在等回调（onMountOutcome 到达即裁决） */
  private readonly mountWaiters = new Map<string, Array<(o: MountOutcome) => void>>()

  constructor(ctx: Context, options: PluginHostOptions) {
    super(ctx, 'plugins')
    const roots = options.roots ?? []
    // 档位分桶，桶内保持声明序（先到先得语义按桶内序成立）
    const kernel: string[] = []
    const dropped: string[] = []
    for (const r of roots) {
      if (typeof r === 'string') kernel.push(r)
      else if (r.tier === 'kernel') kernel.push(r.dir)
      else dropped.push(r.dir)
    }
    this.kernelRoots = kernel
    this.droppedRoots = dropped
    this.droppedHost = options.droppedHost ?? null
    this.authorization = options.authorization ?? null
    this.log = options.log ?? (() => {})
    this.disabledIds = options.disabledIds ?? (() => [])
    this.watchEnabled = options.watch ?? true
    this.settleMs = options.settleMs
    this.maxLivePackages = options.install?.maxLivePackages
    this.factory = options.createInstance ?? defaultInstance
    // DSH 安装管线（工单334）先于首扫装配：工单336 手动投放闸门在 rescan 里挂 manual
    // 提案——首扫就要能看到在册提案面（装配序颠倒会让首扫漏挂）。
    // 工单335：备份根/回收站/私有配置路径/停用集缝随装配下发（缺省 = 管理器内置安全默认）
    const installOpts = options.install
    const authz = this.authorization
    this.installs = installOpts
      ? new PluginInstallManager({
          userRoot: installOpts.userRoot,
          stagingRoot: installOpts.stagingRoot,
          ...(installOpts.backupRoot ? { backupRoot: installOpts.backupRoot } : {}),
          kernelRoots: [...this.kernelRoots],
          sessionInfo: installOpts.sessionInfo,
          log: (event) => this.log(event),
          notify: () => this.ctx.emit('install/changed', { proposals: this.installs?.list() ?? [] }),
          now: () => Date.now(),
          opId: (() => { let n = 0; return () => `install-${Date.now()}-${++n}` })(),
          host: {
            rescan: () => this.rescan(),
            waitMount: (id, timeoutMs) => this.waitMountOutcome(id, timeoutMs),
          },
          mountBoundMs: installOpts.mountBoundMs ?? 12_000,
          ...(installOpts.trashItem ? { trashItem: installOpts.trashItem } : {}),
          ...(installOpts.pluginConfigFile ? { pluginConfigFile: installOpts.pluginConfigFile } : {}),
          ...(installOpts.setCardEnabled ? { setCardEnabled: installOpts.setCardEnabled } : {}),
          ...(installOpts.credentials ? { credentials: installOpts.credentials } : {}),
          ...(authz ? {
            authorization: {
              // 工单338：origin 参数面必须随批准落账（适配器漏传 = 账面无 origin，网络面全拒）
              grant: (id, permissions, codeHash, networkOrigins) => authz.grant(id, permissions, codeHash, networkOrigins),
              revoke: (id) => { authz.revoke(id) },
              clear: (id) => authz.clear(id),
            },
          } : {}),
        })
      : null
    // 首扫在构造期完成：快照带插件清单，与其它服务同一节奏（不做则面板首帧无组件）
    this.rescan()
    if (this.watchEnabled && (this.kernelRoots.length || this.droppedRoots.length)) {
      ctx.on('dispose', watchPluginRoots([...this.kernelRoots, ...this.droppedRoots], () => this.rescan(), { settleMs: this.settleMs }))
    }
    // 挂载结果回报注册（工单334）：宿主壳页 title/崩溃即裁决在等者
    this.droppedHost?.onMountOutcome?.((info) => {
      const waiters = this.mountWaiters.get(info.id) ?? []
      this.mountWaiters.delete(info.id)
      for (const w of waiters) w({ ok: info.ok, message: info.message, unknown: false })
    })
    // 停用集变化即重扫（工单101）：设置服务落盘后发出，清单随即剔除/恢复——
    // 渲染层经既有 plugins/changed 即时路径卸载/重挂，包文件全程不动
    ctx.on('settings/cards-changed', () => this.rescan())
    ctx.on('dispose', () => {
      this.installs?.dispose()
      for (const [, ws] of this.mountWaiters) for (const w of ws) w({ ok: false, message: '面板退出——挂载结果未知', unknown: true })
      this.mountWaiters.clear()
      this.disposeAll()
    })
  }

  /** 当前清单（快照段 `plugins` 的来源；坏插件以 error 态在列，面板据此静默降级；
   * 停用包已被剔除——工单101，恢复出厂/资产指纹互不影响） */
  info(): PluginInfo[] {
    return this.listing
  }

  /** 有界激活等待（工单334）：包 id 的 mount 结论——宿主回报或超时（结果未知） */
  waitMountOutcome(packageId: string, timeoutMs: number): Promise<MountOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const ws = this.mountWaiters.get(packageId)
        if (ws) this.mountWaiters.set(packageId, ws.filter((w) => w !== waiter))
        resolve({ ok: false, message: `挂载等待超时（${timeoutMs}ms）——结果未知`, unknown: true })
      }, timeoutMs)
      const waiter = (o: MountOutcome): void => {
        clearTimeout(timer)
        resolve(o)
      }
      const ws = this.mountWaiters.get(packageId) ?? []
      ws.push(waiter)
      this.mountWaiters.set(packageId, ws)
    })
  }

  /** 安装提案清单（批准 UI 数据面；未装配安装面 = 空表） */
  installProposals(): InstallProposalView[] {
    return this.installs?.list() ?? []
  }

  /**
   * 撤销授权（工单336，可信 UI 真实用户手势）：账撤销（activeGrant 即刻 null——媒体
   * Broker 授权门同步断供）→ rescan（撤销即停接 #335 停用缝，deactivate reason=
   * permission-revoked）。未装配账面 = not_wired 如实报。
   */
  revokeAuthorization(packageId: string): { ok: boolean; code?: string } {
    if (!this.authorization) return { ok: false, code: 'not_wired' }
    const out = this.authorization.revoke(packageId)
    if (out.ok) this.rescan()
    return out
  }

  /** 授权账清单（可信 UI 数据面；含已撤销行——审计可见；未装配 = 空表） */
  authorizationGrants() {
    return this.authorization?.list() ?? []
  }

  /** 协议资产根：插件 id → 目录；未登记 id（含原型键名）一律 undefined */
  dirOf(id: string): string | undefined {
    return this.live.get(id)?.dir
  }

  /** 在装插件的 id → 目录（协议处理器据此随插件增删实时扩缩资产根） */
  allDirs(): Map<string, string> {
    const out = new Map<string, string>()
    for (const [id, instance] of this.live) out.set(id, instance.dir)
    return out
  }

  /**
   * 全量重扫：新增 → 装载、消失 → 卸载、资产变化 → 换代号重载。
   * 清单无实质变化时不发事件（1Hz tick 与看门狗同频时无谓刷新）。
   * 停用集过滤（工单101）在装配最上游：被停用的 id 视同本次没扫到——在装实例走
   * 既有「消失 → 卸载」链、清单自然不含（快照 plugins 段天然无停用包），包文件不动。
   * 工单331：dropped 根另路扫描（独立上下文路由），两档互不混清单。
   */
  rescan(): PluginInfo[] {
    const disabled = new Set(this.disabledIds())
    const scanned = this.scan().filter((item) => !disabled.has(item.id))
    const seen = new Set<string>()

    for (const item of scanned) {
      seen.add(item.id)
      const previous = this.generations.get(item.id)
      const changed = !previous || previous.fingerprint !== item.fingerprint
      if (changed) {
        // 换了一代资产：先卸旧再装新（重载语义），代号递增供渲染层绕开 ESM 模块缓存
        this.unload(item.id)
        this.generations.set(item.id, { fingerprint: item.fingerprint, revision: (previous?.revision ?? 0) + 1 })
      }
      const info = this.toInfo(item)
      if (changed) {
        // 坏插件（manifest 无效）不建实例：没有契约就没有可执行的声明
        if (item.manifest) this.install(item.manifest, item.dir, info)
      }
    }

    for (const id of [...this.live.keys()]) if (!seen.has(id)) this.unload(id)
    for (const id of [...this.generations.keys()]) if (!seen.has(id)) this.generations.delete(id)

    const listing = scanned
      .map((item) => this.toInfo(item))
      .sort(byMountOrder)
    if (JSON.stringify(listing) !== JSON.stringify(this.listing)) {
      this.listing = listing
      this.ctx.emit('plugins/changed', listing)
    }

    this.rescanDropped(disabled, new Set(scanned.map((item) => item.id)))
    return this.listing
  }

  /** 投放包当前清单（dropped 档管理视图；不进 PanelSnapshot.plugins 段） */
  droppedInfo(): DroppedPackageInfo[] {
    return this.droppedListing
  }

  /**
   * 崩溃记账（工单331，AC3）：package-host 在 render-process-gone 时调用——置崩溃错误态、
   * 落事件，**绝不重挂**。后续 rescan 若指纹未变保持 crashed（不自动重挂、mount 副作用
   * 不重放）；代码内容变化 = 用户显式换代，才走 deactivate + 新代次 activate。
   */
  markDroppedCrashed(id: string, reason: string): void {
    const record = this.dropped.get(id)
    if (!record || record.status !== 'ok') return
    record.status = 'crashed'
    this.log({ type: 'dropped-package-crashed', id, generation: record.generation, reason })
    this.publishDropped()
  }

  /** 卸载单个插件（内部原语：重扫发现消失/换代会用到；对外的卸载动作是移除插件目录） */
  unload(id: string): boolean {
    const instance = this.live.get(id)
    if (!instance) return false
    this.live.delete(id)
    try {
      instance.dispose()
    } catch (err) {
      console.warn(`deck-plugins: ${id} 卸载钩子抛错（已摘除，不影响其余插件）：${err instanceof Error ? err.message : err}`)
    }
    return true
  }

  /**
   * dropped 档重扫（工单331）：投放包按迁移分类路由，**不进内核清单**。
   * 状态规则：
   * - 首见 + 分类通过 + 零权限 → activate（投放即生效，无批准闸门）；
   * - 首见 + 含已知敏感权限 → pending-approval（批准前不执行）；
   * - 迁移问题 → pending-migration（结构化错误在列）；结构坏/资产缺失 → error；
   * - 指纹变化（代码换代）→ deactivate 旧 + activate 新代次（crashed 亦然：换代即显式重建）；
   * - 指纹未变 + crashed → **保持 crashed，绝不自动重挂**（AC3）；
   * - 指纹未变 + 运行态 → 原样（不重复 activate）；
   * - 停用/消失/降级为不可执行态 → deactivate。
   *
   * 工单336 授权重评：授权判定**每轮重算**（不再只在首见/换代时）——账撤销/哈希漂移即时
   * 反映（撤销即停，接停用缝 reason=permission-revoked），批准落账后 rescan 即激活；
   * 手动投放同闸门：用户根里的 media.read 待批包挂 manual 提案（批准 UI 同词汇）。
   */
  /**
   * 预算门（工单341，budget.ts）：同时在场投放包上限——超出即显式拒绝：
   * status=error（用户看得到原因）+ dropped-package-budget-exceeded 事件，绝不静默丢弃。
   * `freed` = 本次换代刚拆掉的自己的旧上下文数（计数扣减）。
   */
  private activateWithinBudget(record: DroppedRecord, freed = 0, scope?: ReadonlySet<string>): boolean {
    const cap = this.maxLivePackages ?? MAX_LIVE_DROPPED_PACKAGES
    const live = this.liveDroppedCount(scope) - freed
    if (live >= cap) {
      record.generation = 0
      record.status = 'error'
      record.error = `package_budget_exceeded：同时在场投放包已达上限（${cap}）——本包拒绝激活；先卸载/停用其他包再试（显式拒绝，不静默丢弃）`
      record.issues = null
      this.dropped.set(record.id, record)
      this.log({ type: 'dropped-package-budget-exceeded', id: record.id, live, cap })
      return false
    }
    this.droppedHost?.activate({
      id: record.id, dir: record.dir, generation: record.generation,
      permissions: record.permissions, manifest: record.manifest!,
    })
    record.status = 'ok'
    this.dropped.set(record.id, record)
    this.log({ type: 'dropped-package-activated', id: record.id, generation: record.generation, origin: `deck-pkg://${record.id}` })
    return true
  }

  /**
   * 在场投放上下文数（ok/crashed 都占着 webContents——崩溃未拆也算占用预算）。
   * `scope` = 本轮扫到的 id 集：已从磁盘消失但尚未在轮末清算的包不占预算
   * （否则删包后要等下一轮 rescan 才让出槽位）。
   */
  private liveDroppedCount(scope?: ReadonlySet<string>): number {
    let n = 0
    for (const [id, rec] of this.dropped) {
      if (scope && !scope.has(id)) continue
      if (rec.status === 'ok' || rec.status === 'crashed') n += 1
    }
    return n
  }

  private rescanDropped(disabled: Set<string>, kernelClaimed: Set<string>): void {
    const droppedScanned = new Map<string, DroppedRecord>()
    for (const root of this.droppedRoots) {
      for (const dir of listPluginDirs(root)) {
        const record = this.classifyDroppedDir(dir)
        if (kernelClaimed.has(record.id)) {
          // 内核档先到先得：投放根同 id 副本被忽略（内核不被投放副本遮蔽，ADR-0019 同口径）
          this.log({ type: 'dropped-package-shadowed', id: record.id, dir })
          continue
        }
        if (droppedScanned.has(record.id)) {
          this.log({ type: 'dropped-package-shadowed', id: record.id, dir })
          continue
        }
        droppedScanned.set(record.id, record)
      }
    }

    const scannedIds: ReadonlySet<string> = new Set(droppedScanned.keys())
    for (const [id, next] of droppedScanned) {
      const prev = this.dropped.get(id)
      if (disabled.has(id)) {
        // 停用包视同本次没扫到（工单101 同口径）：在装上下文走下方清算 deactivate、清单剔除
        continue
      }
      const changed = !prev || prev.fingerprint !== next.fingerprint
      // 授权重评（工单336）：每轮重算，不缓存——账面撤销/漂移即时反映。
      // manifest 缺失（error/迁移态）一律不可执行；零权限在 authorizeDroppedRecord 内放行。
      const decision = next.manifest !== null && this.authorizeDroppedRecord(next) === 'activate'
        ? 'activate' as const
        : 'pending-approval' as const
      if (!prev || changed) {
        // 换代（首见 / 代码内容变化，含崩溃后显式改码）：旧上下文拆除、新代次重走分类
        if (prev && (prev.status === 'ok' || prev.status === 'crashed')) this.droppedHost?.deactivate(id)
        if (decision === 'activate') {
          next.generation = (prev?.generation ?? 0) + 1
          // 换代前已拆旧上下文（prev 在场）：预算计数扣掉它自己
          this.activateWithinBudget(next, prev && (prev.status === 'ok' || prev.status === 'crashed') ? 1 : 0, scannedIds)
        } else {
          next.generation = 0
          if (next.status === 'pending-migration') {
            this.log({ type: 'dropped-package-migration', id, issues: next.issues })
          } else if (next.status === 'pending-approval') {
            this.log({ type: 'dropped-package-pending-approval', id, permissions: next.permissions })
          } else if (next.status === 'error') {
            this.log({ type: 'dropped-package-error', id, error: next.error })
          }
        }
        this.dropped.set(id, next)
      } else if (decision === 'activate') {
        if (prev.status === 'ok' || prev.status === 'crashed') {
          // 指纹未变且授权在账：运行态原样（不重复 activate）；crashed 保持 crashed（AC3 不自动重挂）
          next.status = prev.status
          next.generation = prev.generation
        } else {
          // 待批 → 账齐（批准落账后 rescan）：显式换代激活
          next.generation = (prev.generation ?? 0) + 1
          this.activateWithinBudget(next, 0, scannedIds)
        }
        this.dropped.set(id, next)
      } else {
        if (prev.status === 'ok' || prev.status === 'crashed') {
          // 撤销即停（工单336，接 #335 停用缝）：账面撤销/哈希漂移 → 拆上下文回待批
          this.droppedHost?.deactivate(id)
          next.generation = 0
          next.status = 'pending-approval'
          this.log({ type: 'dropped-package-deactivated', id, generation: prev.generation, reason: 'permission-revoked' })
        } else {
          // 指纹未变：crashed 保持 crashed（不自动重挂、副作用不重放），其余原样保留既有记账
          next.status = prev.status
          next.generation = prev.generation
        }
        this.dropped.set(id, next)
      }
    }

    // 手动投放同闸门（工单336）：用户根里待批的 media.read 包挂 manual 提案（批准 UI 同
    // 词汇，批准前不执行）；幂等（在册 pending 提案不重挂）。
    if (this.installs) {
      for (const [id, rec] of droppedScanned) {
        if (disabled.has(id)) continue
        // 手动投放同闸门（工单336 起）：权限全在开放通道内才有批准面。开放度取单一正典
        // （工单338 真机轮教训：此处只认 media.read 时网络包投进用户根没有批准 UI）。
        const approvable = rec.status === 'pending-approval' && rec.permissions.length > 0 && rec.permissions.every((p) => isPermissionChannelOpen(p))
        if (!approvable) continue
        if (this.installs.pendingManualProposalId(id)) continue
        let files: ReturnType<typeof listFileEntries>
        let hash: string
        try {
          files = listFileEntries(rec.dir)
          hash = aggregateHashOf(rec.dir)
        } catch { continue } // 字节不可读无从绑定——下轮 rescan 再议
        this.installs.registerManualProposal({
          pkg: {
            id, name: rec.manifest?.name ?? id, version: rec.manifest?.version ?? '',
            hostApiVersion: rec.manifest?.hostApiVersion ?? 1, permissions: [...rec.permissions],
            optionalPermissions: [...(rec.manifest?.optionalPermissions ?? [])],
            networkOrigins: [...(rec.manifest?.networkOrigins ?? [])],
          },
          dir: rec.dir, files, hash,
        })
      }
    }

    // 消失/停用/被内核遮蔽的：摘记账 + 拆上下文（包文件不动）；在册 manual 提案随包摘除
    for (const id of [...this.dropped.keys()]) {
      if (droppedScanned.has(id) && !disabled.has(id)) continue
      const prev = this.dropped.get(id)!
      if (prev.status === 'ok' || prev.status === 'crashed') {
        this.droppedHost?.deactivate(id)
        if (prev.status === 'ok') {
          this.log({ type: 'dropped-package-deactivated', id, generation: prev.generation, reason: droppedScanned.has(id) ? 'disabled' : 'removed' })
        }
      }
      this.dropped.delete(id)
      this.installs?.dropManualProposal(id)
    }

    this.publishDropped()
  }

  /**
   * 单包授权裁决（工单336）：零权限不经账（投放即生效）；敏感包查授权账——
   * 账上绑定（权限集合+代码哈希）匹配才放行；账面缺失/撤销/漂移 = pending-approval。
   * 聚合哈希按包目录现算（同一份字节绑定的事实源；不可读 = 不放行）。
   */
  private authorizeDroppedRecord(record: DroppedRecord): 'activate' | 'pending-approval' {
    if (record.permissions.length === 0) return 'activate'
    let codeHash: string
    try {
      codeHash = aggregateHashOf(record.dir)
    } catch {
      return 'pending-approval'
    }
    const grant = this.authorization?.activeGrant(record.id) ?? null
    return authorizeDroppedPackageWithGrant({
      permissions: record.permissions,
      optionalPermissions: record.manifest?.optionalPermissions ?? [],
      grant, codeHash,
    })
  }

  /** 单个投放目录的分类：manifest 迁移分类 + 入口资产核对 → 状态记账（不含上下文动作）。
   * 指纹 = manifest 原文 + 入口 stat（与内核档同口径：任一变动即换了一代资产）。 */
  private classifyDroppedDir(dir: string): DroppedRecord {
    let manifestText = ''
    try {
      manifestText = fs.readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')
    } catch { /* 缺失/不可读：按结构错分类 */ }
    let raw: unknown = null
    try {
      raw = JSON.parse(manifestText)
    } catch { /* 坏 JSON：按结构错分类 */ }
    const parsed = classifyDroppedManifest(raw)
    const entryRel = parsed.ok ? parsed.manifest.entry.replace(/^\.\//, '') : null
    const fingerprint = `${manifestText}|${entryRel ? statOf(path.join(dir, entryRel)) : 'no-entry'}`

    if (!parsed.ok) {
      const structural = parsed.issues.filter((i) => i.code === 'manifest_invalid')
      if (structural.length > 0) {
        return {
          id: extractManifestId(raw) ?? fallbackId(dir), dir, manifest: null, issues: null,
          error: structural.map((i) => i.message).join('；'),
          fingerprint, generation: 0, status: 'error', permissions: [],
        }
      }
      return {
        id: extractManifestId(raw) ?? fallbackId(dir),
        dir, manifest: null, issues: parsed.issues, error: null,
        fingerprint, generation: 0, status: 'pending-migration', permissions: [],
      }
    }
    const manifest = parsed.manifest
    const entryMissing = statOf(path.join(dir, manifest.entry.replace(/^\.\//, ''))) === 'missing'
    if (entryMissing) {
      return {
        id: manifest.id, dir, manifest: null, issues: null,
        error: `入口资产不存在: ${manifest.entry}`,
        fingerprint, generation: 0, status: 'error', permissions: manifest.permissions,
      }
    }
    const decision = authorizeDroppedPackage({ permissions: manifest.permissions })
    return {
      id: manifest.id, dir, manifest, issues: null, error: null,
      fingerprint, generation: 0, status: decision === 'activate' ? 'ok' : decision, permissions: manifest.permissions,
    }
  }

  /** 投放清单发布：实质变化才发事件（与内核档同一纪律） */
  private publishDropped(): void {
    const listing: DroppedPackageInfo[] = [...this.dropped.values()]
      .map((r) => this.toDroppedInfo(r))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (JSON.stringify(listing) !== JSON.stringify(this.droppedListing)) {
      this.droppedListing = listing
      this.ctx.emit('dropped-plugins/changed', listing)
    }
  }

  private toDroppedInfo(r: DroppedRecord): DroppedPackageInfo {
    const liveContext = r.status === 'ok' || r.status === 'crashed'
    let issues: DroppedPackageMigrationIssue[] | null = null
    if (r.issues) issues = r.issues.map((i) => ({ ...i }))
    return {
      id: r.id,
      name: r.manifest?.name ?? r.id,
      version: r.manifest?.version ?? '',
      status: r.status,
      permissions: [...r.permissions],
      hostApiVersion: r.manifest?.hostApiVersion ?? null,
      generation: r.generation,
      origin: liveContext ? `deck-pkg://${r.id}` : null,
      error: r.error,
      migrationIssues: issues,
    }
  }

  /**
   * 两轮扫描：**有效 manifest 绝对优先**于坏目录。
   * 先让所有根的有效插件按根序登记 id（先到先得），再把坏目录按未占用的兜底 id 补进来——
   * 一个写坏的插件不该因为目录名撞了内置 id 就把内置组件顶掉，反之亦然。
   */
  private scan(): Scanned[] {
    const valid: Scanned[] = []
    const broken: Scanned[] = []
    const claimed = new Set<string>()

    for (const root of this.kernelRoots) {
      for (const dir of listPluginDirs(root)) {
        const parsed = readManifest(dir)
        if (parsed.manifest) valid.push({
          id: parsed.manifest.id,
          dir,
          manifest: parsed.manifest,
          error: null,
          fingerprint: fingerprintOf(dir, parsed.manifest),
        })
        else broken.push({ id: fallbackId(dir), dir, manifest: null, error: parsed.error ?? 'manifest 无效', fingerprint: '' })
      }
    }

    const out: Scanned[] = []
    for (const item of valid) {
      if (claimed.has(item.id)) {
        console.warn(`deck-plugins: 插件 id 重复（${item.id}），按扫描根先到先得，忽略 ${item.dir}`)
        continue
      }
      claimed.add(item.id)
      out.push(item)
    }
    for (const item of broken) {
      if (claimed.has(item.id)) continue
      claimed.add(item.id)
      out.push(item)
    }
    return out
  }

  /** 快照条目：entry 解析为协议 URL 并带代号；坏插件 entry 为空串（无从 import） */
  private toInfo(item: Scanned): PluginInfo {
    const manifest = item.manifest
    const revision = this.generations.get(item.id)?.revision ?? 0
    if (!manifest) {
      return {
        id: item.id, name: item.id, version: '', entry: '', capabilities: [],
        order: DEFAULT_PLUGIN_ORDER, status: 'error', error: item.error, revision,
      }
    }
    // 入口资产缺失即坏插件：投递一个打不开的组件比不投递更糟（面板只剩空白与报错）
    if (statOf(path.join(item.dir, manifest.entry.replace(/^\.\//, ''))) === 'missing') {
      return {
        id: manifest.id, name: manifest.name, version: manifest.version, entry: '',
        capabilities: manifest.capabilities,
        ...(manifest.mount ? { mount: manifest.mount } : {}),
        order: manifest.order ?? DEFAULT_PLUGIN_ORDER,
        status: 'error', error: `入口资产不存在: ${manifest.entry}`, revision,
      }
    }
    const rel = manifest.entry.replace(/^\.\//, '')
    return {
      id: manifest.id, name: manifest.name, version: manifest.version,
      entry: `${PLUGIN_SCHEME}://${manifest.id}/${rel}?v=${revision}`,
      capabilities: manifest.capabilities,
      ...(manifest.mount ? { mount: manifest.mount } : {}),
      order: manifest.order ?? DEFAULT_PLUGIN_ORDER,
      status: 'ok', error: null, revision,
    }
  }

  private install(manifest: PluginManifest, dir: string, info: PluginInfo): void {
    const instance = this.factory(this.ctx, manifest, dir, info)
    this.live.set(manifest.id, instance)
    try {
      void instance.ready(this.ctx)
    } catch (err) {
      console.warn(`deck-plugins: ${manifest.id} 装载钩子抛错（已摘除）：${err instanceof Error ? err.message : err}`)
      this.live.delete(manifest.id)
    }
  }

  private disposeAll(): void {
    if (this.stopped) return // ctx.on('dispose') 可能多次触发，实例只卸一次
    this.stopped = true
    for (const id of [...this.live.keys()]) this.unload(id)
    // 投放档清算（工单331）：面板退出即拆全部独立上下文
    for (const [id, record] of [...this.dropped.entries()]) {
      if (record.status === 'ok') this.droppedHost?.deactivate(id)
    }
  }
}

/** 默认实例：契约即全部——装载时无主进程资源可建，卸载时无资源可放（钩子留作契约位） */
function defaultInstance(_ctx: Context, manifest: PluginManifest, dir: string, info: PluginInfo): PluginInstance {
  return {
    info,
    manifest,
    dir,
    ready() { /* 插件主进程侧资源自此建立；10a 的桌面组件只渲染，无主进程工作 */ },
    dispose() { /* 与 ready 成对释放 */ },
  }
}
