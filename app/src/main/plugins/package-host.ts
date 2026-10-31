import fs from 'node:fs'
import path from 'node:path'
import { ipcMain, session, WebContentsView, type BrowserWindow, type WebContents } from 'electron'
import { ExecutionContextRegistry } from './identity'
import { PACKAGE_SCHEME, PACKAGE_SHELL_PATH, resolvePackageAssetUrl } from './assets'
import { DROPPED_VIEW_SEGMENTS, type DroppedManifest } from './dropped-manifest'
import type { PanelSnapshot } from '../../shared/contract'

/**
 * 投放包宿主（工单331，ADR-0025）：dropped 档独立执行上下文的 Electron 接线。
 *
 * 每包一个独立 webContents + 独立 origin（`deck-pkg://<id>`）：
 * - 独立 session（`session.fromPartition('deck-pkg-<id>')`，内存态）；
 * - 该 session 上注册 `deck-pkg` 协议处理器服务包根文件（标准+安全特权在 ready 前一次列全）；
 * - session 级 webRequest 默认拒绝出站（仅放行本包 origin）——AC3 默认无出站网络；
 * - sandbox + contextIsolation + 专用预载（deckHost：host.view/host.config，无通用 invoke）；
 * - 主进程登记表（identity.ts）绑定 webContents.id → 包身份，IPC 身份只查表推导；
 * - render-process-gone → 只报崩溃给服务层记账（错误态），**绝不 reload**——AC3 不自动重挂、
 *   mount 副作用不重放；恢复 = 停用/改码后的显式重建（新代次/重新启用）。
 *
 * 视图组合：WebContentsView 挂面板窗 contentView 固定默认位（摆位/热区集成归后续票，
 * 见工单331 收尾报告遗留面）。纯 Electron 接线不做单测——隔离/崩溃/真实 origin 由
 * 工单331 真机验收段存证（t328 探针已验证同款机制，24/24 断言）。
 */

/** 插件私有状态存储端口（生产 = PluginConfigService，身份在宿主侧已推导） */
export interface ConfigStorePort {
  get(id: string): { config: Record<string, unknown>; warnings: string[] }
  set(id: string, patch: unknown): { config: Record<string, unknown>; warnings: string[] }
}

/** 缩略图信封（与 Broker MediaThumbnailResult 同形状；宿主不重复裁决只转发） */
export type MediaThumbnailEnvelope =
  | { ok: true; contentType: string; bytes: number; dataUrl: string }
  | { ok: false; code: string; message: string }

export interface DroppedPackageHostDeps {
  /** 执行上下文登记表（与 PluginHostService 共享；身份唯一事实来源） */
  registry: ExecutionContextRegistry
  /** 私有状态存储（懒取：激活发生在内核装配期，pluginConfig 服务可能尚未注册） */
  configPort: () => ConfigStorePort | null
  /** 崩溃上报（生产 = kernel.plugins.markDroppedCrashed；宿主只报事实，绝不 reload） */
  onCrashed: (id: string, reason: string) => void
  /** 结构化事件出口（DECK_EVENT_LOG） */
  log?: (event: Record<string, unknown>) => void
  /** 视图默认位（摆位集成归后续票） */
  bounds?: { x: number; y: number; width: number; height: number }
  /** 挂载结果回报（工单334 有界激活）：壳页 title=deck-pkg:ready/failed 或崩溃即报事实 */
  onMountOutcome?: (info: { id: string; ok: boolean; message: string | null }) => void
  /**
   * 媒体段查询（工单336，生产 = MediaBroker.viewForPackage）：包获 media.read 授权 →
   * 脱敏快照；未授权 = null（media 段不投——投影之外是「不存在」）。宿主只做
   * capabilities 交集，授权裁决全在 Broker（撤销即断供零窗口）。
   */
  mediaView?: (packageId: string) => Record<string, unknown> | null
  /** 受控缩略图（生产 = MediaBroker.thumbnailForPackage；校验/授权在 Broker） */
  mediaThumbnail?: (packageId: string, key: string) => Promise<MediaThumbnailEnvelope>
}

/** 一条在装上下文 */
interface PackageContext {
  id: string
  generation: number
  manifest: DroppedManifest
  view: WebContentsView
  latestView: Record<string, unknown>
  pageLoaded: boolean
}

