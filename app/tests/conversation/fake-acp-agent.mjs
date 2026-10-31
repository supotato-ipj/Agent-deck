// 确定性 ACP v1 fake 后端（工单332 常驻测试资产）：说 NDJSON JSON-RPC 2.0（ACP 帧），
// 行为按场景脚本化，让 ACP 客户端与会话服务的常规回归完全离线、零 DSH 依赖。
import { pathToFileURL } from 'node:url'
import path from 'node:path'
//
// 两种用法：
//   1) 进程内：attachFakeAcpAgent(scenario, { input, output }) —— PassThrough 流对，
//      fake 收到的每一帧都记进 received[]，wire 断言直接读它。
//   2) 子进程：node fake-acp-agent.mjs --scenario <名> [--trace]
//      会话服务的 spawnProcess 注入真子进程路径用（全链 spawn→帧→生命周期）；
//      --trace 把收到的帧逐行写 stderr（NDJSON），服务测试断言 wire 形状用。
//
// 场景（脚本化、确定性）：
//   fullchain   initialize → session/new → prompt（两条累计 chunk + usage_update → end_turn）
//   slow        prompt 持续流 chunk（默认 60 × 25ms），收到 session/cancel 即收尾
//               （收尾累计 chunk + stopReason:"cancelled"），不取消则流完 end_turn
//   permission  prompt 触发 server→client 请求 session/request_permission（allow-once/reject-once）；
//               客户端回复形状合法（{outcome:{outcome:"selected",optionId}}）→ 工具完成 +
//               最终文本 PERMISSION-OK:<optionId> + end_turn；回复 cancelled → PERMISSION-CANCELLED +
//               stopReason:"cancelled"；形状不合法 → 最终文本 PERMISSION-BAD-SHAPE（全栈暴露坏形状）
//   close       prompt 正常；session/close 后再 prompt → -32602 unknown session
//   crash       session/new 响应后 50ms 硬退（exit code 3）——进程异常退出路径
//   badjson     起手先发一行非法 JSON（协议错误路径），之后行为同 fullchain
//   init-only   只应 initialize，其余请求一律挂起（initialize 超时路径用小超时驱动）
// —— 管理型（工单333）：
//   managed       session/new 接收 mcpServers[0]（{type:"http",url,headers}）并真连它：
//                 MCP initialize → tools/list → tools/call(panel_snapshot) → tools/call
//                 (app_quit，期待未知工具错误)，结果回进转写（SNAPSHOT-OK:/MCP-UNKNOWN-TOOL-OK:/
//                 MCP-FAIL: 标记）；session/new 回复后即刻探活宿主（initialize+tools/list，
//                 t330 实录：真实 DSH 拿到 mcpServers 即刻探活——工单340 冒烟门的观察对象）
//   managed-nosmoke session/new 接收注入但**不探活宿主**（工单340 冒烟超时路径驱动：
//                 模拟某未知版本忽略/搞砸 MCP 注入）
//   managed-nomcp initialize 声明 mcpCapabilities.http:false（能力缺失 → 服务层全有或全无败）
//   mcp-reject    session/new 带 mcpServers 时报 -32602（session/new 失败 → 服务层回滚）

