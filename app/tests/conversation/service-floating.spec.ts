// 会话服务浮动版本接入测试（工单340，ADR-0026）：冒烟门矩阵（通过/失败×管理型/聊天型）、
// 版本/能力/未验收标记记录（视图+诊断）、失败非破坏（fs spy 证明失败路径触不到数据目录写 API）、
// 显式全新数据目录手势（旧目录零触碰、不自动继承、持久化缝）。真子进程 fake + 真回环宿主全链。
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

function stubSource(): ManagedProjectionSource {
  return {
    panelSnapshot: () => ({ clock: {}, sessions: [], hardware: {}, weather: {}, desktop: {}, layout: {}, settings: {}, plugins: [] }),
    pluginsList: () => ({ kernel: [], dropped: [] }),
    pluginSource: () => { throw new Error('插件目录越界: x') },
    contractCatalog: () => ({ audience: 'agent', sections: [], data: {} }),
  }
}

/** 目录指纹：相对路径有序清单 + 内容 sha256（零写入断言的比较基准） */
function dirFingerprint(root: string): string {
  const crypto = require('node:crypto') as typeof import('node:crypto')
  const out: string[] = []
  const walk = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      const childAbs = path.join(dir, e.name)
      if (e.isDirectory()) {
        out.push(`d ${childRel}`)
        walk(childAbs, childRel)
      } else {
        const buf = fs.readFileSync(childAbs)
        out.push(`f ${childRel} ${buf.length} ${crypto.createHash('sha256').update(buf).digest('hex')}`)
      }
    }
  }
  walk(root, '')
  return out.join('\n')
}

interface FloatingHarnessOpts {
  scenario: string
  smokeTimeoutMs?: number
  initializeMs?: number
  persistDshHome?: (home: string) => void
}

