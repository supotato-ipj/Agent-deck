// 网络 Broker（工单338）：逐包 origin 授权、有界请求-响应、重定向不跟随、限流/并发/超时、
// 头白名单、审计脱敏。传输用本地 http server 真测（127.0.0.1 随机端口，无公网依赖）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { NetworkBroker, createNodeTransport, type NetworkBrokerOptions, type NetworkTransportPort } from '../../src/main/network/broker'
import { NetworkAuditService } from '../../src/main/network/audit'
import { Context } from 'cordis'
import { CredentialService } from '../../src/main/credentials/service'
import type { CredentialCipherPort } from '../../src/main/credentials/store'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface ServerHandle { origin: string; close(): Promise<void> }

/** 起一台本地 HTTP 服务（路由按 path 分派） */
function serve(routes: Record<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = (req.url ?? '/').split('?')[0]
      const handler = routes[pathname]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      handler(req, res)
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

let main: ServerHandle
let other: ServerHandle
let auditDir: string
let auditFile: string
/** 工单347：自环路由命中数（跟随跳数的观测口）；other origin 命中数（凭证零外泄观测口） */
let loopHits = 0
let otherHits = 0

beforeAll(async () => {
  auditDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-net-broker-'))
  auditFile = path.join(auditDir, 'network-audit.jsonl')
  main = await serve({
    '/data.json': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ hello: 'deck', from: 'fixture' }))
    },
    '/binary': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from([0, 1, 2, 3, 255]))
    },
    '/big': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('x'.repeat(4096))
    },
    '/redirect': (_req, res) => {
      res.writeHead(302, { location: `${other.origin}/secret` })
      res.end()
    },
    // —— 工单347：同 origin 有界跟随夹具路由 ——
    '/hop-301': (_req, res) => {
      res.writeHead(301, { location: '/data.json' }) // 相对 location：按当前跳 URL 解析
      res.end()
    },
    '/hop-302': (_req, res) => {
      res.writeHead(302, { location: `${main.origin}/data.json` }) // 绝对 location
      res.end()
    },
    '/hop-twice': (_req, res) => {
      res.writeHead(302, { location: '/hop-301' }) // 链式：/hop-twice → /hop-301 → /data.json
      res.end()
    },
    '/loop': (_req, res) => {
      loopHits += 1
      res.writeHead(302, { location: '/loop' }) // 同源自环：跳满上限的观测口
      res.end()
    },
    '/hop-echo': (_req, res) => {
      res.writeHead(302, { location: '/echo-headers' }) // 同源跳到终点后回显请求头
      res.end()
    },
    '/echo-headers': (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ headers: req.headers }))
    },
    '/slow': (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('late')
      }, 400)
    },
  })
  other = await serve({
    '/secret': (_req, res) => {
      otherHits += 1 // 工单347：跨 origin 零命中的证明口
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('secret')
    },
  })
})

afterAll(async () => {
  await main.close()
  await other.close()
  fs.rmSync(auditDir, { recursive: true, force: true })
})

function boot(opts: {
  origins?: string[] | null
  permissions?: string[]
  limits?: NetworkBrokerOptions['limits']
  /** 工单345：每包限额覆写切片（构造期 min(默认,覆写) 生效） */
  packageLimits?: NetworkBrokerOptions['packageLimits']
  transport?: NetworkTransportPort
  audit?: boolean
} = {}) {
  const audit = opts.audit === false
    ? null
    : new NetworkAuditService({ file: auditFile, now: () => Date.now(), log: () => {} })
  const broker = new NetworkBroker({
    authorization: opts.origins === null
      ? null
      : { activeGrant: () => ({ permissions: opts.permissions ?? ['network.request'], networkOrigins: opts.origins ?? [main.origin] }) },
    audit,
    log: () => {},
    ...(opts.limits ? { limits: opts.limits } : {}),
    ...(opts.packageLimits ? { packageLimits: opts.packageLimits } : {}),
    ...(opts.transport ? { transport: opts.transport } : {}),
  })
  return { broker, audit }
}

