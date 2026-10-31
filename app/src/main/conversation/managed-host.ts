// 独立专用 MCP 宿主（工单333，ADR-0016 回环 Streamable HTTP / ADR-0017 bearer 通道绑定 /
// ADR-0018 管理型宿主独立生命周期）：
//
// - 只服务管理型会话：生命周期由会话服务按需驱动（首个管理型会话创建前 start，最后一个
//   管理型会话消亡后 stop），与外部档监听（ADR-0016，未实现）分开——不共享端口、不共享
//   状态。端口即起即选（127.0.0.1:0），绑定失败如实抛错（全有或全无创建的第一道门）。
// - 协议面按工单330 探针经真实 DSH 验证的形状：POST /mcp 单端点、initialize 回
//   Mcp-Session-Id 头、tools/list、tools/call；GET → 405（无 SSE，首版无状态请求-响应）。
//   实现取探针配方（spec326-notes/t330-dsh-acp/mcp-now-server.mjs，真实 DSH 全链验证），
//   不引 SDK——协议细节封闭在本适配器内。
// - 每请求 bearer 鉴权（登记处注入，401 明确拒）；分派只经注入的 dispatch 端口抵达主进程
//   单点投影（本模块不持任何面板服务引用，无私开执行路径）。
// - 投影外：未知工具 → JSON-RPC 明确「未知工具」错误（不静默放行、不空成功，票面 AC4）；
//   其余带 id 方法 → -32601；通知 → 202。
//
// 零 Electron（node:http）；Vitest 以真实回环请求全链覆盖。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { MANAGED_TOOLS } from './managed-projection'
import type { ManagedToolOutcome } from './managed-projection'

/** 单点分派端口：宿主把工具调用交给主进程投影（sessionId 由 bearer 通道绑定推导） */
export type ManagedDispatch = (
  toolName: string,
  args: unknown,
  ctx: { sessionId: string },
) => Promise<ManagedToolOutcome>

export interface ManagedHostDeps {
  /** 会话凭证登记处（每请求 authenticate；宿主自身不铸凭证） */
  registry: { authenticate(headerValue: string | undefined | null): string | null }
  dispatch: ManagedDispatch
  /** 宿主意外消亡（外部关停/底层错误）回调——服务层据此 revokeAll + 降级在场管理会话 */
  onLost?: (err: Error) => void
  /** 存证出口（生产接线 DECK_EVENT_LOG；离线 no-op） */
  log?: (event: Record<string, unknown>) => void
}

export interface ManagedHostStartOptions {
  /** 绑定端口（缺省 0 = 即起即选；测试注入固定端口驱动绑定失败路径） */
  port?: number
}

interface JsonRpcIncoming {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown }
}

const SERVER_INFO = { name: 'agent-deck-managed', version: '0.1.0' }
const INSTRUCTIONS =
  'AGENT DECK 管理型会话只读投影：可读取面板快照、插件清单（内核+投放）、用户根源码与机器可读插件契约目录。' +
  '全部工具只读；控制面写不存在（投影外工具一律未知工具）。'

export class ManagedMcpHost {
  private server: Server | null = null
  private lost = false
  private readonly log: (event: Record<string, unknown>) => void

  constructor(private readonly deps: ManagedHostDeps) {
    this.log = deps.log ?? (() => { /* 离线无存证档 */ })
  }

  get listening(): boolean {
    return this.server != null && this.server.listening
  }

  /** 测试/诊断观察缝：底层 node server */
  get underlying(): Server | null {
    return this.server
  }

