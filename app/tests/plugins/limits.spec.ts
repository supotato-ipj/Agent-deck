// 插件限额覆写（工单345，ADR-0025「用户可收紧不可放宽」的配置面）：
// 合并矩阵（收紧生效 / 放宽拒绝 / 非法值拒绝）、拒绝错误码登记契约目录、
// 两栏投影（默认值 / 生效值）、装配缝切片。纯逻辑测试——config 合并与
// 持久化往返在 tests/config.spec.ts，Broker 执行面在 network/media 域 spec。
import { describe, expect, it } from 'vitest'
import {
  PLUGIN_CONTRACT_CATALOG,
  contractErrorCodes,
  projectCatalog,
} from '../../src/main/plugins/catalog'
import {
  mergeLimitsOverrides,
  packagePermissionSlice,
  permissionLimitColumns,
  type PackageLimitOverrides,
} from '../../src/main/plugins/limits'

const NET_DEFAULTS = PLUGIN_CONTRACT_CATALOG.permissions.find((p) => p.id === 'network.request')!.limits
const MEDIA_DEFAULTS = PLUGIN_CONTRACT_CATALOG.permissions.find((p) => p.id === 'media.control')!.limits

describe('限额覆写合并（工单345：可收紧不可放宽）', () => {
  it('五项限额各一条收紧生效：network 四项 + media.control 速率，全部进合并产物', () => {
    const raw = {
      'pkg-a': {
        'network.request': { requestsPerSecond: 2, maxConcurrent: 1, timeoutMs: 5000, maxResponseBytes: 1024 },
        'media.control': { commandsPerSecond: 3 },
      },
    }
    const out = mergeLimitsOverrides(raw)
    expect(out.rejections).toEqual([])
    expect(out.limits).toEqual(raw)
  })

  it('放宽一律拒绝：每项超默认值 → limit_widen_rejected，条目不进产物，空包剪枝', () => {
    const out = mergeLimitsOverrides({
      'pkg-a': {
        'network.request': {
          requestsPerSecond: (NET_DEFAULTS.requestsPerSecond as number) + 1,
          maxConcurrent: (NET_DEFAULTS.maxConcurrent as number) + 1,
          timeoutMs: (NET_DEFAULTS.timeoutMs as number) + 1,
          maxResponseBytes: (NET_DEFAULTS.maxResponseBytes as number) + 1,
        },
        'media.control': { commandsPerSecond: (MEDIA_DEFAULTS.commandsPerSecond as number) + 1 },
      },
    })
    expect(out.rejections.map((r) => r.code)).toEqual([
      'limit_widen_rejected', 'limit_widen_rejected', 'limit_widen_rejected', 'limit_widen_rejected', 'limit_widen_rejected',
    ])
    // 全部被拒：该包产物剪枝为空（放宽不可能生效）
    expect(out.limits['pkg-a']).toBeUndefined()
  })

  it('放宽拒绝只剪该条目：同权限下合法收紧条目照常保留', () => {
    const out = mergeLimitsOverrides({
      'pkg-a': { 'network.request': { requestsPerSecond: 99, timeoutMs: 4000 } },
    })
    expect(out.rejections).toHaveLength(1)
    expect(out.rejections[0]).toMatchObject({ code: 'limit_widen_rejected', path: 'pkg-a.network.request.requestsPerSecond' })
    expect(out.limits).toEqual({ 'pkg-a': { 'network.request': { timeoutMs: 4000 } } })
  })

  it('非法值拒绝：0 / 负数 / 非数（串/布尔/null/对象）/ 非整数 → limit_invalid', () => {
    const out = mergeLimitsOverrides({
      'pkg-a': {
        'network.request': {
          requestsPerSecond: 0,
          maxConcurrent: -1,
          timeoutMs: '5000',
          maxResponseBytes: null,
        },
        'media.control': { commandsPerSecond: 2.5 },
      },
    })
    expect(out.rejections.map((r) => r.code)).toEqual([
      'limit_invalid', 'limit_invalid', 'limit_invalid', 'limit_invalid', 'limit_invalid',
    ])
    expect(out.limits).toEqual({})
  })

  it('覆写值等于默认值 → 接受（收紧到默认不是放宽）', () => {
    const out = mergeLimitsOverrides({
      'pkg-a': { 'network.request': { requestsPerSecond: NET_DEFAULTS.requestsPerSecond as number } },
    })
    expect(out.rejections).toEqual([])
    expect(out.limits).toEqual({ 'pkg-a': { 'network.request': { requestsPerSecond: NET_DEFAULTS.requestsPerSecond } } })
  })

  it('未知权限 id / 未知限额键 → limit_invalid（该权限或该键整条拒绝）', () => {
    const out = mergeLimitsOverrides({
      'pkg-a': { 'media.read': { snapshotBytes: 1024 }, 'network.request': { unknownKey: 1, timeoutMs: 1000 } },
    })
    expect(out.rejections.map((r) => r.code)).toEqual(['limit_invalid', 'limit_invalid'])
    expect(out.limits).toEqual({ 'pkg-a': { 'network.request': { timeoutMs: 1000 } } })
  })

  it('包 id 形态非法（路径穿越/大写/空格）→ 整包 limit_invalid 拒绝', () => {
    const out = mergeLimitsOverrides({
      '../evil': { 'network.request': { requestsPerSecond: 1 } },
      'Good-Pkg': { 'network.request': { requestsPerSecond: 1 } },
    })
    expect(out.rejections.map((r) => r.code)).toEqual(['limit_invalid', 'limit_invalid'])
    expect(out.limits).toEqual({})
  })

  it('limits 整段非对象（数组/串）→ limit_invalid 且产物为空', () => {
    for (const raw of [[], 'x', 42, null]) {
      const out = mergeLimitsOverrides(raw)
      expect(out.limits).toEqual({})
      expect(out.rejections).toHaveLength(1)
      expect(out.rejections[0].code).toBe('limit_invalid')
    }
  })

  it('缺段（undefined）→ 空产物零拒绝（老 config 静默兼容）', () => {
    const out = mergeLimitsOverrides(undefined)
    expect(out.limits).toEqual({})
    expect(out.rejections).toEqual([])
  })

  it('每条拒绝携带结构化定位（path）与用户可读 message', () => {
    const out = mergeLimitsOverrides({ 'pkg-a': { 'network.request': { requestsPerSecond: 999 } } })
    expect(out.rejections[0].path).toBe('pkg-a.network.request.requestsPerSecond')
    expect(out.rejections[0].message).toContain('limit_widen_rejected')
    expect(out.rejections[0].message).toContain('config.plugins.limits')
  })
})