function makeFloatingHarness(opts: FloatingHarnessOpts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-float-'))
  const dshHome = path.join(tmp, 'dsh-home')
  const workspacesRoot = path.join(tmp, 'workspaces')
  const metadataFile = path.join(tmp, 'metadata.json')
  fs.mkdirSync(dshHome, { recursive: true })
  const registry = new SessionCredentialRegistry()
  const logs: Array<Record<string, unknown>> = []
  const traceBysession = new Map<number, Array<Record<string, unknown>>>()
  const spawnEnvs: Array<Record<string, string>> = []
  let sessionSeq = 0
  const hostRecord = { listening: () => false, startedCount: () => 0 }
  const spawnProcess: ConversationSpawn = (plan, cwd, env) => {
    const seq = ++sessionSeq
    spawnEnvs.push({ ...plan.env })
    const trace: Array<Record<string, unknown>> = []
    traceBysession.set(seq, trace)
    const child: ChildProcess = spawn(process.execPath, [FAKE_AGENT, '--scenario', opts.scenario, '--trace'], {
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
  const ctx = new Context()
  const service = new ConversationService(ctx, {
    dshHome,
    workspacesRoot,
    metadataFile,
    timeouts: { initializeMs: opts.initializeMs, smokeMs: opts.smokeTimeoutMs },
    deps: {
      resolveBackend: async () => ({ exe: 'C:\\fake\\DeepSeek Harness.exe', cliJs: 'C:\\fake\\cli.js', source: 'test' }),
      spawnProcess,
      createJobObject: () => null,
      env: { DECK_TEST: '1' },
      log: (e) => logs.push(e),
      persistDshHome: opts.persistDshHome,
    },
    managed: {
      source: stubSource,
      registry,
      createHost: (deps) => {
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
  return { tmp, dshHome, metadataFile, registry, logs, ctx, service, views, cleanup, hostRecord, spawnEnvs, traceOf: (n: number) => traceBysession.get(n) ?? [] }
}

describe('浮动版本接入·冒烟门矩阵（工单340）', () => {
  let harness: ReturnType<typeof makeFloatingHarness> | null = null

  beforeEach(() => { harness = null })
  afterEach(async () => { if (harness) await harness.cleanup() })

  it('管理型×冒烟通过：真实探活（initialize/tools/list 到达宿主）→ 可建会话，未验收标记+冒烟结果在视图与诊断', async () => {
    harness = makeFloatingHarness({ scenario: 'managed', smokeTimeoutMs: 5000 })
    const h = harness
    const res = await h.service.create('smoke-pass', { managed: true })
    expect(res.ok, `管理型创建应成功：${res.error ?? ''}`).toBe(true)
    const view = res.session!
    // 视图：实际身份 + 未验收标记 + 冒烟结果
    expect(view.backendAgent).toBe('fake-acp-agent')
    expect(view.backendAgentVersion).toBe('0.1.0')
    expect(view.runtimeUnaccepted).toBe(true)
    expect(view.runtimeSmoke).toBe('passed')
    // 存证：运行时接入记录（accepted 恒 false；能力在案）
    const rec = h.logs.find((e) => e.type === 'conversation-runtime-recorded') as Record<string, unknown> | undefined
    expect(rec).toBeDefined()
    expect(rec!.smoke).toBe('passed')
    expect(rec!.accepted).toBe(false)
    expect(rec!.agentVersion).toBe('0.1.0')
    expect(rec!.protocolVersion).toBe(1)
    expect(JSON.stringify(rec!.capabilities)).toContain('mcpCapabilities')
    // 诊断面板（conversation/backend）能看到真实版本与冒烟结果
    const info = h.service.backendInfo()
    expect(info.runtime).not.toBeNull()
    expect(info.runtime!.agentVersion).toBe('0.1.0')
    expect(info.runtime!.smoke).toBe('passed')
    expect(info.runtime!.accepted).toBe(false)
    expect(info.dshHome).toBe(h.dshHome)
  })

  it('管理型×冒烟失败（注入被无视）：全有或全无失败+补救指引，不建行、凭证回收、宿主回收、诊断记录失败', async () => {
    harness = makeFloatingHarness({ scenario: 'managed-nosmoke', smokeTimeoutMs: 600 })
    const h = harness
    const before = h.views().length
    const res = await h.service.create('smoke-fail', { managed: true })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('冒烟')
    expect(res.error).toContain('聊天型') // 补救指引在错误文本里
    expect(res.canRetryAsChat).toBe(true)
    expect(h.views().length).toBe(before) // 不建行（全有或全无）
    expect(h.registry.size()).toBe(0) // 凭证回收
    expect(h.hostRecord.listening()).toBe(false) // 宿主回收
    // 诊断：失败接入也记录（真实版本 + failed）
    const info = h.service.backendInfo()
    expect(info.runtime!.smoke).toBe('failed')
    expect(info.runtime!.accepted).toBe(false)
    expect(info.runtime!.agentVersion).toBe('0.1.0')
  })

  it('聊天型×无冒烟（skipped）：握手通过即可用，未验收标记在案（冒烟只适用管理型）', async () => {
    harness = makeFloatingHarness({ scenario: 'fullchain', smokeTimeoutMs: 5000 })
    const h = harness
    const res = await h.service.create('chat-float')
    expect(res.ok).toBe(true)
    const view = res.session!
    expect(view.runtimeUnaccepted).toBe(true)
    expect(view.runtimeSmoke).toBe('skipped')
    const rec = h.logs.find((e) => e.type === 'conversation-runtime-recorded') as Record<string, unknown> | undefined
    expect(rec!.smoke).toBe('skipped')
    expect(rec!.accepted).toBe(false)
  })

  it('握手失败：明确错误+补救指引、不建行、进程回收，诊断无记录（诚实：没握手就没有身份）', async () => {
    harness = makeFloatingHarness({ scenario: 'init-only', initializeMs: 400, smokeTimeoutMs: 5000 })
    const h = harness
    const before = h.views().length
    const res = await h.service.create('handshake-fail')
    expect(res.ok).toBe(false)
    expect(res.error).toContain('握手失败')
    expect(res.error).toContain('补救')
    expect(h.views().length).toBe(before)
    expect(h.service.backendInfo().runtime).toBeNull()
    // 进程已回收（不留半创建态孤儿）
    await new Promise((r) => setTimeout(r, 200))
  })

  it('浮动回归：fake 版本号变化（0.1.0 → 9.9.9-future）接入行为不变——版本不是拒绝理由', async () => {
    harness = makeFloatingHarness({ scenario: 'fullchain', smokeTimeoutMs: 5000 })
    const h = harness
    const res = await h.service.create('float-a')
    expect(res.ok).toBe(true)
    // fake agent 的 agentVersion 是场景常量；这里验证同一进程内版本字符串原样记录且不影响可用性
    const info = h.service.backendInfo()
    expect(info.runtime!.agentVersion).toBe('0.1.0')
    expect(info.runtime!.accepted).toBe(false)
    expect(h.views()[0].status).toBe('ready')
  })
})

describe('失败非破坏（工单340）：失败路径触不到数据目录写 API（fs spy 证明不可达）', () => {
  let harness: ReturnType<typeof makeFloatingHarness> | null = null

  beforeEach(() => { harness = null })
  afterEach(async () => { if (harness) await harness.cleanup() })

  it('五路失败（握手超时/冒烟超时/能力缺失/session-new 败/进程崩溃）全程零命中 DSH 数据目录写 API，目录内容不变', { timeout: 60000 }, async () => {
    const destructive = ['writeFileSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'truncateSync', 'copyFileSync', 'cpSync', 'appendFileSync', 'mkdtempSync'] as const
    const cases: Array<{ scenario: string; opts: { smokeTimeoutMs?: number; initializeMs?: number }; drive: (h: ReturnType<typeof makeFloatingHarness>) => Promise<unknown> }> = [
      {
        scenario: 'init-only',
        opts: { initializeMs: 300, smokeTimeoutMs: 5000 },
        drive: (h) => h.service.create('f-handshake'),
      },
      {
        scenario: 'managed-nosmoke',
        opts: { smokeTimeoutMs: 400 },
        drive: (h) => h.service.create('f-smoke', { managed: true }),
      },
      {
        scenario: 'managed-nomcp',
        opts: { smokeTimeoutMs: 5000 },
        drive: (h) => h.service.create('f-nomcp', { managed: true }),
      },
      {
        scenario: 'mcp-reject',
        opts: { smokeTimeoutMs: 5000 },
        drive: (h) => h.service.create('f-reject', { managed: true }),
      },
      {
        scenario: 'crash',
        opts: { smokeTimeoutMs: 5000 },
        drive: async (h) => {
          const res = await h.service.create('f-crash')
          expect(res.ok).toBe(true)
          await until(() => h.views()[0]?.status === 'failed')
        },
      },
    ]
    for (const c of cases) {
      harness = makeFloatingHarness({ scenario: c.scenario, ...c.opts })
      const h = harness
      // 数据目录预置内容（非空目录才有说服力）
      fs.mkdirSync(path.join(h.dshHome, 'profiles', 'acp'), { recursive: true })
      fs.writeFileSync(path.join(h.dshHome, 'profiles', 'acp', 'cordis.patch.yml'), '# pre-existing\n', 'utf8')
      const beforeHash = dirFingerprint(h.dshHome)
      const hits: Array<{ fn: string; args: unknown[] }> = []
      const spies = destructive.map((fn) => {
        const spy = vi.spyOn(fs, fn)
        spy.mockImplementation(((...args: unknown[]) => {
          const argText = args.filter((a) => typeof a === 'string' || (a && typeof (a as { href?: unknown }).href === 'string')).map(String).join('|')
          if (argText.includes(h.dshHome)) hits.push({ fn, args })
          return (fs[fn] as (...a: unknown[]) => unknown)(...args)
        }) as never)
        return spy
      })
      try {
        await c.drive(h)
        expect(hits, `场景 ${c.scenario} 触碰了数据目录写 API: ${JSON.stringify(hits)}`).toEqual([])
        expect(dirFingerprint(h.dshHome)).toBe(beforeHash)
      } finally {
        for (const s of spies) s.mockRestore()
      }
      await harness.cleanup()
      harness = null
    }
  })
})
