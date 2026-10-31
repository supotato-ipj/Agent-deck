// 会话服务管理型创建测试（工单333，ADR-0018 全有或全无 / ADR-0017 凭证生命周期）：
// 真子进程 fake + 真回环 MCP 宿主全链——监听先于 session/new（t330 实录顺序）、
// 能力缺失/session-new 失败/绑定失败三路回滚（不建行、不剩凭证、宿主回收）、
// 凭证随会话终态/进程退出/宿主消亡即时失效、续接一律聊天型、聊天型零回归。
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionCredentialRegistry } from '../../src/main/conversation/managed-credentials'
import type { ManagedProjectionSource } from '../../src/main/conversation/managed-projection'
import { ManagedMcpHost } from '../../src/main/conversation/managed-host'
import { ConversationService, type ConversationProcess, type ConversationSpawn } from '../../src/main/conversation/service'
import type { ConversationSessionView } from '../../src/shared/contract'

const FAKE_AGENT = path.resolve(__dirname, 'fake-acp-agent.mjs')

function until<T>(pred: () => T | null | undefined, timeoutMs = 8000, stepMs = 40): Promise<T> {
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

/** 管理型投影源 stub（单点分派的替身——快照形状齐八段键） */
function stubSource(install?: ManagedProjectionSource['installSubmit']): ManagedProjectionSource {
  return {
    panelSnapshot: () => ({ clock: {}, sessions: [], hardware: {}, weather: {}, desktop: {}, layout: {}, settings: {}, plugins: [] }),
    pluginsList: () => ({ kernel: [], dropped: [] }),
    pluginSource: () => { throw new Error('插件目录越界: x') },
    contractCatalog: () => ({ audience: 'agent', sections: [], data: {} }),
    installSubmit: install,
  }
}

interface HostRecord {
  listening: () => boolean
  startedCount: () => number
  failStartWith?: Error
}

function makeManagedHarness(scenario: string, opts: { host?: HostRecord } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mgmt-'))
  const dshHome = path.join(tmp, 'dsh-home')
  const workspacesRoot = path.join(tmp, 'workspaces')
  const metadataFile = path.join(tmp, 'metadata.json')
  fs.mkdirSync(dshHome, { recursive: true })
  const registry = new SessionCredentialRegistry()
  const logs: Array<Record<string, unknown>> = []
  const traceBysession = new Map<number, Array<Record<string, unknown>>>()
  let sessionSeq = 0
  const spawnProcess: ConversationSpawn = (plan, cwd, env) => {
    const seq = ++sessionSeq
    const trace: Array<Record<string, unknown>> = []
    traceBysession.set(seq, trace)
    const child: ChildProcess = spawn(process.execPath, [FAKE_AGENT, '--scenario', scenario, '--trace'], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line.trim()) continue
        try { trace.push(JSON.parse(line)) } catch { /* 半行自愈 */ }
      }
    })
    const proc: ConversationProcess = {
      pid: child.pid,
      stdin: child.stdin!,
      stdout: child.stdout!,
      onExit: (cb) => child.once('exit', (code, signal) => cb(code, signal)),
      killTree: () => { try { child.kill() } catch { /* 尽力 */ } },
    }
    return proc
  }
  const hostRecord = opts.host ?? { listening: () => false, startedCount: () => 0 }
  const ctx = new Context()
  const service = new ConversationService(ctx, {
    dshHome,
    workspacesRoot,
    metadataFile,
    deps: {
      resolveBackend: async () => ({ exe: 'C:\\fake\\DeepSeek Harness.exe', cliJs: 'C:\\fake\\cli.js', source: 'test' }),
      spawnProcess,
      createJobObject: () => null,
      env: { DECK_TEST: '1' },
      log: (e) => logs.push(e),
    },
    managed: {
      source: stubSource,
      registry,
      createHost: (deps) => {
        if (hostRecord.failStartWith) {
          return {
            listening: false,
            start: async () => { throw hostRecord.failStartWith },
            stop: async () => { /* 未起即败 */ },
          }
        }
        const host = new ManagedMcpHost(deps)
        const base = host.start.bind(host)
        let started = 0
        let listeningNow = false
        ;(host as unknown as { start: unknown }).start = async (...a: unknown[]) => {
          const r = await (base as (...args: unknown[]) => Promise<{ url: string; port: number }>)(...a)
          started++
          listeningNow = true
          return r
        }
        const origStop = host.stop.bind(host)
        ;(host as unknown as { stop: unknown }).stop = async () => {
          listeningNow = false
          await origStop()
        }
        hostRecord.listening = () => listeningNow
        hostRecord.startedCount = () => started
        return host
      },
    },
  })
  const views = (): ConversationSessionView[] => service.sessions()
  const cleanup = async () => {
    service.dispose()
    try { await ctx.stop() } catch { /* 已停即略 */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄滞后尽力 */ }
  }
  return { tmp, metadataFile, registry, logs, ctx, service, views, cleanup, hostRecord, traceOf: (n: number) => traceBysession.get(n) ?? [] }
}