/** 零权限包视图默认位：卡面尺寸与桌面卡一致（320×180），右移一列避开时钟卡（40+320+20） */
const DEFAULT_BOUNDS = { x: 380, y: 40, width: 320, height: 180 }

/** 壳页 CSP：connect-src 'none' 在 CSP 层先掐 fetch/XHR（webRequest 拒绝是第二道闸） */
const SHELL_CSP = "default-src 'self' 'unsafe-inline'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'none'"

/**
 * 宿主壳页（内联投喂，同包 origin）：按 PluginApi 契约挂载入口模块。
 * 与内核档卡片同一创作模型（default 导出 mount/update?/unmount?），但宿主面只有
 * {el, view, util, config}——invoke/桥接事件/键盘档对投放包不存在（Undefined 即不存在）。
 */
const SHELL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>deck-pkg</title></head>
<body>
<div id="deck-pkg-root"></div>
<script type="module">
const q = new URLSearchParams(location.search)
const entry = q.get('entry') || ''
const rootEl = document.getElementById('deck-pkg-root')
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
const pad = (n, w = 2) => String(Math.trunc(Math.abs(Number(n) || 0))).padStart(w, '0')
const pad3 = (n) => pad(n, 3)
const pct = (x) => (x === null || x === undefined || !Number.isFinite(Number(x))) ? '--' : Math.round(Number(x) * 100) + '%'
try {
  const mod = await import(new URL(entry, location.href).href)
  const api = mod.default ?? mod
  if (typeof api?.mount !== 'function') throw new Error('模块未导出 mount（default 导出契约对象）')
  const host = {
    el: rootEl,
    view: window.deckHost.view.get(),
    util: { pad, pad3, pct, esc },
    config: window.deckHost.config,
  }
  await api.mount(host)
  window.deckHost.view.subscribe(() => {
    host.view = window.deckHost.view.get()
    try { api.update?.(host) } catch (err) { console.warn('[deck-pkg] update 抛错:', err) }
  })
  document.title = 'deck-pkg:ready'
} catch (err) {
  rootEl.textContent = '组件装载失败: ' + String(err && err.message ? err.message : err)
  document.title = 'deck-pkg:failed'
}
</script>
</body></html>`

export class DroppedPackageHost {
  private readonly deps: DroppedPackageHostDeps
  /** 在装上下文：包 id → 上下文（Map 查表防原型链） */
  private readonly live = new Map<string, PackageContext>()
  /** 已装协议处理器的 session partition（同 session 重复 handle 会抛，换代先 unhandle） */
  private readonly wiredSessions = new Set<string>()
  /** 面板窗（attach 后挂 contentView；激活可先于开窗发生，挂载动作延后补） */
  private panelWindow: BrowserWindow | null = null
  private readonly bounds: { x: number; y: number; width: number; height: number }
  private ipcWired = false
  /**
   * 挂载结果回报订阅（工单335 补通有界激活通路）：服务层经本方法注册（DroppedPackageHostPort
   * 同名端口），壳页 title/崩溃即裁决在等者。工单334 轮的通路缺口——回报只可达 deps 字段
   * （生产构造未注入），服务层按端口方法注册落空 → 有界激活恒走 12s 超时未知态（真机 C4/C5
   * 轮实证：title=deck-pkg:ready 在场而 approve=activation_unknown）。
   */
  private mountOutcomeCb: ((info: { id: string; ok: boolean; message: string | null }) => void) | null = null

  constructor(deps: DroppedPackageHostDeps) {
    this.deps = deps
    this.bounds = deps.bounds ?? DEFAULT_BOUNDS
    this.wireIpc()
  }

  /** 挂载结果回报注册（工单334 端口法）：服务层在等表由此裁决 */
  onMountOutcome(cb: (info: { id: string; ok: boolean; message: string | null }) => void): void {
    this.mountOutcomeCb = cb
  }

  /** 面板窗就绪后挂载（激活可先于开窗——开窗前在装的包在此补挂） */
  attach(win: BrowserWindow): void {
    this.panelWindow = win
    for (const context of this.live.values()) this.show(context)
  }

  /**
   * 拉起独立执行上下文（服务层仅在首次/换代时调用；零权限包投放即生效，无批准闸门）。
   * 同 id 旧上下文由调用方（service）先 deactivate，这里再兜底幂等拆除。
   */
  activate(pkg: { id: string; dir: string; generation: number; permissions: string[]; manifest: DroppedManifest }): void {
    if (this.live.has(pkg.id)) this.deactivate(pkg.id)

    const partition = `deck-pkg-${pkg.id}`
    const ses = session.fromPartition(partition)

    // per-session 协议处理器：只服务本包根（同 id 换代重注册，先摘旧的防重复 handle 抛错）
    const dir = path.resolve(pkg.dir)
    try {
      if (this.wiredSessions.has(partition)) ses.protocol.unhandle(PACKAGE_SCHEME)
      ses.protocol.handle(PACKAGE_SCHEME, async (request) => this.servePackageRequest(request.url, dir))
      this.wiredSessions.add(partition)
    } catch (err) {
      this.deps.log?.({ type: 'dropped-package-protocol-failed', id: pkg.id, message: String(err) })
      return
    }

    // AC3 默认无出站网络：session 级默认拒绝，仅放行本包 origin（跨包/外联全灭）
    const ownOriginPrefix = `${PACKAGE_SCHEME}://${pkg.id}/`
    ses.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url.startsWith(ownOriginPrefix)
      if (!allowed) this.deps.log?.({ type: 'dropped-package-net-blocked', id: pkg.id, url: details.url })
      callback({ cancel: !allowed })
    })

    const view = new WebContentsView({
      webPreferences: {
        partition,
        // 本模块编译产物在 dist/main/plugins/（比 dist/main 深一级）：两级上行才是 dist/preload
        preload: path.join(__dirname, '../../preload/package.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })

    // 主进程登记（AC2）：身份唯一事实来源。IPC handler 只查表推导，永不采信自报。
    const wc = view.webContents
    this.deps.registry.register(wc.id, {
      packageId: pkg.id,
      generation: pkg.generation,
      root: dir,
      origin: `${PACKAGE_SCHEME}://${pkg.id}`,
    })

    const context: PackageContext = {
      id: pkg.id,
      generation: pkg.generation,
      manifest: pkg.manifest,
      view,
      latestView: {},
      pageLoaded: false,
    }
    this.live.set(pkg.id, context)
    this.deps.log?.({ type: 'dropped-package-context-created', id: pkg.id, generation: pkg.generation, webContentsId: wc.id, partition })

    // 挂载结果回报（工单334 有界激活的事实源）：壳页 preload 置 title=deck-pkg:ready/failed
    // → page-title-updated 即报；一次性（每代 mount 恰一个结论）。工单335 补通端口法注册
    const deliverMount = (ok: boolean, message: string | null): void => {
      const info = { id: pkg.id, ok, message }
      this.deps.onMountOutcome?.(info)
      this.mountOutcomeCb?.(info)
    }
    let mountReported = false
    const reportMount = (ok: boolean, message: string | null): void => {
      if (mountReported) return
      mountReported = true
      deliverMount(ok, message)
    }
    wc.on('page-title-updated', (_event, title) => {
      if (title === 'deck-pkg:ready') reportMount(true, null)
      else if (title === 'deck-pkg:failed') reportMount(false, '包页挂载失败（deck-pkg:failed）')
    })

    // AC3 崩溃处置：只报事实进错误态，绝不 reload/不重建（Electron 44 默认也不自动重载）。
    // clean-exit = 主动拆除（deactivate 的 close()）——不是崩溃，不报不记账（工单335）
    wc.on('render-process-gone', (_event, details) => {
      this.deps.log?.({ type: 'dropped-package-render-gone', id: pkg.id, reason: details.reason, exitCode: details.exitCode })
      if (details.reason === 'clean-exit') return
      reportMount(false, `包页进程崩溃（${details.reason}）——挂载未确认`)
      this.deps.onCrashed(pkg.id, details.reason)
    })
    // 包页控制台出主进程日志（与协议 asset-404 同款运营观测）：preload 加载失败、壳页
    // import 失败、插件自身抛错都从这里落盘——包页没有别的可观测出口。
    wc.on('console-message', (_event, _level, message) => {
      if (/Security Warning/.test(message)) return
      this.deps.log?.({ type: 'dropped-package-console', id: pkg.id, message: String(message).slice(0, 300) })
    })
    wc.on('did-finish-load', () => {
      context.pageLoaded = true
      this.pushView(context)
    })
    // 防包页面开新窗/新上下文逃逸
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))

    this.show(context)
    // 宿主壳页（同包 origin）：壳内 import 入口模块并按 PluginApi 契约挂载
    void wc.loadURL(`${PACKAGE_SCHEME}://${pkg.id}/${PACKAGE_SHELL_PATH}?entry=${encodeURIComponent(pkg.manifest.entry)}`)
  }

  /** 拆除独立上下文（停用/换代/消失时；幂等）：摘登记 + 移除视图 + **销毁** webContents
   *（工单335：只 stop 不销毁会让 CDP 目标表与渲染进程残留——卸载后清单消失断言实证）。 */
  deactivate(id: string): void {
    const context = this.live.get(id)
    if (!context) return
    this.live.delete(id)
    this.hide(context)
    this.deps.registry.removePackage(id)
    try {
      if (!context.view.webContents.isDestroyed()) {
        context.view.webContents.stop()
        context.view.webContents.close() // 强制销毁页（render-process-gone 以 clean-exit 报，崩溃处置不误触）
      }
    } catch { /* 已销毁的上下文无需停 */ }
    this.deps.log?.({ type: 'dropped-package-context-removed', id, generation: context.generation })
  }

  /** 快照到达（生产 = kernel.on('panel/changed')）：按 capabilities 裁剪后逐包推送 */
  pushSnapshot(snap: PanelSnapshot): void {
    for (const context of this.live.values()) {
      const view: Record<string, unknown> = {}
      const bag = snap as unknown as Record<string, unknown>
      for (const segment of context.manifest.capabilities) {
        // capabilities 已在分类时裁到投放段集合；此处再交集合一口径（少给而非不给）。
        // media 段特殊：不在面板快照包里，走 Broker 授权查询（未授权 = null 不投）。
        // mediaView 返回 { media: DTO } 包装——投喂解包 DTO（嵌套包装会让卡片的
        // view.media.sessions 落空、永远空态——C6 真机排障实证）。
        if (segment === 'media') {
          const media = this.deps.mediaView?.(context.id) ?? null
          if (media && media.media) view.media = media.media
          continue
        }
        if (DROPPED_VIEW_SEGMENTS.includes(segment as (typeof DROPPED_VIEW_SEGMENTS)[number]) && segment in bag) {
          view[segment] = bag[segment]
        }
      }
      context.latestView = view
      this.pushView(context)
    }
  }

  /**
   * 媒体刷新（工单336，生产 = MediaBroker.onSnapshot）：桥事件驱动的快照代次变化即时
   * 重推——对声明 media 段的在装包重走 capabilities 裁剪（授权查询同源），其余段不动。
   */
  refreshMedia(): void {
    for (const context of this.live.values()) {
      if (!context.manifest.capabilities.includes('media')) continue
      const media = this.deps.mediaView?.(context.id) ?? null
      const view: Record<string, unknown> = { ...context.latestView }
      if (media) view.media = media
      else delete view.media
      context.latestView = view
      this.pushView(context)
    }
  }

  /** 在装上下文数（诊断读数） */
  size(): number {
    return this.live.size
  }

  /** webContents 是否仍存活（诊断读数；崩溃后 isCrashed 路径供验收对照） */
  webContentsOf(id: string): WebContents | null {
    return this.live.get(id)?.view.webContents ?? null
  }

  private show(context: PackageContext): void {
    try {
      if (this.panelWindow && !this.panelWindow.isDestroyed() && !context.view.webContents.isDestroyed()) {
        this.panelWindow.contentView.addChildView(context.view)
        context.view.setBounds({ ...this.bounds })
      }
    } catch (err) {
      this.deps.log?.({ type: 'dropped-package-attach-failed', id: context.id, message: String(err) })
    }
  }

  private hide(context: PackageContext): void {
    try {
      if (this.panelWindow && !this.panelWindow.isDestroyed()) {
        this.panelWindow.contentView.removeChildView(context.view)
      }
    } catch { /* 窗已销毁/未挂载 */ }
  }

  private pushView(context: PackageContext): void {
    if (!context.pageLoaded) return
    try {
      const wc = context.view.webContents
      if (!wc.isDestroyed() && !wc.isCrashed()) {
        wc.send('pkg:host-event', { domain: 'view', view: context.latestView })
      }
    } catch { /* 崩溃/销毁边界：静默（崩溃处置走 render-process-gone） */ }
  }

  private async servePackageRequest(url: string, dir: string): Promise<Response> {
    // 宿主壳页特判：同包 origin 内联投喂（查询串带入口相对路径，manifest 校验已保证其形状）
    let shellPath = false
    try {
      shellPath = new URL(url).pathname === `/${PACKAGE_SHELL_PATH}`
    } catch { /* 解析不了即按 404 走 */ }
    if (shellPath) {
      return new Response(SHELL_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': SHELL_CSP, 'cache-control': 'no-store' },
      })
    }
    const asset = resolvePackageAssetUrl(url, dir)
    if (!asset) {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
    try {
      const body = await fs.promises.readFile(asset.file)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': `${asset.mime}; charset=utf-8`, 'cache-control': 'no-store' },
      })
    } catch {
      return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    }
  }

  /**
   * 基线宿主 IPC（AC2）：身份只查登记表推导（event.sender.id），永不读载荷自报字段。
   * 结构化信封返回（错误码即契约目录 errors 登记），不抛异常。
   */
  private wireIpc(): void {
    if (this.ipcWired) return
    this.ipcWired = true
    ipcMain.handle('pkg:config-get', (event) => {
      const ctx = this.deps.registry.lookup(event.sender.id)
      if (!ctx) return { ok: false as const, code: 'unknown_context', message: '调用方不在执行上下文登记表（未登记或已拆除）' }
      const store = this.deps.configPort()
      if (!store) return { ok: false as const, code: 'config_io_failed', message: '私有状态存储未就绪' }
      try {
        const state = store.get(ctx.packageId)
        return { ok: true as const, config: state.config, warnings: state.warnings }
      } catch (err) {
        return { ok: false as const, code: 'config_io_failed', message: err instanceof Error ? err.message : String(err) }
      }
    })
    ipcMain.handle('pkg:config-set', (event, patch: unknown) => {
      const ctx = this.deps.registry.lookup(event.sender.id)
      if (!ctx) return { ok: false as const, code: 'unknown_context', message: '调用方不在执行上下文登记表（未登记或已拆除）' }
      const store = this.deps.configPort()
      if (!store) return { ok: false as const, code: 'config_io_failed', message: '私有状态存储未就绪' }
      try {
        const state = store.set(ctx.packageId, patch)
        return { ok: true as const, config: state.config, warnings: state.warnings }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // 超限拒收（一个字节不写）与坏载荷在存储层已裁决；这里只映射错误码
        const code = message.includes('超限') ? 'config_too_large' : 'config_invalid'
        return { ok: false as const, code, message }
      }
    })
    // 受控缩略图（工单336）：身份查登记表推导（不采信自报）；授权门/类型大小校验/审计
    // 都在 Broker（宿主只转发）。校验拒付 = 一个字节不出。
    ipcMain.handle('pkg:media-thumbnail', async (event, key: unknown) => {
      const ctx = this.deps.registry.lookup(event.sender.id)
      if (!ctx) return { ok: false as const, code: 'unknown_context', message: '调用方不在执行上下文登记表（未登记或已拆除）' }
      if (typeof key !== 'string' || !key.trim()) {
        return { ok: false as const, code: 'media_session_gone', message: '会话键缺失（缩略图按带代次不透明键寻址）' }
      }
      if (!this.deps.mediaThumbnail) {
        return { ok: false as const, code: 'media_unavailable', message: '媒体面未装配（缩略图不可用）' }
      }
      try {
        return await this.deps.mediaThumbnail(ctx.packageId, key)
      } catch (err) {
        return { ok: false as const, code: 'media_unavailable', message: err instanceof Error ? err.message : String(err) }
      }
    })
  }
}
