// ACP v1 客户端（工单332，ADR-0018 对话通道）：NDJSON JSON-RPC 2.0 over stdio。
// 帧形与方言以工单330 探针实录为准（records/acp-fullchain.ndjson）：
// - 换行分隔 JSON（不是 LSP Content-Length 帧）
// - initialize: protocolVersion 1 + clientCapabilities（fs/terminal 全关——ADR-0018）
// - session/new: { cwd, mcpServers } → { sessionId, configOptions }
// - session/prompt: { sessionId, prompt: [{type:'text',text}] } → 流式 session/update 通知
//   （agent_message_chunk 带累计文本快照 + messageId；usage_update used/size）→ { stopReason }
// - session/cancel: 通知；在途 prompt 以 stopReason:"cancelled" 收束，进程存活可续用
// - session/close: { sessionId } → {}；关闭后同 id prompt → -32602 unknown session
// - session/request_permission: server→client 反向请求；回复必须
//   { outcome: { outcome: 'selected', optionId } }，取消 turn 回 { outcome: { outcome: 'cancelled' } }
// 权限绝不超时自动拒绝（ADR-0018）：本客户端对反向权限请求不设超时，等待调用方裁决。
//
// 本模块零 Electron 依赖；进程注入（attach { input, output }）让离线测试用确定性 fake
// （tests/conversation/fake-acp-agent.mjs）覆盖全部路径。

/** agent→client 的 session/update 通知载荷（DSH 方言字段原样透传，不做语义解释） */
export interface AcpSessionUpdate {
  sessionUpdate: string
  [key: string]: unknown
}

export interface AcpAgentInfo {
  name: string
  version: string
}

export interface AcpInitializeResult {
  protocolVersion: number
  agentInfo: AcpAgentInfo
  agentCapabilities: Record<string, unknown>
  authMethods: unknown[]
}

export interface AcpSessionNewResult {
  sessionId: string
  configOptions?: unknown[]
}

export interface AcpPromptResult {
  stopReason: string
}

export interface AcpPermissionOption {
  optionId: string
  name: string
  kind: string
}

/** server→client 的权限请求（原样字段；不含理由文本——探针实证） */
export interface AcpPermissionRequest {
  sessionId: string
  toolCall: { toolCallId: string }
  options: AcpPermissionOption[]
}

/** 权限回复形状（探针实证：只回 {optionId} 会被 DSH fail-closed） */
export type AcpPermissionOutcome =
  | { outcome: { outcome: 'selected'; optionId: string } }
  | { outcome: { outcome: 'cancelled' } }

export interface AcpIo {
  /** client → agent（agent 的 stdin） */
  input: NodeJS.WritableStream
  /** agent → client（agent 的 stdout） */
  output: NodeJS.ReadableStream
}

export interface AcpClientOptions {
  /** initialize 超时（ms）。npm 独立包冷启实测 >30s（工单330），缺省留足 120s */
  initializeTimeoutMs?: number
  /** 短请求（session/new、session/close、session/resume）超时（ms） */
  requestTimeoutMs?: number
  /** 协议错误（坏 JSON 行等）：不致命，交给调用方存证 */
  onProtocolError?: (err: Error) => void
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout | null
  method: string
}

export class AcpClient {
  private io: AcpIo | null = null
  private buffer = ''
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  /** server→client 反向请求（权限）在途表：id → 裁决回传 */
  private readonly incoming = new Map<number, (outcome: AcpPermissionOutcome) => void>()
  private exited = false
  private exitInfo: { code: number | null; signal: string | null } | null = null
  private exitWaiters: Array<(info: { code: number | null; signal: string | null }) => void> = []