function initResultFor(scenario) {
  return {
    protocolVersion: 1,
    agentInfo: { name: 'fake-acp-agent', version: '0.1.0' },
    agentCapabilities: {
      mcpCapabilities: { http: scenario !== 'managed-nomcp' },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  }
}

/**
 * fake 核心：io.send(obj) 把一帧写给客户端；返回的 handler.recv(frame) 喂客户端来的帧。
 * 返回句柄含 received（收到的全部帧）与 exit(code)（进程内硬退通知缝）。
 */
export function createFakeAcpAgentCore(scenario, io, opts = {}) {
  const received = []
  const sent = []
  let nextId = 1
  let closed = false
  let promptOpen = false
  let cancelled = false
  let sessionNewDone = false
  let slowTimer = null
  let injectedMcp = null
  const pendingTimers = new Set()
  const trace = opts.trace || (() => {})

  const later = (fn, ms) => {
    const t = setTimeout(() => { pendingTimers.delete(t); fn() }, ms)
    pendingTimers.add(t)
    return t
  }
  const send = (obj) => { sent.push(obj); io.send(obj) }
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
  const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  // 工单340 冒烟门观察对象：对注入的回环 MCP 宿主做最小探活（initialize → tools/list，
  // 带 bearer）。真实 DSH 在 session/new 后即刻做同一链路（t330 实录先 server/discover，
  // 方言请求宿主按 -32601 回，不影响 initialize/tools/list 两发的到达）。
  async function probeInjectedMcp(mcp) {
    if (!mcp || mcp.type !== 'http') return
    const headers = { 'Content-Type': 'application/json' }
    for (const hd of mcp.headers ?? []) headers[hd.name] = hd.value
    try {
      const init = await fetch(mcp.url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 90001, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp-agent', version: '0.1.0' } } }),
      })
      const sid = init.headers.get('mcp-session-id')
      if (sid) headers['mcp-session-id'] = sid
      await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) })
      await fetch(mcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 90002, method: 'tools/list', params: {} }) })
    } catch { /* 宿主不可达：探活落空，冒烟门按超时处置 */ }
  }

  const handle = (frame) => {
    received.push(frame)
    trace(frame)
    if (!frame || typeof frame !== 'object') return
    const isRequest = frame.id !== undefined && frame.method !== undefined
    const isNotification = frame.id === undefined && frame.method !== undefined
    if (isRequest) {
      switch (frame.method) {
        case 'initialize':
          // init-only：挂起不应答（initialize 超时路径的驱动场景）
          if (scenario !== 'init-only') reply(frame.id, initResultFor(scenario))
          return
        case 'session/new':
          sessionNewDone = true
          // 管理型：记录注入的 mcpServers[0]（工单333）；mcp-reject 场景带注入即报错（回滚路径）
          if (Array.isArray(frame.params?.mcpServers) && frame.params.mcpServers.length > 0) {
            if (scenario === 'mcp-reject') {
              replyError(frame.id, -32602, 'Invalid params: mcp server rejected (fake mcp-reject)')
              return
            }
            injectedMcp = frame.params.mcpServers[0]
            // 工单340：真实 DSH 拿到 mcpServers 即刻探活宿主（t330 实录）——managed 场景
            // 在回复后 10ms 探活（initialize+tools/list）；managed-nosmoke 场景保持沉默。
            if (scenario === 'managed') {
              const target = injectedMcp
              later(() => { void probeInjectedMcp(target) }, 10)
            }
          }
          reply(frame.id, { sessionId: 'fake-session-1', configOptions: [] })
          // 工单340：crash 场景带注入时先探活再崩（对齐真实时序：即刻探活在前、崩溃在后——
          // 否则冒烟门等不到探活 → 创建全有或全无失败，测不到「ready 后 crash」生命周期）
          if (scenario === 'crash') {
            const hasInjection = Array.isArray(frame.params?.mcpServers) && frame.params.mcpServers.length > 0
            if (hasInjection && injectedMcp) {
              const target = injectedMcp
              void probeInjectedMcp(target).finally(() => { later(() => exit(3), 50) })
            } else {
              later(() => exit(3), 50)
            }
          }
          return
        case 'session/prompt': {
          if (closed) { replyError(frame.id, -32602, `Invalid params: unknown session: ${frame.params?.sessionId}`); return }
          if (promptOpen) { replyError(frame.id, -32603, 'prompt already in flight'); return }
          promptOpen = true
          cancelled = false
          runPromptScenario(frame)
          return
        }
        case 'session/set_config_option':
          // DSH 方言：返回更新后的 configOptions（值形状不校验——原样记账）
          reply(frame.id, { configOptions: [{ id: frame.params?.configId ?? '', value: frame.params?.value ?? '' }] })
          return
        case 'session/close':
          closed = true
          reply(frame.id, {})
          return
        case 'session/resume':
          // 会话正文持久在后端（DSH_HOME/sessions 同语义）：新进程可按 id 续接既有会话
          if (frame.params?.sessionId !== 'fake-session-1') { replyError(frame.id, -32602, 'Invalid params: unknown session'); return }
          reply(frame.id, { sessionId: frame.params.sessionId, configOptions: [] })
          return
        default:
          replyError(frame.id, -32601, `Method not found: ${frame.method}`)
      }
      return
    }
    if (isNotification && frame.method === 'session/cancel') {
      cancelled = true
      return
    }
  }

  const update = (u) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session-1', update: u } })

  function runPromptScenario(frame) {
    const promptId = frame.id
    const finish = (stopReason) => {
      promptOpen = false
      reply(promptId, { stopReason })
    }
    if (scenario === 'managed') {
      void runManagedTurn(promptId, finish)
      return
    }
    if (scenario === 'permission') {
      update({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Fake escalation write', kind: 'edit', status: 'in_progress' })
      // server→client 请求：session/request_permission（ACP 反向请求）
      const reqId = nextId++
      send({
        jsonrpc: '2.0', id: reqId, method: 'session/request_permission',
        params: {
          sessionId: 'fake-session-1',
          toolCall: { toolCallId: 'call_1' },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        },
      })
      // 等客户端回复：recv 会把 response 也喂给 onPermissionReply（下见 recv 包装）
      permissionWaiters.push({ reqId, promptId, finish })
      return
    }
    if (scenario === 'slow') {
      const total = opts.slowChunks ?? 60
      const gapMs = opts.slowGapMs ?? 25
      let i = 0
      let cumulative = ''
      const step = () => {
        if (cancelled) {
          update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-slow', content: { type: 'text', text: `${cumulative}(cut)` } })
          finish('cancelled')
          return
        }
        if (i >= total) { finish('end_turn'); return }
        cumulative += `chunk${i} `
        update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-slow', content: { type: 'text', text: cumulative } })
        if (i === 0) update({ sessionUpdate: 'usage_update', used: 10, size: 1000 })
        i++
        slowTimer = later(step, gapMs)
      }
      step()
      return
    }
    // fullchain（与 badjson 同路径）
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'FAKE' } })
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text: 'FAKE HELLO' } })
    update({ sessionUpdate: 'usage_update', used: 10, size: 1000 })
    finish('end_turn')
  }

  const permissionWaiters = []

  // —— 管理型 turn（工单333）：真连注入的回环 MCP 端点（Streamable HTTP + bearer），
  //    完整走 initialize → tools/list → tools/call（快照读 + 写类名两发），结果进转写。
  async function runManagedTurn(promptId, finish) {
    // 累计快照语义（探针实录：同 messageId 的 chunk 是整条消息的累计快照——探针 #330/#332）
    let mcpText = ''
    const chunk = (text) => {
      mcpText += (mcpText ? ' ' : '') + text
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-mcp', content: { type: 'text', text: mcpText } })
    }
    update({ sessionUpdate: 'tool_call', toolCallId: 'call_snap', title: 'panel_snapshot', kind: 'other', status: 'in_progress' })
    try {
      if (!injectedMcp || injectedMcp.type !== 'http') throw new Error('no injected http mcp server')
      let mcpSession = null
      const rpc = async (method, params, withSession = true) => {
        const headers = { 'Content-Type': 'application/json' }
        for (const hd of injectedMcp.headers ?? []) headers[hd.name] = hd.value
        if (withSession && mcpSession) headers['mcp-session-id'] = mcpSession
        const res = await fetch(injectedMcp.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: nextId++ + 10000, method, params }) })
        const sid = res.headers.get('mcp-session-id')
        if (sid) mcpSession = sid
        const body = await res.json()
        return { status: res.status, body }
      }
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp-agent', version: '0.1.0' } }, false)
      if (!init.body.result) throw new Error(`MCP initialize 失败: ${JSON.stringify(init.body).slice(0, 120)}`)
      await rpc('notifications/initialized', {}, false)
      const list = await rpc('tools/list', {})
      const names = (list.body.result?.tools ?? []).map((t) => t.name)
      const call = await rpc('tools/call', { name: 'panel_snapshot', arguments: {} })
      const toolText = call.body.result?.content?.[0]?.text ?? ''
      let keys = []
      try { keys = Object.keys(JSON.parse(toolText)) } catch { /* 快照不是对象：标记里如实空 */ }
      update({
        sessionUpdate: 'tool_call_update', toolCallId: 'call_snap', status: call.body.result?.isError ? 'failed' : 'completed',
        content: [{ type: 'content', content: { type: 'text', text: `tools=${names.join(',')}` } }],
      })
      chunk(`SNAPSHOT-OK:${keys.join('|')}|TOOLS=${names.length}`)
    } catch (err) {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_snap', status: 'failed' })
      chunk(`MCP-FAIL:${err instanceof Error ? err.message : String(err)}`)
      finish('end_turn')
      return
    }
    // 写类工具名（投影外）：期待宿主封闭集门的「未知工具」错误——不静默放行
    try {
      const headers = { 'Content-Type': 'application/json' }
      for (const hd of injectedMcp.headers ?? []) headers[hd.name] = hd.value
      const res = await fetch(injectedMcp.url, {
        method: 'POST', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++ + 10000, method: 'tools/call', params: { name: 'app_quit', arguments: {} } }),
      })
      const body = await res.json()
      if (body.error && /未知工具/.test(body.error.message)) chunk(`MCP-UNKNOWN-TOOL-OK:app_quit`)
      else chunk(`MCP-WRITE-NOT-REJECTED:${JSON.stringify(body).slice(0, 120)}`)
    } catch (err) {
      chunk(`MCP-FAIL-2:${err instanceof Error ? err.message : String(err)}`)
    }
    finish('end_turn')
  }

  function resolvePermission(frame) {
    const w = permissionWaiters.shift()
    if (!w) return
    const result = frame.result
    const outcome = result && result.outcome && result.outcome.outcome
    if (outcome === 'cancelled') {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' })
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-perm', content: { type: 'text', text: 'PERMISSION-CANCELLED' } })
      w.finish('cancelled')
      return
    }
    const shapeOk = outcome === 'selected' && typeof result.outcome.optionId === 'string'
    if (!shapeOk) {
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'failed' })
      update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-perm', content: { type: 'text', text: 'PERMISSION-BAD-SHAPE' } })
      w.finish('end_turn')
      return
    }
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'fake wrote file' } }] })
    update({ sessionUpdate: 'agent_message_chunk', messageId: 'm-perm', content: { type: 'text', text: `PERMISSION-OK:${result.outcome.optionId}` } })
    w.finish('end_turn')
  }

  // 权限挂起轮询：request_permission 发出后，客户端的 response 会作为普通帧进来
  const recv = (frame) => {
    if (frame && typeof frame === 'object' && frame.id !== undefined && frame.method === undefined
      && permissionWaiters.some((w) => w.reqId === frame.id)) {
      received.push(frame)
      trace(frame)
      resolvePermission(frame)
      return
    }
    handle(frame)
  }

  function exit(code) {
    for (const t of pendingTimers) clearTimeout(t)
    if (slowTimer) clearTimeout(slowTimer)
    io.exit?.(code)
  }

  return {
    recv,
    received,
    /** fake 发出的全部帧（session/update、权限请求、响应——wire 断言用） */
    sent,
    /** 测试观察缝：权限请求是否已发出 */
    permissionPending: () => permissionWaiters.length > 0,
  }
}

