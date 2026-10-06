import fs from 'node:fs'
import path from 'node:path'

/**
 * 插件资产寻址（工单10 辅缝）：`deck-plugin://<host>/<path>` → 磁盘文件 + MIME。
 * 纯函数、不 import electron——Electron 装配（特权协议注册 + protocol.handle）在 protocol.ts。
 *
 * 主机名即插件 id：`deck-plugin://app/…` 是宿主渲染层自身，其余主机名对插件目录。
 * 读盘只在主进程发生（渲染层 contextIsolation + sandbox，插件文件永不由渲染层触碰）。
 */

/** 应用自定义协议：渲染层页面与插件资产同源同协议（spec「插件体系」） */
export const PLUGIN_SCHEME = 'deck-plugin'

/** 宿主渲染层的主机名（插件目录用插件 id 作主机名） */
export const APP_HOST = 'app'

/** 一条资产根：协议主机名 → 磁盘目录（可选挂载前缀） */
export interface AssetRoot {
  host: string
  dir: string
  /** 该根在主机下的挂载路径（如 `/shared`）；省略即挂在主机根下 */
  prefix?: string
}

/** 投递白名单：只有这些类型才经协议外发（.js 必须是 text/javascript，否则 ESM 被拒） */
const MIME_BY_EXT: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** 按扩展名给 MIME；白名单外返回 null（调用方回 404，绝不按未知类型投递） */
export function mimeOf(file: string): string | null {
  return MIME_BY_EXT[path.extname(file).toLowerCase()] ?? null
}

/** 解析后的资产：绝对文件路径 + MIME */
export interface ResolvedAsset {
  file: string
  mime: string
}

/**
 * 把协议 URL 解析成磁盘文件。任一环节不成立即 null（→ 404）：
 * 协议不符、主机未登记、路径逃出根目录、NUL/反斜杠、目标是目录、所有根下都没有、类型不在白名单。
 * 同一主机名可挂多根，按 roots 顺序逐根尝试（渲染层根优先，共享模块根在后）。
 * 查表用 Map（09 踩坑 1 的纪律：外部字符串查表一律防原型链）。
 */
export function resolveAssetUrl(rawUrl: string, roots: AssetRoot[]): ResolvedAsset | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${PLUGIN_SCHEME}:`) return null

  // URL 规范已把主机名归一为小写；id 的合法字符集本身即小写，无歧义。
  // 同一主机名可挂多根（渲染层根 + dist/shared：跨进程共享模块经协议同源取，
  // 本根没有就换下一根——首个命中即止，根序即优先级）
  const dirs = roots
    .filter((r) => r.host === url.hostname)
    .map((r) => ({ dir: path.resolve(r.dir), mount: mountOf(r.prefix) }))
  if (dirs.length === 0) return null

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null

  for (const { dir: root, mount } of dirs) {
    if (mount && pathname !== mount && !pathname.startsWith(`${mount}/`)) continue
    const rel = mount ? pathname.slice(mount.length) : pathname
    const file = path.resolve(root, '.' + (rel.startsWith('/') ? rel : `/${rel}`))
    // 穿越防线：`..` 已被 normalize 吃掉，此处判的是「解出来仍在根内」
    if (file !== root && !file.startsWith(root + path.sep)) continue

    let stat: fs.Stats
    try {
      stat = fs.statSync(file)
    } catch {
      continue // 该根下无此文件（多根寻址的常态）→ 试下一根
    }
    if (!stat.isFile()) continue

    const mime = mimeOf(file)
    if (!mime) return null // 类型不在白名单：换根无益（同一路径名同扩展）
    return { file, mime }
  }
  return null
}

/** 归一挂载前缀：`shared` / `/shared/` → `/shared`；空与 `/` → 无前缀（挂主机根） */
function mountOf(prefix: string | undefined): string {
  if (!prefix) return ''
  const p = prefix.startsWith('/') ? prefix : `/${prefix}`
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}
