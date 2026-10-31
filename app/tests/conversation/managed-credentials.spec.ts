// 管理型会话凭证登记处测试（工单333，ADR-0017 后端会话凭证 / ADR-0018 管理授权）：
// 签发即高熵随机、仅内存、绑定会话 id；认证只认登记表（通道绑定身份，绝不采信参数
// 自报）；revoke 即时失效；revokeAll = 宿主重拉语义；无任何持久化出口。
import { describe, expect, it } from 'vitest'
import { SessionCredentialRegistry } from '../../src/main/conversation/managed-credentials'

describe('管理型会话凭证登记处（工单333）', () => {
  it('签发：返回 Bearer 形 bearer；同会话重复签发给新 token 且旧的作废（会话内不轮换口径外的显式重签）', () => {
    const reg = new SessionCredentialRegistry()
    const t1 = reg.issue('s1')
    expect(t1).toMatch(/^Bearer [A-Za-z0-9_-]+$/)
    const t2 = reg.issue('s1')
    expect(t2).not.toBe(t1)
    // 重签后旧 token 不再被认
    expect(reg.authenticate(t1)).toBeNull()
    expect(reg.authenticate(t2)).toBe('s1')
  })

  it('认证：只认登记表里的 token；形状不符/未知 token/空值 → null（通道绑定，不自报身份）', () => {
    const reg = new SessionCredentialRegistry()
    const token = reg.issue('s1')
    expect(reg.authenticate(`Bearer ${token.slice('Bearer '.length)}`)).toBe('s1')
    expect(reg.authenticate('Bearer not-issued')).toBeNull()
    expect(reg.authenticate('not-a-bearer')).toBeNull()
    expect(reg.authenticate('')).toBeNull()
    expect(reg.authenticate(undefined)).toBeNull()
    expect(reg.authenticate('Basic xxx')).toBeNull()
    // 别的会话拿不到这个 token 的身份
    expect(reg.authenticate(`Bearer ${'x'.repeat(43)}`)).toBeNull()
  })

  it('不同会话各自 token 互不串认（每会话独立签发，ADR-0017）', () => {
    const reg = new SessionCredentialRegistry()
    const t1 = reg.issue('s1')
    const t2 = reg.issue('s2')
    expect(reg.authenticate(t1)).toBe('s1')
    expect(reg.authenticate(t2)).toBe('s2')
    expect(reg.size()).toBe(2)
  })

  it('revoke：显式结束会话/进程退出 → 该会话凭证即时失效，其余不受影响', () => {
    const reg = new SessionCredentialRegistry()
    const t1 = reg.issue('s1')
    const t2 = reg.issue('s2')
    reg.revoke('s1')
    expect(reg.authenticate(t1)).toBeNull()
    expect(reg.authenticate(t2)).toBe('s2')
    // 幂等：重复 revoke 不抛
    expect(() => reg.revoke('s1')).not.toThrow()
    expect(reg.size()).toBe(1)
  })

  it('revokeAll：宿主重拉语义——全部凭证即时失效（ADR-0017）', () => {
    const reg = new SessionCredentialRegistry()
    const t1 = reg.issue('s1')
    const t2 = reg.issue('s2')
    reg.revokeAll()
    expect(reg.authenticate(t1)).toBeNull()
    expect(reg.authenticate(t2)).toBeNull()
    expect(reg.size()).toBe(0)
  })

  it('高熵：token 主体 ≥ 32 字节熵的编码长度且批量签发零碰撞', () => {
    const reg = new SessionCredentialRegistry()
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(reg.issue(`s${i}`))
    expect(seen.size).toBe(200)
    // base64url(32 bytes) = 43 字符
    for (const t of seen) expect(t.slice('Bearer '.length).length).toBeGreaterThanOrEqual(43)
  })

  it('仅内存：登记处没有落盘/序列化出口（凭证绝不落盘——红线）', () => {
    const reg = new SessionCredentialRegistry()
    reg.issue('s1')
    const exported = JSON.stringify(reg)
    expect(exported).not.toMatch(/Bearer\s+[A-Za-z0-9_-]{20,}/)
    // toJSON 也不得漏 token
    expect((reg as unknown as { toJSON?: () => unknown }).toJSON).toBeUndefined()
  })

  it('bearerOf：仅内存查询缝——在册返回完整头值，revoke 后为 null，未知会话为 null（真机验收观察口用）', () => {
    const reg = new SessionCredentialRegistry()
    const t = reg.issue('s1')
    expect(reg.bearerOf('s1')).toBe(t)
    expect(reg.bearerOf('ghost')).toBeNull()
    reg.revoke('s1')
    expect(reg.bearerOf('s1')).toBeNull()
  })
})
