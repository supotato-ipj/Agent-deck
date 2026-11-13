// 命名凭证（工单339）：加密保存（明文不落盘）、显式绑定三元组、逐包撤销、轮换不重批、
// 卸载只清绑定。加密端口注入可逆假密码器（生产 = safeStorage，真机段 C9 验）。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CredentialStore, type CredentialCipherPort } from '../../src/main/credentials/store'

/** 可逆假密码器：enc:base64（只为测试断言「文件里没有明文」，不声称是加密） */
function fakeCipher(available = true): CredentialCipherPort {
  return {
    available: () => available,
    encrypt: (plain) => `enc:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher) => Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString('utf8'),
  }
}

let dir: string
let file: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-cred-'))
  file = path.join(dir, 'credentials.json')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function store(cipher = fakeCipher(), now = () => 1_700_000_000_000) {
  return new CredentialStore({ file, cipher, now, log: () => {} })
}

describe('凭证保存与视图（工单339）', () => {
  it('set 后 list 只有元数据；文件里没有明文 secret', () => {
    const s = store()
    expect(s.set('accept-cred', 's3cr3t-v1')).toEqual({ ok: true })
    const [view] = s.list()
    expect(view).toMatchObject({ name: 'accept-cred', headerName: 'authorization', valuePrefix: 'Bearer ', rotatedAt: null })
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).not.toContain('s3cr3t-v1')
    expect(raw).toContain('enc:')
  })

  it('同名 set = 轮换：createdAt 不变、rotatedAt 更新、绑定不受影响', () => {
    let now = 1_000
    const s = new CredentialStore({ file, cipher: fakeCipher(), now: () => now, log: () => {} })
    s.set('cred', 'v1')
    s.bind('pkg-a', 'cred', 'http://127.0.0.1:1111')
    now = 2_000
    s.set('cred', 'v2')
    const [view] = s.list()
    expect(view.createdAt).toBe(1_000)
    expect(view.rotatedAt).toBe(2_000)
    expect(view.bindings).toHaveLength(1)
    // 轮换后解析到新值（不需要任何重新批准）
    expect(s.resolve('pkg-a', 'cred', 'http://127.0.0.1:1111')).toMatchObject({ ok: true, headerName: 'authorization', value: 'Bearer v2' })
  })

  it('name/secret/headerName 形状非法 → credential_invalid；host/content-length 头被拒', () => {
    const s = store()
    expect(s.set('BAD NAME', 'x')).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('ok', '')).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('ok', 'x', { headerName: 'Host' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('ok', 'x', { headerName: 'content-length' })).toMatchObject({ ok: false, code: 'credential_invalid' })
  })

  it('自定义头名与前缀（x-api-key 类凭据）', () => {
    const s = store()
    expect(s.set('api', 'k-123', { headerName: 'x-api-key', valuePrefix: '' })).toEqual({ ok: true })
    expect(s.resolve('pkg', 'api', 'https://api.example.com')).toMatchObject({ ok: false })
    s.bind('pkg', 'api', 'https://api.example.com')
    expect(s.resolve('pkg', 'api', 'https://api.example.com')).toMatchObject({ ok: true, headerName: 'x-api-key', value: 'k-123' })
  })

  it('加密不可用 → 拒绝保存（绝不落明文兜底）；在册凭证解析也如实不可用', () => {
    const ok = store()
    ok.set('cred', 'v1')
    const down = store(fakeCipher(false))
    expect(down.set('cred2', 'v2')).toMatchObject({ ok: false, code: 'credential_store_unavailable' })
    expect(down.list().map((c) => c.name)).toEqual(['cred'])
    down.bind('pkg', 'cred', 'http://127.0.0.1:1')
    expect(down.resolve('pkg', 'cred', 'http://127.0.0.1:1')).toMatchObject({ ok: false, code: 'credential_unavailable' })
  })
})

describe('绑定矩阵（工单339）：包 + 凭证 + 精确 origin', () => {
  it('同一凭证可绑多个包/多个 origin；解析只在绑定组合上放行', () => {
    const s = store()
    s.set('cred', 'v1')
    s.bind('pkg-a', 'cred', 'http://127.0.0.1:1111')
    s.bind('pkg-b', 'cred', 'http://127.0.0.1:1111')
    s.bind('pkg-a', 'cred', 'https://second.example.com')
    expect(s.resolve('pkg-a', 'cred', 'http://127.0.0.1:1111').ok).toBe(true)
    expect(s.resolve('pkg-b', 'cred', 'http://127.0.0.1:1111').ok).toBe(true)
    expect(s.resolve('pkg-a', 'cred', 'https://second.example.com').ok).toBe(true)
    // 未绑定组合：同包其他 origin / 其他包未绑定 / 不存在凭证——同一出口（无枚举信号）
    expect(s.resolve('pkg-c', 'cred', 'http://127.0.0.1:1111')).toMatchObject({ ok: false, code: 'credential_unavailable' })
    expect(s.resolve('pkg-a', 'cred', 'http://127.0.0.1:9999')).toMatchObject({ ok: false, code: 'credential_unavailable' })
    expect(s.resolve('pkg-a', 'nope', 'http://127.0.0.1:1111')).toMatchObject({ ok: false, code: 'credential_unavailable' })
  })

  it('逐包撤销：unbind 一个三元组，其他绑定不受影响', () => {
    const s = store()
    s.set('cred', 'v1')
    s.bind('pkg-a', 'cred', 'http://127.0.0.1:1111')
    s.bind('pkg-b', 'cred', 'http://127.0.0.1:1111')
    expect(s.unbind('pkg-a', 'cred', 'http://127.0.0.1:1111')).toEqual({ ok: true })
    expect(s.resolve('pkg-a', 'cred', 'http://127.0.0.1:1111')).toMatchObject({ ok: false })
    expect(s.resolve('pkg-b', 'cred', 'http://127.0.0.1:1111').ok).toBe(true)
    expect(s.unbind('pkg-a', 'cred', 'http://127.0.0.1:1111')).toMatchObject({ ok: false, code: 'credential_unavailable' })
  })

  it('bind 拒绝非纯 origin；绑定 origin 正典化（默认端口/大小写归一）', () => {
    const s = store()
    s.set('cred', 'v1')
    expect(s.bind('pkg', 'cred', 'http://127.0.0.1:1111/path')).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.bind('pkg', 'cred', 'HTTP://127.0.0.1:80')).toEqual({ ok: true })
    expect(s.resolve('pkg', 'cred', 'http://127.0.0.1').ok).toBe(true)
  })

  it('卸载只清绑定，凭证本体保留；删除凭证才销毁本体并连带清绑定', () => {
    const s = store()
    s.set('cred', 'v1')
    s.bind('pkg-a', 'cred', 'http://127.0.0.1:1111')
    s.clearBindingsFor('pkg-a')
    expect(s.resolve('pkg-a', 'cred', 'http://127.0.0.1:1111')).toMatchObject({ ok: false })
    expect(s.list().map((c) => c.name)).toEqual(['cred'])
    expect(s.remove('cred')).toEqual({ ok: true })
    expect(s.list()).toEqual([])
  })

  it('跨重启重载：凭证与绑定在案；孤儿绑定（凭证已删）载入即丢', () => {
    const s = store()
    s.set('cred', 'v1')
    s.bind('pkg-a', 'cred', 'http://127.0.0.1:1111')
    const reborn = store()
    expect(reborn.resolve('pkg-a', 'cred', 'http://127.0.0.1:1111').ok).toBe(true)
    // 手工把绑定指向不存在的凭证：重载时不虚挂
    const body = JSON.parse(fs.readFileSync(file, 'utf8'))
    body.bindings.push({ packageId: 'pkg-x', credentialName: 'ghost', origin: 'http://127.0.0.1:1', boundAt: 1 })
    fs.writeFileSync(file, JSON.stringify(body), 'utf8')
    const clean = store()
    expect(clean.bindingsFor('pkg-x')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// oauth 型凭证（工单348）：type: 'static' | 'oauth' 两型；oauth 配置整组
// {tokenEndpoint, clientId, clientSecret, scope?} 序列化成单个 JSON 字符串走既有 cipher
// 一块加密——明文（含 clientSecret/clientId/发证地址）永不落盘；读入缺省 static（旧
// credentials.json 零迁移）；绑定三元组与轮换语义沿用静态面。
// ---------------------------------------------------------------------------
describe('oauth 型凭证（工单348）：单块加密与两型模型', () => {
  // 发证地址 = 完整 URL（评审裁定 2026-11-13：真实发证服务几乎全带路径——飞书/Azure/GitHub；
  // 校验走 origin.ts 请求 URL 口径：http(s)、拒 userinfo、允许路径/query），正典 href 落盘
  const oauthOpts = { type: 'oauth' as const, tokenEndpoint: 'https://issuer.example.com/oauth/token', clientId: 'cid-1', scope: 'read write' }

  it('set oauth 后文件是单块密文：clientSecret/clientId/发证地址明文都不落盘；视图带 type、无 clientSecret', () => {
    const s = store()
    expect(s.set('oa-cred', 'cs-999', oauthOpts)).toEqual({ ok: true })
    const raw = fs.readFileSync(file, 'utf8')
    expect(raw).toContain('enc:')
    expect(raw).not.toContain('cs-999')
    expect(raw).not.toContain('cid-1')
    expect(raw).not.toContain('issuer.example.com')
    const [view] = s.list()
    expect(view).toMatchObject({ name: 'oa-cred', type: 'oauth', headerName: 'authorization', valuePrefix: 'Bearer ', rotatedAt: null })
    expect(JSON.stringify(view)).not.toContain('cs-999')
  })

  it('oauth 同名 set = 轮换：createdAt 不变、rotatedAt 更新、绑定不受影响；static↔oauth 可换型轮换', () => {
    let now = 1_000
    const s = new CredentialStore({ file, cipher: fakeCipher(), now: () => now, log: () => {} })
    s.set('oa-cred', 'cs-v1', oauthOpts)
    s.bind('pkg-a', 'oa-cred', 'http://127.0.0.1:1111')
    now = 2_000
    s.set('oa-cred', 'cs-v2', { ...oauthOpts, clientId: 'cid-2' })
    const [view] = s.list()
    expect(view.createdAt).toBe(1_000)
    expect(view.rotatedAt).toBe(2_000)
    expect(view.bindings).toHaveLength(1)
    // 换型轮换：oauth → static 同名覆盖
    s.set('oa-cred', 'plain-v3')
    const [after] = s.list()
    expect(after.type).toBe('static')
    expect(s.resolve('pkg-a', 'oa-cred', 'http://127.0.0.1:1111')).toMatchObject({ ok: true, value: 'Bearer plain-v3' })
  })

  it('oauth 校验：发证地址走合法 http(s) URL 口径（可带路径、拒 userinfo、≤512）；clientId/clientSecret 非空且 secret ≤ 4096', () => {
    const s = store()
    // 非法形态：非 http(s)、内嵌 userinfo、超长、不可解析、缺角
    expect(s.set('oa', 'cs', { type: 'oauth', tokenEndpoint: 'ftp://issuer.example.com/oauth/token', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa', 'cs', { type: 'oauth', tokenEndpoint: 'https://user:pass@issuer.example.com/oauth/token', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa', 'cs', { type: 'oauth', tokenEndpoint: `https://issuer.example.com/${'x'.repeat(512)}`, clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa', 'cs', { type: 'oauth', tokenEndpoint: 'not a url', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa', 'cs', { type: 'oauth', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    // 合法形态：带路径（真实提供商形态——飞书/Azure/GitHub 都是带路径端点）
    expect(s.set('oa', 'cs', { type: 'oauth', tokenEndpoint: 'https://issuer.example.com', clientId: '' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa', 'cs', { type: 'oauth', tokenEndpoint: 'https://issuer.example.com/oauth/token', clientId: 'cid', scope: '' })).toEqual({ ok: true }) // scope 空串 = 不设
    expect(s.set('oa2', '', { type: 'oauth', tokenEndpoint: 'https://issuer.example.com', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa2', 'x'.repeat(4097), { type: 'oauth', tokenEndpoint: 'https://issuer.example.com', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    expect(s.set('oa2', 'cs', { type: 'oauth', clientId: 'cid' })).toMatchObject({ ok: false, code: 'credential_invalid' })
    // 发证地址正典化（scheme/host 小写、默认端口归一、href 串）后落盘
    expect(s.set('oa3', 'cs', { type: 'oauth', tokenEndpoint: 'HTTPS://ISSUER3.example.com:443/login/oauth/access_token', clientId: 'cid' })).toEqual({ ok: true })
    s.bind('pkg', 'oa3', 'http://127.0.0.1:1')
    const canon = s.resolve('pkg', 'oa3', 'http://127.0.0.1:1')
    if (!canon.ok || canon.kind !== 'oauth') return
    expect(canon.config.tokenEndpoint).toBe('https://issuer3.example.com/login/oauth/access_token')
  })

  it('旧 credentials.json 零迁移：无 type 字段的记录载入即 static，解析照旧', () => {
    const legacy = {
      version: 1,
      credentials: [{ name: 'old-cred', headerName: 'authorization', valuePrefix: 'Bearer ', cipher: fakeCipher().encrypt('v-legacy'), createdAt: 1, rotatedAt: null }],
      bindings: [],
    }
    fs.writeFileSync(file, JSON.stringify(legacy), 'utf8')
    const s = store()
    const [view] = s.list()
    expect(view).toMatchObject({ name: 'old-cred', type: 'static' })
    s.bind('pkg', 'old-cred', 'http://127.0.0.1:1')
    expect(s.resolve('pkg', 'old-cred', 'http://127.0.0.1:1')).toMatchObject({ ok: true, value: 'Bearer v-legacy' })
  })

  it('resolve 分型：static 回 kind static + 注入值；oauth 回 kind oauth + 解密配置（clientSecret 只在内存面）', () => {
    const s = store()
    s.set('st', 'st-v1')
    s.set('oa', 'cs-888', oauthOpts)
    // 正典化：scheme/host 小写、默认端口归一、href 串落盘
    s.set('oa-canon', 'cs-canonical', { type: 'oauth', tokenEndpoint: 'HTTPS://Issuer.Canonical.example.com/oauth/token', clientId: 'cid-canon' })
    s.bind('pkg-a', 'st', 'http://127.0.0.1:1111')
    s.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
    s.bind('pkg-a', 'oa-canon', 'http://127.0.0.1:1111')
    expect(s.resolve('pkg-a', 'st', 'http://127.0.0.1:1111')).toMatchObject({ ok: true, kind: 'static', headerName: 'authorization', value: 'Bearer st-v1' })
    const oa = s.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111')
    expect(oa).toMatchObject({ ok: true, kind: 'oauth', headerName: 'authorization', valuePrefix: 'Bearer ' })
    if (!oa.ok || oa.kind !== 'oauth') return
    expect(oa.config).toEqual({ tokenEndpoint: 'https://issuer.example.com/oauth/token', clientId: 'cid-1', clientSecret: 'cs-888', scope: 'read write' })
    const canon = s.resolve('pkg-a', 'oa-canon', 'http://127.0.0.1:1111')
    if (!canon.ok || canon.kind !== 'oauth') return
    expect(canon.config.tokenEndpoint).toBe('https://issuer.canonical.example.com/oauth/token')
  })

  it('oauth 密文损坏（解不开/非 JSON/形状缺角）→ credential_unavailable，不虚挂注入值', () => {
    const s = store()
    s.set('oa', 'cs-777', oauthOpts)
    s.bind('pkg-a', 'oa', 'http://127.0.0.1:1111')
    const body = JSON.parse(fs.readFileSync(file, 'utf8'))
    const cases = [
      fakeCipher().encrypt('not-json'),
      fakeCipher().encrypt(JSON.stringify({ tokenEndpoint: 'https://issuer.example.com' })),
      fakeCipher().encrypt(JSON.stringify({ tokenEndpoint: 'https://issuer.example.com', clientId: 'c', scope: 'x' })),
      fakeCipher().encrypt(JSON.stringify({ clientId: 'c', clientSecret: 's' })),
      'enc:!!!broken-base64!!!',
    ]
    for (const bad of cases) {
      body.credentials[0].cipher = bad
      fs.writeFileSync(file, JSON.stringify(body), 'utf8')
      const reborn = store()
      expect(reborn.resolve('pkg-a', 'oa', 'http://127.0.0.1:1111')).toMatchObject({ ok: false, code: 'credential_unavailable' })
    }
  })

  it('加密不可用时 oauth 同样拒存（绝不落明文兜底）；在册 oauth 解析如实不可用', () => {
    const ok = store()
    ok.set('oa', 'cs-1', oauthOpts)
    const down = store(fakeCipher(false))
    expect(down.set('oa2', 'cs-2', oauthOpts)).toMatchObject({ ok: false, code: 'credential_store_unavailable' })
    down.bind('pkg', 'oa', 'http://127.0.0.1:1')
    expect(down.resolve('pkg', 'oa', 'http://127.0.0.1:1')).toMatchObject({ ok: false, code: 'credential_unavailable' })
  })
})
