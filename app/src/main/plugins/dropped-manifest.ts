import { PLUGIN_ID_RE } from './manifest'
import { currentHostApiVersion, knownPermissionIds } from './catalog'

/**
 * 投放包 manifest 迁移分类（工单331，ADR-0025）。
 *
 * 与内核档解析器（manifest.ts，宽松、少给而非不给）不同，投放档按 ADR-0025 走
 * **明确断裂迁移**：旧包（缺 `hostApiVersion` 主版本）、未知权限、宿主 API 不兼容
 * 一律给出结构化迁移错误 → 待迁移态；不保留旧同上下文/全 invoke 兼容层，不自动改写 JS。
 *
 * 两条宽松度基准（沿用 ADR-0019 手动投放口径）：
 * - capabilities（只读快照段声明）宽松：未知/越档串静默裁剪到投放四段，不使包失效；
 * - permissions（敏感权限声明）严格：权限目录是封闭集合，未知串 = 迁移错误
 *   （插件不能靠新字符串创造权限，静默裁剪会让包作者误以为权限已生效）。
 *
 * 纯逻辑：无 fs、无 Electron。常量（当前主版本 / 已知权限）取自 catalog.ts 单一正典。
 */

/**
 * 投放档只读快照段上限（正典登记，渲染层裁剪同源）：ADR-0019 投放窄面四段 + 工单336
 * 媒体段。media 段只在包获 media.read 授权时投喂（package-host 授权门交集，少给而非不给）。
 */
export const DROPPED_VIEW_SEGMENTS = Object.freeze(['clock', 'hardware', 'layout', 'settings', 'media'] as const)

/** 通过分类的投放包 manifest（零权限包 permissions 为空清单） */
export interface DroppedManifest {
  id: string
  name: string
  version: string
  entry: string
  /** 目标宿主 API 主版本（= 当前主版本才可通过） */
  hostApiVersion: number
  /** 声明的敏感权限（必需；已校验全部在权限目录内） */
  permissions: string[]
  /** 可选权限（工单337：逐项批准语义——批准面可只授必需集；已校验全部在权限目录内） */
  optionalPermissions: string[]
  /** 只读快照段（已裁剪到投放四段并去重） */
  capabilities: string[]
  mount?: string
  order?: number
}

/** 迁移问题：结构化、可读、机器可消费（进待迁移态） */
export interface MigrationIssue {
  /** 错误码（契约目录 errors 登记） */
  code: 'host_api_version_missing' | 'host_api_version_unsupported' | 'permission_unknown' | 'manifest_invalid'
  /** 中文可读原因（用户/agent 直接可读） */
  message: string
  /** host_api_version_unsupported 附属：期望主版本 */
  expected?: number
  /** host_api_version_unsupported 附属：实得主版本 */
  actual?: unknown
  /** permission_unknown 附属：未知权限串清单 */
  unknown?: string[]
}

export type DroppedManifestResult =
  | { ok: true; manifest: DroppedManifest }
  | { ok: false; issues: MigrationIssue[] }

function str(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null
}

/** 入口相对路径校验：与内核档同规则（插件目录内的 .js/.mjs，拒绝绝对/盘符/反斜杠/穿越） */
function validEntry(entry: string): boolean {
  if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) return false
  if (entry.includes('\\')) return false
  if (entry.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(entry)) return false
  return !entry.split('/').includes('..')
}

/** 主版本判定：正整数才参与比较；其余（字符串/小数/null）归不兼容 */
function asMajor(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null
}

/**
 * 投放包 manifest 迁移分类：通过 = 当前主版本的包（零权限或权限全在目录内）；
 * 否则给出**全部**迁移问题（一次报全，作者不用改一轮跑一轮）。顺序确定：
 * 结构错 → 缺主版本 → 主版本不兼容 → 未知权限。
 */
