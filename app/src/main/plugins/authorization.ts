/**
 * 投放包授权状态机（工单331，ADR-0025）：manifest 权限声明 → 执行裁决。
 *
 * - 零权限包（permissions 空清单）→ `activate`：无敏感权限不走批准闸门，投放即生效；
 * - 权限全在目录内但含敏感权限 → `pending-approval`：敏感包不论来源，批准前不执行
 *   （批准 UI 归后续票；本票先钉住「不执行」的事实）。
 *
 * 未知权限/坏结构不进本状态机——那是 dropped-manifest.ts 的迁移分类（待迁移态/error 态）。
 * 纯逻辑：无 fs、无 Electron。
 */

/** 投放包运行态（封闭词表；清单与事件共用） */
export const DROPPED_PACKAGE_STATES = Object.freeze([
  'ok', // 运行中（独立上下文已拉起）
  'crashed', // 崩溃错误态：不自动重挂、不重放 mount 副作用，恢复=显式重建
  'pending-approval', // 待批准：含敏感权限，批准前不执行
  'pending-migration', // 待迁移：旧包/未知权限/主版本不兼容，带结构化迁移错误
  'error', // 坏包：结构错/资产缺失（沿用既有 error 语义）
] as const)

export type DroppedPackageState = (typeof DROPPED_PACKAGE_STATES)[number]

export interface AuthorizationInput {
  permissions?: readonly string[]
}

/** 授权裁决：activate = 立即拉起独立上下文；pending-approval = 等批准不执行 */
export type AuthorizationDecision = 'activate' | 'pending-approval'

export function authorizeDroppedPackage(input: AuthorizationInput): AuthorizationDecision {
  const perms = input.permissions ?? []
  return perms.length > 0 ? 'pending-approval' : 'activate'
}

/**
 * 账面授权查询形状（工单336：PluginAuthorizationLedger.activeGrant 同形状——
 * 这里只声明依赖的字段，不 import 账实现，裁决保持纯逻辑）。
 */
export interface GrantLookup {
  permissions: readonly string[]
  codeHash: string
}

/**
 * 授权裁决 v2（工单336，ADR-0025 按包/按代码代次授予）：本票只开 media.read 通路——
 * - 零权限 → activate（不经账）；
 * - 权限**全部** = media.read 且账上 grant 匹配（声明的权限 ⊆ 授权集合 且 代码哈希相等）
 *   → activate（跨重启持久化授权）；
 * - 其余一切（media.control/network.request 通道未开放归 #337/#338、无账、哈希漂移、
 *   权限漂移）→ pending-approval（批准前不执行；同 id 新代码不继承旧批准）。
 */
export function authorizeDroppedPackageWithGrant(input: {
  permissions?: readonly string[]
  /** 可选权限声明面（工单337）：账面授予的可选子集必须落在声明面内 */
  optionalPermissions?: readonly string[]
  grant: GrantLookup | null
  codeHash: string
}): AuthorizationDecision {
  const perms = input.permissions ?? []
  if (perms.length === 0) return 'activate'
  // 敏感权限通道开放度（工单336/337）：media.read 与 media.control 已开放（后者可选、
  // 逐项批准——账面子集授权即放行）；network.request 等仍未开放（混入即不放行——账面即便匹配也不行）
  const openChannels = new Set(['media.read', 'media.control'])
  if (!perms.every((p) => openChannels.has(p))) return 'pending-approval'
  const grant = input.grant
  if (!grant) return 'pending-approval'
  if (grant.codeHash !== input.codeHash) return 'pending-approval'
  // 权限集合绑定（工单337 可选权限语义）：必需权限全部在账 + 账面不越声明面
  // （必需 ∪ 可选）——可选未授 = 降级运行（不是不激活）；账面越声明面 = 漂移
  const declared = new Set([...perms, ...(input.optionalPermissions ?? [])])
  const granted = grant.permissions
  if (!perms.every((p) => granted.includes(p))) return 'pending-approval'
  if (!granted.every((p) => declared.has(p))) return 'pending-approval'
  return 'activate'
}
