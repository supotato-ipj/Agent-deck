import { describe, expect, it } from 'vitest'
import { authorizeDroppedPackageWithGrant } from '../../src/main/plugins/authorization'

/**
 * 授权裁决 v2（工单336，ADR-0025）：敏感通路开放度（工单336 media.read、工单337 media.control）——
 * 权限全部 = media.read 且账上 grant 匹配（权限集合覆盖 + 代码哈希相等）才放行；
 * 其余敏感权限（media.control/network.request）批准通道未开放（#337/#338），
 * 无账/哈希漂移/权限漂移一律 pending-approval（批准前不执行）。
 */
describe('授权裁决 v2：media.read 通路打开', () => {
  it('零权限 → activate（投放即生效，不查账）', () => {
    expect(authorizeDroppedPackageWithGrant({ permissions: [], grant: null, codeHash: 'h' })).toBe('activate')
  })

  it('纯 media.read + 账上绑定匹配 → activate', () => {
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['media.read'],
      grant: { permissions: ['media.read'], codeHash: 'h1' },
      codeHash: 'h1',
    })).toBe('activate')
  })

  it('纯 media.read 无账 → pending-approval（批准前不执行）', () => {
    expect(authorizeDroppedPackageWithGrant({ permissions: ['media.read'], grant: null, codeHash: 'h1' })).toBe('pending-approval')
  })

  it('代码哈希漂移（同 id 新代码）→ pending-approval（不继承旧批准，更新重批）', () => {
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['media.read'],
      grant: { permissions: ['media.read'], codeHash: 'old' },
      codeHash: 'new',
    })).toBe('pending-approval')
  })

  it('权限漂移（包声明的权限集合超出账面授权）→ pending-approval', () => {
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['media.read', 'media.control'],
      grant: { permissions: ['media.read'], codeHash: 'h1' },
      codeHash: 'h1',
    })).toBe('pending-approval')
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['media.read'],
      grant: { permissions: ['media.read', 'media.control'], codeHash: 'h1' },
      codeHash: 'h1',
    })).toBe('pending-approval')
  })

  it('media.control 通路开放（工单337）：账面子集授权匹配 → activate', () => {
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['media.read', 'media.control'],
      grant: { permissions: ['media.read', 'media.control'], codeHash: 'h1' },
      codeHash: 'h1',
    })).toBe('activate')
  })

  it('network.request 通路开放（工单338）：账面匹配 → activate（origin 由网络 Broker 另查）', () => {
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['network.request'],
      grant: { permissions: ['network.request'], codeHash: 'h1' },
      codeHash: 'h1',
    })).toBe('activate')
  })

  it('混入未开放权限（未来权限）→ pending-approval（账再匹配也不放行）', () => {
    expect(authorizeDroppedPackageWithGrant({
      permissions: ['future.permission'],
      grant: { permissions: ['future.permission'], codeHash: 'h1' },
      codeHash: 'h1',
    })).toBe('pending-approval')
  })
})
