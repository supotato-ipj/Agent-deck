// 独立专用 MCP 宿主测试（工单333，ADR-0016 回环 Streamable HTTP / ADR-0017 bearer 通道绑定 /
// ADR-0018 管理型独立宿主）：协议面按 t330 探针经真实 DSH 验证的形状（initialize 带
// Mcp-Session-Id、tools/list、tools/call），鉴权每请求验 bearer（凭证登记处注入），
// 分派走注入的单点投影；未知工具/未知方法/GET/坏 JSON/绑定失败全部明确报错。
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { SessionCredentialRegistry } from '../../src/main/conversation/managed-credentials'
import { MANAGED_TOOLS, type ManagedProjectionSource } from '../../src/main/conversation/managed-projection'
import { ManagedMcpHost, type ManagedDispatch } from '../../src/main/conversation/managed-host'

function okSource(): ManagedProjectionSource {
  return {
    panelSnapshot: () => ({ clock: { text: '12:00' } }),
    pluginsList: () => ({ kernel: [], dropped: [] }),
    pluginSource: () => { throw new Error('插件目录越界: ../x') },
    contractCatalog: () => ({ audience: 'agent', sections: [], data: {} }),
  }
}

function makeDispatch(): ManagedDispatch & { calls: Array<{ name: string; args: unknown; sessionId: string }> } {
  const log: Array<{ name: string; args: unknown; sessionId: string }> = []
  const fn = async (name: string, args: unknown, ctx: { sessionId: string }) => {
    log.push({ name, args, sessionId: ctx.sessionId })
    return { ok: true, payload: { echoed: name } }
  }
  return Object.assign(fn, { calls: log }) as ManagedDispatch & { calls: Array<{ name: string; args: unknown; sessionId: string }> }
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Record<string, string> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON（404/405 空体等） */ }
  const hs: Record<string, string> = {}
  res.headers.forEach((v, k) => { hs[k] = v })
  return { status: res.status, json, headers: hs }
}

async function startHost(overrides: { dispatch?: ManagedDispatch; registry?: SessionCredentialRegistry } = {}) {
  const registry = overrides.registry ?? new SessionCredentialRegistry()
  const dispatch = overrides.dispatch ?? makeDispatch()
  const host = new ManagedMcpHost({ registry, dispatch })
  const started = await host.start()
  return { host, registry, dispatch: dispatch as ManagedDispatch & { calls: Array<{ name: string; args: unknown; sessionId: string }> }, ...started }
}

