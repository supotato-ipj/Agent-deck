// 插件限额覆写（工单345，ADR-0025「用户可收紧不可放宽」的配置面与执行面共用逻辑）：
// config.json `plugins.limits` 段的合并校验（放宽/非法值结构化拒绝）+ 每包生效限额
// 计算（min(目录默认值, 覆写值)）+ 契约投影两栏（默认值/生效值）+ 装配缝切片。
//
// 纯数据 + 纯函数：无 fs、无 Electron。限额默认值的单一正典是 catalog.ts 权限目录
// （permissions[n].limits）——本模块只引用不复制；错误码登记在同一目录（limit_widen_rejected /
// limit_invalid）。Broker 侧另做一道 min 钳制（构造期生效）：配置面拒绝 + 执行面钳制双保险，
// 越权配置在任何一层都不可能让包拿到更宽限额。

import { PLUGIN_CONTRACT_CATALOG, type PermissionLimitColumns } from './catalog'
import { PLUGIN_ID_RE } from './manifest'

/**
 * 归一覆写形状（config.plugins.limits 合并产物，也是 PluginsConfig.limits 的类型）：
 * 包 id → 权限 id → 限额键 → 正整数覆写值。只含通过校验的条目。
 */
export type PackageLimitOverrides = Record<string, Record<string, Record<string, number>>>

/** 拒绝错误码（登记在契约错误目录，kind=gate）：放宽与非法值分码 */
export type LimitRejectionCode = 'limit_widen_rejected' | 'limit_invalid'

/** 结构化拒绝记录：错误码 + 配置路径 + 用户可读 message（config.ts 原样转 warning） */
export interface LimitRejection {
  code: LimitRejectionCode
  /** 配置路径（不含 config.plugins.limits 前缀）：`<pkg>.<perm>.<key>` / `<pkg>` / `<pkg>.<perm>` */
  path: string
  message: string
}

/**
 * 本票开放的覆写面（工单345 共识裁定）：network.request 全部 4 键 + media.control 速率。
 * 键清单不在此复制——从权限目录正典取该权限 limits 的全部键；未来开放 media.read 等
 * 权限时把 id 加进此清单即可（目录加了键这里自动跟随，不存在第二处正典）。
 */
const OVERRIDABLE_PERMISSION_IDS: readonly string[] = ['network.request', 'media.control']

/** 权限 id → 该权限可覆写的限额键集合（值从目录正典推导，只读） */
function overridableKeys(): ReadonlyMap<string, ReadonlyMap<string, number>> {
  const out = new Map<string, ReadonlyMap<string, number>>()
  for (const p of PLUGIN_CONTRACT_CATALOG.permissions) {
    if (!OVERRIDABLE_PERMISSION_IDS.includes(p.id)) continue
    out.set(p.id, new Map(Object.entries(p.limits)))
  }
  return out
}

const OVERRIDABLE = overridableKeys()

/**
 * 逐条合并校验：raw 是 config.plugins.limits 的原值（未知形状）。
 *
 * 规则（ADR-0025「可收紧不可放宽」）：
 * - 条目值须为 ≥1 的整数（目录限额全是整数语义——速率/并发/毫秒/字节）；
 * - 覆写值 > 目录默认值 → `limit_widen_rejected`（放宽拒绝）；
 * - 非数/非整数/0/负数、未知权限、未知限额键、非法包 id → `limit_invalid`；
 * - 拒绝只剪该条目（同批合法条目照常生效，同 config.ts 各段「少给而非不给」惯例）；
 * - 空/缺段 = 无覆写，零拒绝（老 config 静默兼容）。
 */