describe('授权门（工单338）：未授权 origin 默认拒绝', () => {
  it('命中声明 origin → 请求-响应真实回传（文本 JSON）', async () => {
    const { broker } = boot()
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json?x=1` })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out).toMatchObject({ status: 200, origin: main.origin, method: 'GET', truncated: false })
    expect(JSON.parse(String(out.text))).toEqual({ hello: 'deck', from: 'fixture' })
    expect(out.base64).toBeUndefined()
  })

  it('未声明 origin → network_permission_denied（一个字节不出）', async () => {
    const { broker } = boot({ origins: [other.origin] })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(out).toMatchObject({ ok: false, code: 'network_permission_denied', origin: main.origin })
  })

  it('账面缺 network.request（只授 origin）→ 同样拒绝', async () => {
    const { broker } = boot({ origins: [main.origin], permissions: ['media.read'] })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(out).toMatchObject({ ok: false, code: 'network_permission_denied' })
  })

  it('无授权面 → 全拒', async () => {
    const { broker } = boot({ origins: null })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(out).toMatchObject({ ok: false, code: 'network_permission_denied' })
  })
})

describe('有界请求-响应（工单338）', () => {
  it('文本类型 → text；二进制类型 → base64（不猜内容）', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const text = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(text.ok && typeof text.text === 'string').toBe(true)
    const bin = await broker.requestForPackage('pkg-net', { url: `${main.origin}/binary` })
    expect(bin.ok).toBe(true)
    if (!bin.ok) return
    expect(bin.base64).toBe(Buffer.from([0, 1, 2, 3, 255]).toString('base64'))
  })

  it('超过 maxResponseBytes → 按键截断并如实标记 truncated', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100, maxResponseBytes: 1000 } })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/big` })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.truncated).toBe(true)
    expect(out.bytes).toBe(1000)
    expect(String(out.text)).toHaveLength(1000)
  })

  it('超时 → network_timeout（与权限拒绝/限流分域）', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100, timeoutMs: 80 } })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/slow` })
    expect(out).toMatchObject({ ok: false, code: 'network_timeout' })
  })
})

describe('重定向不自动跟随（工单338）', () => {
  it('跨 origin 302 → network_redirect_blocked + 目标在案（不跟随、不泄目标内容）', async () => {
    const { broker, audit } = boot()
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/redirect` })
    expect(out).toMatchObject({ ok: false, code: 'network_redirect_blocked', status: 302 })
    if (out.ok) return
    expect(String(out.location)).toContain('/secret')
    // 审计只记目标 origin（不记完整 URL、不含正文）
    const buckets = audit!.aggregate()
    expect(buckets.some((b) => b.counts.redirect >= 1)).toBe(true)
    const raw = fs.readFileSync(auditFile, 'utf8')
    expect(raw).toContain(other.origin)
    expect(raw).not.toContain('/secret')
  })
})

