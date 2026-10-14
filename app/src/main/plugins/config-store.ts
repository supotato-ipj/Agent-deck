// 插件私有状态存储的纯逻辑（工单178，ADR-0014 决策 (c)）：按插件 id 命名空间的键值。
// 无 fs / 无 Electron——落盘真源是 desktop/adapter 的 tmp+rename 原子写单一出处，
// 本模块只管「什么样的值算合法」「合并后长什么样」「多大算超限」。
//
// 强度沿用项目既有惯例（config.ts 合并校验 + layout-store.ts 损坏自愈）：
// 坏值逐键回退并记 warning，不整体失败；坏 JSON 视同空对象。超限拒收不静默截断。

import { PLUGIN_ID_RE } from './manifest'

/**
 * 单个命名空间的体积上限（UTF-8 字节）：超限即拒收并如实回报（抛 BridgeError）。
 * 64 KiB 对「组卡存组定义与临时卡序号」这类运行态数据绰绰有余，又能让单个插件包
 * 撑不爆面板的状态目录。超限不截断——静默截断等于让调用方以为整份写进去了。
 */
export const PLUGIN_CONFIG_MAX_BYTES = 64 * 1024

/** 嵌套深度上限：值须落在 JSON 数据模型内，畸形深嵌套（自引用/万层）在判定阶段就被拒 */
const MAX_DEPTH = 64

/**
 * 值是否落在 JSON 数据模型内：纯对象 / 数组 / 字符串 / **有限**数 / 布尔 / null。
 *
 * 判据是「原样往返 JSON 而不丢信息」，故以下一律判为坏值：
 * undefined 与函数/符号（JSON.stringify 会整个丢掉该键）、NaN/Infinity（静默变 null）、
 * Date/Map/Set/类实例（静默变成别的形态）、以及自引用结构（直接抛）。
 */
export function jsonValueOk(value: unknown, depth = 0, seen: Set<object> = new Set()): boolean {
  if (depth > MAX_DEPTH) return false
  if (value === null) return true
  const t = typeof value
  if (t === 'string' || t === 'boolean') return true
  if (t === 'number') return Number.isFinite(value as number)
  if (t !== 'object') return false
  const obj = value as object
  if (seen.has(obj)) return false // 自引用：JSON.stringify 会直接抛
  seen.add(obj)
  try {
    if (Array.isArray(obj)) return obj.every((item) => jsonValueOk(item, depth + 1, seen))
    // 只认纯对象（原型为 Object.prototype 或 null）：类实例/Date/Map 等一律判坏
    const proto = Object.getPrototypeOf(obj)
    if (proto !== Object.prototype && proto !== null) return false
    return Object.values(obj as Record<string, unknown>).every((v) => jsonValueOk(v, depth + 1, seen))
  } finally {
    seen.delete(obj)
  }
}

/** 键名非空字符串（空键在文件里不可寻址，逐键回退不适用） */
function keyOk(key: string): boolean {
  return key !== ''
}

export interface PluginConfigMergeResult {
  config: Record<string, unknown>
  /** 本次合并的自愈记录（坏值逐键回退……）；调用方负责记 warning 并如实回传 */
  warnings: string[]
}

/**
 * 逐键合并校验（写路径）：patch 逐键覆盖 base。
 *
 * 坏值（不在 JSON 数据模型内、空键）**逐键**回退——保留 base 里的既有值、若原本没有则
 * 该键不落盘；其余键照常合并。整份不失败，与 config.ts 的 mergePanel/mergePlugins 同款
 * 「少给而非不给」。patch 整体非对象则视同空补丁（无键可校验，无 warning）。
 */
export function mergePluginConfig(
  base: Record<string, unknown>,
  patch: unknown,
): PluginConfigMergeResult {
  const config: Record<string, unknown> = { ...base }
  const warnings: string[] = []
  if (patch === undefined || patch === null) return { config, warnings }
  if (typeof patch !== 'object' || Array.isArray(patch)) {
    warnings.push('plugin-config patch 不是对象，已按空补丁处理（未改动任何键）')
    return { config, warnings }
  }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!keyOk(key)) {
      warnings.push(`plugin-config.${key} 键名非法（空键不可寻址），已回退`)
      continue
    }
    if (!jsonValueOk(value)) {
      warnings.push(`plugin-config.${key} 值不在 JSON 数据模型内，已保留既有值（该键本次未写）`)
      continue
    }
    config[key] = value
  }
  return { config, warnings }
}

/**
 * 解析落盘文本（读路径）：null = 从未写过（首次装载，区别于「写坏了」）。
 * 坏 JSON / 顶层非对象 → 空对象并记 warning（损坏自愈，下次保存覆写，同 loadTaskbarStore）；
 * 顶层对象里逐键再校验一遍——坏键丢弃记 warning，其余键照常读入（逐键自愈，不拖垮整份）。
 */
export function loadPluginConfig(text: string | null): { config: Record<string, unknown>; warnings: string[]; missing: boolean } {
  if (text === null) return { config: {}, warnings: [], missing: true }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { config: {}, warnings: ['plugin-config 文件不是合法 JSON，已视同空对象'], missing: false }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { config: {}, warnings: ['plugin-config 文件顶层不是对象，已视同空对象'], missing: false }
  }
  // 逐键自愈：坏键丢、其余留（与写路径同一份判据，不给读/写两套口径）
  return { ...mergePluginConfig({}, raw), missing: false }
}

/** 序列化（与 taskbar/layout-store 同款：两空格缩进 + 尾换行，便于人工看与手工改） */
export function serializePluginConfig(config: Record<string, unknown>): string {
  return JSON.stringify(config, null, 2) + '\n'
}

/**
 * 命名空间 id 形态校验：与 plugin.json 的 id 同一份字符集（manifest.ts 单一出处）。
 *
 * 这一条防的是**寻址安全**——id 直接当文件名，字符集收紧才不会把文件写到
 * plugin-config 目录之外（`/`、`\`、盘符、`..` 一律不在集内）。
 *
 * 它**不是**命名空间隔离：字符合法与否与「这份状态归谁」无关，调用方照样可以自证
 * 别人的合法 id 去读写别人的命名空间（ADR-0014 Consequences：id 由调用方自证）。
 */
export function validPluginConfigId(id: unknown): id is string {
  return typeof id === 'string' && PLUGIN_ID_RE.test(id)
}