  private updateHandler: ((sessionId: string, update: AcpSessionUpdate) => void) | null = null
  private permissionHandler: ((req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome) | null = null
  private exitHandler: ((info: { code: number | null; signal: string | null }) => void) | null = null
  private readonly onProtocolError: (err: Error) => void

  constructor(private readonly options: AcpClientOptions = {}) {
    this.onProtocolError = options.onProtocolError ?? (() => { /* 缺省吞（坏行尽力而为） */ })
  }

  onSessionUpdate(handler: (sessionId: string, update: AcpSessionUpdate) => void): void {
    this.updateHandler = handler
  }

  /** 权限裁决回调：返回形状错误的后果由后端 fail-closed 承担（探针实证），调用方必须给合规形状 */
  onPermissionRequest(handler: (req: AcpPermissionRequest) => Promise<AcpPermissionOutcome> | AcpPermissionOutcome): void {
    this.permissionHandler = handler
  }

  onExit(handler: (info: { code: number | null; signal: string | null }) => void): void {
    this.exitHandler = handler
  }

  attach(io: AcpIo): void {
    this.io = io
    io.output.setEncoding?.('utf8')
    io.output.on('data', (chunk: string | Buffer) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (line) this.handleLine(line)
      }
    })
    io.output.on('error', () => { /* 读侧断（进程死）：退出事件另行到达 */ })
    if (typeof (io.input as NodeJS.WritableStream & { on?: unknown }).on === 'function') {
      ;(io.input as NodeJS.WritableStream & { on: (ev: string, cb: (err: Error) => void) => void }).on('error', () => { /* 写侧断：exit 路径兜底 */ })
    }
  }

  /** 后端进程退出（服务层从子进程 'exit' 事件喂进来）：在途请求全部按退出拒绝 */
  notifyExit(code: number | null, signal: string | null): void {
    if (this.exited) return
    this.exited = true
    this.exitInfo = { code, signal }
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer)
      p.reject(new Error(`后端进程已退出 (code=${code ?? 'null'})——请求 ${p.method} 未完成`))
    }
    this.pending.clear()
    // 在途权限请求：没有进程就没有会话，回调方（服务层）会在终态清理；这里清表防泄漏
    this.incoming.clear()
    for (const w of this.exitWaiters) w(this.exitInfo)
    this.exitWaiters = []
    this.exitHandler?.(this.exitInfo)
  }

  /** 等待进程退出（服务层 end() 的有界等待用） */
  waitExit(timeoutMs: number): Promise<{ code: number | null; signal: string | null } | null> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.exitWaiters = this.exitWaiters.filter((w) => w !== wrapped)
        resolve(null)
      }, timeoutMs)
      const wrapped = (info: { code: number | null; signal: string | null }) => {
        clearTimeout(timer)
        resolve(info)
      }
      this.exitWaiters.push(wrapped)
    })
  }

  get isExited(): boolean {
    return this.exited
  }

  /** 结束输入侧：stdin 落地 → 后端自然退出（探针实证 exit code 0） */
  end(): void {
    try {
      ;(this.io?.input as NodeJS.WritableStream & { end?: () => void }).end?.()
    } catch { /* 尽力 */ }
  }

  private write(msg: Record<string, unknown>): void {
    if (!this.io) throw new Error('ACP 客户端未接线（attach 未调用）')
    try {
      this.io.input.write(Buffer.from(JSON.stringify(msg) + '\n', 'utf8'))
    } catch (err) {
      // 写侧已断（进程死）：等 exit 事件的统一清理，不向调用方伪装成功
      throw new Error(`ACP 写失败（后端进程可能已退出）：${err instanceof Error ? err.message : err}`)
    }
  }

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (this.exited) return Promise.reject(new Error(`后端进程已退出——无法发起 ${method}`))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`等待 ${method} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
        : null
      this.pending.set(id, { resolve: resolve as (r: unknown) => void, reject, timer, method })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** ACP initialize（clientCapabilities 不声明 fs/terminal——ADR-0018） */
  initialize(): Promise<AcpInitializeResult> {
    return this.request<AcpInitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, this.options.initializeTimeoutMs ?? 120_000)
  }

  sessionNew(params: { cwd: string; mcpServers: unknown[] }): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>('session/new', params, this.options.requestTimeoutMs ?? 30_000)
  }

  sessionResume(params: { sessionId: string; cwd: string; mcpServers: unknown[] }): Promise<AcpSessionNewResult> {
    return this.request<AcpSessionNewResult>('session/resume', params, this.options.requestTimeoutMs ?? 30_000)
  }

  /** prompt：turn 可长跑（分钟级），不设请求超时；错误路径由退出/协议错误兜底 */
  prompt(sessionId: string, text: string): Promise<AcpPromptResult> {
    return this.request<AcpPromptResult>('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    }, 0)
  }

  /** session/cancel：通知（无 id、无响应）；在途 prompt 以 stopReason:"cancelled" 收束 */
  cancel(sessionId: string): void {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  /** DSH 方言：session/set_config_option（value 为 JSON 字符串——探针 #330 实录）。
   * 封在本适配器内，供「用户显式配置的 provider 路由」导入面使用，无 UI 面（ADR-0018）。 */
  setConfigOption(sessionId: string, configId: string, value: string): Promise<unknown> {
    return this.request<unknown>('session/set_config_option', { sessionId, configId, value }, this.options.requestTimeoutMs ?? 30_000)
  }

  closeSession(sessionId: string): Promise<void> {
    return this.request<Record<string, never>>('session/close', { sessionId }, this.options.requestTimeoutMs ?? 30_000)
      .then(() => undefined)
  }

  private handleLine(line: string): void {
    let msg: {
      jsonrpc?: string
      id?: number
      method?: string
      result?: unknown
      error?: { code?: number; message?: string }
      params?: Record<string, unknown>
    }
    try {
      msg = JSON.parse(line)
    } catch (err) {
      this.onProtocolError(new Error(`ACP 帧解析失败：${err instanceof Error ? err.message : err}（line=${line.slice(0, 120)}）`))
      return
    }
    if (!msg || typeof msg !== 'object') return
    const isResponse = msg.id !== undefined && msg.method === undefined
    const isIncomingRequest = msg.id !== undefined && msg.method !== undefined
    if (isResponse) {
      const pending = this.pending.get(msg.id as number)
      if (!pending) return
      this.pending.delete(msg.id as number)
      if (pending.timer) clearTimeout(pending.timer)
      if (msg.error) {
        pending.reject(new Error(`${pending.method} 失败 (${msg.error.code ?? '?'}): ${msg.error.message ?? 'unknown error'}`))
      } else {
        pending.resolve(msg.result)
      }
      return
    }
    if (isIncomingRequest) {
      if (msg.method === 'session/request_permission') {
        const params = (msg.params ?? {}) as unknown as AcpPermissionRequest
        const respond = (outcome: AcpPermissionOutcome) => {
          this.incoming.delete(msg.id as number)
          this.write({ jsonrpc: '2.0', id: msg.id, result: outcome })
        }
        this.incoming.set(msg.id as number, respond)
        if (!this.permissionHandler) {
          // 无裁决方：不能替用户选，也不能超时拒——挂起（进程退出时随表清理）
          return
        }
        Promise.resolve()
          .then(() => this.permissionHandler!(params))
          .then(respond)
          .catch(() => { /* 裁决回调异常：保持挂起（绝不自动拒绝） */ })
        return
      }
      // 未知反向请求：按协议回 Method not found（不能挂死对端）
      this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } })
      return
    }
    if (msg.method === 'session/update') {
      const params = (msg.params ?? {}) as { sessionId?: string; update?: AcpSessionUpdate }
      if (params.sessionId && params.update) this.updateHandler?.(params.sessionId, params.update)
    }
    // 其余通知（未知方法）静默：后端方言扩展不应打断会话
  }
}