/** 从 wire trace 提取 session/new 的 mcpServers 注入形状（含 bearer——测试内存观察缝） */
function injectedMcpOf(trace: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const frame = trace.find((f) => (f as { method?: string }).method === 'session/new')
  return ((frame?.params as { mcpServers?: unknown[] })?.mcpServers ?? []) as Array<Record<string, unknown>>
}

function bearerOf(mcp: Array<Record<string, unknown>>): string | null {
  const headers = (mcp[0]?.headers ?? []) as Array<{ name?: string; value?: string }>
  return headers.find((h) => h.name === 'Authorization')?.value ?? null
}

describe('会话服务管理型创建（工单333 全有或全无）', () => {
  let harness: ReturnType<typeof makeManagedHarness> | null = null

  beforeEach(() => { harness = null })
  afterEach(async () => { if (harness) await harness.cleanup() })

  it('快乐路径：先起监听 → 铸凭证 → session/new 带 http mcpServers（bearer 在 headers）→ 行在册 managed=true → prompt 真连宿主读快照', async () => {
    harness = makeManagedHarness('managed')
    const h = harness
    const before = h.views().length
    const res = await h.service.create('managed-accept', { managed: true })
    expect(res.ok).toBe(true)
    const view = res.session!
    expect(view.managed).toBe(true)
    expect(h.views().length).toBe(before + 1)
    // 凭证在册恰一条
    expect(h.registry.size()).toBe(1)
    // wire：mcpServers 注入形状（t330 实录）
    await until(() => h.traceOf(1).some((f) => (f as { method?: string }).method === 'session/new'))
    const mcp = injectedMcpOf(h.traceOf(1))
    expect(mcp).toHaveLength(1)
    expect(mcp[0].type).toBe('http')
    expect(String(mcp[0].url)).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(mcp[0].name).toBe('agent-deck-managed')
    const bearer = bearerOf(mcp)
    expect(bearer).toMatch(/^Bearer [A-Za-z0-9_-]{43,}$/)
    // 通道绑定：宿主侧 bearer 确实登记在本会话名下
    expect(h.registry.authenticate(bearer!)).toBe(view.id)
    // 日志与元数据不落凭证（红线）
    const logText = JSON.stringify(h.logs)
    expect(logText).not.toContain(bearer!.slice('Bearer '.length))
    const metaText = fs.existsSync(h.metadataFile) ? fs.readFileSync(h.metadataFile, 'utf8') : ''
    expect(metaText).not.toContain(bearer!.slice('Bearer '.length))
    expect(metaText).toContain('"managed": true')

    // prompt：fake 真连宿主（initialize → tools/list → tools/call 快照 + 写类名拒绝）
    await until(() => h.views().find((s) => s.id === view.id)?.status === 'ready')
    await h.service.prompt(view.id, 'run managed turn')
    const got = await until(() => {
      const s = h.views().find((x) => x.id === view.id)
      const text = (s?.transcript ?? []).filter((e) => e.kind === 'agent').map((e) => e.text).join('')
      return text.includes('SNAPSHOT-OK:') && text.includes('MCP-UNKNOWN-TOOL-OK:app_quit') ? text : null
    })
    expect(got).toContain('clock') // 快照八段键之一真实回读
    // 工单334：封闭集 4→5（+plugin_install_submit 写工具；只读四工具不回归）
    expect(got).toMatch(/TOOLS=5/)
    // 工具调用存证（无载荷、无凭证）
    const toolLogs = h.logs.filter((e) => e.type === 'managed-tool-call')
    expect(toolLogs.some((e) => e.tool === 'panel_snapshot' && e.ok === true)).toBe(true)
  })

  it('能力缺失（http=false）：创建失败、不建行、凭证回收、宿主回收、错误可辩、显式可重试聊天型', async () => {
    harness = makeManagedHarness('managed-nomcp')
    const h = harness
    const before = h.views().length
    const res = await h.service.create('nomcp', { managed: true })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/HTTP MCP/)
    expect(res.canRetryAsChat).toBe(true)
    expect(h.views().length).toBe(before)
    expect(h.registry.size()).toBe(0)
    expect(h.hostRecord.listening()).toBe(false)
    // 不给聊天型留半创建态：进程也已回收（fake 进程被 killTree）
    await new Promise((r) => setTimeout(r, 100))
  })

  it('session/new 失败（mcp-reject）：创建失败、不建行、凭证回收、宿主回收', async () => {
    harness = makeManagedHarness('mcp-reject')
    const h = harness
    const before = h.views().length
    const res = await h.service.create('reject', { managed: true })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/mcp server rejected/)
    expect(res.canRetryAsChat).toBe(true)
    expect(h.views().length).toBe(before)
    expect(h.registry.size()).toBe(0)
    expect(h.hostRecord.listening()).toBe(false)
  })

  it('监听绑定失败：创建失败、不铸凭证、不 spawn、不建行', async () => {
    const host: HostRecord = { listening: () => false, startedCount: () => 0, failStartWith: new Error('listen EADDRINUSE: 端口被占') }
    harness = makeManagedHarness('managed', { host })
    const h = harness
    const before = h.views().length
    const res = await h.service.create('bindfail', { managed: true })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/绑定失败|EADDRINUSE|端口被占/)
    expect(res.canRetryAsChat).toBe(true)
    expect(h.views().length).toBe(before)
    expect(h.registry.size()).toBe(0)
    expect(h.traceOf(1)).toHaveLength(0) // 没拉起过进程
  })

  it('凭证生命周期·显式结束：end 后 bearer 即时失效 + 宿主随最后管理会话消亡回收', async () => {
    harness = makeManagedHarness('managed')
    const h = harness
    const res = await h.service.create('lifecycle', { managed: true })
    expect(res.ok).toBe(true)
    const view = res.session!
    await until(() => h.traceOf(1).some((f) => (f as { method?: string }).method === 'session/new'))
    const bearer = bearerOf(injectedMcpOf(h.traceOf(1)))!
    expect(h.registry.authenticate(bearer)).toBe(view.id)
    expect(h.hostRecord.listening()).toBe(true)
    await h.service.end(view.id)
    expect(h.registry.authenticate(bearer)).toBeNull()
    await until(() => h.hostRecord.listening() === false)
    expect(h.hostRecord.listening()).toBe(false)
  })

  it('凭证生命周期·进程异常退出：crash 后 bearer 即时失效（不重放、不复活）', async () => {
    harness = makeManagedHarness('crash')
    const h = harness
    const res = await h.service.create('crashy', { managed: true })
    expect(res.ok).toBe(true)
    const view = res.session!
    await until(() => h.traceOf(1).some((f) => (f as { method?: string }).method === 'session/new'))
    const bearer = bearerOf(injectedMcpOf(h.traceOf(1)))!
    await until(() => h.registry.authenticate(bearer) === null, 8000)
    await until(() => h.views().find((s) => s.id === view.id)?.status === 'failed')
    expect(h.registry.authenticate(bearer)).toBeNull()
  })

  it('宿主意外消亡：revokeAll + 在场管理会话降级（managed=false + system 说明 + 仍可聊天）', async () => {
    harness = makeManagedHarness('managed')
    const h = harness
    const res = await h.service.create('degrade', { managed: true })
    expect(res.ok).toBe(true)
    const view = res.session!
    await until(() => h.traceOf(1).some((f) => (f as { method?: string }).method === 'session/new'))
    const bearer = bearerOf(injectedMcpOf(h.traceOf(1)))!
    await until(() => h.views().find((s) => s.id === view.id)?.status === 'ready')
    // 外部直关底层监听（模拟宿主被强杀）
    const host = (h.service as unknown as { host: { underlying: import('node:http').Server | null } }).host
    host.underlying?.close()
    await until(() => h.registry.authenticate(bearer) === null)
    const degraded = await until(() => {
      const s = h.views().find((x) => x.id === view.id)
      return s && s.managed === false && s.transcript.some((e) => e.kind === 'system' && e.text.includes('管理通道已失效')) ? s : null
    })
    expect(degraded).not.toBeNull()
    // 仍可聊天（进程在场）
    expect(degraded!.backendPid).not.toBeNull()
  })

  it('续接一律聊天型：managed 会话 end 后 resume，mcpServers 恒空、managed=false、凭证不复活', async () => {
    harness = makeManagedHarness('managed')
    const h = harness
    const res = await h.service.create('resume-me', { managed: true })
    expect(res.ok).toBe(true)
    const view = res.session!
    await h.service.end(view.id)
    const resumed = await h.service.resume(view.id)
    expect(resumed.ok).toBe(true)
    await until(() => h.traceOf(2).some((f) => (f as { method?: string }).method === 'session/resume'))
    const newMcp = injectedMcpOf(h.traceOf(2))
    expect(newMcp).toHaveLength(0) // 续接 wire 上无任何管理通道
    expect(h.registry.size()).toBe(0)
    expect(h.views().find((s) => s.id === view.id)?.managed).toBe(false)
    const text = (h.views().find((s) => s.id === view.id)?.transcript ?? []).filter((e) => e.kind === 'system').map((e) => e.text).join('')
    expect(text).toMatch(/管理|聊天/)
  })

  it('聊天型零回归：默认 create 不起宿主、不铸凭证、mcpServers 恒空（#332 行为原样）', async () => {
    harness = makeManagedHarness('fullchain')
    const h = harness
    const res = await h.service.create('chat-only')
    expect(res.ok).toBe(true)
    await until(() => h.traceOf(1).some((f) => (f as { method?: string }).method === 'session/new'))
    expect(injectedMcpOf(h.traceOf(1))).toHaveLength(0)
    expect(h.registry.size()).toBe(0)
    expect(h.hostRecord.startedCount()).toBe(0)
    expect(h.views().every((s) => s.managed === false)).toBe(true)
  })

  it('managed-install 全链编排（工单334）：fake 经 MCP 提交工作区包 → 提案 pending → 批准 → activated + staging 清偿 + 审计', { timeout: 20000 }, async () => {
    // 真实 PluginInstallManager（tmp 目录）：source.installSubmit 直连（编排面与生产同构——
    // 生产在 index.ts 把 installSubmit 缝到 PluginHostService.installs）
    const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-inst-user-'))
    const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-inst-stage-'))
    fs.mkdirSync(userRoot, { recursive: true })
    fs.mkdirSync(stagingRoot, { recursive: true })
    const installLogs: Array<Record<string, unknown>> = []
    let rescanCount = 0
    const { PluginInstallManager } = await import('../../src/main/plugins/install')
    let service2: ConversationService
    const mgr = new PluginInstallManager({
      userRoot,
      stagingRoot,
      kernelRoots: [],
      sessionInfo: (sessionId) => {
        const v = service2.sessions().find((s) => s.id === sessionId)
        return v ? { cwd: v.cwd, label: v.label } : null
      },
      log: (e) => installLogs.push(e),
      notify: () => { /* 提案经 list() 读 */ },
      now: () => Date.now(),
      opId: (() => { let n = 0; return () => `op-${++n}` })(),
      host: {
        rescan: () => { rescanCount++ },
        waitMount: async () => ({ ok: true, message: null, unknown: false }),
      },
      mountBoundMs: 2000,
    })
    try {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-mgmt-install-'))
      const dshHome2 = path.join(tmp2, 'dsh-home')
      const workspacesRoot2 = path.join(tmp2, 'workspaces')
      fs.mkdirSync(dshHome2, { recursive: true })
      fs.mkdirSync(workspacesRoot2, { recursive: true })
      const registry2 = new SessionCredentialRegistry()
      const ctx2 = new Context()
      const installSvcLogs: Array<Record<string, unknown>> = []
      const spawnFake: ConversationSpawn = (plan, cwd, env) => {
        const child: ChildProcess = spawn(process.execPath, [FAKE_AGENT, '--scenario', 'managed-install', '--trace'], {
          cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
        })
        return {
          pid: child.pid,
          stdin: child.stdin!,
          stdout: child.stdout!,
          onExit: (cb) => child.once('exit', (code, signal) => cb(code, signal)),
          killTree: () => { try { child.kill() } catch { /* 尽力 */ } },
        }
      }
      service2 = new ConversationService(ctx2, {
        dshHome: dshHome2,
        workspacesRoot: workspacesRoot2,
        metadataFile: path.join(tmp2, 'metadata.json'),
        deps: {
          resolveBackend: async () => ({ exe: 'C:\\fake\\DeepSeek Harness.exe', cliJs: 'C:\\fake\\cli.js', source: 'test' }),
          spawnProcess: spawnFake,
          createJobObject: () => null,
          env: { DECK_TEST: '1' },
          log: (e) => installSvcLogs.push(e),
        },
        managed: {
          source: () => stubSource((args, mctx) => mgr.submit(args, { sessionId: mctx.sessionId, backend: 'dsh' })),
          registry: registry2,
        },
      })
      try {
        const res = await service2.create('install-e2e', { managed: true })
        expect(res.ok, `管理型创建应成功：${res.error ?? ''}`).toBe(true)
        // fake 在 cwd 写包并经 MCP 提交 → 提案 pending（会话工作区包含校验走真实会话 cwd）
        const proposal = await until(() => mgr.list().find((p) => p.status === 'pending') ?? null, 10000)
        expect(proposal).toBeTruthy()
        expect(proposal!.pkg.id).toBe('dsh-hello')
        expect(proposal!.source.backend).toBe('dsh')
        // 待装载区纪律：staging 有副本、用户根无目录
        expect(fs.existsSync(path.join(stagingRoot, proposal!.proposalId, 'plugin.json'))).toBe(true)
        expect(fs.existsSync(path.join(userRoot, 'dsh-hello'))).toBe(false)
        // 真实用户手势（批准）→ 转正 → rescan → activated
        const decided = await mgr.approve(proposal!.proposalId)
        expect(decided).toMatchObject({ ok: true, status: 'activated' })
        expect(fs.existsSync(path.join(userRoot, 'dsh-hello', 'plugin.json'))).toBe(true)
        expect(fs.existsSync(path.join(stagingRoot, proposal!.proposalId))).toBe(false)
        expect(rescanCount).toBeGreaterThanOrEqual(1)
        // 审计：意图/结局分离且 opId 相关
        const intent = installLogs.find((e) => e.type === 'plugin-install-intent')
        const outcome = installLogs.find((e) => e.type === 'plugin-install-outcome')
        expect(intent).toMatchObject({ pkgId: 'dsh-hello' })
        expect(outcome).toMatchObject({ outcome: 'activated', opId: (intent as Record<string, unknown>)['opId'] })
      } finally {
        service2.dispose()
        await ctx2.stop().catch(() => {})
        try { fs.rmSync(tmp2, { recursive: true, force: true }) } catch { /* Windows 句柄滞后尽力（fake cwd 锁） */ }
      }
    } finally {
      mgr.dispose()
      for (const d of [userRoot, stagingRoot]) fs.rmSync(d, { recursive: true, force: true })
    }
  })
})
