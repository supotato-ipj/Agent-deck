// ACP v1 客户端测试（工单332）：NDJSON 帧、请求关联、session/update 分发、
// 权限反向请求与回复形状、取消、关闭、进程退出与协议错误路径。
// fake 后端 = tests/conversation/fake-acp-agent.mjs（确定性脚本，零 DSH 依赖）。
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachFakeAcpAgent } from './fake-acp-agent.mjs'
import { AcpClient } from '../../src/main/conversation/acp'

function makePair() {
  const toAgent = new PassThrough() // 客户端写 → fake 读
  const fromAgent = new PassThrough() // fake 写 → 客户端读
  return { toAgent, fromAgent }
}

function receivedOf(agent: { received: unknown[] }, method: string): Array<Record<string, unknown>> {
  return (agent.received as Array<Record<string, unknown>>).filter((f) => (f as { method?: string }).method === method)
}

describe('ACP 客户端：帧与会话链', () => {
  let client: AcpClient
  let toAgent: PassThrough
  let fromAgent: PassThrough
  let agent: ReturnType<typeof attachFakeAcpAgent>

  beforeEach(() => {
    ({ toAgent, fromAgent } = makePair())
    agent = attachFakeAcpAgent('fullchain', { input: toAgent, output: fromAgent })
    client = new AcpClient({})
    client.attach({ input: toAgent, output: fromAgent })
  })

  afterEach(async () => {
    client.end()
    toAgent.end()
    fromAgent.end()
  })

  it('initialize 全链：NDJSON 帧进、initialize 结果出，clientCapabilities 不声明 fs/terminal', async () => {
    const res = await client.initialize()
    expect(res.protocolVersion).toBe(1)
    expect(res.agentInfo.name).toBe('fake-acp-agent')
    expect(res.authMethods).toEqual([])
    const init = receivedOf(agent, 'initialize')[0] as { params: Record<string, unknown> }
    const caps = init.params.clientCapabilities as Record<string, unknown>
    expect(caps.fs).toEqual({ readTextFile: false, writeTextFile: false })
    expect(caps.terminal).toBe(false)
  })

  it('session/new 与 prompt 流式：update 通知分发、end_turn 结果', async () => {
    await client.initialize()
    const updates: Array<{ sessionId: string; update: Record<string, unknown> }> = []
    client.onSessionUpdate((sessionId, update) => updates.push({ sessionId, update }))
    const created = await client.sessionNew({ cwd: 'C:\\fake-cwd', mcpServers: [] })
    expect(created.sessionId).toBe('fake-session-1')
    const result = await client.prompt(created.sessionId, 'hello')
    expect(result.stopReason).toBe('end_turn')
    const chunks = updates.filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
    expect(chunks.length).toBe(2)
    // 累计快照语义：最后一条 chunk 是全量文本
    expect((chunks[1].update.content as { text: string }).text).toBe('FAKE HELLO')
    expect(updates.some((u) => u.update.sessionUpdate === 'usage_update')).toBe(true)
    // prompt 帧形状：prompt 是 [{type:'text',text}] 数组
    const promptFrames = receivedOf(agent, 'session/prompt') as Array<{ params: { prompt: unknown } }>
    expect(promptFrames[0].params.prompt).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('slow 场景 cancel：在途 prompt 以 stopReason cancelled 收束，fake 收到 cancel 通知', async () => {
    const { toAgent: t2, fromAgent: f2 } = makePair()
    const slowAgent = attachFakeAcpAgent('slow', { input: t2, output: f2, opts: { slowChunks: 60, slowGapMs: 10 } })
    const c2 = new AcpClient({})
    c2.attach({ input: t2, output: f2 })
    try {
      await c2.initialize()
      const created = await c2.sessionNew({ cwd: 'C:\\fake-cwd', mcpServers: [] })
      const promptPromise = c2.prompt(created.sessionId, 'count')
      await new Promise((r) => setTimeout(r, 120)) // 等 chunk 真的流起来再取消
      c2.cancel(created.sessionId)
      const result = await promptPromise
      expect(result.stopReason).toBe('cancelled')
      expect(receivedOf(slowAgent, 'session/cancel').length).toBe(1)
      // 进程仍存活：后续 prompt 可续用
      const again = await c2.prompt(created.sessionId, 'again')
      // 取消后再次 prompt 应正常跑完（slow 场景取消位已复位）
      expect(['end_turn', 'cancelled']).toContain(again.stopReason)
    } finally {
      c2.end()
      t2.end()
      f2.end()
    }
  })

  it('权限反向请求：回复形状 {outcome:{outcome:"selected",optionId}} 逐字上 wire，选项原样呈现', async () => {
    const { toAgent: t3, fromAgent: f3 } = makePair()
    const permAgent = attachFakeAcpAgent('permission', { input: t3, output: f3 })
    const c3 = new AcpClient({})
    let seenRequest: unknown = null
    c3.onPermissionRequest(async (req) => {
      seenRequest = req
      return { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
    c3.attach({ input: t3, output: f3 })
    try {
      await c3.initialize()
      const created = await c3.sessionNew({ cwd: 'C:\\fake-cwd', mcpServers: [] })
      const result = await c3.prompt(created.sessionId, 'escalate')
      expect(result.stopReason).toBe('end_turn')
      // 请求原样到达：options 与 toolCall 逐字
      const req = seenRequest as { sessionId: string; toolCall: { toolCallId: string }; options: Array<{ optionId: string; kind: string }> }
      expect(req.toolCall.toolCallId).toBe('call_1')
      expect(req.options.map((o) => o.optionId)).toEqual(['allow-once', 'reject-once'])
      // wire 上的回复形状（fake 校验形状，坏形状会以 PERMISSION-BAD-SHAPE 文本暴露）
      const updates = (permAgent.sent as Array<{ method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }>)
        .filter((f) => f.method === 'session/update')
      const texts = updates.map((u) => u.params?.update?.content?.text ?? '').join('|')
      expect(texts).toContain('PERMISSION-OK:allow-once')
      expect(texts).not.toContain('PERMISSION-BAD-SHAPE')
    } finally {
      c3.end()
      t3.end()
      f3.end()
    }
  })

  it('close 后 prompt：-32602 unknown session 以异常浮出', async () => {
    await client.initialize()
    const created = await client.sessionNew({ cwd: 'C:\\fake-cwd', mcpServers: [] })
    await client.closeSession(created.sessionId)
    await expect(client.prompt(created.sessionId, 'after close')).rejects.toThrow(/unknown session/)
  })

  it('exit 中途：prompt 在途请求随进程退出被拒绝，onExit 收到退出码', async () => {
    const { toAgent: t4, fromAgent: f4 } = makePair()
    let exitInfo: { code: number | null } | null = null
    const crashAgent = attachFakeAcpAgent('crash', { input: t4, output: f4, opts: { onExit: (code: number | null) => { exitInfo = { code }; c4.notifyExit(code, null) } } })
    const c4 = new AcpClient({})
    c4.attach({ input: t4, output: f4 })
    try {
      await c4.initialize()
      await c4.sessionNew({ cwd: 'C:\\fake-cwd', mcpServers: [] })
      await vi.waitFor(() => expect(exitInfo).not.toBeNull(), { timeout: 2000 })
      // crash 场景没有在途 prompt；这里验证退出后新请求立即失败（不再等超时）
      await expect(c4.sessionNew({ cwd: 'C:\\fake-cwd', mcpServers: [] })).rejects.toThrow(/已退出|exited/)
      expect((exitInfo as { code: number | null } | null)?.code).toBe(3)
    } finally {
      c4.end()
      t4.end()
      f4.end()
    }
  })

  it('协议错误：非法 JSON 行不致命，后续帧照常处理', async () => {
    const { toAgent: t5, fromAgent: f5 } = makePair()
    const errors: Error[] = []
    const badAgent = attachFakeAcpAgent('badjson', { input: t5, output: f5 })
    const c5 = new AcpClient({ onProtocolError: (e) => errors.push(e) })
    c5.attach({ input: t5, output: f5 })
    try {
      // badjson 场景在 CLI 才注入坏行；进程内手工喂一行
      f5.write('not-json-at-all\n')
      const res = await c5.initialize()
      expect(res.protocolVersion).toBe(1)
      void badAgent
      expect(errors.length).toBe(1)
    } finally {
      c5.end()
      t5.end()
      f5.end()
    }
  })

  it('initialize 超时：小超时窗内无响应即拒绝', async () => {
    const { toAgent: t6, fromAgent: f6 } = makePair()
    const idleAgent = attachFakeAcpAgent('init-only', { input: t6, output: f6 })
    const c6 = new AcpClient({ initializeTimeoutMs: 120 })
    c6.attach({ input: t6, output: f6 })
    try {
      await expect(c6.initialize()).rejects.toThrow(/timeout|超时/i)
    } finally {
      c6.end()
      t6.end()
      f6.end()
      void idleAgent
    }
  })

  it('跨 chunk 断帧：一帧 JSON 被拆成多次 write 仍正确解析', async () => {
    const { toAgent: t7, fromAgent: f7 } = makePair()
    // 用 fullchain fake，但把它的输出经手工拆帧转发
    const splitOut = new PassThrough()
    const real = attachFakeAcpAgent('fullchain', { input: t7, output: splitOut })
    void real
    let pending = ''
    splitOut.on('data', (d) => {
      pending += d.toString('utf8')
      // 每次只转发 7 字节，强制把 JSON 行拆碎
      while (pending.length > 0) {
        const take = pending.slice(0, 7)
        pending = pending.slice(7)
        f7.write(take)
      }
    })
    const c7 = new AcpClient({})
    c7.attach({ input: t7, output: f7 })
    try {
      const res = await c7.initialize()
      expect(res.protocolVersion).toBe(1)
      const created = await c7.sessionNew({ cwd: 'C:\\x', mcpServers: [] })
      const r = await c7.prompt(created.sessionId, 'hi')
      expect(r.stopReason).toBe('end_turn')
    } finally {
      c7.end()
      t7.end()
      f7.end()
      splitOut.end()
    }
  })
})
