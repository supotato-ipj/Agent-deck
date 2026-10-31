// 对话窗会话服务（工单332，ADR-0018 对话通道 / ADR-0026 DSH 运行时；工单333 管理型叠加）。
//
// 拍板落地面：
// - 仅长驻 ACP v1；聊天型为默认（mcpServers:[]、不签后端会话凭证、不起管理监听、
//   不注入合成引导 prompt）。
// - 管理型（工单333）用户显式勾选才创建，**全有或全无**：先起独立专用 MCP 宿主监听
//   （t330 实录：DSH 拿到 mcpServers 即刻探活——监听必须先于 session/new）→ 能力检查
//   （initialize mcpCapabilities.http）→ 铸仅内存会话凭证 → session/new 注入
//   {type:"http",url,headers:[Authorization bearer]}。监听绑定失败/能力缺失/session/new
//   失败 → 不建会话行、凭证回收、宿主无在场管理会话即回收，返回明确错误 +
//   canRetryAsChat（「以聊天型创建」是用户显式选择，绝不静默降级）。
// - 凭证生命周期（ADR-0017）：显式结束/进程异常退出/面板退出/宿主重拉即失效（仅内存）；
//   宿主意外消亡 → revokeAll + 在场管理会话降级（仍可聊天，恢复管理须新建）。
//   续接一律聊天型（mcpServers:[]、managed 翻 false——ADR-0018 续接语义）。
// - 每会话一进程：主进程直接 spawn 描述符（不经 shell）；工作目录默认 userData 下
//   会话专属空目录；Windows 上 Job Object kill-on-close 兜底孤儿。
// - 元数据/正文分离：面板只存会话元数据（id/backend/backendSessionId/cwd 绝对路径/
//   label/managed/时间戳），转写仅内存视图；正文归 DSH（$DSH_HOME/sessions 权威）。
//   凭证绝不落盘（元数据、存证日志都不含 bearer——红线）。
// - 不自动重启：进程异常退出 → 会话标 failed，UI 呈现明确失败态，由用户决定新建或续接
//   （session/resume 按元数据 backendSessionId + 同一 cwd；后端不回放历史）。
// - 权限绝不超时自动拒绝：request_permission 挂起直到用户裁决或用户取消本 turn。
// - 显式结束：先 cancel 在途 turn（短宽限落定）→ session/close → stdin close 自然退出
//   （探针实证 exit code 0）；超时即树杀兜底。
//
// Electron 零依赖：进程/描述符/Job Object/事件存证全走依赖缝，离线测试用确定性 ACP
// fake（tests/conversation/fake-acp-agent.mjs）全链覆盖。

import { spawn as nodeSpawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Service } from 'cordis'
import type { Context } from 'cordis'
import { userDataPath } from '../paths'
import {
  buildLaunchPlan,
  resolveDshInstall,
  defaultProbeDeps,
  type DshInstall,
  type DshLaunchPlan,
} from './dsh-backend'
import { createKillOnCloseJob, type JobObjectHandle } from './job-object'
import { AcpClient } from './acp'
import type { AcpPermissionOutcome, AcpPermissionRequest, AcpSessionUpdate } from './acp'
import { SessionCredentialRegistry } from './managed-credentials'
import { dispatchManagedTool, type ManagedProjectionSource, type ManagedToolOutcome } from './managed-projection'
import { ManagedMcpHost, type ManagedHostDeps } from './managed-host'
import type {
  ConversationBackendInfo,
  ConversationPermissionOption,
  ConversationSessionStatus,
  ConversationSessionView,
  ConversationTranscriptEntry,
} from '../../shared/contract'

/** 会话子进程抽象（真源 = child_process spawn；测试注入 fake CLI） */
export interface ConversationProcess {
  pid: number | undefined
  stdin: NodeJS.WritableStream & { end?: () => void }
  stdout: NodeJS.ReadableStream
  onExit(cb: (code: number | null, signal: string | null) => void): void
  killTree(): void
}

export type ConversationSpawn = (plan: DshLaunchPlan, cwd: string, env: Record<string, string | undefined>) => ConversationProcess

export interface ConversationDeps {
  /** 后端描述符解析（config 显式 → env → 探测）；null = 未安装 */
  resolveBackend(config: { exe?: string }): Promise<DshInstall | null>
  /** 每会话一进程的发射缝 */
  spawnProcess: ConversationSpawn
  /** kill-on-close Job Object（null = 不可用，回落树杀兜底） */
  createJobObject(): JobObjectHandle | null
  /** spawn 基础环境（真源 process.env；测试注入隔离环境） */
  env: Record<string, string | undefined>
  /** 存证出口（生产接线 DECK_EVENT_LOG；离线 no-op） */
  log(event: Record<string, unknown>): void
  now(): number
}

export interface ConversationServiceOptions {
  /** 面板专属稳定 DSH_HOME（ADR-0026；缺省 userData/dsh-home） */
  dshHome?: string
  /** 会话专属工作目录根（缺省 userData/conversation/cwd） */
  workspacesRoot?: string
  /** 元数据落盘文件（缺省 userData/conversation/metadata.json） */
  metadataFile?: string
  /** 后端档（config.conversation 下发）：exe 显式安装路径；model 显式 provider 路由（DSH 方言值） */
  config?: { exe?: string; model?: string }
  /** 对话窗唤起钩子（生产装配注入窗口 show；服务本体零 Electron） */
  notifyShow?: (sessionId: string | null) => void
  /** 管理面（工单333）：缺省 = 本装配未启用管理面，managed 创建如实报错（不静默当聊天） */
  managed?: ConversationManagedOptions
  deps?: Partial<ConversationDeps>
}