  /** 起监听（回环，端口即起即选）。绑定失败如实抛错——全有或全无创建的第一道门 */
  start(options: ManagedHostStartOptions = {}): Promise<{ url: string; port: number }> {
    if (this.server) return Promise.reject(new Error('MCP 宿主已在运行（先 stop 再 start）'))
    this.lost = false
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res) })
      server.on('error', (err) => {
        if (!server.listening) {
          reject(new Error(`MCP 宿主监听绑定失败（127.0.0.1:${options.port ?? 0}）：${err.message}`))
          return
        }
        this.lost = true
        this.server = null
        this.log({ type: 'managed-host-error', message: err.message })
        this.deps.onLost?.(err)
      })
      server.on('close', () => {
        if (this.lost) return
        // 外部直关底层监听（强杀/端口坍塌）：同 lost 语义——服务层 revokeAll + 降级
        this.lost = true
        this.server = null
        const err = new Error('MCP 宿主监听面意外消亡（外部关闭）')
        this.log({ type: 'managed-host-lost', message: err.message })
        this.deps.onLost?.(err)
      })
      server.listen(options.port ?? 0, '127.0.0.1', () => {
        const addr = server.address()
        if (!addr || typeof addr !== 'object') {
          reject(new Error('MCP 宿主监听地址异常（非 IPv4 回环）'))
          return
        }
        this.server = server
        this.log({ type: 'managed-host-started', port: addr.port })
        resolve({ url: `http://127.0.0.1:${addr.port}/mcp`, port: addr.port })
      })
    })
  }

  /** 停监听（最后一个管理型会话消亡/面板退出）。不铸不销凭证——revokeAll 由服务层同步做 */
  stop(): Promise<void> {
    const server = this.server
    if (!server) return Promise.resolve()
    this.server = null
    this.lost = true // 主动停不触发 onLost
    return new Promise((resolve) => {
      server.close(() => resolve())
    })
  }

  // ------------------------------------------------------------------
  // 请求处理（每请求独立鉴权，无状态）
  // ------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.url !== '/mcp') {
        res.writeHead(404).end()
        return
      }
      if (req.method === 'GET') {
        // 无 SSE（ADR-0016 首版无状态请求-响应，不开事件流）
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' }).end()
        return
      }
      // bearer 通道绑定鉴权（ADR-0017：身份只来自主进程登记的通道绑定）
      const sessionId = this.deps.registry.authenticate(req.headers.authorization)
      if (!sessionId) {
        this.writeJson(res, 401, {
          jsonrpc: '2.0', id: null,
          error: { code: -32001, message: 'unauthorized（bearer 不在管理型会话凭证登记表中）' },
        })
        return
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = Buffer.concat(chunks).toString('utf8')
      let msg: JsonRpcIncoming
      try {
        msg = JSON.parse(body) as JsonRpcIncoming
      } catch {
        res.writeHead(400).end()
        return
      }
      if (!msg || typeof msg.method !== 'string') {
        res.writeHead(400).end()
        return
      }
      const hasId = msg.id !== undefined && msg.id !== null
      if (!hasId) {
        // 通知（notifications/*）：无状态面不维护订阅，202 收讫
        res.writeHead(202).end()
        return
      }
      const id = msg.id as number | string
      if (msg.method === 'initialize') {
        // t330 实录：DSH 对 HTTP MCP 先 server/discover（Streams-HTTP 方言）再 initialize；
        // server/discover 等方言请求按 -32601 回（非标准方法，fail-fast 由对端消化）
        this.writeJson(res, 200, {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        }, { 'Mcp-Session-Id': randomUUID() })
        return
      }
      if (msg.method === 'tools/list') {
        this.writeJson(res, 200, { jsonrpc: '2.0', id, result: { tools: MANAGED_TOOLS } })
        return
      }
      if (msg.method === 'tools/call') {
        const name = typeof msg.params?.name === 'string' ? msg.params.name : ''
        const args = msg.params?.arguments ?? {}
        await this.handleToolCall(res, id, name, args, sessionId)
        return
      }
      this.writeJson(res, 200, {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `Method not found: ${msg.method}（宿主只提供 initialize/tools/list/tools/call）` },
      })
    } catch (err) {
      // 处理管线兜底：不让一次请求异常拖垮监听
      this.log({ type: 'managed-host-request-error', message: err instanceof Error ? err.message : String(err) })
      try { this.writeJson(res, 500, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'internal error' } }) } catch { /* 已断连 */ }
    }
  }

  private async handleToolCall(
    res: ServerResponse,
    id: number | string,
    name: string,
    args: unknown,
    sessionId: string,
  ): Promise<void> {
    if (!name) {
      this.writeJson(res, 200, {
        jsonrpc: '2.0', id,
        error: { code: -32602, message: '未知工具: （空工具名）——管理型会话只有只读投影' },
      })
      return
    }
    // 封闭集门（宿主级保证）：投影外工具名在进分派前就按「未知工具」明确拒绝——
    // 无论下游 dispatch 接线如何，写类名/编造名都到不了面板服务（票面 AC4）
    if (!MANAGED_TOOLS.some((t) => t.name === name)) {
      this.writeJson(res, 200, {
        jsonrpc: '2.0', id,
        error: { code: -32602, message: `未知工具: ${name}（管理型会话只有只读投影，投影外工具不存在）` },
      })
      return
    }
    const outcome = await this.deps.dispatch(name, args, { sessionId })
    if (!outcome.ok) {
      // unknown_tool / invalid_args 是协议级参数错误；source_error 是执行失败（MCP isError 信封）
      if (outcome.reason === 'source_error') {
        this.writeJson(res, 200, {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: outcome.message }], isError: true },
        })
        return
      }
      this.writeJson(res, 200, {
        jsonrpc: '2.0', id,
        error: { code: -32602, message: outcome.message },
      })
      return
    }
    this.writeJson(res, 200, {
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: JSON.stringify(outcome.payload) }], isError: false },
    })
  }

  private writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const out = Buffer.from(JSON.stringify(body))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': out.length, ...headers })
    res.end(out)
  }
}
