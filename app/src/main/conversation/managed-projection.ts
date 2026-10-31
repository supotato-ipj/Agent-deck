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
    // 失败不自动重试——按结构化错误修复后重新提交。撞见卸载残留私有配置时提案带
    // 「旧数据继承」独立批准项（工单335；继承与否由用户独立决定，不合并进代码批准）。
    description: '提交一个零权限插件包供用户批准安装（确定性操作）：sourceDir 必须是本会话工作区内的绝对路径目录，包含 plugin.json（零权限 manifest）与入口 JS。批准前代码不执行；本工具不等待批准结果（异步提案），用 plugins_list 观察状态。同 id 曾被卸载且留有私有配置时，提案附带「旧数据继承」独立批准项（用户独立决定，未决默认新配置起步）。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceDir: { type: 'string', description: '包目录的绝对路径（必须在会话工作区内）' },
      },
      required: ['sourceDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'plugin_update_submit',
    // 工单335 确定性更新操作（ADR-0019 update 换入 / ADR-0025 代次批准）：目标=用户根在册包；
    // 源 manifest id 必须等于目标 id（不允许改名）；新字节进待装载区，**待批期间旧代次继续
    // 运行**；提案带旧→新 diff 与权限变化；批准=原子换代（旧版送回收站），拒绝不影响旧代次；
    // 相同字节 → no_change（不重载、不制造批准）。正常更新保留包私有配置。敏感权限包
    // permission_deferred。busy = 有写操作在途（唯一可重试）；结果未知不重放，以 plugins_list 对账。
    description: '提交一个已安装零权限插件包的更新供用户批准（确定性操作）：packageId=用户根在册包 id，sourceDir=本会话工作区内的新版包目录（manifest id 必须与 packageId 一致，零权限）。待批期间旧版本继续运行；批准后原子替换；字节与在册完全相同时返回 no_change（无需批准）。本工具不等待批准结果，用 plugins_list 对账。',
    inputSchema: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '目标包 id（用户插件根中已安装）' },
        sourceDir: { type: 'string', description: '新版包目录的绝对路径（必须在会话工作区内，manifest id 与 packageId 一致）' },
      },
      required: ['packageId', 'sourceDir'],
      additionalProperties: false,
    },
  },
  {
    name: 'plugin_set_enabled',
    // 工单335 停用/启用（ADR-0019 沿用既有 settings 停用集缝，W 免闸门——可逆不引入代码）：
    // 停用=解除挂载保留目录与私有配置；启用=恢复挂载。接既有 config.plugins.disabled 停用集。
    description: '停用或启用一个插件包（确定性、可逆操作）：停用=解除挂载但保留包目录与私有配置；启用=重新挂载。对内置/第一方包与投放包同样有效（settings 停用集）。',
    inputSchema: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '插件包 id' },
        enabled: { type: 'boolean', description: 'true=启用，false=停用' },
      },
      required: ['packageId', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'plugin_uninstall',
    // 工单335 卸载（ADR-0019/0025）：只对用户根投放包；目录送**回收站**（失败明确报错，
    // 绝不降级永久删除）；私有配置保留但脱离挂载；同 id 重装的旧数据继承由用户独立批准。
    // 内核/第一方包不可卸载（只能停用，not_manageable）。卸载后清单以 plugins_list 对账。
    description: '卸载一个用户根投放插件包（确定性操作）：包目录送系统回收站（误删可找回；回收站失败即失败，绝不永久删除）。私有配置保留但脱离挂载——同 id 重装时是否继承旧数据由用户独立批准。内置/第一方包不可卸载。',
    inputSchema: {
      type: 'object',
      properties: {
        packageId: { type: 'string', description: '要卸载的包 id（用户插件根中已安装）' },
      },
      required: ['packageId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plugins_rescan',
    // 工单335 确定性重扫（ADR-0019：无参数无闸门；触发的重载与 watcher 同源）：手动投放/
    // watcher 失效后的目录重新入列；返回最新投放包清单供对账（R 档，不做任何写）。
    description: '触发插件目录重扫（只读对账操作）：刷新扫描并返回最新投放包清单。不改变任何包——用于手动投放或 watcher 失效后让目录重新入列，以及写操作结果未知后的状态对账。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
  /** 更新提交（工单335 写工具；缺省 = 未接线如实报不可用） */
  updateSubmit?(args: { packageId: string; sourceDir: string }, ctx: { sessionId: string }): Promise<unknown>
  /** 停用/启用（工单335 写工具，接 settings 停用集缝；缺省 = 未接线如实报不可用） */
  setEnabled?(args: { packageId: string; enabled: boolean }): Promise<unknown>
  /** 卸载（工单335 写工具，回收站路径；缺省 = 未接线如实报不可用） */
  uninstallPackage?(args: { packageId: string }): Promise<unknown>
  /** 确定性重扫（工单335 对账操作；缺省 = 未接线如实报不可用） */
  rescan?(): unknown
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
      case 'plugin_update_submit': {
        // 工单335：与 install 同族——只收路径；sessionId 从 bearer 通道绑定来
        const a = (args ?? {}) as { packageId?: unknown; sourceDir?: unknown }
        if (typeof a.packageId !== 'string' || !a.packageId.trim()) {
          return { ok: false, reason: 'invalid_args', message: 'plugin_update_submit 需要 packageId（用户根中已安装的包 id）' }
        }
        if (typeof a.sourceDir !== 'string' || !a.sourceDir.trim() || !path.isAbsolute(a.sourceDir)) {
          return { ok: false, reason: 'invalid_args', message: 'plugin_update_submit 需要 sourceDir（新版包目录绝对路径，必须在会话工作区内）' }
        }
        if (!source.updateSubmit) {
          return { ok: false, reason: 'source_error', message: '本面板未装配安装面（update 未接线）——更新工具不可用' }
        }
        const payload = await source.updateSubmit({ packageId: a.packageId, sourceDir: a.sourceDir }, { sessionId: ctx?.sessionId ?? '' })
        return { ok: true, payload }
      }
      case 'plugin_set_enabled': {
        const a = (args ?? {}) as { packageId?: unknown; enabled?: unknown }
        if (typeof a.packageId !== 'string' || !a.packageId.trim()) {
          return { ok: false, reason: 'invalid_args', message: 'plugin_set_enabled 需要 packageId（插件包 id）' }
        }
        if (typeof a.enabled !== 'boolean') {
          return { ok: false, reason: 'invalid_args', message: 'plugin_set_enabled 需要 enabled（布尔：true=启用 false=停用）' }
        }
        if (!source.setEnabled) {
          return { ok: false, reason: 'source_error', message: '本面板未装配停用/启用面（settings 停用集未接线）——工具不可用' }
        }
        const payload = await source.setEnabled({ packageId: a.packageId, enabled: a.enabled })
        return { ok: true, payload }
      }
      case 'plugin_uninstall': {
        const a = (args ?? {}) as { packageId?: unknown }
        if (typeof a.packageId !== 'string' || !a.packageId.trim()) {
          return { ok: false, reason: 'invalid_args', message: 'plugin_uninstall 需要 packageId（用户根中已安装的包 id）' }
        }
        if (!source.uninstallPackage) {
          return { ok: false, reason: 'source_error', message: '本面板未装配卸载面（回收站未接线）——卸载工具不可用' }
        }
        const payload = await source.uninstallPackage({ packageId: a.packageId })
        return { ok: true, payload }
      }
      case 'plugins_rescan': {
        if (!source.rescan) {
          return { ok: false, reason: 'source_error', message: '本面板未装配重扫面（未接线）——工具不可用' }
        }
        return { ok: true, payload: source.rescan() }
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
  /** 更新/停用/卸载/重扫缝（工单335；缺省 = 未装配，工具如实报不可用） */
  updateSubmit?: (args: { packageId: string; sourceDir: string }, ctx: { sessionId: string }) => Promise<unknown>
  setEnabled?: (args: { packageId: string; enabled: boolean }) => Promise<unknown>
  uninstallPackage?: (args: { packageId: string }) => Promise<unknown>
  rescan?: () => unknown
}): ManagedProjectionSource {
  return {
    panelSnapshot: () => deps.panelSnapshot(),
    pluginsList: () => deps.pluginsList(),
    installSubmit: deps.installSubmit,
    updateSubmit: deps.updateSubmit,
    setEnabled: deps.setEnabled,
    uninstallPackage: deps.uninstallPackage,
    rescan: deps.rescan,
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