describe('限额两栏投影（工单345：默认值 / 当前生效值）', () => {
  it('无覆写：全部权限限额 default === effective（media.read 限额也在投影内）', () => {
    const cols = permissionLimitColumns(undefined)
    expect(cols['network.request'].requestsPerSecond).toEqual({ default: 5, effective: 5 })
    expect(cols['network.request'].maxResponseBytes).toEqual({ default: 2 * 1024 * 1024, effective: 2 * 1024 * 1024 })
    expect(cols['media.control'].commandsPerSecond).toEqual({ default: 5, effective: 5 })
    expect(cols['media.read'].snapshotBytes).toEqual({ default: 64 * 1024, effective: 64 * 1024 })
  })

  it('按包收紧后 effective = min(默认, 覆写)；未覆写包维持默认', () => {
    const ov = mergeLimitsOverrides({ 'pkg-a': { 'network.request': { requestsPerSecond: 2 } } }).limits
    expect(permissionLimitColumns(ov, 'pkg-a')['network.request'].requestsPerSecond).toEqual({ default: 5, effective: 2 })
    expect(permissionLimitColumns(ov, 'pkg-b')['network.request'].requestsPerSecond).toEqual({ default: 5, effective: 5 })
  })

  it('生效值恒为 min(默认, 覆写)：越权手写对象（绕过合并）也不会放宽', () => {
    const crafted = { 'pkg-a': { 'network.request': { requestsPerSecond: 99 } } } as unknown as PackageLimitOverrides
    expect(permissionLimitColumns(crafted, 'pkg-a')['network.request'].requestsPerSecond.effective).toBe(5)
  })

  it('projectCatalog resourceLimits 投影 = packages 原样 + permissionLimits 两栏（缺省默认视图）', () => {
    const out = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent')
    const rl = out.data.resourceLimits as { packages: unknown; permissionLimits: Record<string, Record<string, { default: number; effective: number }>> }
    expect(rl.packages).toEqual(PLUGIN_CONTRACT_CATALOG.resourceLimits)
    expect(rl.permissionLimits['network.request'].requestsPerSecond).toEqual({ default: 5, effective: 5 })
  })

  it('projectCatalog 可传按包两栏数据：收紧后 agent 投影可见生效值', () => {
    const ov = mergeLimitsOverrides({ 'pkg-a': { 'media.control': { commandsPerSecond: 1 } } }).limits
    const out = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent', { permissionLimitColumns: permissionLimitColumns(ov, 'pkg-a') })
    const rl = out.data.resourceLimits as { permissionLimits: Record<string, Record<string, { default: number; effective: number }>> }
    expect(rl.permissionLimits['media.control'].commandsPerSecond).toEqual({ default: 5, effective: 1 })
  })
})

describe('限额覆写错误码登记契约错误目录（工单345）', () => {
  it('limit_widen_rejected / limit_invalid 在典且为 gate 类', () => {
    const codes = contractErrorCodes()
    expect(codes).toContain('limit_widen_rejected')
    expect(codes).toContain('limit_invalid')
    for (const entry of PLUGIN_CONTRACT_CATALOG.errors) {
      if (entry.code === 'limit_widen_rejected' || entry.code === 'limit_invalid') {
        expect(entry.kind).toBe('gate')
      }
    }
  })
})

describe('装配缝切片（packagePermissionSlice）', () => {
  it('按权限抽取每包切片，供 Broker 构造期读取', () => {
    const ov = mergeLimitsOverrides({
      'pkg-a': { 'network.request': { requestsPerSecond: 2 }, 'media.control': { commandsPerSecond: 3 } },
      'pkg-b': { 'network.request': { timeoutMs: 1000 } },
    }).limits
    expect(packagePermissionSlice(ov, 'network.request')).toEqual({
      'pkg-a': { requestsPerSecond: 2 },
      'pkg-b': { timeoutMs: 1000 },
    })
    expect(packagePermissionSlice(ov, 'media.control')).toEqual({ 'pkg-a': { commandsPerSecond: 3 } })
  })

  it('无覆写 → 空切片（不炸不造键）', () => {
    expect(packagePermissionSlice(undefined, 'network.request')).toEqual({})
    expect(packagePermissionSlice({}, 'media.control')).toEqual({})
  })
})
