// origin 正典化与匹配（工单338）：声明面只收纯 origin；请求面按 WHATWG URL.origin 归一；
// 命中只认精确相等（不按主域/前缀/端口范围——ADR-0025 明确否掉「按主域名授权」）。
import { describe, expect, it } from 'vitest'
import { originGranted, originOfDeclaration, originOfRequestUrl } from '../../src/main/network/origin'

describe('请求 URL → 授权匹配键（工单338）', () => {
  it('路径/查询/片段不进匹配键：origin 内路径与方法同属授权', () => {
    const out = originOfRequestUrl('http://127.0.0.1:47823/api/data.json?x=1#frag')
    expect(out).toMatchObject({ ok: true, origin: 'http://127.0.0.1:47823', protocol: 'http:' })
  })

  it('scheme/host 大小写归一、默认端口省略（声明面与请求面同一把尺）', () => {
    expect(originOfRequestUrl('HTTP://Example.COM:80/a')).toMatchObject({ ok: true, origin: 'http://example.com' })
    expect(originOfRequestUrl('https://Example.com:443/x')).toMatchObject({ ok: true, origin: 'https://example.com' })
    expect(originOfRequestUrl('https://example.com:8443/x')).toMatchObject({ ok: true, origin: 'https://example.com:8443' })
  })

  it('IPv6 方括号保留', () => {
    expect(originOfRequestUrl('http://[::1]:8080/ping')).toMatchObject({ ok: true, origin: 'http://[::1]:8080' })
  })

  it('非 HTTP(S) 一律不支持（首版无 WebSocket/原始 Socket/永久流）', () => {
    expect(originOfRequestUrl('ws://example.com/socket')).toMatchObject({ ok: false, reason: 'unsupported_scheme' })
    expect(originOfRequestUrl('ftp://example.com/file')).toMatchObject({ ok: false, reason: 'unsupported_scheme' })
  })

  it('坏 URL / userinfo 内嵌 = 结构化拒绝', () => {
    expect(originOfRequestUrl('not a url')).toMatchObject({ ok: false, reason: 'invalid' })
    expect(originOfRequestUrl('http://user:pass@example.com/')).toMatchObject({ ok: false, reason: 'not_pure_origin' })
  })
})

describe('manifest 声明 origin（工单338）', () => {
  it('纯 origin 通过，并归一到与请求面同一个键', () => {
    expect(originOfDeclaration('http://127.0.0.1:47823')).toMatchObject({ ok: true, origin: 'http://127.0.0.1:47823' })
    expect(originOfDeclaration('HTTP://Example.COM:80/')).toMatchObject({ ok: true, origin: 'http://example.com' })
  })

  it('带路径/查询/片段 = 配置错误（不猜「前缀授权」）', () => {
    expect(originOfDeclaration('http://127.0.0.1:47823/api')).toMatchObject({ ok: false, reason: 'not_pure_origin' })
    expect(originOfDeclaration('http://127.0.0.1:47823/?a=1')).toMatchObject({ ok: false, reason: 'not_pure_origin' })
    expect(originOfDeclaration('http://127.0.0.1:47823/#x')).toMatchObject({ ok: false, reason: 'not_pure_origin' })
  })
})

describe('授权命中（工单338）', () => {
  it('精确相等才放行：不同端口/不同 scheme/子域都不算命中', () => {
    const granted = ['http://127.0.0.1:47823']
    expect(originGranted(granted, 'http://127.0.0.1:47823')).toBe(true)
    expect(originGranted(granted, 'http://127.0.0.1:47824')).toBe(false)
    expect(originGranted(granted, 'https://127.0.0.1:47823')).toBe(false)
    expect(originGranted(['http://example.com'], 'http://sub.example.com')).toBe(false)
    expect(originGranted(['http://example.com'], 'http://example.com.evil.test')).toBe(false)
  })

  it('空/缺省授予集 = 全拒', () => {
    expect(originGranted([], 'http://127.0.0.1:1')).toBe(false)
    expect(originGranted(undefined, 'http://127.0.0.1:1')).toBe(false)
    expect(originGranted(null, 'http://127.0.0.1:1')).toBe(false)
  })
})
