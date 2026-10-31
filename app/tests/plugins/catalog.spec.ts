import { describe, expect, it } from 'vitest'
import {
  PLUGIN_CONTRACT_CATALOG,
  PROJECTABLE_CATALOG_SECTIONS,
  projectCatalog,
  baselineApiDomainIds,
  currentHostApiVersion,
  knownPermissionIds,
  contractErrorCodes,
} from '../../src/main/plugins/catalog'

/**
 * 插件契约目录（工单331，ADR-0025 拍板）：机器可读的单一正典——manifest 形状、
 * hostApiVersion、基线宿主 API、权限目录、结构化错误与资源上限。
 * 批准 UI 与 agent/MCP 从同一来源投影（本票只落目录与投影接口形状）。
 *
 * 单一正典的机械保证：投放包解析器（dropped-manifest.ts）与宿主运行时从本模块
 * 取常量（当前主版本 / 已知权限 / 基线域），不许另立第二处字面量。
 */

describe('插件契约目录：正典自洽（工单331）', () => {
  it('当前主版本为正整数 1（首版）', () => {
    expect(currentHostApiVersion()).toBe(1)
    expect(Number.isInteger(PLUGIN_CONTRACT_CATALOG.hostApiVersion.current)).toBe(true)
    expect(PLUGIN_CONTRACT_CATALOG.hostApiVersion.current).toBeGreaterThan(0)
  })

  it('版本策略声明：同主版本只做向后兼容新增，删除/改语义须升主版本', () => {
    expect(PLUGIN_CONTRACT_CATALOG.hostApiVersion.policy).toBe('same-major-backward-compatible')
  })

  it('manifest schema 覆盖投放包契约字段，hostApiVersion 必填', () => {
    const names = PLUGIN_CONTRACT_CATALOG.manifest.map((f) => f.name)
    for (const required of ['id', 'name', 'version', 'entry', 'hostApiVersion']) {
      expect(names).toContain(required)
    }
    const hostApi = PLUGIN_CONTRACT_CATALOG.manifest.find((f) => f.name === 'hostApiVersion')
    expect(hostApi?.required).toBe(true)
  })

  it('基线宿主 API 分领域：host.view / host.config / host.media 在典，且不含通用 invoke', () => {
    expect(baselineApiDomainIds()).toEqual(['host.view', 'host.config', 'host.media'])
    const allActions = PLUGIN_CONTRACT_CATALOG.baselineHostApi.flatMap((d) => d.actions)
    expect(allActions.some((a) => a.includes('invoke'))).toBe(false)
    for (const domain of PLUGIN_CONTRACT_CATALOG.baselineHostApi) {
      expect(domain.status).toBe('enforced') // 基线域本票即落地，不是纸面声明
    }
  })

  it('首版权限目录登记 media.read / media.control / network.request，全部为敏感权限', () => {
    expect(knownPermissionIds()).toEqual(['media.read', 'media.control', 'network.request'])
    for (const p of PLUGIN_CONTRACT_CATALOG.permissions) {
      expect(p.kind).toBe('sensitive')
    }
  })

  it('network.request 授权模型为精确 origin；首版为声明态（消费路径归后续票）', () => {
    const net = PLUGIN_CONTRACT_CATALOG.permissions.find((p) => p.id === 'network.request')
    expect(net?.grant).toBe('exact-origin')
    expect(net?.status).toBe('declared')
    // 工单336：media.read = enforced；工单337：media.control 可选权限逐项批准 = enforced
    expect(PLUGIN_CONTRACT_CATALOG.permissions.find((p) => p.id === 'media.read')?.status).toBe('enforced')
    expect(PLUGIN_CONTRACT_CATALOG.permissions.find((p) => p.id === 'media.control')?.status).toBe('enforced')
  })

  it('每个权限与基线域引用的错误码都在错误目录中登记', () => {
    const defined = contractErrorCodes()
    for (const domain of PLUGIN_CONTRACT_CATALOG.baselineHostApi) {
      for (const code of domain.errors) expect(defined).toContain(code)
    }
    for (const p of PLUGIN_CONTRACT_CATALOG.permissions) {
      for (const code of p.errors) expect(defined).toContain(code)
    }
    // 迁移错误码在典（AC5 可读迁移错误的结构化落点）
    for (const code of ['host_api_version_missing', 'host_api_version_unsupported', 'permission_unknown']) {
      expect(defined).toContain(code)
    }
  })

  it('错误码唯一且分类齐备（migration / runtime）', () => {
    const codes = PLUGIN_CONTRACT_CATALOG.errors.map((e) => e.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBeGreaterThan(0)
    const kinds = new Set(PLUGIN_CONTRACT_CATALOG.errors.map((e) => e.kind))
    expect(kinds.has('migration')).toBe(true)
    expect(kinds.has('runtime')).toBe(true)
  })

  it('权限目录不允许运行时凭新字符串造权限：knownPermissionIds 只读且封闭', () => {
    const ids = knownPermissionIds()
    expect(Object.isFrozen(ids)).toBe(true)
  })

  it('资源上限声明在典：每项敏感权限带限额声明（数值型）', () => {
    for (const p of PLUGIN_CONTRACT_CATALOG.permissions) {
      expect(Object.keys(p.limits).length).toBeGreaterThan(0)
      for (const v of Object.values(p.limits)) {
        expect(typeof v === 'number' && Number.isFinite(v) || typeof v === 'string').toBe(true)
      }
    }
  })
})

describe('契约目录投影（批准 UI / agent 同源投影接口形状，工单331）', () => {
  it('投影两档受众：approval-ui 与 agent', () => {
    const ui = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'approval-ui')
    const agent = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent')
    expect(ui.audience).toBe('approval-ui')
    expect(agent.audience).toBe('agent')
  })

  it('投影段集合是封闭词表且两档受众的段都取自该词表', () => {
    expect(Object.isFrozen(PROJECTABLE_CATALOG_SECTIONS)).toBe(true)
    const allowed = new Set(PROJECTABLE_CATALOG_SECTIONS)
    const ui = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'approval-ui')
    const agent = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent')
    for (const section of ui.sections) expect(allowed.has(section)).toBe(true)
    for (const section of agent.sections) expect(allowed.has(section)).toBe(true)
    // agent 全量投影，批准 UI 至少含权限段（批准对象）与身份段（批准给谁）
    expect(agent.sections.length).toBe(PROJECTABLE_CATALOG_SECTIONS.length)
    expect(ui.sections).toContain('permissions')
    expect(ui.sections).toContain('identity')
  })

  it('投影结果 JSON 可序列化且逐段可独立取用（MCP/批准 UI 按段拉取的形状）', () => {
    const agent = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent')
    const round = JSON.parse(JSON.stringify(agent)) as typeof agent
    expect(round).toEqual(agent)
    // 投影携带目录本身可按段取：permissions 段给出权限 id 清单
    const perms = agent.data.permissions as Array<{ id: string }>
    expect(perms.map((p) => p.id)).toEqual(knownPermissionIds())
  })

  it('approval-ui 投影不含完整错误目录与 manifest schema（批准面最小化）', () => {
    const ui = projectCatalog(PLUGIN_CONTRACT_CATALOG, 'approval-ui')
    expect(ui.sections).not.toContain('errors')
    expect(ui.sections).not.toContain('manifest')
  })
})
