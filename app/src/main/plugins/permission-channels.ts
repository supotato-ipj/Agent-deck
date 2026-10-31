/**
 * 敏感权限「批准通道开放度」单一正典（工单336/337/338）。
 *
 * 「开放」= 有完整批准面：提案数据面 → 批准手势 → 授权账落账 → 运行时消费路径。
 * 三个消费点共用本表——**三处各写一遍曾在工单338 真机轮踩过**：
 * 手动投放提案挂载只认 media.read，网络包投进用户根后连批准 UI 都不出现。
 *
 * 纯常量：无 fs、无 Electron。
 */
export const OPEN_PERMISSION_CHANNELS: ReadonlySet<string> = new Set([
  'media.read',   // 工单336
  'media.control', // 工单337（可选权限逐项批准）
  'network.request', // 工单338（origin 参数面随账落账）
])

/** 该权限是否有完整批准通道（未开放 = 安装闸门结构化拒付 permission_deferred） */
export function isPermissionChannelOpen(permissionId: string): boolean {
  return OPEN_PERMISSION_CHANNELS.has(permissionId)
}
