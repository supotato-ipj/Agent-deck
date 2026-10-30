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
