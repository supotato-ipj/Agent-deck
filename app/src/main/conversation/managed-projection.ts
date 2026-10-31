// 管理型信任档只读投影（工单333，ADR-0009 单点分派 / ADR-0010 档×客体裁剪 / ADR-0025 契约目录）：
//
// 后端档（管理型会话）经 MCP 能看到的**封闭工具集**——面板快照、插件清单（内核+投放两路）、
// 用户根源码、机器可读插件契约目录。全部只读：**任何控制面写在本票不存在**（ADR-0009 投影
// 之外是「不存在」而非「被拒」——MCP 工具面即投影，投影外工具名一律 unknown_tool，不静默
// 放行、不返回空成功）。
//
// 分派经注入的 source 端口抵达主进程单点（生产装配 = bridge.snapshot()/plugins 清单服务），
// 宿主与投影模块都不私开第二条执行路径。目录本体取 catalog.ts 的单一正典（#331），经
// projectCatalog 的 agent 受众投影——批准 UI 与 agent 同源不同段（ADR-0025）。
//
// 纯逻辑 + node:fs 薄工厂：无 Electron，Vitest 全覆盖。

import fs from 'node:fs'
import path from 'node:path'
import { PACKAGE_RESOURCE_LIMITS, PLUGIN_CONTRACT_CATALOG, projectCatalog } from '../plugins/catalog'

/** MCP tools/list 的工具描述（inputSchema 用 JSON Schema 2020-12 子集） */
export interface ManagedToolDescriptor {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** 管理型工具封闭集（顺序即 tools/list 顺序） */
export const MANAGED_TOOLS: readonly ManagedToolDescriptor[] = Object.freeze([
  {
    name: 'panel_snapshot',
    description: '读取面板当前快照（只读）：时钟/会话/硬件/天气/桌面/布局/设置/插件八段（panel/snapshot 同源单点）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'plugins_list',
    description: '读取插件清单（只读）：kernel 内置/第一方包与 dropped 用户投放包两路清单，含状态与错误态。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'plugin_source',
    description: '读取用户插件根（dropped 档）的插件源码（只读）：path 缺省列目录，给相对路径读文件内容；仅限用户根内，越界拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        pluginId: { type: 'string', description: '插件目录名（用户根下的目录）' },
        path: { type: 'string', description: '插件目录内的相对路径；缺省 = 列目录' },
      },
      required: ['pluginId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plugin_contract_catalog',
    description: '读取机器可读插件契约目录（只读发现面，不授予权限）：manifest 形状/宿主 API 版本策略/基线宿主域/权限目录/结构化错误/资源上限。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'plugin_install_submit',
    // 工单334 确定性安装操作（ADR-0019 写入契约 / ADR-0025 批准面）：MCP 只收路径不收代码正文；
    // 包 = 会话工作区内目录，含 plugin.json（id/name/version/entry/hostApiVersion=当前主版本/
    // permissions 必须为空数组=零权限）+ entry 指向的 .js/.mjs（default 导出 mount(host)）。
    // 上限：总量 8MiB/单文件 2MiB/256 文件/深度 8/扩展名白名单（js/mjs/css/json/html/svg/png/woff2）；
    // 拒 node_modules/.git/符号链接/敏感权限包（permission_deferred）。提交后进入待批准
    // （字节进待装载区，热插拔不可见），真实用户批准前不执行；结果以 plugins_list 对账。
    // 失败不自动重试——按结构化错误修复后重新提交。
    description: '提交一个零权限插件包供用户批准安装（确定性操作）：sourceDir 必须是本会话工作区内的绝对路径目录，包含 plugin.json（零权限 manifest）与入口 JS。批准前代码不执行；本工具不等待批准结果（异步提案），用 plugins_list 观察状态。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceDir: { type: 'string', description: '包目录的绝对路径（必须在会话工作区内）' },
      },
      required: ['sourceDir'],
      additionalProperties: false,
    },
  },
])

/** 生产投影源端口（主进程单点的薄引用——由装配层注入） */
export interface ManagedProjectionSource {
  panelSnapshot(): unknown
  pluginsList(): unknown
  pluginSource(args: { pluginId: string; path?: string }): unknown
  contractCatalog(): unknown
  /** 安装提交（工单334 写工具；缺省 = 本装配未接线，工具如实报不可用） */
  installSubmit?(args: { sourceDir: string }, ctx: { sessionId: string }): Promise<unknown>
}

export type ManagedToolOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; reason: 'unknown_tool' | 'invalid_args' | 'source_error'; message: string }

