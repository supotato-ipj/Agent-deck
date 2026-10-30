// 对话窗会话服务测试（工单332）：真实子进程形态的确定性 ACP fake（fake-acp-agent.mjs
// CLI）走全链 spawn→NDJSON→生命周期，断言创建/流式/权限/取消/结束/异常退出/续接/
// 元数据记账与进程卫生。零 DSH 依赖。
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConversationService, type ConversationProcess, type ConversationSpawn } from '../../src/main/conversation/service'
import type { ConversationSessionView } from '../../src/shared/contract'

const FAKE_AGENT = path.resolve(__dirname, 'fake-acp-agent.mjs')

interface SpawnRecord {
  plan: { file: string; args: string[]; env: Record<string, string> }
  cwd: string
  env: Record<string, string | undefined>
  pid: number | undefined
  alive: () => boolean
  traceFrames: () => Array<Record<string, unknown>>
}

function until<T>(pred: () => T | null | undefined, timeoutMs = 5000, stepMs = 40): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      try {
        const v = pred()
        if (v) { resolve(v); return }
      } catch { /* 谓词内部异常按未就绪处理 */ }
      if (Date.now() - started > timeoutMs) { reject(new Error('until 超时')); return }
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

function makeHarness(scenario: string) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-conv-'))
  const dshHome = path.join(tmp, 'dsh-home')
  const workspacesRoot = path.join(tmp, 'workspaces')
  const metadataFile = path.join(tmp, 'metadata.json')
  fs.mkdirSync(dshHome, { recursive: true })
  const spawns: SpawnRecord[] = []
  const logs: Array<Record<string, unknown>> = []
  const jobHandles: Array<{ assigned: number[]; closed: boolean }> = []
  const spawnProcess: ConversationSpawn = (plan, cwd, env) => {
    const child: ChildProcess = spawn(process.execPath, [FAKE_AGENT, '--scenario', scenario, '--trace'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const trace: Array<Record<string, unknown>> = []
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line.trim()) continue
        try { trace.push(JSON.parse(line)) } catch { /* 半行自愈 */ }
      }
    })
    const record: SpawnRecord = {
      plan,
      cwd,
      env,
      pid: child.pid,
      alive: () => child.pid != null && child.exitCode == null && !child.killed,
      traceFrames: () => trace,
    }
    spawns.push(record)
    const proc: ConversationProcess = {
      pid: child.pid,
      stdin: child.stdin!,
      stdout: child.stdout!,
      onExit: (cb) => child.once('exit', (code, signal) => cb(code, signal)),
      killTree: () => { try { child.kill() } catch { /* 尽力 */ } },
    }
    return proc
  }
  const createJobObject = () => {
    const handle = { assigned: [] as number[], closed: false }
    jobHandles.push(handle)
    return {
      assign(pid: number) { handle.assigned.push(pid); return true },
      close() { handle.closed = true },
    }
  }
  const ctx = new Context()
  const service = new ConversationService(ctx, {
    dshHome,
    workspacesRoot,
    metadataFile,
    deps: {
      resolveBackend: async () => ({ exe: 'C:\\fake\\DeepSeek Harness.exe', cliJs: 'C:\\fake\\cli.js', source: 'test' }),
      spawnProcess,
      createJobObject,
      env: { DECK_TEST: '1' },
      log: (e) => logs.push(e),
    },
  })
  const views = (): ConversationSessionView[] => service.sessions()
  const cleanup = async () => {
    service.dispose()
    try { await ctx.stop() } catch { /* 已停即略 */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄滞后尽力 */ }
  }
  return { tmp, dshHome, workspacesRoot, metadataFile, spawns, logs, jobHandles, ctx, service, views, cleanup }
}

async function createdSession(h: ReturnType<typeof makeHarness>, label?: string) {
  const res = await h.service.create(label)
  expect(res.ok).toBe(true)
  const session = res.session!
  await until(() => h.views().find((s) => s.id === session.id)?.status === 'ready')
  return session
}

