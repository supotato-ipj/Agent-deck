import fs from 'node:fs'
import path from 'node:path'
import { PLUGIN_CAPABILITIES, type PluginCapability, type PluginManifest } from '../../shared/contract'

/**
 * 插件 manifest 契约（工单10 辅缝）：纯逻辑校验，无 fs / 无 Electron。
 * id 同时是协议主机名（`deck-plugin://<id>/…`），故字符集与寻址安全一并在此收口。
 */

/** 协议主机名的合法字符集：小写字母数字打头，其后可含 `-` `.` `_` */
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/

/** 合法能力集（与快照段同源，新增快照段须同步登记） */
const CAPABILITY_SET = new Set<string>(PLUGIN_CAPABILITIES)

export type ManifestResult = { manifest?: PluginManifest; error?: string }

/** manifest 顶层文件名（插件目录内唯一定位文件） */
export const MANIFEST_FILE = 'plugin.json'

function str(raw: unknown): string | null {
  return typeof raw === 'string' ? raw : null
}

/** 入口相对路径校验：必须是插件目录内的 .js/.mjs 文件——绝对路径、盘符、反斜杠、穿越一律拒绝 */
function validEntry(entry: string): boolean {
  if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) return false
  if (entry.includes('\\')) return false
  if (entry.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(entry)) return false
  return !entry.split('/').includes('..')
}

/**
 * 解析 plugin.json 原文：返回校验通过的 manifest 或中文原因。
 * 必填项缺失即整体失效（插件不装载）；可选字段类型不合规则丢弃该字段——
 * 「少给而非不给」，一份坏 manifest 不该连累插件的其它合法声明。
 */
export function parseManifest(raw: unknown): ManifestResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'plugin.json 顶层必须是对象' }
  }
  const m = raw as Record<string, unknown>

  const id = str(m.id)
  if (id === null || id === '') return { error: 'plugin.json 缺 id' }
  if (!ID_RE.test(id)) return { error: `plugin.json id 非法（非小写主机名字符集）: ${id}` }

  const name = str(m.name)?.trim() ?? ''
  if (!name) return { error: 'plugin.json 缺 name' }

  const version = str(m.version)?.trim() ?? ''
  if (!version) return { error: 'plugin.json 缺 version' }

  const entry = str(m.entry)
  if (entry === null || entry === '') return { error: 'plugin.json 缺 entry' }
  if (!validEntry(entry)) return { error: `plugin.json entry 非法（须为插件目录内的 .js/.mjs）: ${entry}` }

  const rawCaps = Array.isArray(m.capabilities) ? m.capabilities : []
  // 未知能力串静默丢弃：能力是收窄方向的声明，认不得的能力一律不给
  const capabilities: PluginCapability[] = [...new Set(
    rawCaps.filter((c): c is PluginCapability => typeof c === 'string' && CAPABILITY_SET.has(c)),
  )]

  const mount = str(m.mount)?.trim() || undefined
  const order = typeof m.order === 'number' && Number.isFinite(m.order) ? m.order : undefined

  return { manifest: { id, name, version, entry, capabilities, ...(mount ? { mount } : {}), ...(order === undefined ? {} : { order }) } }
}

/** 读盘解析：文件缺失/非法 JSON 与校验失败走同一形状（错误即不装载） */
export function readManifest(dir: string): ManifestResult {
  const file = path.join(dir, MANIFEST_FILE)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return { error: `缺少 ${MANIFEST_FILE}` }
  }
  try {
    return parseManifest(JSON.parse(text))
  } catch {
    return { error: `${MANIFEST_FILE} 不是合法 JSON` }
  }
}