/** 管理型宿主最小面（真源 ManagedMcpHost；测试注入 stub 驱动绑定失败等路径） */
export interface ManagedMcpHostLike {
  start(opts?: { port?: number }): Promise<{ url: string; port: number }>
  stop(): Promise<void>
  readonly listening: boolean
}

export interface ConversationManagedOptions {
  /** 投影源工厂（主进程单点引用；调用时惰性求值——生产装配在内核启动后才有单点） */
  source: () => ManagedProjectionSource
  /** 宿主构造缝（缺省真 ManagedMcpHost） */
  createHost?: (deps: ManagedHostDeps) => ManagedMcpHostLike
  /** 凭证登记处（缺省自建；测试注入共享观察） */
  registry?: SessionCredentialRegistry
}

/** 元数据行（落盘唯一形状——不存正文，ADR-0018） */
interface ConversationMetaRow {
  id: string
  backend: string
  backendSessionId: string | null
  cwd: string
  label: string
  managed: boolean
  createdAt: number
  endedAt: number | null
}

interface PermissionWaiter {
  resolve(outcome: AcpPermissionOutcome): void
  options: ConversationPermissionOption[]
  entryIndex: number
}

interface SessionRuntime {
  proc: ConversationProcess
  client: AcpClient
  job: JobObjectHandle | null
  backendSessionId: string
  inFlight: Promise<void> | null
  pendingPermission: PermissionWaiter | null
  ending: boolean
}

interface InternalSession {
  view: ConversationSessionView
  runtime: SessionRuntime | null
  meta: ConversationMetaRow
}

const END_GRACE_MS = 5000
const EXIT_WAIT_MS = 10_000
const EXIT_FORCE_WAIT_MS = 3000

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c.text === 'string') return c.text
  }
  return ''
}

export class ConversationService extends Service {
  private readonly deps: ConversationDeps
  private readonly dshHome: string
  private readonly workspacesRoot: string
  private readonly metadataFile: string
  private readonly backendConfig: { exe?: string; model?: string }
  private readonly notifyShow: (sessionId: string | null) => void
  private readonly managedOpts: ConversationManagedOptions | null
  private readonly credentials: SessionCredentialRegistry
  private readonly sessionsInternal = new Map<string, InternalSession>()
  private metadataLoaded = false
  private backendCache: DshInstall | null | undefined
  /** 独立专用 MCP 宿主（管理面；按需起停，与外部档监听分开生命周期——工单333） */
  private host: ManagedMcpHostLike | null = null
  private hostUrl: string | null = null
  private hostStarting: Promise<{ url: string; port: number }> | null = null

  constructor(ctx: Context, options: ConversationServiceOptions = {}) {
    super(ctx, 'conversation')
    this.dshHome = options.dshHome ?? userDataPath('dsh-home')
    this.workspacesRoot = options.workspacesRoot ?? userDataPath('conversation', 'cwd')
    this.metadataFile = options.metadataFile ?? userDataPath('conversation', 'metadata.json')
    this.backendConfig = options.config ?? {}
    this.notifyShow = options.notifyShow ?? (() => { /* 离线装配无窗可开 */ })
    this.managedOpts = options.managed ?? null
    this.credentials = options.managed?.registry ?? new SessionCredentialRegistry()
    const d = options.deps ?? {}
    this.deps = {
      resolveBackend: d.resolveBackend ?? (async (cfg) => resolveDshInstall(cfg, defaultProbeDeps())),
      spawnProcess: d.spawnProcess ?? defaultSpawn,
      createJobObject: d.createJobObject ?? (() => createKillOnCloseJob()),
      env: d.env ?? process.env,
      log: d.log ?? (() => { /* 离线无存证档 */ }),
      now: d.now ?? (() => Date.now()),
    }
    // 面板退出：终止全部会话进程（不留后台孤儿——ADR-0018）
    ctx.on('dispose', () => this.dispose())
  }

  // ------------------------------------------------------------------
  // 元数据（只存元数据；坏档自愈为空表）
  // ------------------------------------------------------------------

  private loadMetadata(): void {
    if (this.metadataLoaded) return
    this.metadataLoaded = true
    try {
      if (!fs.existsSync(this.metadataFile)) return
      const raw = JSON.parse(fs.readFileSync(this.metadataFile, 'utf8')) as { sessions?: ConversationMetaRow[] }
      for (const row of Array.isArray(raw.sessions) ? raw.sessions : []) {
        if (!row || typeof row.id !== 'string' || typeof row.cwd !== 'string') continue
        if (this.sessionsInternal.has(row.id)) continue
        this.sessionsInternal.set(row.id, {
          view: rowToView(row),
          runtime: null,
          meta: row,
        })
      }
    } catch (err) {
      this.deps.log({ type: 'conversation-metadata-broken', message: err instanceof Error ? err.message : String(err) })
      // 坏档视同空表（自愈），下次保存覆盖
    }
  }