/** 单工具分派：封闭集查表 → source 端口；一切失败都是明确错误（无空成功） */
export async function dispatchManagedTool(
  name: string,
  args: unknown,
  source: ManagedProjectionSource,
  ctx?: { sessionId: string },
): Promise<ManagedToolOutcome> {
  const tool = MANAGED_TOOLS.find((t) => t.name === name)
  if (!tool) {
    return { ok: false, reason: 'unknown_tool', message: `未知工具: ${name}（管理型会话只有只读投影，投影外工具不存在）` }
  }
  try {
    switch (tool.name) {
      case 'panel_snapshot':
        return { ok: true, payload: source.panelSnapshot() }
      case 'plugins_list':
        return { ok: true, payload: source.pluginsList() }
      case 'plugin_contract_catalog':
        return { ok: true, payload: source.contractCatalog() }
      case 'plugin_install_submit': {
        const a = (args ?? {}) as { sourceDir?: unknown }
        if (typeof a.sourceDir !== 'string' || !a.sourceDir.trim()) {
          return { ok: false, reason: 'invalid_args', message: 'plugin_install_submit 需要 sourceDir（包目录绝对路径，必须在会话工作区内）' }
        }
        if (!path.isAbsolute(a.sourceDir)) {
          return { ok: false, reason: 'invalid_args', message: 'sourceDir 必须是绝对路径（MCP 只收路径不收正文）' }
        }
        if (!source.installSubmit) {
          return { ok: false, reason: 'source_error', message: '本面板未装配安装面（install 未接线）——安装工具不可用' }
        }
        // sessionId 从 bearer 通道绑定来（ctx），绝不采信参数自报
        const payload = await source.installSubmit({ sourceDir: a.sourceDir }, { sessionId: ctx?.sessionId ?? '' })
        return { ok: true, payload }
      }
      case 'plugin_source': {
        const a = (args ?? {}) as { pluginId?: unknown; path?: unknown }
        if (typeof a.pluginId !== 'string' || !a.pluginId.trim() || path.isAbsolute(a.pluginId)) {
          return { ok: false, reason: 'invalid_args', message: 'plugin_source 需要 pluginId（用户根下的插件目录名，字符串）' }
        }
        if (a.path !== undefined && typeof a.path !== 'string') {
          return { ok: false, reason: 'invalid_args', message: 'path 必须是插件目录内的相对路径字符串' }
        }
        return { ok: true, payload: source.pluginSource({ pluginId: a.pluginId, path: a.path }) }
      }
      default:
        return { ok: false, reason: 'unknown_tool', message: `未知工具: ${name}` }
    }
  } catch (err) {
    return { ok: false, reason: 'source_error', message: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// 生产 source 工厂（node:fs 薄实现；纯注入端口在测试里替代）
// ---------------------------------------------------------------------------

const SOURCE_MAX_FILE_BYTES = PACKAGE_RESOURCE_LIMITS.maxFileBytes

/** 目录列条目（file/dir + 文件字节数） */
interface SourceDirEntry {
  name: string
  type: 'file' | 'dir' | 'other'
  sizeBytes?: number
}

/**
 * node:fs 实现的生产 source：panelSnapshot/pluginsList/contractCatalog 由装配层给单点
 * 引用；pluginSource 在 userRoot 内做包含校验（resolve 后前缀断言 + symlink 逃逸同样
 * 被 resolve 后前缀检查拦住）、体积上限（PACKAGE_RESOURCE_LIMITS.maxFileBytes 口径）。
 * 全部失败抛错 → dispatchManagedTool 归一为 source_error。
 */
export function createNodeProjectionSource(deps: {
  userRoot: string
  panelSnapshot: () => unknown
  pluginsList: () => unknown
  /** 安装提交缝（工单334；缺省 = 未装配，工具如实报不可用） */
  installSubmit?: (args: { sourceDir: string }, ctx: { sessionId: string }) => Promise<unknown>
}): ManagedProjectionSource {
  return {
    panelSnapshot: () => deps.panelSnapshot(),
    pluginsList: () => deps.pluginsList(),
    installSubmit: deps.installSubmit,
    contractCatalog: () => projectCatalog(PLUGIN_CONTRACT_CATALOG, 'agent'),
    pluginSource: ({ pluginId, path: relPath }) => {
      const rootReal = fs.realpathSync(deps.userRoot)
      const pluginRoot = path.resolve(rootReal, pluginId)
      // 包含校验（双保险：.. 上跳、绝对路径、插件名本身带路径段都被 resolve+前缀断言拦住）
      if (pluginRoot !== rootReal && !pluginRoot.startsWith(rootReal + path.sep)) {
        throw new Error(`插件目录越界: ${pluginId}`)
      }
      if (!fs.existsSync(pluginRoot) || !fs.statSync(pluginRoot).isDirectory()) {
        throw new Error(`用户根中不存在插件目录: ${pluginId}`)
      }
      const pluginReal = fs.realpathSync(pluginRoot)
      if (!relPath || relPath.trim() === '' || relPath.trim() === '.') {
        const entries: SourceDirEntry[] = []
        for (const name of fs.readdirSync(pluginReal).sort()) {
          const st = fs.lstatSync(path.join(pluginReal, name))
          entries.push(st.isDirectory()
            ? { name, type: 'dir' }
            : { name, type: st.isFile() ? 'file' : 'other', sizeBytes: st.isFile() ? st.size : undefined })
        }
        return { pluginId, root: pluginReal, entries }
      }
      const target = path.resolve(pluginReal, relPath)
      if (target !== pluginReal && !target.startsWith(pluginReal + path.sep)) {
        throw new Error(`路径越界: ${relPath}`)
      }
      if (!fs.existsSync(target)) throw new Error(`文件不存在: ${relPath}`)
      const st = fs.statSync(target)
      if (!st.isFile()) throw new Error(`不是普通文件: ${relPath}`)
      if (st.size > SOURCE_MAX_FILE_BYTES) {
        throw new Error(`文件超出读取上限（${st.size} > ${SOURCE_MAX_FILE_BYTES} 字节）: ${relPath}`)
      }
      return { pluginId, path: relPath, content: fs.readFileSync(target, 'utf8'), bytes: st.size }
    },
  }
}