export function mergeLimitsOverrides(raw: unknown): { limits: PackageLimitOverrides; rejections: LimitRejection[] } {
  const limits: PackageLimitOverrides = {}
  const rejections: LimitRejection[] = []
  if (raw === undefined) return { limits, rejections }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    rejections.push({
      code: 'limit_invalid',
      path: '',
      message: 'config.plugins.limits 不是对象，已整体回退默认（无覆写）——limit_invalid',
    })
    return { limits, rejections }
  }
  for (const [pkgId, permRaw] of Object.entries(raw as Record<string, unknown>)) {
    // 包 id 与 plugin.json 同一份字符集（manifest.ts 单一出处）：id 直接进配置键与
    // 寻址面，形态收紧才不会造出永不可能命中的键或带路径段的键
    if (typeof pkgId !== 'string' || !PLUGIN_ID_RE.test(pkgId)) {
      rejections.push({
        code: 'limit_invalid',
        path: pkgId,
        message: `config.plugins.limits 下的包 id 形态非法：${JSON.stringify(pkgId)}，已整包拒绝——limit_invalid`,
      })
      continue
    }
    if (typeof permRaw !== 'object' || permRaw === null || Array.isArray(permRaw)) {
      rejections.push({
        code: 'limit_invalid',
        path: pkgId,
        message: `config.plugins.limits.${pkgId} 不是对象，已整包拒绝——limit_invalid`,
      })
      continue
    }
    for (const [permId, limitsRaw] of Object.entries(permRaw as Record<string, unknown>)) {
      const defaults = OVERRIDABLE.get(permId)
      if (!defaults) {
        rejections.push({
          code: 'limit_invalid',
          path: `${pkgId}.${permId}`,
          message: `config.plugins.limits.${pkgId}.${permId} 不在可覆写权限面（network.request / media.control），已拒绝——limit_invalid`,
        })
        continue
      }
      if (typeof limitsRaw !== 'object' || limitsRaw === null || Array.isArray(limitsRaw)) {
        rejections.push({
          code: 'limit_invalid',
          path: `${pkgId}.${permId}`,
          message: `config.plugins.limits.${pkgId}.${permId} 不是对象，已拒绝——limit_invalid`,
        })
        continue
      }
      for (const [key, value] of Object.entries(limitsRaw as Record<string, unknown>)) {
        const path = `${pkgId}.${permId}.${key}`
        const base = defaults.get(key)
        if (base === undefined) {
          rejections.push({
            code: 'limit_invalid',
            path,
            message: `config.plugins.limits.${path} 不是该权限已登记的限额键，已拒绝——limit_invalid`,
          })
          continue
        }
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
          rejections.push({
            code: 'limit_invalid',
            path,
            message: `config.plugins.limits.${path} 须为 1..${base} 的整数（可收紧不可放宽），已拒绝该条目——limit_invalid`,
          })
          continue
        }
        if (value > base) {
          rejections.push({
            code: 'limit_widen_rejected',
            path,
            message: `config.plugins.limits.${path}=${value} 超过目录默认值 ${base}（可收紧不可放宽），已拒绝该条目——limit_widen_rejected`,
          })
          continue
        }
        // 合法收紧（含收紧到默认值）：进产物
        ;(limits[pkgId] ??= {})[permId] ??= {}
        limits[pkgId][permId][key] = value
      }
    }
  }
  return { limits, rejections }
}

/** 单包单权限的覆写切片（合法正整数才参与生效计算） */
function overrideValue(overrides: PackageLimitOverrides | undefined, packageId: string, permId: string, key: string): number | null {
  const v = overrides?.[packageId]?.[permId]?.[key]
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? v : null
}

/**
 * 权限限额两栏投影（默认值 / 当前生效值）：覆盖目录内全部权限限额（含本票不可覆写的
 * media.read——投影是完整契约视图，可覆写面由配置校验把守）。packageId 缺省 = 无包
 * 上下文的默认视图（effective === default）。
 */
export function permissionLimitColumns(overrides: PackageLimitOverrides | undefined, packageId?: string): PermissionLimitColumns {
  const out: PermissionLimitColumns = {}
  for (const p of PLUGIN_CONTRACT_CATALOG.permissions) {
    out[p.id] = {}
    for (const key of Object.keys(p.limits)) {
      const base = p.limits[key]
      const v = packageId ? overrideValue(overrides, packageId, p.id, key) : null
      out[p.id][key] = { default: base, effective: v === null ? base : Math.min(base, v) }
    }
  }
  return out
}

/** 装配缝切片：从归一覆写中抽某权限的每包切片（Broker packageLimits 选项形状） */
export function packagePermissionSlice(overrides: PackageLimitOverrides | undefined, permissionId: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  if (!overrides) return out
  for (const [pkgId, perms] of Object.entries(overrides)) {
    const slice = perms[permissionId]
    if (slice && Object.keys(slice).length > 0) out[pkgId] = { ...slice }
  }
  return out
}