// ---------------------------------------------------------------------------
// 同 origin 重定向有界跟随（工单347）：GET/HEAD 的同 origin（URL.origin 精确相等）3xx
// 由 Broker 有界代为跟随——最多 maxRedirects 跳（缺省 3，可按包收紧不可放宽），每跳重过
// 授权门、计一个速率额度、一条审计、独立 timeoutMs，凭证按同包同 origin 重新注入；
// 成功结果只多 redirects 计数（0 基）。跨 origin 与非 GET/HEAD 的 3xx 维持
// network_redirect_blocked；跳满上限仍在 3xx → network_redirect_limit（带最后已知 location）。
// ---------------------------------------------------------------------------
describe('同 origin 重定向有界跟随（工单347）', () => {
  it('同源 301（相对 location）→ 跟随到 /data.json：ok、200、正文正确、redirects=1', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/hop-301` })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out).toMatchObject({ status: 200, origin: main.origin, method: 'GET', truncated: false, redirects: 1 })
    expect(JSON.parse(String(out.text))).toEqual({ hello: 'deck', from: 'fixture' })
  })

  it('同源 302（绝对 location）→ 同样跟随：redirects=1', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/hop-302` })
    expect(out).toMatchObject({ ok: true, status: 200, origin: main.origin, redirects: 1 })
  })

  it('同源链式两跳 → redirects=2；直连无跳 → redirects=0', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const chained = await broker.requestForPackage('pkg-net', { url: `${main.origin}/hop-twice` })
    expect(chained).toMatchObject({ ok: true, status: 200, origin: main.origin, redirects: 2 })
    const direct = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(direct).toMatchObject({ ok: true, redirects: 0 })
  })

  it('同源自环 → 跳满缺省 3 跳 → network_redirect_limit + 最后已知 location（命中 4 次后停）', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const before = loopHits
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/loop` })
    expect(out).toMatchObject({ ok: false, code: 'network_redirect_limit', status: 302, origin: main.origin, method: 'GET' })
    if (out.ok) return
    expect(String(out.location)).toBe('/loop')
    expect(loopHits - before).toBe(4) // 首跳 + 3 次跟随，第 4 个 3xx 即停
  })

  it('覆写 maxRedirects:1（收紧）→ 一跳即 limit；覆写 99（放宽）被 min 钳回缺省 3', async () => {
    const tight = boot({ limits: { requestsPerSecond: 100 }, packageLimits: { 'pkg-tight': { maxRedirects: 1 } } })
    const beforeTight = loopHits
    const outTight = await tight.broker.requestForPackage('pkg-tight', { url: `${main.origin}/loop` })
    expect(outTight).toMatchObject({ ok: false, code: 'network_redirect_limit' })
    expect(loopHits - beforeTight).toBe(2) // 允许跳 1 次，第 2 个 3xx 即 limit
    const wide = boot({ limits: { requestsPerSecond: 100 }, packageLimits: { 'pkg-wide': { maxRedirects: 99 } } })
    const beforeWide = loopHits
    const outWide = await wide.broker.requestForPackage('pkg-wide', { url: `${main.origin}/loop` })
    expect(outWide).toMatchObject({ ok: false, code: 'network_redirect_limit' })
    expect(loopHits - beforeWide).toBe(4) // 放宽不可能生效：仍按缺省 3 跳
  })

  it('POST 遇同源 302 → 仍 network_redirect_blocked（仅 GET/HEAD 自动跟随，带 location）', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/hop-302`, method: 'POST', body: 'x' })
    expect(out).toMatchObject({ ok: false, code: 'network_redirect_blocked', status: 302, origin: main.origin, method: 'POST' })
    if (out.ok) return
    expect(String(out.location)).toContain('/data.json')
  })

  it('带凭证同源跟随：终点请求头含注入凭证、凭证逐跳按本 origin 重新解析、other origin 零命中', async () => {
    const seen: string[] = []
    const broker = new NetworkBroker({
      authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [main.origin] }) },
      credentials: {
        // 工单348：端口转异步双口——夹具只把返回包进 Promise + 补 refresh 空桩（断言零改动）
        resolve: async (pkg, name, origin) => {
          seen.push(`${pkg}|${name}|${origin}`)
          return { ok: true as const, headerName: 'authorization', value: 'Bearer hop-secret', refreshable: false }
        },
        refresh: async () => ({ ok: false as const, code: 'credential_unavailable' as const, message: '静态夹具无刷新面' }),
      },
      audit: null,
      log: () => {},
      limits: { requestsPerSecond: 100 },
    })
    const before = otherHits
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/hop-echo`, credential: 'hop-cred' })
    expect(out).toMatchObject({ ok: true, status: 200, origin: main.origin, redirects: 1 })
    if (!out.ok) return
    const headers = JSON.parse(String(out.text)).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer hop-secret')
    // 每跳按「同包 + 本 origin」重新 resolve：首跳 + 跟随跳各一次，origin 全部是授权 origin
    expect(seen).toEqual([`pkg-net|hop-cred|${main.origin}`, `pkg-net|hop-cred|${main.origin}`])
    expect(otherHits - before).toBe(0) // other origin 零命中：凭证零外泄是被证明的
  })

  it('授权中途撤销 → 第二跳 network_permission_denied（跟随链断供，终点零命中）', async () => {
    let dataHits = 0
    const target = await serve({
      '/go': (_req, res) => { res.writeHead(302, { location: '/data.json' }); res.end() },
      '/data.json': (_req, res) => { dataHits += 1; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hit') },
    })
    try {
      let gateCalls = 0
      const broker = new NetworkBroker({
        authorization: {
          activeGrant: () => {
            gateCalls += 1
            return gateCalls === 1
              ? { permissions: ['network.request'], networkOrigins: [target.origin] }
              : { permissions: ['media.read'], networkOrigins: [target.origin] }
          },
        },
        audit: null,
        log: () => {},
        limits: { requestsPerSecond: 100 },
      })
      const out = await broker.requestForPackage('pkg-net', { url: `${target.origin}/go` })
      expect(out).toMatchObject({ ok: false, code: 'network_permission_denied', origin: target.origin })
      expect(dataHits).toBe(0) // 第二跳根本没发（零窗口断链）
    } finally {
      await target.close()
    }
  })

  it('审计：同源两跳 → 3 条账（2 跳 + 1 终点），中间跳带 redirectTo，账面不含路径', async () => {
    const file = path.join(auditDir, 'audit-hop-chain.jsonl')
    const audit = new NetworkAuditService({ file, now: () => Date.now(), log: () => {} })
    const broker = new NetworkBroker({
      authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [main.origin] }) },
      audit,
      log: () => {},
      limits: { requestsPerSecond: 100 },
    })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/hop-twice` })
    expect(out).toMatchObject({ ok: true, redirects: 2 })
    const raw = fs.readFileSync(file, 'utf8').trim()
    const lines = raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines).toHaveLength(3)
    for (const rec of lines) {
      expect(rec.origin).toBe(main.origin)
      expect(rec.outcome).toBe('ok')
    }
    expect(lines[0]).toMatchObject({ status: 302, redirectTo: main.origin }) // /hop-twice → /hop-301
    expect(lines[1]).toMatchObject({ status: 301, redirectTo: main.origin }) // /hop-301 → /data.json
    expect(lines[2]).toMatchObject({ status: 200 })
    expect(raw).not.toContain('/hop-twice')
    expect(raw).not.toContain('/data.json')
    const buckets = audit.aggregate()
    expect(buckets[0].counts.request).toBe(3)
  })
})

describe('限额（工单338）：限流/并发与权限拒绝是不同错误', () => {
  it('速率窗：1/s 上限下同秒第二发 → network_rate_limited', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 1 } })
    const first = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(first.ok).toBe(true)
    const second = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json` })
    expect(second).toMatchObject({ ok: false, code: 'network_rate_limited' })
  })

  it('并发上限：maxConcurrent=1 时在途再发 → network_rate_limited', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100, maxConcurrent: 1 } })
    const [a, b] = await Promise.all([
      broker.requestForPackage('pkg-net', { url: `${main.origin}/slow` }),
      broker.requestForPackage('pkg-net', { url: `${main.origin}/slow` }),
    ])
    const codes = [a.ok, b.ok].filter(Boolean).length
    expect(codes).toBe(1)
    const denied = [a, b].find((r) => !r.ok)
    expect(denied).toMatchObject({ code: 'network_rate_limited' })
  })

  it('不支持的方法 → network_failed（方法白名单）', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json`, method: 'TRACE' })
    expect(out).toMatchObject({ ok: false, code: 'network_failed' })
  })
})