describe('对话窗会话服务（工单332）', () => {
  let harness: ReturnType<typeof makeHarness> | null = null

  beforeEach(() => { harness = null })
  afterEach(async () => { await harness?.cleanup(); harness = null })

  it('创建：每会话独立进程与专属空工作目录，DSH_HOME/env/args 走探针配方，握手与会话账目落盘', async () => {
    harness = makeHarness('fullchain')
    const h = harness!
    const session = await createdSession(h, '验收会话')
    // 进程与工作目录一一对应；目录为空且绝对
    expect(h.spawns.length).toBe(1)
    const rec = h.spawns[0]
    expect(rec.cwd).toBe(session.cwd)
    expect(path.isAbsolute(session.cwd)).toBe(true)
    expect(fs.existsSync(session.cwd)).toBe(true)
    expect(fs.readdirSync(session.cwd)).toEqual([])
    // 启动计划：--profile acp + DSH_HOME 指面板专属目录 + ELECTRON_RUN_AS_NODE
    expect(rec.plan.args).toContain('--profile')
    expect(rec.plan.args[rec.plan.args.indexOf('--profile') + 1]).toBe('acp')
    expect(rec.plan.env.DSH_HOME).toBe(h.dshHome)
    expect(rec.plan.env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(rec.env.DSH_HOME).toBe(h.dshHome)
    // 聊天型零管理面：session/new 的 mcpServers 为空数组（wire 断言）
    const sessionNew = rec.traceFrames().find((f) => f.method === 'session/new') as { params: { mcpServers: unknown[]; cwd: string } }
    expect(sessionNew.params.mcpServers).toEqual([])
    expect(sessionNew.params.cwd).toBe(session.cwd)
    // 握手存证（agentInfo 实测记录）
    const handshake = h.logs.find((e) => e.type === 'conversation-handshake') as Record<string, unknown> | undefined
    expect(handshake).toBeDefined()
    expect(handshake!.agent).toBe('fake-acp-agent')
    expect(handshake!.protocolVersion).toBe(1)
    // Job Object 已挂（kill-on-close 兜底）
    expect(h.jobHandles[0].assigned).toEqual([rec.pid])
    // 元数据落盘：只存元数据（无转写字段）
    const meta = JSON.parse(fs.readFileSync(h.metadataFile, 'utf8'))
    const row = meta.sessions.find((s: { id: string }) => s.id === session.id)
    expect(row).toBeDefined()
    expect(row.backend).toBe('dsh')
    expect(row.cwd).toBe(session.cwd)
    expect(row.label).toBe('验收会话')
    expect(row.managed).toBe(false)
    expect(row.createdAt).toBeGreaterThan(0)
    expect(JSON.stringify(row)).not.toContain('transcript')
    // 视图：backendAgent 实测、状态 ready
    const view = h.views().find((s) => s.id === session.id)!
    expect(view.backendAgent).toBe('fake-acp-agent')
    expect(view.status).toBe('ready')
    expect(view.managed).toBe(false)
  })

  it('prompt 流式：用户/回复条目（累计快照替换）、usage 记账、end_turn 结果存证', async () => {
    harness = makeHarness('fullchain')
    const h = harness!
    const session = await createdSession(h)
    const res = await h.service.prompt(session.id, '你好')
    expect(res.ok).toBe(true)
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'ready')
    const view = h.views().find((s) => s.id === session.id)!
    const user = view.transcript.find((e) => e.kind === 'user')
    expect(user?.text).toBe('你好')
    const agentEntries = view.transcript.filter((e) => e.kind === 'agent')
    expect(agentEntries.map((e) => e.text)).toEqual(['FAKE HELLO']) // 累计快照替换，不叠行
    expect(view.usage).toEqual({ used: 10, size: 1000 })
    const result = h.logs.find((e) => e.type === 'conversation-prompt-result') as Record<string, unknown>
    expect(result.stopReason).toBe('end_turn')
  })

  it('权限请求原样呈现 + 用户裁决形状逐字上 wire + 绝不超时自动拒绝', async () => {
    harness = makeHarness('permission')
    const h = harness!
    const session = await createdSession(h)
    const promptDone = h.service.prompt(session.id, 'escalate')
    // 权限请求浮出（原样选项）
    const pending = await until(() => h.views().find((s) => s.id === session.id)?.pendingPermission ?? null)
    expect(pending!.options.map((o) => o.optionId)).toEqual(['allow-once', 'reject-once'])
    const permEntry = h.views().find((s) => s.id === session.id)!.transcript.find((e) => e.kind === 'permission')
    expect(permEntry?.options?.length).toBe(2)
    const toolEntry = h.views().find((s) => s.id === session.id)!.transcript.find((e) => e.kind === 'tool')
    expect(toolEntry?.toolCallId).toBe('call_1')
    expect(toolEntry?.raw?.sessionUpdate).toBe('tool_call')
    // 绝不超时自动拒绝：挂 600ms 后请求仍在途（客户端无超时路径）
    await new Promise((r) => setTimeout(r, 600))
    expect(h.views().find((s) => s.id === session.id)?.pendingPermission).not.toBeNull()
    const resolved = await h.service.respondPermission(session.id, 'allow-once')
    expect(resolved.ok).toBe(true)
    const result = await promptDone
    expect(result.ok).toBe(true)
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'ready')
    // wire 上的回复形状（探针实证：必须 {outcome:{outcome:"selected",optionId}}）
    const responses = h.spawns[0].traceFrames().filter((f) => f.id !== undefined && f.method === undefined && f.result)
    const permReply = responses.find((f) => (f.result as { outcome?: { outcome?: string } }).outcome?.outcome === 'selected')
    expect(permReply).toBeDefined()
    expect((permReply!.result as { outcome: { optionId: string } }).outcome.optionId).toBe('allow-once')
    // 权限存证
    expect(h.logs.find((e) => e.type === 'conversation-permission-request')).toBeDefined()
    expect((h.logs.find((e) => e.type === 'conversation-permission-resolved') as Record<string, unknown>).optionId).toBe('allow-once')
  })

  it('取消：在途权限一并回 cancelled，prompt 以 stopReason cancelled 收束、进程存活可续用', async () => {
    harness = makeHarness('slow')
    const h = harness!
    const session = await createdSession(h)
    const promptDone = h.service.prompt(session.id, 'count')
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'busy')
    const cancelled = await h.service.cancel(session.id)
    expect(cancelled.ok).toBe(true)
    const result = await promptDone
    expect(result.ok).toBe(true)
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'ready')
    const view = h.views().find((s) => s.id === session.id)!
    expect(view.transcript.some((e) => e.kind === 'agent' && e.text.includes('(cut)'))).toBe(true)
    expect((h.logs.find((e) => e.type === 'conversation-prompt-result') as Record<string, unknown>).stopReason).toBe('cancelled')
    // 进程存活：后续 prompt 可续用（end_turn 收束）
    const again = await h.service.prompt(session.id, 'again')
    expect(again.ok).toBe(true)
    await until(() => (h.logs.filter((e) => e.type === 'conversation-prompt-result').length >= 2))
    expect(h.spawns.length).toBe(1)
  })

  it('权限在途时取消：权限回复走 cancelled 形状', async () => {
    harness = makeHarness('permission')
    const h = harness!
    const session = await createdSession(h)
    const promptDone = h.service.prompt(session.id, 'escalate')
    await until(() => h.views().find((s) => s.id === session.id)?.pendingPermission ?? null)
    await h.service.cancel(session.id)
    await promptDone
    // 等 turn 真正收束（prompt 是流式接口，调用返回只代表受理）
    await until(() => (h.logs.filter((e) => e.type === 'conversation-prompt-result').length >= 1))
    const responses = h.spawns[0].traceFrames().filter((f) => f.id !== undefined && f.method === undefined && f.result)
    const cancelReply = responses.find((f) => (f.result as { outcome?: { outcome?: string } }).outcome?.outcome === 'cancelled')
    expect(cancelReply).toBeDefined()
  })

  it('显式结束：在途先 cancel 再 close，stdin close 自然退出 code 0，元数据记 endedAt', async () => {
    harness = makeHarness('slow')
    const h = harness!
    const session = await createdSession(h)
    void h.service.prompt(session.id, 'count')
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'busy')
    const res = await h.service.end(session.id)
    expect(res.ok).toBe(true)
    // wire 顺序：session/cancel 通知在 session/close 请求之前
    const frames = h.spawns[0].traceFrames()
    const cancelIdx = frames.findIndex((f) => f.method === 'session/cancel')
    const closeIdx = frames.findIndex((f) => f.method === 'session/close')
    expect(cancelIdx).toBeGreaterThanOrEqual(0)
    expect(closeIdx).toBeGreaterThan(cancelIdx)
    // 进程自然退出（fake stdin end → exit 0）
    await until(() => !h.spawns[0].alive(), 8000)
    const exitLog = h.logs.find((e) => e.type === 'conversation-process-exit') as Record<string, unknown>
    expect(exitLog.code).toBe(0)
    expect((h.logs.find((e) => e.type === 'conversation-ended') as Record<string, unknown>).sessionId).toBe(session.id)
    // 元数据 endedAt 落盘
    const meta = JSON.parse(fs.readFileSync(h.metadataFile, 'utf8'))
    expect(meta.sessions.find((s: { id: string }) => s.id === session.id).endedAt).toBeGreaterThan(0)
    // Job Object 句柄已收
    expect(h.jobHandles[0].closed).toBe(true)
    // 结束后再 end 幂等
    expect((await h.service.end(session.id)).ok).toBe(true)
  })

  it('进程异常退出：状态 failed、错误可见、不自动重启不重放（spawn 恰一次）', async () => {
    harness = makeHarness('crash')
    const h = harness!
    const session = await createdSession(h)
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'failed')
    const view = h.views().find((s) => s.id === session.id)!
    expect(view.error).toContain('退出')
    expect(h.spawns.length).toBe(1) // 不自动重启
    expect((h.logs.find((e) => e.type === 'conversation-failed') as Record<string, unknown>).sessionId).toBe(session.id)
  })

  it('续接：按元数据 backendSessionId + 同一 cwd 重新拉进程并 session/resume，正文不回放插入 system 说明', async () => {
    harness = makeHarness('fullchain')
    const h = harness!
    const session = await createdSession(h)
    await h.service.prompt(session.id, '你好')
    await h.service.end(session.id)
    await until(() => !h.spawns[0].alive(), 8000)
    const res = await h.service.resume(session.id)
    expect(res.ok).toBe(true)
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'ready' && h.spawns.length === 2)
    const resumeFrame = h.spawns[1].traceFrames().find((f) => f.method === 'session/resume') as { params: { sessionId: string; cwd: string; mcpServers: unknown[] } }
    expect(resumeFrame.params.sessionId).toBe(session.backendSessionId ?? '')
    expect(resumeFrame.params.cwd).toBe(session.cwd)
    expect(resumeFrame.params.mcpServers).toEqual([])
    const view = h.views().find((s) => s.id === session.id)!
    // 续接不回放历史：旧转写清空，只有一条 system 说明
    expect(view.transcript.filter((e) => e.kind === 'system').length).toBeGreaterThanOrEqual(1)
    expect(view.transcript.some((e) => e.text.includes('不回放'))).toBe(true)
  })

  it('panel 退出（dispose）：在途全部终止、进程回收、Job Object 收口', async () => {
    harness = makeHarness('slow')
    const h = harness!
    const session = await createdSession(h)
    void h.service.prompt(session.id, 'count')
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'busy')
    h.service.dispose()
    await until(() => !h.spawns[0].alive(), 8000)
    expect(h.jobHandles[0].closed).toBe(true)
  })

  it('后端不可用：创建全有或全无（不 spawn、状态不入列）、backendInfo 如实报缺', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-conv-'))
    try {
      const ctx = new Context()
      const svc = new ConversationService(ctx, {
        dshHome: path.join(tmp, 'h'),
        workspacesRoot: path.join(tmp, 'w'),
        metadataFile: path.join(tmp, 'm.json'),
        deps: { resolveBackend: async () => null },
      })
      const info = svc.backendInfo()
      expect(info.available).toBe(false)
      const res = await svc.create()
      expect(res.ok).toBe(false)
      expect(res.error).toContain('未检测到')
      expect(svc.sessions()).toEqual([])
      svc.dispose()
      void ctx.stop().catch(() => {})
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('元数据重载：重启后清单从盘恢复（ended 会话在列、转写为空、不复活进程）', async () => {
    const h0 = makeHarness('fullchain')
    try {
      const session = await createdSession(h0)
      await h0.service.end(session.id)
      await until(() => !h0.spawns[0].alive(), 8000)
      const ctx2 = new Context()
      const svc2 = new ConversationService(ctx2, {
        dshHome: h0.dshHome,
        workspacesRoot: h0.workspacesRoot,
        metadataFile: h0.metadataFile,
        deps: { resolveBackend: async () => null },
      })
      const rows = svc2.sessions()
      expect(rows.length).toBe(1)
      expect(rows[0].id).toBe(session.id)
      expect(rows[0].status).toBe('ended')
      expect(rows[0].transcript).toEqual([])
      expect(rows[0].backendPid).toBeNull()
      svc2.dispose()
      void ctx2.stop().catch(() => {})
    } finally {
      await h0.cleanup()
    }
  })

  it('busy 期二次 prompt 被拒（一轮一 turn）', async () => {
    harness = makeHarness('slow')
    const h = harness!
    const session = await createdSession(h)
    void h.service.prompt(session.id, 'count')
    await until(() => h.views().find((s) => s.id === session.id)?.status === 'busy')
    const res = await h.service.prompt(session.id, 'second')
    expect(res.ok).toBe(false)
    await h.service.cancel(session.id)
  })

  it('坏元数据 JSON：视同空表重建（自愈，不炸服务）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-conv-'))
    try {
      fs.writeFileSync(path.join(tmp, 'm.json'), '{not json')
      const ctx = new Context()
      const svc = new ConversationService(ctx, {
        dshHome: path.join(tmp, 'h'),
        workspacesRoot: path.join(tmp, 'w'),
        metadataFile: path.join(tmp, 'm.json'),
        deps: { resolveBackend: async () => null },
      })
      expect(svc.sessions()).toEqual([])
      svc.dispose()
      void ctx.stop().catch(() => {})
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
