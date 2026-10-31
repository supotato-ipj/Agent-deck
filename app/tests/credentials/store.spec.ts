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