export function classifyDroppedManifest(raw: unknown): DroppedManifestResult {
  const issues: MigrationIssue[] = []
  const m = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : null) as Record<string, unknown> | null

  // —— 结构契约（沿用内核档同规则；结构坏不是「旧包」，进 error 态而非待迁移态）——
  let id = '', name = '', version = '', entry = ''
  if (!m) {
    issues.push({ code: 'manifest_invalid', message: 'plugin.json 顶层必须是对象' })
  } else {
    id = str(m.id) ?? ''
    name = (str(m.name) ?? '').trim()
    version = (str(m.version) ?? '').trim()
    entry = str(m.entry) ?? ''
    if (!id) issues.push({ code: 'manifest_invalid', message: 'plugin.json 缺 id' })
    else if (!PLUGIN_ID_RE.test(id)) issues.push({ code: 'manifest_invalid', message: `plugin.json id 非法（非小写主机名字符集）: ${id}` })
    if (!name) issues.push({ code: 'manifest_invalid', message: 'plugin.json 缺 name' })
    if (!version) issues.push({ code: 'manifest_invalid', message: 'plugin.json 缺 version' })
    if (!entry) issues.push({ code: 'manifest_invalid', message: 'plugin.json 缺 entry' })
    else if (!validEntry(entry)) issues.push({ code: 'manifest_invalid', message: `plugin.json entry 非法（须为插件目录内的 .js/.mjs）: ${entry}` })
  }

  // —— hostApiVersion 主版本（AC5：缺失 = 旧模型包；不匹配 = 不兼容）——
  const current = currentHostApiVersion()
  if (m) {
    if (!('hostApiVersion' in m) || m.hostApiVersion === undefined) {
      issues.push({ code: 'host_api_version_missing', message: `manifest 缺 hostApiVersion：这是旧模型插件包（同上下文/全 invoke 路径已退役），须按当前主版本（${current}）改写 manifest 后重新投放` })
    } else {
      const major = asMajor(m.hostApiVersion)
      if (major === null || major !== current) {
        issues.push({ code: 'host_api_version_unsupported', message: `hostApiVersion 主版本 ${String(m.hostApiVersion)} 与宿主当前主版本（${current}）不兼容：同主版本才可装载，须迁移后重新投放`, expected: current, actual: m.hostApiVersion })
      }
    }
  }

  // —— permissions（封闭权限目录；未知串 = 迁移错误，静默放行会让作者误以为已生效）——
  let permissions: string[] = []
  if (m && 'permissions' in m && m.permissions !== undefined) {
    const rawPerms = m.permissions
    if (Array.isArray(rawPerms) && rawPerms.every((p) => typeof p === 'string')) {
      const known = new Set(knownPermissionIds())
      const unknown = [...new Set(rawPerms.filter((p: string) => !known.has(p)))]
      if (unknown.length > 0) {
        issues.push({ code: 'permission_unknown', message: `manifest 声明了权限目录外的未知权限（${unknown.join('、')}）：权限是封闭目录，须改用目录内权限或升宿主主版本`, unknown })
      } else {
        permissions = [...new Set(rawPerms as string[])]
      }
    } else {
      issues.push({ code: 'permission_unknown', message: 'manifest permissions 须为字符串数组：无法解释的声明按未知权限处置，不静默放行' })
    }
  }

  // —— optionalPermissions（工单337：可选权限逐项批准；封闭目录同严——未知串 = 迁移错误）——
  let optionalPermissions: string[] = []
  if (m && 'optionalPermissions' in m && m.optionalPermissions !== undefined) {
    const rawOpt = m.optionalPermissions
    if (Array.isArray(rawOpt) && rawOpt.every((p) => typeof p === 'string')) {
      const known = new Set(knownPermissionIds())
      const unknown = [...new Set(rawOpt.filter((p: string) => !known.has(p)))]
      if (unknown.length > 0) {
        issues.push({ code: 'permission_unknown', message: `manifest 声明了权限目录外的未知可选权限（${unknown.join('、')}）：权限是封闭目录，须改用目录内权限或升宿主主版本`, unknown })
      } else {
        optionalPermissions = [...new Set(rawOpt as string[])]
      }
    } else {
      issues.push({ code: 'permission_unknown', message: 'manifest optionalPermissions 须为字符串数组：无法解释的声明按未知权限处置，不静默放行' })
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  // —— capabilities（投放宽松：未知/越档串静默裁剪，少给而非不给）——
  const allowedViews = new Set<string>(DROPPED_VIEW_SEGMENTS)
  const rawCaps = Array.isArray(m?.capabilities) ? (m!.capabilities as unknown[]) : []
  const capabilities = [...new Set(rawCaps.filter((c): c is string => typeof c === 'string' && allowedViews.has(c)))]

  const mount = str(m?.mount)?.trim() || undefined
  const order = typeof m?.order === 'number' && Number.isFinite(m!.order) ? m!.order : undefined

  return {
    ok: true,
    manifest: {
      id, name, version, entry,
      hostApiVersion: current,
      permissions,
      optionalPermissions,
      capabilities,
      ...(mount ? { mount } : {}),
      ...(order === undefined ? {} : { order }),
    },
  }
}