describe('每包限额覆写（工单345：构造期生效，可收紧不可放宽）', () => {
  /** 记录 transport 实际收到的限额（超时/字节上限的观测口） */
  function spyingTransport(seen: Array<{ timeoutMs: number; maxBytes: number }>): NetworkTransportPort {
    return {
      send: async (spec) => {
        seen.push({ timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes })
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok'), truncated: false }
      },
    }
  }

  it('收紧速率：覆写 1/s 的包同秒第二发被拒；未覆写包不受影响', async () => {
    const { broker } = boot({ packageLimits: { 'pkg-tight': { requestsPerSecond: 1 } } })
    const first = await broker.requestForPackage('pkg-tight', { url: `${main.origin}/data.json` })
    expect(first.ok).toBe(true)
    const second = await broker.requestForPackage('pkg-tight', { url: `${main.origin}/data.json` })
    expect(second).toMatchObject({ ok: false, code: 'network_rate_limited' })
    // 另一个包走目录默认（5/s）：覆写只作用于声明的包
    const loose = await broker.requestForPackage('pkg-loose', { url: `${main.origin}/data.json` })
    expect(loose.ok).toBe(true)
  })

  it('收紧并发：maxConcurrent=1 时在途再发 → network_rate_limited（该包独享生效值）', async () => {
    let release: (() => void) | null = null
    const hang: NetworkTransportPort = {
      send: () => new Promise((resolve) => { release = () => resolve({ status: 200, headers: {}, body: Buffer.from('ok'), truncated: false }) }),
    }
    const { broker } = boot({ transport: hang, packageLimits: { 'pkg-t': { maxConcurrent: 1 } } })
    const inflight = broker.requestForPackage('pkg-t', { url: `${main.origin}/data.json` })
    const second = await broker.requestForPackage('pkg-t', { url: `${main.origin}/data.json` })
    expect(second).toMatchObject({ ok: false, code: 'network_rate_limited' })
    release!()
    await inflight
  })

  it('收紧超时与响应体上限：transport 收到生效值；未覆写包仍走目录默认', async () => {
    const seen: Array<{ timeoutMs: number; maxBytes: number }> = []
    const { broker } = boot({
      transport: spyingTransport(seen),
      packageLimits: { 'pkg-t': { timeoutMs: 1234, maxResponseBytes: 4096 } },
    })
    await broker.requestForPackage('pkg-t', { url: `${main.origin}/data.json` })
    await broker.requestForPackage('pkg-other', { url: `${main.origin}/data.json` })
    expect(seen[0]).toEqual({ timeoutMs: 1234, maxBytes: 4096 })
    expect(seen[1]).toEqual({ timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 })
  })

  it('放宽不可能生效：程序化传入超默认覆写被 min 钳回默认（越权配置拿不到更宽限额）', async () => {
    const seen: Array<{ timeoutMs: number; maxBytes: number }> = []
    const { broker } = boot({
      transport: spyingTransport(seen),
      packageLimits: { 'pkg-t': { timeoutMs: 999_999, maxResponseBytes: 99 * 1024 * 1024 } },
    })
    await broker.requestForPackage('pkg-t', { url: `${main.origin}/data.json` })
    expect(seen[0]).toEqual({ timeoutMs: 10_000, maxBytes: 2 * 1024 * 1024 })
  })
})

