// oauth 型凭证运行时面（工单348）：令牌纯内存缓存、按凭证名单飞、refresh 强制刷新口、
// 发证调用走宿主 IO（速率额度/超时/字节上限/审计归属）。发证服务 = 本地 http server
// 真测（127.0.0.1 随机端口，无公网依赖）；断言只看外部可见行为——resolve/refresh 结果、
// 发证服务实际收到的请求体/头、审计回调实参。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context } from 'cordis'
import { CredentialService } from '../../src/main/credentials/service'
import { createNodeTransport, type CredentialRefreshIo } from '../../src/main/network/broker'
import type { CredentialCipherPort } from '../../src/main/credentials/store'

/** 可逆假密码器（与 store.spec 同款） */
function fakeCipher(available = true): CredentialCipherPort {
  return {
    available: () => available,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher) => Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString('utf8'),
  }
}

interface IssuerHandle {
  origin: string
  /** 发证服务实际收到的调用（外部可见行为的观测口） */
  calls: Array<{ body: Record<string, string>; contentType: string; authorization: string | undefined }>
  close(): Promise<void>
}

/** 本地发证服务：POST /token 记下收到的表单与头，回 JSON access_token（可编排失败形态） */
function startIssuer(opts: {
  status?: number
  payload?: Record<string, unknown>
  delayMs?: number
} = {}): Promise<IssuerHandle> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const respond = () => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          const body: Record<string, string> = {}
          for (const [k, v] of new URLSearchParams(raw)) body[k] = v
          handle.calls.push({ body, contentType: String(req.headers['content-type'] ?? ''), authorization: req.headers.authorization })
          const status = opts.status ?? 200
          const payload = opts.payload ?? { access_token: `tok-${handle.calls.length}`, expires_in: 3600 }
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(payload))
        })
      }
      if (opts.delayMs) setTimeout(respond, opts.delayMs)
      else respond()
    })
    const handle = {
      origin: '',
      calls: [] as IssuerHandle['calls'],
      close: () => new Promise<void>((r) => server.close(() => r())),
    }
    server.listen(0, '127.0.0.1', () => {
      handle.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
      resolve(handle)
    })
  })
}

/** 宿主 IO 假件：速率/审计观测口 + 真传输（打到本地发证服务）+ 超时/字节上限捕获 */
function makeIo(overrides: Partial<CredentialRefreshIo> = {}): CredentialRefreshIo & {
  readonly rateCalls: number
  readonly audits: Array<{ origin: string; outcome: 'ok' | 'error'; status?: number }>
  readonly sentSpecs: Array<{ timeoutMs: number; maxBytes: number; method: string; url: string }>
} {
  const transport = createNodeTransport()
  const state = {
    rateCalls: 0,
    audits: [] as Array<{ origin: string; outcome: 'ok' | 'error'; status?: number }>,
    sentSpecs: [] as Array<{ timeoutMs: number; maxBytes: number; method: string; url: string }>,
  }
  const io: CredentialRefreshIo = {
    consumeRate: () => {
      state.rateCalls += 1
      return true
    },
    timeoutMs: 5_000,
    maxBytes: 65_536,
    send: (spec) => {
      state.sentSpecs.push({ timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes, method: spec.method, url: spec.url.href })
      return transport.send(spec)
    },
    audit: (rec) => {
      state.audits.push({ ...rec })
    },
    ...overrides,
  }
  // 观测口用 getter 挂在 io 本体上（读到的永远是活值）
  return Object.defineProperties(io, {
    rateCalls: { get: () => state.rateCalls },
    audits: { get: () => state.audits },
    sentSpecs: { get: () => state.sentSpecs },
  }) as CredentialRefreshIo & {
    readonly rateCalls: number
    readonly audits: Array<{ origin: string; outcome: 'ok' | 'error'; status?: number }>
    readonly sentSpecs: Array<{ timeoutMs: number; maxBytes: number; method: string; url: string }>
  }
}

// 发证地址是纯 origin（工单348 决策 7：origin.ts 口径，不带路径）——POST 即打到 origin 根
const OAUTH_SET = (issuerOrigin: string) => ({ type: 'oauth' as const, tokenEndpoint: issuerOrigin, clientId: 'cid-1', scope: 'read write' })

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cred-oauth-'))
  file = path.join(dir, 'credentials.json')
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function service(logEvents: Array<Record<string, unknown>> = []): CredentialService {
  return new CredentialService(new Context(), { file, cipher: fakeCipher(), log: (e) => logEvents.push(e) })
}