describe('独立专用 MCP 宿主（工单333）', () => {
  it('start：绑定 127.0.0.1 即起即选端口（url 形状 + 宿主标记 listening）', async () => {
    const h = await startHost()
    try {
      expect(h.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      expect(h.port).toBeGreaterThan(0)
      expect(h.host.listening).toBe(true)
    } finally { await h.host.stop() }
    expect(h.host.listening).toBe(false)
  })

  it('监听绑定失败：端口被占 → start 抛明确错误、listening=false、不产生凭证副作用', async () => {
    const blocker = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const taken = (blocker.address() as { port: number }).port
    const registry = new SessionCredentialRegistry()
    const host = new ManagedMcpHost({ registry, dispatch: makeDispatch() })
    await expect(host.start({ port: taken })).rejects.toThrow(/绑定失败|EADDRINUSE|占用/)
    expect(host.listening).toBe(false)
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
  })

  it('bearer 鉴权每请求强制：无 token/错 token → 401 JSON-RPC error；有效 token（登记处签发）放行', async () => {
    const h = await startHost()
    try {
      const noAuth = await post(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
      expect(noAuth.status).toBe(401)
      expect(noAuth.json.error).toBeTruthy()
      const badAuth = await post(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer wrong' })
      expect(badAuth.status).toBe(401)
      const token = h.registry.issue('sess-1')
      const ok = await post(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: token })
      expect(ok.status).toBe(200)
      expect(ok.json.result).toBeTruthy()
    } finally { await h.host.stop() }
  })

  it('initialize：协议版本/能力/serverInfo/instructions + Mcp-Session-Id 响应头（t330 实录形状）', async () => {
    const h = await startHost()
    try {
      const token = h.registry.issue('sess-1')
      const res = await post(h.url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }, { Authorization: token })
      expect(res.status).toBe(200)
      expect(res.json.result.protocolVersion).toBeTruthy()
      expect(res.json.result.capabilities.tools).toBeTruthy()
      expect(res.json.result.serverInfo.name).toMatch(/agent-deck/)
      expect(res.json.result.instructions).toMatch(/只读|read-only/i)
      expect(res.headers['mcp-session-id']).toBeTruthy()
    } finally { await h.host.stop() }
  })

  it('tools/list：恰管理型只读封闭集（与 managed-projection 同源）', async () => {
    const h = await startHost()
    try {
      const token = h.registry.issue('sess-1')
      const res = await post(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { Authorization: token })
      const names = res.json.result.tools.map((t: { name: string }) => t.name).sort()
      expect(names).toEqual(MANAGED_TOOLS.map((t) => t.name).sort())
    } finally { await h.host.stop() }
  })

  it('tools/call 已知工具：单点分派 + 通道绑定 sessionId 透传 + MCP 结果信封（isError:false）', async () => {
    const h = await startHost()
    try {
      const token = h.registry.issue('sess-9')
      const res = await post(h.url, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'panel_snapshot', arguments: {} } }, { Authorization: token })
      expect(res.status).toBe(200)
      expect(res.json.result.isError).toBe(false)
      expect(res.json.result.content[0].type).toBe('text')
      expect(JSON.parse(res.json.result.content[0].text)).toEqual({ echoed: 'panel_snapshot' })
      expect(h.dispatch.calls[0]).toEqual({ name: 'panel_snapshot', args: {}, sessionId: 'sess-9' })
    } finally { await h.host.stop() }
  })

  it('tools/call 未知工具（写类名在内）：JSON-RPC 明确「未知工具」错误——不静默放行、不空成功', async () => {
    const h = await startHost()
    try {
      const token = h.registry.issue('sess-1')
      for (const name of ['app_quit', 'taskbar_set_enabled', 'plugins_install', 'now']) {
        const res = await post(h.url, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: {} } }, { Authorization: token })
        expect(res.json.error, name).toBeTruthy()
        expect(res.json.error.message).toMatch(/未知工具/)
        expect(h.dispatch.calls.length, name).toBe(0)
      }
    } finally { await h.host.stop() }
  })

  it('tools/call 投影源报错（source_error）：MCP 结果 isError:true + 错误文本（执行失败，非协议错）', async () => {
    const dispatch: ManagedDispatch = async () => ({ ok: false, reason: 'source_error', message: '插件目录越界: ../x' })
    const h = await startHost({ dispatch })
    try {
      const token = h.registry.issue('sess-1')
      const res = await post(h.url, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'plugin_source', arguments: { pluginId: 'x', path: '../y' } } }, { Authorization: token })
      expect(res.status).toBe(200)
      expect(res.json.result.isError).toBe(true)
      expect(res.json.result.content[0].text).toMatch(/越界/)
    } finally { await h.host.stop() }
  })

  it('协议外方法（带 id）→ -32601；通知（无 id）→ 202 无响应体要求', async () => {
    const h = await startHost()
    try {
      const token = h.registry.issue('sess-1')
      const unknown = await post(h.url, { jsonrpc: '2.0', id: 6, method: 'resources/list' }, { Authorization: token })
      expect(unknown.json.error.code).toBe(-32601)
      const notif = await post(h.url, { jsonrpc: '2.0', method: 'notifications/initialized' }, { Authorization: token })
      expect(notif.status).toBe(202)
    } finally { await h.host.stop() }
  })

  it('GET → 405（无 SSE 流，ADR-0016 首版无状态）；坏 JSON → 400；非 /mcp 路径 → 404', async () => {
    const h = await startHost()
    try {
      const token = h.registry.issue('sess-1')
      const get = await fetch(h.url, { headers: { Authorization: token } })
      expect(get.status).toBe(405)
      const bad = await post(h.url, 'not-json{{{', { Authorization: token })
      expect(bad.status).toBe(400)
      const wrongPath = await post(h.url.replace(/\/mcp$/, '/other'), { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: token })
      expect(wrongPath.status).toBe(404)
    } finally { await h.host.stop() }
  })

  it('凭证随宿主生命周期：stop = revokeAll 语义由服务层调用；宿主重启后旧 bearer 401（宿主重拉语义驱动面）', async () => {
    const registry = new SessionCredentialRegistry()
    const h = await startHost({ registry })
    const token = h.registry.issue('sess-1')
    try {
      const ok = await post(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: token })
      expect(ok.status).toBe(200)
    } finally { await h.host.stop() }
    // 宿主已停：原 bearer 请求连接失败（监听面消失）；新起宿主后 registry 若未清则仍可用——
    // 服务层契约是 stop/restart 必伴随 revokeAll（managed-credentials.spec 覆盖状态机，
    // 这里只证监听面随宿主消亡）
    await expect(post(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { Authorization: token })).rejects.toThrow()
  })

  it('宿主意外消亡（外部关闭底层监听）→ onLost 回调（服务层据此降级会话+revokeAll）', async () => {
    let lost: Error | null = null
    const host = new ManagedMcpHost({ registry: new SessionCredentialRegistry(), dispatch: makeDispatch(), onLost: (err) => { lost = err } })
    const started = await host.start()
    // 外部直关底层 server（模拟宿主被强杀/端口坍塌）
    ;(host as unknown as { server: import('node:http').Server }).server.close()
    await new Promise((r) => setTimeout(r, 30))
    expect(lost).not.toBeNull()
    void started
  })

  it('并发多请求：每个请求独立 bearer 认证与分派（无状态请求-响应，ADR-0016）', async () => {
    const h = await startHost()
    try {
      const t1 = h.registry.issue('s1')
      const t2 = h.registry.issue('s2')
      const [a, b, c] = await Promise.all([
        post(h.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: t1 }),
        post(h.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { Authorization: t2 }),
        post(h.url, { jsonrpc: '2.0', id: 3, method: 'tools/list' }, { Authorization: 'Bearer ' + randomBytes(43).toString('base64url') }),
      ])
      expect(a.status).toBe(200)
      expect(b.status).toBe(200)
      expect(c.status).toBe(401)
    } finally { await h.host.stop() }
  })
})