/**
 * 进程内接线：input = 客户端写来的流（Readable），output = fake 写给客户端的流（Writable）。
 * 返回 { agent, feed(line) }——feed 喂一行 NDJSON 给 fake。
 */
export function attachFakeAcpAgent(scenario, { input, output, opts } = {}) {
  let buf = ''
  const agent = createFakeAcpAgentCore(scenario, {
    send: (obj) => { output.write(JSON.stringify(obj) + '\n') },
    exit: opts?.onExit,
  }, opts)
  input.setEncoding('utf8')
  input.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      agent.recv(frame)
    }
  })
  return agent
}

// —— CLI 入口（子进程形态）：stdin/stdout 直连，--trace 落 stderr ——
function main() {
  const argv = process.argv.slice(2)
  const flag = (name, def = null) => {
    const i = argv.indexOf(name)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def
  }
  const scenario = flag('--scenario', 'fullchain')
  const trace = argv.includes('--trace') ? (frame) => { try { process.stderr.write(JSON.stringify(frame) + '\n') } catch { /* 尽力 */ } } : () => {}
  const opts = {
    trace,
    slowChunks: Number(flag('--slow-chunks', '60')),
    slowGapMs: Number(flag('--slow-gap-ms', '25')),
  }
  const agent = createFakeAcpAgentCore(scenario, {
    send: (obj) => { process.stdout.write(JSON.stringify(obj) + '\n') },
    exit: (code) => { process.exitCode = code ?? 0; process.exit(code ?? 0) },
  }, opts)
  let buf = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let frame
      try { frame = JSON.parse(line) } catch { continue }
      agent.recv(frame)
    }
  })
  if (scenario === 'badjson') process.stdout.write('this is not json\n')
  process.stdin.resume()
}

if (process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