  private saveMetadata(): void {
    try {
      fs.mkdirSync(path.dirname(this.metadataFile), { recursive: true })
      const body = JSON.stringify({ version: 1, sessions: [...this.sessionsInternal.values()].map((s) => s.meta) }, null, 2)
      const tmp = `${this.metadataFile}.tmp`
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, this.metadataFile)
    } catch (err) {
      this.deps.log({ type: 'conversation-metadata-save-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }

  // ------------------------------------------------------------------
  // 视图与事件
  // ------------------------------------------------------------------

  sessions(): ConversationSessionView[] {
    this.loadMetadata()
    return JSON.parse(JSON.stringify([...this.sessionsInternal.values()].map((s) => s.view))) as ConversationSessionView[]
  }

  private emitChanged(): void {
    this.ctx.emit('conversation/changed', { sessions: this.sessions() })
  }

  private logEvent(event: Record<string, unknown>): void {
    // 存证时间戳（t）由 fileEventLog 落笔时统一盖——这里自带 t 会把宿主的 t 覆成 undefined
    this.deps.log({ ...event, ts: this.deps.now() })
  }

  // ------------------------------------------------------------------
  // 后端描述符
  // ------------------------------------------------------------------

  backendInfo(): ConversationBackendInfo {
    if (this.backendCache === undefined) {
      this.backendCache = resolveDshInstall(this.backendConfig, defaultProbeDeps())
    }
    if (!this.backendCache) {
      return {
        available: false,
        detail: '未检测到 DSH 桌面安装（已探测标准安装位）；可在 config.json conversation.dshExe 显式指定安装路径',
        exe: null,
      }
    }
    return { available: true, detail: `已解析 DSH 安装（来源 ${this.backendCache.source}）`, exe: this.backendCache.exe }
  }

  private async resolveBackendCached(): Promise<DshInstall | null> {
    if (this.backendCache === undefined) {
      this.backendCache = await this.deps.resolveBackend(this.backendConfig)
      this.logEvent({ type: 'conversation-backend', available: !!this.backendCache, source: this.backendCache?.source ?? null })
    }
    return this.backendCache
  }

  // ------------------------------------------------------------------
  // 创建（全有或全无；工单333：managed 路由管理型创建）
  // ------------------------------------------------------------------

  async create(label?: string, opts?: { managed?: boolean }): Promise<{ ok: boolean; session?: ConversationSessionView; error?: string; canRetryAsChat?: boolean }> {
    if (opts?.managed) return this.createManaged(label)
    return this.createChat(label)
  }

  /** 管理面装配缺省时的如实报错（不静默当聊天型——ADR-0018 全有或全无） */
  private async createManaged(label?: string): Promise<{ ok: boolean; session?: ConversationSessionView; error?: string; canRetryAsChat?: boolean }> {
    if (!this.managedOpts) {
      return { ok: false, error: '本装配未启用管理面（无投影源）——请以聊天型创建', canRetryAsChat: true }
    }
    this.loadMetadata()
    const install = await this.resolveBackendCached()
    if (!install) {
      return { ok: false, error: this.backendInfo().detail }
    }
    // 1) 先起监听（t330 实录：DSH 拿到 mcpServers 即刻 server/discover+initialize+tools/list）
    let hostUrl: string
    try {
      hostUrl = (await this.ensureManagedHost()).url
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.logEvent({ type: 'conversation-managed-create-failed', reason: 'host-bind', message })
      return { ok: false, error: `管理通道监听绑定失败：${message}`, canRetryAsChat: true }
    }
    // 2) 铸会话 id/cwd/凭证（仍不建行——全有或全无）
    const id = randomUUID()
    const cwd = path.join(this.workspacesRoot, id)
    fs.mkdirSync(cwd, { recursive: true })
    const authorization = this.credentials.issue(id)
    const meta: ConversationMetaRow = {
      id,
      backend: 'dsh',
      backendSessionId: null,
      cwd,
      label: label?.trim() || `管理会话 ${new Date(this.deps.now()).toLocaleString()}`,
      managed: true,
      createdAt: this.deps.now(),
      endedAt: null,
    }
    const view = rowToView(meta)
    view.status = 'starting'
    const internal: InternalSession = { view, runtime: null, meta }
    try {
      // 3) spawn + initialize（能力检查在 session/new 前——能力缺失即回滚）
      const mcpServers = [{
        type: 'http',
        name: 'agent-deck-managed',
        url: hostUrl,
        headers: [{ name: 'Authorization', value: authorization }],
      }]
      const runtime = await this.bootProcess(internal, cwd, null, mcpServers, { requireHttpMcp: true })
      // 4) 全部成功才在册（不半创建）
      internal.runtime = runtime
      view.backendSessionId = runtime.backendSessionId
      meta.backendSessionId = runtime.backendSessionId
      view.backendPid = runtime.proc.pid ?? null
      view.status = 'ready'
      this.sessionsInternal.set(id, internal)
      this.saveMetadata()
      // 存证不含 bearer（红线）：mcpUrl 是回环地址无凭证，可入档
      this.logEvent({ type: 'conversation-managed-created', sessionId: id, backendSessionId: runtime.backendSessionId, cwd, mcpUrl: hostUrl })
      this.emitChanged()
      return { ok: true, session: this.sessionView(id) }
    } catch (err) {
      // 全有或全无回滚：杀进程、吊销凭证、无在场管理会话则回收宿主、不建行
      if (internal.runtime) this.cleanupRuntime(internal.runtime)
      this.credentials.revoke(id)
      this.releaseManagedHostIfIdle()
      const message = err instanceof Error ? err.message : String(err)
      this.logEvent({ type: 'conversation-managed-create-failed', reason: 'boot', message })
      return { ok: false, error: message, canRetryAsChat: true }
    }
  }

  private async createChat(label?: string): Promise<{ ok: boolean; session?: ConversationSessionView; error?: string }> {
    this.loadMetadata()
    const install = await this.resolveBackendCached()
    if (!install) {
      return { ok: false, error: this.backendInfo().detail }
    }
    const id = randomUUID()
    const cwd = path.join(this.workspacesRoot, id)
    fs.mkdirSync(cwd, { recursive: true })
    const meta: ConversationMetaRow = {
      id,
      backend: 'dsh',
      backendSessionId: null,
      cwd,
      label: label?.trim() || `会话 ${new Date(this.deps.now()).toLocaleString()}`,
      managed: false,
      createdAt: this.deps.now(),
      endedAt: null,
    }
    const view = rowToView(meta)
    view.status = 'starting'
    const internal: InternalSession = { view, runtime: null, meta }
    this.sessionsInternal.set(id, internal)
    this.emitChanged()
    try {
      const runtime = await this.bootProcess(internal, cwd, null)
      internal.runtime = runtime
      view.backendSessionId = runtime.backendSessionId
      meta.backendSessionId = runtime.backendSessionId
      view.backendPid = runtime.proc.pid ?? null
      view.status = 'ready'
      this.saveMetadata()
      this.logEvent({ type: 'conversation-created', sessionId: id, backendSessionId: runtime.backendSessionId, cwd })
      this.emitChanged()
      return { ok: true, session: this.sessionView(id) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.failSession(internal, `会话创建失败：${message}`)
      this.saveMetadata()
      this.emitChanged()
      return { ok: false, error: message }
    }
  }

  /** 拉起进程 + initialize（管理型加能力检查）+ session/new（聊天型 mcpServers 恒空） */
  private async bootProcess(
    internal: InternalSession,
    cwd: string,
    resumeSessionId: string | null,
    mcpServers: unknown[] = [],
    opts: { requireHttpMcp?: boolean } = {},
  ): Promise<SessionRuntime> {
    const install = await this.resolveBackendCached()
    if (!install) throw new Error('后端描述符解析失败（未检测到 DSH 安装）')
    const plan = buildLaunchPlan(install, this.dshHome)
    const env = { ...this.deps.env, ...plan.env }
    const proc = this.deps.spawnProcess(plan, cwd, env)
    const client = new AcpClient({
      onProtocolError: (err) => this.logEvent({ type: 'conversation-protocol-error', sessionId: internal.view.id, message: err.message }),
    })
    client.attach({ input: proc.stdin, output: proc.stdout })
    const job = this.deps.createJobObject()
    if (job && proc.pid) job.assign(proc.pid)
    const runtime: SessionRuntime = {
      proc,
      client,
      job,
      backendSessionId: resumeSessionId ?? '',
      inFlight: null,
      pendingPermission: null,
      ending: false,
    }
    internal.runtime = runtime
    this.wireClient(internal, runtime)
    // 退出即事实：统一在此处理（end()/异常路径按 ending 位分账）
    proc.onExit((code, signal) => {
      client.notifyExit(code, signal)
      this.onProcessExit(internal, runtime, code)
    })
    const handshake = await client.initialize()
    internal.view.backendAgent = handshake.agentInfo?.name ?? null
    internal.view.backendAgentVersion = handshake.agentInfo?.version ?? null
    this.logEvent({
      type: 'conversation-handshake',
      sessionId: internal.view.id,
      agent: handshake.agentInfo?.name ?? null,
      agentVersion: handshake.agentInfo?.version ?? null,
      protocolVersion: handshake.protocolVersion,
    })
    // 管理型能力检查（ADR-0018：后端未声明 HTTP MCP 能力 → 全有或全无失败，在 session/new 前拦截）
    if (opts.requireHttpMcp) {
      const caps = handshake.agentCapabilities as { mcpCapabilities?: { http?: unknown } } | undefined
      if (caps?.mcpCapabilities?.http !== true) {
        throw new Error('后端未声明 HTTP MCP 能力（initialize agentCapabilities.mcpCapabilities.http !== true）——按 ADR-0018 不创建管理型会话')
      }
    }
    const sessionResult = resumeSessionId
      ? await client.sessionResume({ sessionId: resumeSessionId, cwd, mcpServers })
      : await client.sessionNew({ cwd, mcpServers })
    runtime.backendSessionId = sessionResult.sessionId
    // 用户显式配置的 provider 路由（导入面，非 UI）：仅新建会话下发；续接按后端持久化的会话路由走
    if (!resumeSessionId && this.backendConfig.model) {
      await client.setConfigOption(runtime.backendSessionId, 'model', this.backendConfig.model)
      this.logEvent({ type: 'conversation-config-option', sessionId: internal.view.id, configId: 'model' })
    }
    this.logEvent({
      type: resumeSessionId ? 'conversation-resumed' : 'conversation-session-new',
      sessionId: internal.view.id,
      backendSessionId: sessionResult.sessionId,
      // 存证只记形状不记载荷（凭证在 headers 里——绝不落盘红线）
      mcpServers: mcpServers.length > 0 ? 'injected(managed)' : 'empty(chat)',
    })
    return runtime
  }

  // ------------------------------------------------------------------
  // 管理面宿主（工单333）：按需起停 + 单点分派 + 凭证失效联动
  // ------------------------------------------------------------------

  /** 起宿主（幂等并发安全）：只在未监听时 start；绑定失败如实上抛（全有或全无第一道门） */
  private ensureManagedHost(): Promise<{ url: string; port: number }> {
    const managedOpts = this.managedOpts
    if (this.host?.listening && this.hostUrl) return Promise.resolve({ url: this.hostUrl, port: Number(this.hostUrl.match(/:(\d+)\//)?.[1] ?? 0) })
    if (!managedOpts) return Promise.reject(new Error('本装配未启用管理面'))
    if (!this.hostStarting) {
      this.hostStarting = (async () => {
        const deps: ManagedHostDeps = {
          registry: this.credentials,
          dispatch: (name, args, ctx) => this.dispatchManaged(name, args, ctx),
          onLost: (err) => this.onHostLost(err),
          log: (e) => this.logEvent(e),
        }
        const host = (managedOpts.createHost ?? ((hd) => new ManagedMcpHost(hd)))(deps)
        try {
          const started = await host.start()
          this.host = host
          this.hostUrl = started.url
          return started
        } catch (err) {
          this.host = null
          this.hostUrl = null
          throw err
        }
      })().finally(() => { this.hostStarting = null })
    }
    return this.hostStarting
  }

  /** 单点分派：投影封闭集 → 主进程投影源；存证只记形状（工具名/结局），不记载荷与凭证 */
  private async dispatchManaged(name: string, args: unknown, ctx: { sessionId: string }): Promise<ManagedToolOutcome> {
    if (!this.managedOpts) {
      return { ok: false, reason: 'unknown_tool', message: `未知工具: ${name}（本装配未启用管理面）` }
    }
    const outcome = await dispatchManagedTool(name, args, this.managedOpts.source())
    this.logEvent({ type: 'managed-tool-call', sessionId: ctx.sessionId, tool: name, ok: outcome.ok, reason: outcome.ok ? null : outcome.reason })
    return outcome
  }

  /** 宿主意外消亡（ADR-0018 降级语义）：凭证全部失效 + 在场管理会话降级为聊天型 */
  private onHostLost(err: Error): void {
    this.credentials.revokeAll()
    this.host = null
    this.hostUrl = null
    for (const s of this.sessionsInternal.values()) {
      if (s.runtime && s.view.managed) {
        s.view.managed = false
        s.view.transcript.push({
          kind: 'system',
          at: this.deps.now(),
          text: '管理通道已失效（MCP 宿主重拉）——本会话仍可聊天；恢复管理须新建管理型会话（ADR-0018）。',
        })
      }
    }
    this.logEvent({ type: 'conversation-management-lost', message: err.message })
    this.emitChanged()
  }

  /** 最后一个管理型会话消亡且宿主仍在 → 回收监听（ADR-0018 按需监听） */
  private releaseManagedHostIfIdle(): void {
    const alive = [...this.sessionsInternal.values()].some((s) => s.runtime && s.view.managed)
    if (!alive && this.host?.listening) {
      const host = this.host
      this.host = null
      this.hostUrl = null
      void host.stop().catch(() => { /* 回收尽力 */ })
    }
  }

  /** 裸进程回收（创建失败回滚用——不建行、不标 failed，直接清） */
  private cleanupRuntime(runtime: SessionRuntime): void {
    if (runtime.pendingPermission) runtime.pendingPermission.resolve({ outcome: { outcome: 'cancelled' } })
    try { runtime.client.end() } catch { /* 尽力 */ }
    try { runtime.proc.killTree() } catch { /* 尽力 */ }
    runtime.job?.close()
  }

  // ------------------------------------------------------------------
  // ACP 事件接线（转写视图）
  // ------------------------------------------------------------------

  private findByBackendSession(backendSessionId: string): InternalSession | null {
    for (const s of this.sessionsInternal.values()) {
      if (s.runtime?.backendSessionId === backendSessionId) return s
    }
    return null
  }

  private wireClient(internal: InternalSession, runtime: SessionRuntime): void {
    const { client } = runtime
    client.onSessionUpdate((backendSessionId, update) => {
      const s = this.findByBackendSession(backendSessionId) ?? internal
      this.applySessionUpdate(s, update)
    })
    client.onPermissionRequest((req) => this.onPermissionRequest(internal, runtime, req))
  }

  /** session/update → 转写视图（回复累计快照替换；工具/未知事件原样载荷呈现） */
  private applySessionUpdate(internal: InternalSession, update: AcpSessionUpdate): void {
    const view = internal.view
    const kind = update.sessionUpdate
    if (kind === 'agent_message_chunk') {
      const messageId = typeof update.messageId === 'string' ? update.messageId : null
      const text = extractText(update.content ?? update.contentBlock)
      if (messageId) {
        const existing = view.transcript.find((e) => e.kind === 'agent' && e.toolCallId === messageId)
        if (existing) existing.text = text
        else view.transcript.push({ kind: 'agent', at: this.deps.now(), text, toolCallId: messageId })
      } else {
        const last = view.transcript[view.transcript.length - 1]
        if (last && last.kind === 'agent') last.text = text
        else view.transcript.push({ kind: 'agent', at: this.deps.now(), text })
      }
      this.logEvent({ type: 'conversation-chunk', sessionId: view.id, messageId, chars: text.length })
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : null
      const status = typeof update.status === 'string' ? update.status : null
      const text = extractText(update.title) || contentText(update.content)
      const existing = toolCallId ? view.transcript.find((e) => e.kind === 'tool' && e.toolCallId === toolCallId) : undefined
      if (existing) {
        existing.status = status ?? existing.status
        existing.raw = update as Record<string, unknown>
        if (text) existing.text = text
      } else {
        view.transcript.push({
          kind: 'tool',
          at: this.deps.now(),
          text: text || `工具调用 ${toolCallId ?? ''}`,
          toolCallId,
          status,
          raw: update as Record<string, unknown>,
        })
      }
      this.logEvent({ type: 'conversation-tool', sessionId: view.id, update: kind, toolCallId, status })
    } else if (kind === 'usage_update') {
      view.usage = {
        used: typeof update.used === 'number' ? update.used : null,
        size: typeof update.size === 'number' ? update.size : null,
      }
    } else {
      // 未知方言：原样呈现（不解释、不丢）
      view.transcript.push({
        kind: 'system',
        at: this.deps.now(),
        text: `后端事件 ${kind}`,
        raw: update as Record<string, unknown>,
      })
    }
    this.emitChanged()
  }

  /** 权限请求：挂起直到用户裁决/取消——绝不超时自动拒绝（ADR-0018） */
  private onPermissionRequest(internal: InternalSession, runtime: SessionRuntime, req: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    return new Promise<AcpPermissionOutcome>((resolve) => {
      const entry: ConversationTranscriptEntry = {
        kind: 'permission',
        at: this.deps.now(),
        text: `工具审批：${req.toolCall?.toolCallId ?? '未知工具'}`,
        toolCallId: req.toolCall?.toolCallId ?? null,
        options: req.options,
        resolvedOptionId: null,
      }
      internal.view.transcript.push(entry)
      internal.view.pendingPermission = { options: req.options }
      runtime.pendingPermission = {
        resolve,
        options: req.options,
        entryIndex: internal.view.transcript.length - 1,
      }
      this.logEvent({ type: 'conversation-permission-request', sessionId: internal.view.id, toolCallId: req.toolCall?.toolCallId ?? null, options: req.options })
      this.emitChanged()
    })
  }

  // ------------------------------------------------------------------
  // 对外动作
  // ------------------------------------------------------------------

  private sessionView(id: string): ConversationSessionView {
    const s = this.sessionsInternal.get(id)
    if (!s) throw new Error(`未知会话: ${id}`)
    return JSON.parse(JSON.stringify(s.view)) as ConversationSessionView
  }

  showSession(sessionId?: string): { ok: boolean; error?: string } {
    this.loadMetadata()
    let target: string | null = null
    if (sessionId) {
      if (!this.sessionsInternal.has(sessionId)) return { ok: false, error: `未知会话: ${sessionId}` }
      target = sessionId
    } else {
      const running = [...this.sessionsInternal.values()].find((s) => s.runtime)
      const latest = [...this.sessionsInternal.values()].sort((a, b) => b.meta.createdAt - a.meta.createdAt)[0]
      target = (running ?? latest)?.view.id ?? null
    }
    this.notifyShow(target)
    return { ok: true }
  }

  async prompt(sessionId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    this.loadMetadata()
    const s = this.sessionsInternal.get(sessionId)
    if (!s || !s.runtime) return { ok: false, error: s ? '会话未在运行（可续接或新建）' : `未知会话: ${sessionId}` }
    if (s.view.status === 'busy' || s.runtime.inFlight) return { ok: false, error: '已有在途 turn（先取消或等它收束）' }
    if (s.view.status !== 'ready') return { ok: false, error: `会话状态 ${s.view.status} 不能发送输入` }
    const body = String(text ?? '')
    if (!body.trim()) return { ok: false, error: '输入为空' }
    s.view.transcript.push({ kind: 'user', at: this.deps.now(), text: body })
    s.view.status = 'busy'
    this.logEvent({ type: 'conversation-prompt-start', sessionId })
    this.emitChanged()
    const runtime = s.runtime
    const inFlight = runtime.client.prompt(runtime.backendSessionId, body).then(
      (result) => {
        if (s.runtime === runtime) runtime.inFlight = null
        if (s.view.status === 'busy') s.view.status = 'ready'
        this.logEvent({ type: 'conversation-prompt-result', sessionId, stopReason: result.stopReason })
        this.emitChanged()
      },
      (err) => {
        if (s.runtime === runtime) runtime.inFlight = null
        if (s.view.status === 'busy') {
          s.view.status = runtime.client.isExited ? 'failed' : 'ready'
          s.view.transcript.push({ kind: 'system', at: this.deps.now(), text: `发送失败：${err instanceof Error ? err.message : err}` })
        }
        this.logEvent({ type: 'conversation-prompt-error', sessionId, message: err instanceof Error ? err.message : String(err) })
        this.emitChanged()
      },
    )
    runtime.inFlight = inFlight
    return { ok: true }
  }

  async cancel(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.sessionsInternal.get(sessionId)
    if (!s || !s.runtime) return { ok: false, error: s ? '会话未在运行' : `未知会话: ${sessionId}` }
    this.cancelTurn(s)
    return { ok: true }
  }

  /** 取消在途 turn：权限挂起回 cancelled、发 session/cancel 通知（进程存活可续用） */
  private cancelTurn(s: InternalSession): void {
    if (s.runtime?.pendingPermission) {
      this.resolvePermission(s, { outcome: { outcome: 'cancelled' } })
    }
    try {
      s.runtime?.client.cancel(s.runtime.backendSessionId)
    } catch { /* 进程已死时退出路径统一处置 */ }
    this.logEvent({ type: 'conversation-cancel', sessionId: s.view.id })
    this.emitChanged()
  }

  async respondPermission(sessionId: string, optionId: string): Promise<{ ok: boolean; error?: string }> {
    const s = this.sessionsInternal.get(sessionId)
    if (!s || !s.runtime?.pendingPermission) return { ok: false, error: '无在途权限请求' }
    if (!s.runtime.pendingPermission.options.some((o) => o.optionId === optionId)) {
      return { ok: false, error: `optionId 不在当前请求的选项清单内（原样选项只认后端给的）` }
    }
    this.resolvePermission(s, { outcome: { outcome: 'selected', optionId } })
    return { ok: true }
  }

  private resolvePermission(s: InternalSession, outcome: AcpPermissionOutcome): void {
    const pending = s.runtime?.pendingPermission
    if (!pending) return
    s.runtime!.pendingPermission = null
    s.view.pendingPermission = null
    const entry = s.view.transcript[pending.entryIndex]
    if (entry && entry.kind === 'permission') {
      entry.resolvedOptionId = outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : 'cancelled'
    }
    pending.resolve(outcome)
    this.logEvent({ type: 'conversation-permission-resolved', sessionId: s.view.id, optionId: outcome.outcome.outcome === 'selected' ? outcome.outcome.optionId : 'cancelled' })
    this.emitChanged()
  }

  /** 显式结束：cancel 在途（短宽限）→ session/close → stdin close → 自然退出，树杀兜底 */
  async end(sessionId: string): Promise<{ ok: boolean; error?: string }> {
    this.loadMetadata()
    const s = this.sessionsInternal.get(sessionId)
    if (!s) return { ok: false, error: `未知会话: ${sessionId}` }
    if (!s.runtime) {
      // 已结束/已失败：幂等收尾（补 endedAt）
      if (s.view.status !== 'ended') {
        s.view.status = 'ended'
        s.view.endedAt = this.deps.now()
        s.meta.endedAt = s.view.endedAt
        this.saveMetadata()
        this.emitChanged()
      }
      return { ok: true }
    }
    if (s.runtime.ending) return { ok: true }
    s.runtime.ending = true
    try {
      // 1) 在途 turn 先 cancel，给短宽限让落定（ADR-0018 结束会话语义）
      if (s.runtime.pendingPermission || s.runtime.inFlight) {
        this.cancelTurn(s)
        await Promise.race([s.runtime.inFlight ?? Promise.resolve(), sleep(END_GRACE_MS)])
      }
      // 2) session/close（失败容忍——进程可能已死）
      try {
        await s.runtime.client.closeSession(s.runtime.backendSessionId)
        this.logEvent({ type: 'conversation-session-close', sessionId })
      } catch (err) {
        this.logEvent({ type: 'conversation-session-close-failed', sessionId, message: err instanceof Error ? err.message : String(err) })
      }
      // 3) stdin close → 自然退出（探针实证 exit code 0）
      s.runtime.client.end()
      const exited = await s.runtime.client.waitExit(EXIT_WAIT_MS)
      if (!exited) {
        // 4) 兜底：树杀 + Job Object 收口
        try { s.runtime.proc.killTree() } catch { /* 尽力 */ }
        await s.runtime.client.waitExit(EXIT_FORCE_WAIT_MS)
        this.logEvent({ type: 'conversation-process-forcekilled', sessionId })
      }
      this.finishSession(s, 'ended')
      return { ok: true }
    } catch (err) {
      // 结束路径自身的异常不让会话卡死：强杀兜底后按 ended 记账
      try { s.runtime.proc.killTree() } catch { /* 尽力 */ }
      await s.runtime.client.waitExit(EXIT_FORCE_WAIT_MS)
      this.finishSession(s, 'ended')
      this.logEvent({ type: 'conversation-end-error', sessionId, message: err instanceof Error ? err.message : String(err) })
      return { ok: true }
    }
  }

  /** 续接面板自己创建的会话：元数据 backendSessionId + 同一绝对 cwd，重新拉进程 session/resume */
  async resume(sessionId: string): Promise<{ ok: boolean; session?: ConversationSessionView; error?: string }> {
    this.loadMetadata()
    const s = this.sessionsInternal.get(sessionId)
    if (!s) return { ok: false, error: `未知会话: ${sessionId}` }
    if (s.runtime) return { ok: false, error: '会话仍在运行，无需续接' }
    if (!s.meta.backendSessionId) return { ok: false, error: '该会话没有后端会话 id（创建未完成），不可续接' }
    s.view.status = 'starting'
    s.view.error = null
    this.emitChanged()
    try {
      fs.mkdirSync(s.meta.cwd, { recursive: true })
      const runtime = await this.bootProcess(s, s.meta.cwd, s.meta.backendSessionId)
      s.runtime = runtime
      s.view.backendPid = runtime.proc.pid ?? null
      // 后端不回放历史（探针实证）：旧正文不可找回，插入明确说明
      s.view.transcript = [{
        kind: 'system',
        at: this.deps.now(),
        text: `已续接后端会话（${s.meta.backendSessionId.slice(0, 8)}…）。后端不回放历史正文，此前消息不可找回；正文权威在后端。`,
      }]
      // 续接一律聊天型（ADR-0018）：管理通道与凭证不随续接恢复，恢复管理须新建管理型会话
      if (s.meta.managed) {
        s.meta.managed = false
        s.view.managed = false
        s.view.transcript.push({
          kind: 'system',
          at: this.deps.now(),
          text: '续接一律聊天型（ADR-0018）：原管理通道与凭证不随续接恢复；恢复管理须新建管理型会话。',
        })
        this.logEvent({ type: 'conversation-resume-chat-only', sessionId })
      }
      s.view.usage = { used: null, size: null }
      s.view.endedAt = null
      s.meta.endedAt = null
      s.view.status = 'ready'
      this.saveMetadata()
      this.logEvent({ type: 'conversation-resume-ok', sessionId })
      this.emitChanged()
      return { ok: true, session: this.sessionView(sessionId) }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.failSession(s, `续接失败：${message}`)
      this.saveMetadata()
      this.emitChanged()
      return { ok: false, error: message }
    }
  }

  /** 面板退出前是否有在途 turn（退出确认弹窗依据，ADR-0018） */
  hasInFlightTurns(): boolean {
    return [...this.sessionsInternal.values()].some((s) => s.view.status === 'busy')
  }

  /** 面板退出（dispose）：终止全部会话进程，不留后台孤儿 */
  dispose(): void {
    for (const s of this.sessionsInternal.values()) {
      if (!s.runtime) continue
      const { runtime } = s
      runtime.ending = true
      if (runtime.pendingPermission) this.resolvePermission(s, { outcome: { outcome: 'cancelled' } })
      try { runtime.client.cancel(runtime.backendSessionId) } catch { /* 尽力 */ }
      try { runtime.client.end() } catch { /* 尽力 */ }
      // 有界宽限后强杀（退出路径不等 close 握手）
      setTimeout(() => {
        if (!runtime.client.isExited) {
          try { runtime.proc.killTree() } catch { /* 尽力 */ }
        }
        runtime.job?.close()
      }, 1200)
      if (s.view.status !== 'ended' && s.view.status !== 'failed') {
        s.view.status = 'ended'
        s.view.endedAt = this.deps.now()
        s.meta.endedAt = s.view.endedAt
      }
      s.runtime = null
      s.view.backendPid = null
    }
    // 管理面：凭证全清（宿主重拉/面板重启即失效——ADR-0017）+ 监听回收
    this.credentials.revokeAll()
    if (this.host?.listening) {
      const host = this.host
      this.host = null
      this.hostUrl = null
      void host.stop().catch(() => { /* 回收尽力 */ })
    }
    this.saveMetadata()
    this.emitChanged()
  }

  // ------------------------------------------------------------------
  // 进程退出与终态
  // ------------------------------------------------------------------

  private onProcessExit(internal: InternalSession, runtime: SessionRuntime, code: number | null): void {
    runtime.job?.close()
    if (runtime.ending) {
      this.logEvent({ type: 'conversation-process-exit', sessionId: internal.view.id, code })
      return // end()/dispose 流程自己记账
    }
    // 异常退出：不自动重启、不重放（ADR-0018）——标 failed，用户决定新建或续接
    this.logEvent({ type: 'conversation-process-exit', sessionId: internal.view.id, code })
    this.failSession(internal, `后端进程异常退出 (code=${code ?? 'null'})——会话已中断，不自动重启；可新建会话或续接本会话`)
    this.saveMetadata()
    this.emitChanged()
  }

  private failSession(internal: InternalSession, error: string): void {
    const runtime = internal.runtime
    if (runtime) {
      if (runtime.pendingPermission) this.resolvePermission(internal, { outcome: { outcome: 'cancelled' } })
      try { runtime.client.end() } catch { /* 尽力 */ }
      try { runtime.proc.killTree() } catch { /* 尽力 */ }
      runtime.job?.close()
    }
    internal.runtime = null
    internal.view.status = 'failed'
    internal.view.error = error
    internal.view.backendPid = null
    internal.view.pendingPermission = null
    internal.view.transcript.push({ kind: 'system', at: this.deps.now(), text: error })
    // 管理型：进程退出即凭证失效（ADR-0017）+ 宿主按需回收（工单333）
    this.credentials.revoke(internal.view.id)
    this.releaseManagedHostIfIdle()
    this.logEvent({ type: 'conversation-failed', sessionId: internal.view.id, message: error })
  }

  /** 终态记账（ended）：进程引用清除、元数据落盘 */
  private finishSession(internal: InternalSession, status: 'ended'): void {
    if (internal.runtime?.pendingPermission) this.resolvePermission(internal, { outcome: { outcome: 'cancelled' } })
    internal.runtime?.job?.close()
    internal.runtime = null
    internal.view.status = status
    internal.view.endedAt = this.deps.now()
    internal.meta.endedAt = internal.view.endedAt
    internal.view.backendPid = null
    internal.view.pendingPermission = null
    // 管理型：显式结束即凭证失效（ADR-0017）+ 宿主按需回收（工单333）
    this.credentials.revoke(internal.view.id)
    this.releaseManagedHostIfIdle()
    this.saveMetadata()
    this.logEvent({ type: 'conversation-ended', sessionId: internal.view.id })
    this.emitChanged()
  }
}

// ------------------------------------------------------------------

function rowToView(row: ConversationMetaRow): ConversationSessionView {
  return {
    id: row.id,
    backend: row.backend,
    backendSessionId: row.backendSessionId,
    backendPid: null,
    backendAgent: null,
    backendAgentVersion: null,
    cwd: row.cwd,
    label: row.label,
    managed: row.managed,
    status: row.endedAt != null ? 'ended' : 'failed',
    createdAt: row.createdAt,
    endedAt: row.endedAt,
    transcript: [],
    usage: { used: null, size: null },
    error: null,
    pendingPermission: null,
  }
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map((c) => extractText((c as { content?: unknown })?.content ?? c)).filter(Boolean).join('\n')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 缺省进程发射：描述符直 spawn（不经 shell），管道三通 + 隐藏窗 */
function defaultSpawn(plan: DshLaunchPlan, cwd: string, env: Record<string, string | undefined>): ConversationProcess {
  const child = nodeSpawn(plan.file, plan.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return {
    pid: child.pid,
    stdin: child.stdin!,
    stdout: child.stdout!,
    onExit: (cb) => child.once('exit', (code, signal) => cb(code, signal)),
    killTree: () => {
      if (!child.pid) return
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      } catch { /* 尽力 */ }
    },
  }
}