describe('头白名单与审计脱敏（工单338）', () => {
  it('包自带 authorization/cookie 头被丢弃（凭证注入归 #339）', async () => {
    const { broker } = boot({ limits: { requestsPerSecond: 100 } })
    const out = await broker.requestForPackage('pkg-net', {
      url: `${main.origin}/echo-headers`,
      headers: { authorization: 'Bearer leaked', cookie: 'sid=1', accept: 'application/json' },
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const seen = JSON.parse(String(out.text)).headers as Record<string, string>
    expect(seen.authorization).toBeUndefined()
    expect(seen.cookie).toBeUndefined()
    expect(seen.accept).toBe('application/json')
  })

  it('审计记录只有 origin/方法/结果（无 query、无正文、无头）', async () => {
    const file = path.join(auditDir, 'audit-nopayload.jsonl')
    const audit = new NetworkAuditService({ file, now: () => Date.now(), log: () => {} })
    const broker = new NetworkBroker({
      authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [main.origin] }) },
      audit,
      log: () => {},
      limits: { requestsPerSecond: 100 },
    })
    await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json?token=SECRET`, method: 'POST', body: 'BODY-SECRET' })
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain(main.origin)
    expect(raw).toContain('POST')
    expect(raw).not.toContain('SECRET')
    expect(raw).not.toContain('BODY')
  })
})

// ---------------------------------------------------------------------------
// 命名凭证注入（工单339）：只在「本包 + 本 origin」绑定匹配时注入；未绑定/不存在/凭证面
// 缺席一律 credential_unavailable（与网络权限无关，不撤销权限、不静默换凭证）；注入头
// 在包自带头被白名单丢弃之后才写（包不能覆盖）。跨 origin 重定向不跟随 → 目标拿不到凭证。
// ---------------------------------------------------------------------------
describe('命名凭证注入（工单339）', () => {
  it('已绑定凭证 → 注入头（值来自凭证解析口），包自带的 authorization 被丢弃后由注入面覆盖', async () => {
    const seen: string[] = []
    const broker = new NetworkBroker({
      authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [main.origin] }) },
      credentials: {
        // 工单348：端口转异步双口——夹具只把返回包进 Promise + 补 refresh 空桩（断言零改动）
        resolve: async (pkg, name, origin) => {
          seen.push(`${pkg}|${name}|${origin}`)
          return { ok: true as const, headerName: 'authorization', value: 'Bearer s3cr3t-v1', refreshable: false }
        },
        refresh: async () => ({ ok: false as const, code: 'credential_unavailable' as const, message: '静态夹具无刷新面' }),
      },
      audit: null,
      log: () => {},
      limits: { requestsPerSecond: 100 },
    })
    const out = await broker.requestForPackage('pkg-net', {
      url: `${main.origin}/echo-headers`,
      credential: 'accept-cred',
      headers: { authorization: 'Bearer forged' },
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const headers = JSON.parse(String(out.text)).headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer s3cr3t-v1')
    expect(seen).toEqual([`pkg-net|accept-cred|${main.origin}`])
  })

  it('未绑定/不存在 → credential_unavailable，请求根本没发出（目标服务零命中）', async () => {
    let hits = 0
    const target = await serve({
      '/probe': (_req, res) => { hits += 1; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hit') },
    })
    try {
      const broker = new NetworkBroker({
        authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [target.origin] }) },
        credentials: {
          resolve: async () => ({ ok: false as const, code: 'credential_unavailable' as const, message: '未绑定' }),
          refresh: async () => ({ ok: false as const, code: 'credential_unavailable' as const, message: '静态夹具无刷新面' }),
        },
        audit: null,
        log: () => {},
        limits: { requestsPerSecond: 100 },
      })
      const out = await broker.requestForPackage('pkg-net', { url: `${target.origin}/probe`, credential: 'ghost' })
      expect(out).toMatchObject({ ok: false, code: 'credential_unavailable', origin: target.origin })
      expect(hits).toBe(0)
    } finally {
      await target.close()
    }
  })

  it('凭证面缺席（未装配）→ credential_unavailable（不当作「无凭证直连」）', async () => {
    const broker = new NetworkBroker({
      authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [main.origin] }) },
      audit: null,
      log: () => {},
      limits: { requestsPerSecond: 100 },
    })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json`, credential: 'any' })
    expect(out).toMatchObject({ ok: false, code: 'credential_unavailable' })
  })

  it('网络权限未授时先拒权限（凭证不发出去也救不了）', async () => {
    const broker = new NetworkBroker({
      authorization: { activeGrant: () => ({ permissions: ['media.read'], networkOrigins: [main.origin] }) },
      credentials: {
        resolve: async () => ({ ok: true as const, headerName: 'authorization', value: 'Bearer x', refreshable: false }),
        refresh: async () => ({ ok: false as const, code: 'credential_unavailable' as const, message: '静态夹具无刷新面' }),
      },
      audit: null,
      log: () => {},
      limits: { requestsPerSecond: 100 },
    })
    const out = await broker.requestForPackage('pkg-net', { url: `${main.origin}/data.json`, credential: 'c' })
    expect(out).toMatchObject({ ok: false, code: 'network_permission_denied' })
  })

  it('跨 origin 重定向带凭证：不跟随，目标服务零命中（凭证不跨域）', async () => {
    let otherHits = 0
    const second = await serve({
      '/secret': (_req, res) => { otherHits += 1; res.writeHead(200, { 'content-type': 'text/plain' }); res.end('secret') },
    })
    const first = await serve({
      '/go': (_req, res) => { res.writeHead(302, { location: `${second.origin}/secret` }); res.end() },
    })
    try {
      const broker = new NetworkBroker({
        authorization: { activeGrant: () => ({ permissions: ['network.request'], networkOrigins: [first.origin] }) },
        credentials: {
          resolve: async () => ({ ok: true as const, headerName: 'authorization', value: 'Bearer s3cr3t', refreshable: false }),
          refresh: async () => ({ ok: false as const, code: 'credential_unavailable' as const, message: '静态夹具无刷新面' }),
        },
        audit: null,
        log: () => {},
        limits: { requestsPerSecond: 100 },
      })
      const out = await broker.requestForPackage('pkg-net', { url: `${first.origin}/go`, credential: 'cred' })
      expect(out).toMatchObject({ ok: false, code: 'network_redirect_blocked' })
      expect(otherHits).toBe(0)
    } finally {
      await first.close()
      await second.close()
    }
  })
})

