/**
 * Listary HTTP 客户端测试（工单07，假 API）：真传输层打本机回环假服务——
 * 引擎离线（连接拒绝/超时）、限流载荷、空结果、offset 翻页请求体、非法载荷。
 * 「查询词只发往本机」由传输目标（回环常量 + 假服务收包）实证。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ListaryNetworkError, classifyFailure, parseResponse } from '../../src/main/search/engine'
import { listarySearch } from '../../src/main/search/client'

const SEEN: Array<{ query: unknown; limit: unknown; offset: unknown }> = []

/** 假 Listary API 行为挡位：每个用例换挡；收到请求体时拿到 res 直接应答 */
type FakeBehavior = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
let behave: FakeBehavior = () => {}
let server: http.Server
let port = 0

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const parsed = JSON.parse(body) as Record<string, unknown>
      SEEN.push({ query: parsed.query, limit: parsed.limit, offset: parsed.offset })
      behave(req, body, res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  SEEN.length = 0
  behave = (_req, body, res) => {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const q = String(parsed.query)
    const all = [
      { path: 'C:\\a.txt', name: 'a.txt' },
      { path: 'C:\\b.txt', name: 'b.txt' },
    ]
    const offset = Number(parsed.offset ?? 0)
    const limit = Number(parsed.limit ?? 8)
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { query: q, total: all.length, offset, limit, count: 0, results: all.slice(offset, offset + limit) } }))
  }
})

const TIMEOUT = 500

describe('listarySearch（真传输层 × 假 API）', () => {
  it('POST JSON 到回环假服务并解析载荷；请求体带 query/limit/offset（offset 翻页透传）', async () => {
    const payload = (await listarySearch({ port, timeoutMs: TIMEOUT }, 'word', 8, 40)) as { ok: boolean; data: { results: unknown[] } }
    expect(payload.ok).toBe(true)
    expect(SEEN).toEqual([{ query: 'word', limit: 8, offset: 40 }])
  })

  it('默认页（offset 0）返回结果且可解析；空结果载荷原样返回', async () => {
    const payload = (await listarySearch({ port, timeoutMs: TIMEOUT }, 'word', 8, 0)) as { ok: boolean; data: { results: unknown[] } }
    expect(classifyFailure(payload)).toBeNull()
    const parsed = parseResponse(payload)
    expect(parsed.total).toBe(2)
    expect(parsed.items.map((i) => i.name)).toEqual(['a.txt', 'b.txt'])

    behave = (_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, data: { query: 'nothing', total: 0, offset: 0, limit: 8, count: 0, results: [] } }))
    }
    const empty = (await listarySearch({ port, timeoutMs: TIMEOUT }, 'nothing', 8, 0)) as { data: { total: number; results: unknown[] } }
    expect(empty.data.total).toBe(0)
    expect(empty.data.results).toEqual([])
  })

  it('翻页语义：offset 越过结果数得到空页（假 API 按请求体切片）', async () => {
    const payload = (await listarySearch({ port, timeoutMs: TIMEOUT }, 'word', 8, 8)) as { data: { results: unknown[] } }
    expect(payload.data.results).toEqual([])
    expect(SEEN[0]).toEqual({ query: 'word', limit: 8, offset: 8 })
  })

  it('限流载荷（TOO_MANY_REQUESTS）原样返回并由 classifyFailure 归 rate_limited', async () => {
    behave = (_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'TOO_MANY_REQUESTS' }))
    }
    const payload = await listarySearch({ port, timeoutMs: TIMEOUT }, 'x', 8, 0)
    expect(classifyFailure(payload)).toBe('rate_limited')
  })

  it('SEARCH_UNAVAILABLE 载荷归 offline（引擎未就绪）', async () => {
    behave = (_req, _body, res) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: false, error: 'SEARCH_UNAVAILABLE' }))
    }
    const payload = await listarySearch({ port, timeoutMs: TIMEOUT }, 'x', 8, 0)
    expect(classifyFailure(payload)).toBe('offline')
  })

  it('连接拒绝 → ListaryNetworkError（offline，不冒充其他故障）', async () => {
    await expect(listarySearch({ port: 1, timeoutMs: TIMEOUT }, 'x', 8, 0)).rejects.toBeInstanceOf(ListaryNetworkError)
  })

  it('响应超时 → ListaryNetworkError', async () => {
    behave = () => { /* 永不应答 */ }
    await expect(listarySearch({ port, timeoutMs: 120 }, 'x', 8, 0)).rejects.toBeInstanceOf(ListaryNetworkError)
  })

  it('非 JSON 载荷 → 普通异常（引擎在线但行为异常，归类 error 不冒充离线）', async () => {
    behave = (_req, _body, res) => {
      res.end('<html>gateway error</html>')
    }
    const err = await listarySearch({ port, timeoutMs: TIMEOUT }, 'x', 8, 0).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(ListaryNetworkError)
    expect(classifyFailure(err)).toBe('error')
  })

  it('每次请求新建连接（无 keep-alive：连发两枪都到齐）', async () => {
    await listarySearch({ port, timeoutMs: TIMEOUT }, 'first', 8, 0)
    await listarySearch({ port, timeoutMs: TIMEOUT }, 'second', 8, 0)
    expect(SEEN.map((s) => s.query)).toEqual(['first', 'second'])
  })
})