describe('oauth 运行时面（工单348）：取令牌、缓存、单飞、refresh', () => {
  it('首次 resolve 无缓存 → 取令牌后回注入值：发证服务收到体参式 form（grant_type/client_id/client_secret/scope），无 BASIC 头', async () => {
    const issuer = await startIssuer()
    try {
      const svc = service()
      expect(svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))).toEqual({ ok: true })
      expect(svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')).toEqual({ ok: true })
      const io = makeIo()
      const out = await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', io)
      expect(out).toMatchObject({ ok: true, headerName: 'authorization', value: 'Bearer tok-1', refreshable: true })
      // 发证服务实际收到：POST + 体参式 RFC 6749 表单
      expect(issuer.calls).toHaveLength(1)
      expect(issuer.calls[0].contentType).toContain('application/x-www-form-urlencoded')
      expect(issuer.calls[0].body).toEqual({ grant_type: 'client_credentials', client_id: 'cid-1', client_secret: 'cs-888', scope: 'read write' })
      expect(issuer.calls[0].authorization).toBeUndefined()
      // 审计：一行，origin=发证地址，无令牌无 client_secret
      expect(io.audits).toEqual([{ origin: issuer.origin, outcome: 'ok', status: 200 }])
    } finally {
      await issuer.close()
    }
  })

  it('缓存优先：第二次 resolve 不再打发证服务；refresh 强制刷新 → 新令牌、缓存跟着换', async () => {
    const issuer = await startIssuer()
    try {
      const svc = service()
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      const first = await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())
      expect(first).toMatchObject({ ok: true, value: 'Bearer tok-1' })
      const second = await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())
      expect(issuer.calls).toHaveLength(1) // 缓存命中：发证服务零新增调用
      expect(second).toMatchObject({ ok: true, value: 'Bearer tok-1' })
      const io = makeIo()
      const refreshed = await svc.refresh('pkg-a', 'oa', 'http://127.0.0.1:1111', io)
      expect(refreshed).toMatchObject({ ok: true, headerName: 'authorization', value: 'Bearer tok-2' })
      expect(issuer.calls).toHaveLength(2)
      // 刷新后缓存 = 新令牌：resolve 不再打发证服务
      const third = await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())
      expect(third).toMatchObject({ ok: true, value: 'Bearer tok-2' })
      expect(issuer.calls).toHaveLength(2)
      expect(io.audits).toEqual([{ origin: issuer.origin, outcome: 'ok', status: 200 }])
    } finally {
      await issuer.close()
    }
  })

  it('单飞：并发 N resolve 同时撞冷缓存 → 发证服务只收到 1 次调用，全体同一令牌', async () => {
    const issuer = await startIssuer({ delayMs: 80 })
    try {
      const svc = service()
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      const results = await Promise.all(Array.from({ length: 6 }, () => svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())))
      expect(issuer.calls).toHaveLength(1) // 单飞断言：一次真实调用
      for (const r of results) expect(r).toMatchObject({ ok: true, value: 'Bearer tok-1' })
    } finally {
      await issuer.close()
    }
  })

  it('发证服务失败（非 2xx / 缺 access_token / 非 JSON）→ credential_unavailable；消息可含状态码、绝不含令牌', async () => {
    const bad400 = await startIssuer({ status: 400, payload: { error: 'invalid_client' } })
    const missing = await startIssuer({ payload: { token_type: 'bearer' } })
    const junk = await startIssuer({ payload: 'not-json-{' as unknown as Record<string, unknown> })
    try {
      for (const [name, issuer] of [['oa-a', bad400], ['oa-b', missing], ['oa-c', junk]] as const) {
        const svc = service()
        svc.set(name, 'cs-888', OAUTH_SET(issuer.origin))
        svc.bind('pkg-a', name, 'http://127.0.0.1:1111')
        const io = makeIo()
        const out = await svc.refresh('pkg-a', name, 'http://127.0.0.1:1111', io)
        expect(out).toMatchObject({ ok: false, code: 'credential_unavailable' })
        if (out.ok) return
        expect(out.message).not.toContain('tok-')
        expect(out.message).not.toContain('cs-888')
        expect(JSON.stringify(io.audits)).not.toContain('tok-')
        expect(io.audits[0].origin).toBe(issuer.origin)
        expect(io.audits[0].outcome).toBe('error')
      }
      expect(bad400.calls[0].body.grant_type).toBe('client_credentials')
    } finally {
      await Promise.all([bad400.close(), missing.close(), junk.close()])
    }
  })

  it('refresh 复验三元组：未绑定/凭证不存在/静态型 → credential_unavailable，发证服务零调用', async () => {
    const issuer = await startIssuer()
    try {
      const svc = service()
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.set('st', 'st-v1')
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      svc.bind('pkg-a', 'st', 'http://127.0.0.1:1111')
      expect(await svc.refresh('pkg-b', 'oa', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: false, code: 'credential_unavailable' }) // 其他包未绑定
      expect(await svc.refresh('pkg-a', 'oa', 'http://127.0.0.1:9999', makeIo())).toMatchObject({ ok: false, code: 'credential_unavailable' }) // 其他 origin
      expect(await svc.refresh('pkg-a', 'ghost', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: false, code: 'credential_unavailable' }) // 不存在
      expect(await svc.refresh('pkg-a', 'st', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: false, code: 'credential_unavailable' }) // 静态型无刷新面
      expect(await svc.resolve('pkg-a', 'ghost', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: false, code: 'credential_unavailable' })
      expect(issuer.calls).toHaveLength(0)
    } finally {
      await issuer.close()
    }
  })

  it('宿主 IO 面：占速率额度、随 timeoutMs/maxBytes；额度拒 = 刷新未发起（零 HTTP、零审计行）', async () => {
    const issuer = await startIssuer()
    try {
      const svc = service()
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      const io = makeIo({ timeoutMs: 1234, maxBytes: 4096 })
      await svc.refresh('pkg-a', 'oa', 'http://127.0.0.1:1111', io)
      expect(io.rateCalls).toBe(1)
      expect(io.sentSpecs[0]).toMatchObject({ timeoutMs: 1234, maxBytes: 4096, method: 'POST' })
      expect(io.sentSpecs[0].url).toBe(`${issuer.origin}/`)
      // 额度拒：刷新无法发起（额度被询问过一次——占额动作本身发生，只是拒绝放行）
      let deniedRateCalls = 0
      const denied = makeIo({ consumeRate: () => { deniedRateCalls += 1; return false } })
      const out = await svc.refresh('pkg-a', 'oa', 'http://127.0.0.1:1111', denied)
      expect(out).toMatchObject({ ok: false, code: 'credential_unavailable' })
      expect(issuer.calls).toHaveLength(1)
      expect(deniedRateCalls).toBe(1)
      expect(denied.audits).toEqual([])
      // 缓存未被失败的刷新污染：resolve 仍回旧令牌且零新增调用
      const cached = await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())
      expect(cached).toMatchObject({ ok: true, value: 'Bearer tok-1' })
      expect(issuer.calls).toHaveLength(1)
    } finally {
      await issuer.close()
    }
  })

  it('轮换/删除清内存令牌缓存：set 同名新配置后 resolve 重新取令牌', async () => {
    const issuer = await startIssuer()
    const issuer2 = await startIssuer()
    try {
      const svc = service()
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      expect(await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: true, value: 'Bearer tok-1' })
      svc.set('oa', 'cs-999', OAUTH_SET(issuer2.origin))
      expect(await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: true, value: 'Bearer tok-1' })
      expect(issuer2.calls[0].body.client_secret).toBe('cs-999')
      expect(issuer.calls).toHaveLength(1)
      // remove 同样清缓存：重建后再取
      svc.remove('oa')
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      expect(await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111', makeIo())).toMatchObject({ ok: true })
      expect(issuer.calls).toHaveLength(2)
    } finally {
      await Promise.all([issuer.close(), issuer2.close()])
    }
  })

  it('静态型 resolve 照旧回注入值（refreshable false）；无 io 的 oauth 冷缓存 resolve → credential_unavailable（不裸发网络）', async () => {
    const issuer = await startIssuer()
    try {
      const svc = service()
      svc.set('st', 'st-v1')
      svc.bind('pkg-a', 'st', 'http://127.0.0.1:1111')
      expect(await svc.resolve('pkg-a', 'st', 'http://127.0.0.1:1111')).toMatchObject({ ok: true, value: 'Bearer st-v1', refreshable: false })
      svc.set('oa', 'cs-888', OAUTH_SET(issuer.origin))
      svc.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
      expect(await svc.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111')).toMatchObject({ ok: false, code: 'credential_unavailable' })
      expect(issuer.calls).toHaveLength(0)
    } finally {
      await issuer.close()
    }
  })
})
