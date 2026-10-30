import { describe, expect, it } from 'vitest'
import { ExecutionContextRegistry } from '../../src/main/plugins/identity'
import { authorizeDroppedPackage, DROPPED_PACKAGE_STATES, type DroppedPackageState } from '../../src/main/plugins/authorization'

/**
 * 执行上下文登记表（工单331，ADR-0025）：主进程登记 webContents.id → 包身份，
 * 是唯一身份源——IPC handler 一律查表推导插件 id/包根/代次，不采信调用参数自报。
 */

function entry(over: Partial<Parameters<ExecutionContextRegistry['register']>[1]> = {}) {
  return {
    packageId: 'widget-a',
    generation: 1,
    root: 'D:\\plugins\\widget-a',
    origin: 'deck-pkg://widget-a',
    ...over,
  }
}

describe('执行上下文登记表（AC2：身份从登记表推导，不采信自报）', () => {
  it('登记后可按 webContents.id 查到包身份（只读条目）', () => {
    const reg = new ExecutionContextRegistry()
    reg.register(42, entry())
    const got = reg.lookup(42)
    expect(got?.packageId).toBe('widget-a')
    expect(got?.generation).toBe(1)
    expect(got?.root).toBe('D:\\plugins\\widget-a')
    expect(got?.origin).toBe('deck-pkg://widget-a')
    // 只读：外部改不动登记表内部
    expect(Object.isFrozen(got)).toBe(true)
  })

  it('未登记 id（含崩溃后摘除）→ null：unknown_context 分支的事实来源', () => {
    const reg = new ExecutionContextRegistry()
    expect(reg.lookup(7)).toBeNull()
    reg.register(7, entry())
    reg.remove(7)
    expect(reg.lookup(7)).toBeNull()
  })

  it('同 id 重复登记覆盖旧条目（换代重建语境），按包反查返回最新', () => {
    const reg = new ExecutionContextRegistry()
    reg.register(42, entry({ generation: 1 }))
    reg.register(42, entry({ generation: 2 }))
    expect(reg.lookup(42)?.generation).toBe(2)
  })

  it('按包 id 反查全部上下文（崩溃处置/停用清算用）', () => {
    const reg = new ExecutionContextRegistry()
    reg.register(1, entry({ packageId: 'pkg-a' }))
    reg.register(2, entry({ packageId: 'pkg-a', generation: 2 }))
    reg.register(3, entry({ packageId: 'pkg-b' }))
    const contextsOfA = reg.byPackage('pkg-a')
    expect(contextsOfA.map((c) => c.webContentsId).sort()).toEqual([1, 2])
    expect(reg.byPackage('pkg-b').length).toBe(1)
    expect(reg.byPackage('pkg-x')).toEqual([])
  })

  it('摘除按包清算：removePackage 摘掉该包全部上下文，不动他包', () => {
    const reg = new ExecutionContextRegistry()
    reg.register(1, entry({ packageId: 'pkg-a' }))
    reg.register(2, entry({ packageId: 'pkg-b' }))
    reg.register(3, entry({ packageId: 'pkg-a' }))
    reg.removePackage('pkg-a')
    expect(reg.lookup(1)).toBeNull()
    expect(reg.lookup(3)).toBeNull()
    expect(reg.lookup(2)?.packageId).toBe('pkg-b')
  })

  it('登记规模可盘点（验收/审计读数）', () => {
    const reg = new ExecutionContextRegistry()
    expect(reg.size()).toBe(0)
    reg.register(1, entry())
    reg.register(2, entry({ packageId: 'pkg-b' }))
    expect(reg.size()).toBe(2)
  })
})

describe('投放包授权状态机（AC1：无敏感权限不走批准闸门，投放即生效）', () => {
  it('状态词表封闭：ok 运行 / crashed 崩溃错误态 / pending-approval 待批准 / pending-migration 待迁移 / error 坏包', () => {
    expect([...DROPPED_PACKAGE_STATES]).toEqual(['ok', 'crashed', 'pending-approval', 'pending-migration', 'error'])
    expect(Object.isFrozen(DROPPED_PACKAGE_STATES))
  })

  it('零权限包 → 直接激活（无闸门：投放即生效）', () => {
    expect(authorizeDroppedPackage({ permissions: [] })).toBe('activate')
  })

  it('权限全在目录内但含敏感权限 → 待批准（敏感包批准前不执行，批准 UI 归后续票）', () => {
    expect(authorizeDroppedPackage({ permissions: ['media.read'] })).toBe('pending-approval')
    expect(authorizeDroppedPackage({ permissions: ['media.read', 'network.request'] })).toBe('pending-approval')
  })

  it('缺 permissions 字段视同零权限（解析器已把缺省归一为空清单，双保险）', () => {
    expect(authorizeDroppedPackage({})).toBe('activate')
    expect(authorizeDroppedPackage({ permissions: undefined })).toBe('activate')
  })

  it('状态类型收口：DroppedPackageState 可作清单判别', () => {
    const s: DroppedPackageState = 'pending-migration'
    expect(DROPPED_PACKAGE_STATES).toContain(s)
  })
})
