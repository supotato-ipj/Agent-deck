import fs from 'node:fs/promises'
import { protocol } from 'electron'
import type { PluginHostService } from './service'
import { APP_HOST, PLUGIN_SCHEME, resolveAssetUrl, type AssetRoot } from './assets'

/**
 * 插件资产协议装配（工单10）：Electron 侧的特权协议注册与请求处理。
 * 纯寻址逻辑在 assets.ts（可离线测），本文件只做 Electron 接线。
 *
 * 两处调用时机是硬约束：
 * - registerPluginScheme() 必须在 app ready 之前调用（Electron 文档要求）
 * - 协议 handler 在 app ready 之后、窗口载入之前装
 */

/** 特权协议注册：standard = 可作同源页面与模块，secure = ESM 必需，bypassCSP 免写死 CSP。必须在 app ready 前调用一次。 */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PLUGIN_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

/** 面板页面 URL（渲染层自此经协议加载，与插件资产同源） */
export function panelUrl(): string {
  return `${PLUGIN_SCHEME}://${APP_HOST}/index.html`
}

/** 任务栏页面 URL（工单49：与面板页同根同源） */
export function taskbarUrl(): string {
  return `${PLUGIN_SCHEME}://${APP_HOST}/taskbar.html`
}

/**
 * 装协议处理器：应用渲染层根目录 + 当前在装插件的目录，随插件增删实时变化。
 * 读盘只在这里发生——渲染层永远拿不到文件系统句柄（contextIsolation + sandbox 不变）。
 */
export function installPluginProtocol(options: { appRoot: string; host: PluginHostService }): void {
  protocol.handle(PLUGIN_SCHEME, async (request) => {
    const roots: AssetRoot[] = [{ host: APP_HOST, dir: options.appRoot }]
    for (const [id, dir] of options.host.allDirs()) roots.push({ host: id, dir })
    const asset = resolveAssetUrl(request.url, roots)
    if (!asset) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    const body = await fs.readFile(asset.file)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': `${asset.mime}; charset=utf-8`,
        // 插件主机名与页面主机名不同即跨源：模块加载要过 CORS，放开读（只读本机协议资产）
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
    })
  })
}
