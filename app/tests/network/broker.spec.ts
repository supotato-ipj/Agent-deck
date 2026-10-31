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
