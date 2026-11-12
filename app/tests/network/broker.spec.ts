// 网络 Broker（工单338）：逐包 origin 授权、有界请求-响应、重定向不跟随、限流/并发/超时、
// 头白名单、审计脱敏。传输用本地 http server 真测（127.0.0.1 随机端口，无公网依赖）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { NetworkBroker, type NetworkBrokerOptions, type NetworkTransportPort } from '../../src/main/network/broker'
import { NetworkAuditService } from '../../src/main/network/audit'
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
        resolve: (pkg, name, origin) => {
          seen.push(`${pkg}|${name}|${origin}`)
          return { ok: true, headerName: 'authorization', value: 'Bearer hop-secret' }
        },
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
        resolve: (pkg, name, origin) => {
          seen.push(`${pkg}|${name}|${origin}`)
          return { ok: true, headerName: 'authorization', value: 'Bearer s3cr3t-v1' }
        },
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
        credentials: { resolve: () => ({ ok: false, code: 'credential_unavailable', message: '未绑定' }) },
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
      credentials: { resolve: () => ({ ok: true, headerName: 'authorization', value: 'Bearer x' }) },
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
        credentials: { resolve: () => ({ ok: true, headerName: 'authorization', value: 'Bearer s3cr3t' }) },
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