// ---------------------------------------------------------------------------
// oauth 自动刷新（工单348）：纯被动 401 触发——oauth 型已注入请求被目标拒 401 → 凭证库
// 单飞刷新一次（按凭证名）→ 摘旧头注新头重发当前请求恰好一次；刷新失败或刷新后仍 401 =
// credential_unavailable 终态（永不透传 401）；同一逻辑请求最多一次刷新+重试。静态/无凭证
// 401 维持 ok:true 透传。发证调用占触发包速率额度、随 timeoutMs/maxResponseBytes、不占并发
// 槽；每次真实发证调用一条审计（origin=发证地址、POST、无令牌）。夹具 = 本地「发证 + API」
// 双角色 http server + 真 CredentialService（假密码器），全走 Broker 公共入口。
// ---------------------------------------------------------------------------
describe('oauth 自动刷新（工单348）', () => {
  /** 可逆假密码器（与 store.spec 同款） */
  function oauthCipher(): CredentialCipherPort {
    return {
      available: () => true,
      encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
      decrypt: (cipher) => Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString('utf8'),
    }
  }

  /**
   * oauth 夹具：发证服务（origin 根发 tok-N）+ API 服务（只认有效集内的 Bearer）。
   * 运行期可编排：state.rejectAll（API 全拒，模拟「刷新后仍被拒」）、state.issuerFail
   * （发证失败形态）。冷启动时发证调用占速率额度——额度类用例按「请求数 + 发证数」预算。
   */
  async function oauthFixture(opts: { apiDelayMs?: number; issuerDelayMs?: number } = {}) {
    const state = {
      rejectAll: false,
      issuerFail: null as null | { status?: number; payload?: Record<string, unknown> },
    }
    const validTokens = new Set<string>()
    let issued = 0
    const issuerCalls: Array<{ body: Record<string, string> }> = []
    // 发证端点带路径（评审裁定 2026-11-13：真实提供商形态——飞书/Azure/GitHub 端点全带路径）
    const issuer = await serve({
      '/oauth/token': (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const body: Record<string, string> = {}
          for (const [k, v] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) body[k] = v
          issuerCalls.push({ body })
          const respond = () => {
            const fail = state.issuerFail
            const payload = fail?.payload ?? { access_token: `tok-${++issued}`, expires_in: 3600 }
            const token = typeof payload.access_token === 'string' ? payload.access_token : null
            if (token && !fail) validTokens.add(`Bearer ${token}`)
            res.writeHead(fail?.status ?? 200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(payload))
          }
          if (opts.issuerDelayMs) setTimeout(respond, opts.issuerDelayMs)
          else respond()
        })
      },
    })
    const apiHits: Array<string | undefined> = [] // 每次真实命中记下的 authorization 头
    const api = await serve({
      '/data': (req, res) => {
        const respond = () => {
          const auth = req.headers.authorization
          apiHits.push(auth)
          if (!state.rejectAll && auth && validTokens.has(auth)) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: true, served: auth }))
          } else {
            res.writeHead(401, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'token expired' }))
          }
        }
        if (opts.apiDelayMs) setTimeout(respond, opts.apiDelayMs)
        else respond()
      },
      '/always-401': (req, res) => {
        apiHits.push(req.headers.authorization)
        res.writeHead(401, { 'content-type': 'text/plain' })
        res.end('denied')
      },
    })
    // 真 CredentialService（假密码器 + 临时文件）：oauth 配置/binding/缓存全走生产缝
    const credDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-net-oauth-'))
    const svc = new CredentialService(new Context(), {
      file: path.join(credDir, 'credentials.json'),
      cipher: oauthCipher(),
      log: () => {},
    })
    svc.set('oa', 'cs-oa-888', { type: 'oauth', tokenEndpoint: `${issuer.origin}/oauth/token`, clientId: 'cid-net', scope: 'read' })
    svc.bind('pkg-oa', 'oa', api.origin)
    const port = {
      resolve: (pkg: string, name: string, origin: string, io: Parameters<CredentialService['resolve']>[3]) => svc.resolve(pkg, name, origin, io),
      refresh: (pkg: string, name: string, origin: string, io: Parameters<CredentialService['refresh']>[3]) => svc.refresh(pkg, name, origin, io),
    }
    const cleanup = async () => {
      await Promise.all([issuer.close(), api.close()])
      fs.rmSync(credDir, { recursive: true, force: true })
    }
    return { state, issuer, issuerCalls, validTokens, api, apiHits, svc, port, cleanup }
  }

  /** 常规 Broker（额度宽松、并发放宽） */
  function brokerOn(fx: Awaited<ReturnType<typeof oauthFixture>>, opts: { limits?: NetworkBrokerOptions['limits']; audit?: NetworkAuditService | null; log?: (e: Record<string, unknown>) => void; transport?: NetworkTransportPort; packageLimits?: NetworkBrokerOptions['packageLimits'] } = {}) {
    return new NetworkBroker({
      authorization: { activeGrant: (pkg) => pkg === 'pkg-oa' ? { permissions: ['network.request'], networkOrigins: [fx.api.origin] } : null },
      credentials: { resolve: (pkg, name, origin, io) => fx.svc.resolve(pkg, name, origin, io), refresh: (pkg, name, origin, io) => fx.svc.refresh(pkg, name, origin, io) },
      ...(opts.audit !== undefined ? { audit: opts.audit } : { audit: null }),
      log: opts.log ?? (() => {}),
      limits: { requestsPerSecond: 100, maxConcurrent: 50, ...(opts.limits ?? {}) },
      ...(opts.transport ? { transport: opts.transport } : {}),
      ...(opts.packageLimits ? { packageLimits: opts.packageLimits } : {}),
    })
  }

  it('⑧ 首次请求无缓存 → 先取令牌再发出：API 首击即带上 Bearer tok-1，200', async () => {
    const fx = await oauthFixture()
    try {
      const out = await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
      expect(out).toMatchObject({ ok: true, status: 200, origin: fx.api.origin, redirects: 0 })
      expect(fx.issuerCalls).toHaveLength(1)
      expect(fx.issuerCalls[0].body).toEqual({ grant_type: 'client_credentials', client_id: 'cid-net', client_secret: 'cs-oa-888', scope: 'read' })
      expect(fx.apiHits).toEqual(['Bearer tok-1'])
    } finally {
      await fx.cleanup()
    }
  })

  it('① 令牌过期（API 拒现役令牌）→ 自动刷新一次 → 重试原请求成功；全程恰好两次发证、三次 API 命中', async () => {
    const fx = await oauthFixture()
    try {
      expect(await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true, status: 200 })
      // 服务器侧过期：tok-1 作废（发证服务随后发的 tok-2 仍有效）
      fx.validTokens.delete('Bearer tok-1')
      const out = await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
      expect(out).toMatchObject({ ok: true, status: 200 })
      if (!out.ok) return
      expect(JSON.parse(String(out.text)).served).toBe('Bearer tok-2')
      expect(fx.issuerCalls).toHaveLength(2) // 预热 + 刷新，恰好一次刷新
      expect(fx.apiHits).toEqual(['Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2']) // 401 → 摘旧头重发新头
    } finally {
      await fx.cleanup()
    }
  })

  it('② 发证服务失败（非 2xx / 缺 access_token）→ credential_unavailable 终态（不透传 401、不重试）+ 审计子因 refresh-failed', async () => {
    const auditFile = path.join(auditDir, 'audit-oauth-fail.jsonl')
    for (const [tier, fail] of [['http-400', { status: 400, payload: { error: 'invalid_client' } }] as const, ['missing-token', { payload: { token_type: 'bearer' } }] as const]) {
      const fx = await oauthFixture()
      try {
        const broker = brokerOn(fx, { audit: new NetworkAuditService({ file: `${auditFile}.${tier}`, now: () => Date.now(), log: () => {} }) })
        expect(await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true, status: 200 })
        fx.validTokens.delete('Bearer tok-1')
        fx.state.issuerFail = fail
        const out = await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
        expect(out).toMatchObject({ ok: false, code: 'credential_unavailable', origin: fx.api.origin })
        if (out.ok) return
        expect(out.message).toContain('刷新失败')
        expect(out.message).not.toContain('tok-')
        expect(fx.issuerCalls).toHaveLength(2) // 刷新确实打了一次发证
        expect(fx.apiHits).toHaveLength(2) // 首次 401 后没有重试（刷新失败即终态）
        const raw = fs.readFileSync(`${auditFile}.${tier}`, 'utf8')
        expect(raw).not.toContain('tok-')
        expect(raw).toContain('refresh-failed')
        expect(raw).toContain(fx.issuer.origin)
      } finally {
        await fx.cleanup()
      }
    }
  })

  it('③ 并发 N 请求同撞过期 → 发证服务只收到 1 次刷新调用，全体同一新令牌 200', async () => {
    const fx = await oauthFixture({ apiDelayMs: 60, issuerDelayMs: 60 })
    try {
      const broker = brokerOn(fx)
      expect(await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true, status: 200 })
      fx.validTokens.delete('Bearer tok-1')
      const results = await Promise.all(Array.from({ length: 6 }, () => broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })))
      expect(fx.issuerCalls).toHaveLength(2) // 预热 1 + 并发批次共享 1（单飞断言）
      for (const r of results) {
        expect(r).toMatchObject({ ok: true, status: 200 })
        if (!r.ok) return
        expect(JSON.parse(String(r.text)).served).toBe('Bearer tok-2')
      }
    } finally {
      await fx.cleanup()
    }
  })

  it('④ 刷新成功但重试仍 401 → credential_unavailable（刷新后仍被拒）：不第二次刷新、不第三次重试', async () => {
    const fx = await oauthFixture()
    try {
      expect(await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true, status: 200 })
      // API 此后全拒（新令牌也进不了有效集）：刷新拿到的 tok-2 照样被拒
      fx.state.rejectAll = true
      const out = await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
      expect(out).toMatchObject({ ok: false, code: 'credential_unavailable', status: 401, origin: fx.api.origin })
      if (out.ok) return
      expect(out.message).toContain('刷新后仍被拒')
      expect(fx.issuerCalls).toHaveLength(2) // 刷新一次后不再刷
      expect(fx.apiHits).toHaveLength(3) // 首次 + 一次重试，没有第三次
    } finally {
      await fx.cleanup()
    }
  })

  it('⑤ 审计与日志全文无 access_token/client_secret；发证行 origin=发证地址、POST；终态行带审计子因', async () => {
    const logEvents: Array<Record<string, unknown>> = []
    const auditFile = path.join(auditDir, 'audit-oauth.jsonl')
    const audit = new NetworkAuditService({ file: auditFile, now: () => Date.now(), log: () => {} })
    const fx = await oauthFixture()
    try {
      const broker = brokerOn(fx, { audit, log: (e) => logEvents.push(e) })
      expect(await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true })
      fx.validTokens.delete('Bearer tok-1')
      expect(await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true, status: 200 })
      const raw = fs.readFileSync(auditFile, 'utf8')
      expect(raw).not.toContain('tok-')
      expect(raw).not.toContain('cs-oa-888')
      expect(raw).not.toContain('cid-net')
      const lines = raw.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
      const refreshLine = lines.find((l) => l.origin === fx.issuer.origin)
      expect(refreshLine).toMatchObject({ method: 'POST', outcome: 'ok', status: 200 })
      // 刷新后仍被拒的终态子因
      fx.state.rejectAll = true
      const out = await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
      expect(out).toMatchObject({ ok: false, code: 'credential_unavailable' })
      const raw2 = fs.readFileSync(auditFile, 'utf8')
      expect(raw2).not.toContain('tok-')
      expect(raw2).toContain('refreshed-still-denied')
      // 凭证域日志也不含令牌/secret
      expect(JSON.stringify(logEvents)).not.toContain('tok-')
      expect(JSON.stringify(logEvents)).not.toContain('cs-oa-888')
    } finally {
      await fx.cleanup()
    }
  })

  it('⑥ 静态凭证 401 照旧透传 ok:true status:401（零改动）；无凭证请求同样透传', async () => {
    const fx = await oauthFixture()
    try {
      const broker = brokerOn(fx)
      fx.svc.set('st', 'st-v1')
      fx.svc.bind('pkg-oa', 'st', fx.api.origin)
      const out = await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/always-401`, credential: 'st' })
      expect(out).toMatchObject({ ok: true, status: 401, origin: fx.api.origin })
      expect(fx.issuerCalls).toHaveLength(0) // 静态面零刷新
      const bare = await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/always-401` })
      expect(bare).toMatchObject({ ok: true, status: 401 })
    } finally {
      await fx.cleanup()
    }
  })

  it('⑦ 解绑即断供：unbind 后请求 credential_unavailable（发证与 API 零新增命中）', async () => {
    const fx = await oauthFixture()
    try {
      expect(await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true })
      expect(fx.svc.unbind('pkg-oa', 'oa', fx.api.origin)).toEqual({ ok: true })
      const out = await brokerOn(fx).requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
      expect(out).toMatchObject({ ok: false, code: 'credential_unavailable' })
      expect(fx.issuerCalls).toHaveLength(1) // 只有首轮预热的发证调用
      expect(fx.apiHits).toHaveLength(1)
    } finally {
      await fx.cleanup()
    }
  })

  it('刷新占触发包速率额度、重试照常占额度：额度分级下链路逐步 starvation（刷新饿死 / 重试饿死 / 全链通）', async () => {
    // 冷启动（请求+取令牌）占 2 额度；过期轮（请求+刷新+重试）占 3 额度——合计 5
    for (const [limit, expected] of [
      [5, { phase: 'full', code: 'ok' }],
      [4, { phase: 'retry', code: 'network_rate_limited' }],
      [3, { phase: 'refresh', code: 'credential_unavailable' }],
    ] as const) {
      const fx = await oauthFixture()
      try {
        const broker = brokerOn(fx, { limits: { requestsPerSecond: limit } })
        expect(await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true })
        fx.validTokens.delete('Bearer tok-1')
        const out = await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })
        if (expected.code === 'ok') {
          expect(out).toMatchObject({ ok: true, status: 200 })
          expect(fx.apiHits).toHaveLength(3) // 401 → 重试 200
        } else if (expected.code === 'network_rate_limited') {
          expect(out).toMatchObject({ ok: false, code: 'network_rate_limited' }) // 刷新成了、重试没额度
          expect(fx.issuerCalls).toHaveLength(2)
          expect(fx.apiHits).toHaveLength(2) // 无第三次命中
        } else {
          expect(out).toMatchObject({ ok: false, code: 'credential_unavailable' })
          if (!out.ok) expect(out.message).toContain('速率额度不足')
          expect(fx.issuerCalls).toHaveLength(1) // 刷新没发起（预热那次之外零发证调用）
        }
      } finally {
        await fx.cleanup()
      }
    }
  })

  it('刷新调用随触发包生效 timeoutMs/maxResponseBytes（传输缝观测口）', async () => {
    const fx = await oauthFixture()
    const sentSpecs: Array<{ url: string; method: string; timeoutMs: number; maxBytes: number; bodyFields: Record<string, string> }> = []
    const inner = createNodeTransport()
    try {
      const broker = brokerOn(fx, {
        packageLimits: { 'pkg-oa': { timeoutMs: 1234, maxResponseBytes: 4096 } },
        transport: {
          send: async (spec) => {
            const rec = { url: spec.url.href, method: spec.method, timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes, bodyFields: {} as Record<string, string> }
            if (spec.body) for (const [k, v] of new URLSearchParams(spec.body.toString('utf8'))) rec.bodyFields[k] = v
            sentSpecs.push(rec)
            return inner.send(spec)
          },
        },
      })
      expect(await broker.requestForPackage('pkg-oa', { url: `${fx.api.origin}/data`, credential: 'oa' })).toMatchObject({ ok: true })
      const refreshSpec = sentSpecs.find((s) => s.url === `${fx.issuer.origin}/oauth/token`)
      expect(refreshSpec).toMatchObject({ method: 'POST', timeoutMs: 1234, maxBytes: 4096 })
      expect(refreshSpec!.bodyFields.grant_type).toBe('client_credentials')
      expect(refreshSpec!.bodyFields.client_secret).toBe('cs-oa-888') // 体参式（RFC 6749）——只在此传输缝短暂存在
      expect(refreshSpec!.bodyFields.client_id).toBe('cid-net')
    } finally {
      await fx.cleanup()
    }
  })
})
