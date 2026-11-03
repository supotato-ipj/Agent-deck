// 窗口预览窗控制器（工单379，spec #369 决策 15/25/26）：胶囊展开的横向预览的**承载半边**。
// 复用既有 Electron 置顶窗承载（决策 25：不引入第二套 UI 框架/常驻面板实例）——
// 无边框深色置顶窗，内容页 preview.html，条目由桥事件 'preview/changed' 驱动。
//
// DWM 实时缩略图（373 探针 go 裁决）：目标窗**必须由本进程持有**——预览窗就是目标窗，
// 主进程按渲染层上行的条目矩形用 DwmRegisterThumbnail/DwmUpdateThumbnailProperties 把
// 源窗内容实时填入对应条目；注册失败（含特殊应用）上行 live-failed，服务改判图标+标题
// 回退。预览关闭/条目滚出即注销关系——资源随关闭释放。
//
// 交互（决策 14/16）：预览窗可聚焦（收 Esc 与条目点击）；失焦即「点外收起」。
// 鼠标离开不收起（不监听 leave）；打开后先上屏（可交互），缩略图随后逐张填入
// （200ms 主交互预算只约束打开/可交互段）。
import { BrowserWindow, desktopCapturer, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import type { WindowPreviewItem, WindowPreviewState } from '../../shared/contract'
import { wireBridgeIpc, wireHostIpc } from '../panel-ipc'
import type { EventLog } from '../panel-ipc'
import { previewUrl } from '../plugins/protocol'
import { hwndOf } from '../win32'
import { registerThumbnail, unregisterThumbnail, updateThumbnail, windowAlive } from './thumbnails'
import type { ThumbRect } from './thumbnails'
import { foregroundWindow } from './geom-write'

/** 预览窗标题：验收控制器按 pid + 标题寻窗（CAPSULE_TITLE 先例） */
export const PREVIEW_TITLE = 'DECK-WINDOW-PREVIEW'

/** 预览窗几何（DIP）：胶囊正下方；高度容条目（缩略图 110 + 标题行 + 内边距） */
const PREVIEW_H = 196
const PREVIEW_MAX_W = 1000
const PREVIEW_MIN_W = 420
/** 胶囊条带顶（DIP，capsule-window.ts 同源常量：y=6 + 高 30）：预览紧贴其下 */
const CAPSULE_BOTTOM = 6 + 30
const GAP = 8

/** 渲染层上行的条目矩形（CSS px，相对预览窗视口左上角） */
export interface PreviewLayoutRect {
  hwnd: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * 关闭态承载位（屏幕外但保持可见）：Chromium 会冻结隐藏窗的渲染层，首次展开要多付
 * ~180ms 的解冻/IPC 时延（真机轮实证）；留在屏幕外可见态则渲染层常热，展开只需移动 +
 * 取焦（实测 open→首帧 ~20ms）。内容在关闭时已清空、缓存已释放，屏幕外不承载残影。
 */
function parkedBounds(): { x: number; y: number; width: number; height: number } {
  const d = screen.getPrimaryDisplay()
  const area = d.workArea ?? d.bounds
  const width = Math.max(PREVIEW_MIN_W, Math.min(PREVIEW_MAX_W, area.width - 120))
  return { x: area.x - width - 64, y: area.y + 64, width, height: PREVIEW_H }
}

function previewBounds(): { x: number; y: number; width: number; height: number } {
  const d = screen.getPrimaryDisplay()
  const area = d.workArea ?? d.bounds
  const width = Math.max(PREVIEW_MIN_W, Math.min(PREVIEW_MAX_W, area.width - 120))
  return {
    x: area.x + Math.round((area.width - width) / 2),
    // 胶囊在主屏顶部（bounds 原点 + 6 DIP）；预览在其下方，不压胶囊
    y: d.bounds.y + CAPSULE_BOTTOM + GAP,
    width,
    height: PREVIEW_H,
  }
}

export interface PreviewController {
  dispose(): void
  /** 当前预览窗原生句柄（DWM 目标窗；不在场 = null） */
  hwnd(): number | null
}

/**
 * 预览窗控制器：订阅 preview/changed 与 workspace/changed。
 * - Agent 桌面可用时预建承载窗（停在屏幕外保持可见——渲染层常热，展开只做移动+取焦）；
 * - open=true → 移到展开位/上屏/取焦；open=false → 移回屏幕外并注销全部缩略图关系
 *   （关闭即释放；窗口本身随 Agent 桌面存续，供下一次展开复用）；
 * - 切出 Agent 桌面 → 销窗（零残留）。
 */
export function startPreviewWindowController(options: { ctx: Context; log: EventLog | null }): PreviewController {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  let disposed = false
  let lastState: WindowPreviewState | null = null
  /** 已注册的 DWM 关系（hwnd → 句柄） */
  const thumbs = new Map<number, unknown>()
  /** 已注册关系的目标矩形（物理 px，目标窗客户区坐标）——缓存取景裁剪用 */
  const thumbRects = new Map<number, ThumbRect>()
  let lastThumbCount = 0
  /** 本轮展开的缓存取景是否已做（实时内容上屏后一次） */
  let cacheCaptured = false

  const wantAvailable = (): boolean => {
    if (disposed) return false
    const ws = ctx.desktopWorkspace?.state() ?? null
    return Boolean(ws && ws.available && ws.current === 'agent')
  }

  const releaseAll = (): void => {
    for (const thumb of thumbs.values()) unregisterThumbnail(thumb)
    thumbs.clear()
    thumbRects.clear()
    if (lastThumbCount !== 0) log?.append({ type: 'preview-released', relations: 0 })
    lastThumbCount = 0
    ctx.emit('window-preview/live-registered', { count: 0 })
  }

  const sendState = (state: WindowPreviewState): void => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('deck:bridge-event', 'preview/changed', state)
    }
  }

  const createWindow = (): BrowserWindow => {
    const w = new BrowserWindow({
      ...parkedBounds(),
      title: PREVIEW_TITLE,
      show: false,
      frame: false,
      // 不透明深色（DWM 缩略图不往分层/透明窗合成——373 探针的承载形态同款取舍）
      transparent: false,
      backgroundColor: '#12141a',
      resizable: false,
      movable: false,
      // 可聚焦：Esc 与条目点击（取焦后失焦 = 点外收起）
      focusable: true,
      hasShadow: true,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, '../../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // 隐藏态也按前台速度走：预览窗预建后要能立刻响应 open 推送（200ms 可交互预算），
        // Chromium 默认会节流隐藏/遮挡渲染层（面板同因加了全局开关，这里按窗再钉死）
        backgroundThrottling: false,
      },
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    w.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) log?.append({ type: 'preview-renderer-console', level, message, line, sourceId })
    })
    w.webContents.on('did-fail-load', (_event, code, description, url) => {
      log?.append({ type: 'preview-load-failed', code, description, url })
    })
    wireBridgeIpc(w, ctx.bridge, ['preview/changed', 'focus/changed'])
    wireHostIpc(w, null, log, {
      onPreviewLayout: (rects) => applyLayout(rects as PreviewLayoutRect[]),
    })
    // 点外收起（失焦）：只在预览确实展开时收（自身 hide/关闭引发的失焦不重复处理）
    w.on('blur', () => {
      if (disposed || !lastState?.open) return
      // 进入聚焦时目标窗取前台造成的失焦归选择路径收口（服务随后 close('select')）——
      // 此处再收会把「选择」误判成「点外」
      if (ctx.agentFocus?.state().focused != null) return
      log?.append({ type: 'preview-blur', fg: foregroundWindow() })
      ctx.windowPreview?.close('blur')
    })
    w.webContents.on('did-finish-load', () => {
      if (lastState) sendState(lastState)
    })
    w.once('ready-to-show', () => {
      // 常热：屏幕外保持可见（不取焦）——见 parkedBounds 注释
      if (!disposed && !w.isDestroyed()) w.showInactive()
    })
    void w.loadURL(previewUrl())
    log?.append({ type: 'preview-window-created' })
    return w
  }

  /** 渲染层上报条目矩形 → 目标窗内 DWM 关系逐条注册/更新/注销（物理 px 换算） */
  const applyLayout = (rects: PreviewLayoutRect[]): void => {
    if (!win || win.isDestroyed()) return
    const items: WindowPreviewItem[] = lastState?.open ? lastState.items : []
    if (!items.length) {
      releaseAll()
      return
    }
    const byHwnd = new Map(items.filter((x) => x.mode === 'live').map((x) => [x.hwnd, x] as const))
    const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1
    const seen = new Set<number>()
    for (const r of rects) {
      if (!r || !byHwnd.has(Number(r.hwnd))) continue
      if (!windowAlive(Number(r.hwnd))) continue
      const hwnd = Number(r.hwnd)
      seen.add(hwnd)
      const dest = {
        left: Math.round(r.x * scale),
        top: Math.round(r.y * scale),
        right: Math.round((r.x + r.w) * scale),
        bottom: Math.round((r.y + r.h) * scale),
      }
      const existing = thumbs.get(hwnd)
      thumbRects.set(hwnd, dest)
      if (existing) {
        updateThumbnail(existing, dest)
        continue
      }
      const thumb = registerThumbnail(hwndOf(win), hwnd, dest)
      if (thumb) {
        thumbs.set(hwnd, thumb)
      } else {
        // 注册失败（特殊应用/权限）：回退图标+标题（预览始终可用）
        ctx.emit('window-preview/live-failed', { hwnd })
      }
    }
    // 条目滚出视口/模式变化：注销关系（资源不随滚动累积）
    for (const [hwnd, thumb] of [...thumbs]) {
      if (seen.has(hwnd)) continue
      unregisterThumbnail(thumb)
      thumbs.delete(hwnd)
      thumbRects.delete(hwnd)
    }
    if (thumbs.size !== lastThumbCount) {
      lastThumbCount = thumbs.size
      // 逐张填入存证（只记关系数——不含标题/图像，决策 26）
      log?.append({ type: 'preview-thumbs', count: thumbs.size })
    }
    ctx.emit('window-preview/live-registered', { count: thumbs.size })
    maybeCaptureFrames()
  }

  /**
   * 最近缓存取景（决策 15）：实时缩略图全部上屏后做一次屏幕取景，把每条目区裁成内存帧
   * 交给预览服务（最小化时上屏的「最近缓存」）。
   *
   * 为什么不用 PrintWindow 抓外部窗：真机实证 PrintWindow(PW_RENDERFULLCONTENT) 对 WPF
   * 窗会**无限期阻塞**调用线程（探针里冻结主进程 30s；独立复现脚本直接挂死）——主进程
   * 不能对第三方窗做同步跨进程绘制。取景走 desktopCapturer（GPU/合成器异步）且裁剪的是
   * 预览窗上已由 DWM 合成的实时画面——不阻塞主线程，缓存内容就是用户刚看到的最近画面。
   */
  const maybeCaptureFrames = (): void => {
    if (cacheCaptured || !lastState?.open) return
    const liveItems = (lastState.items || []).filter((x) => x.mode === 'live')
    if (!liveItems.length) return
    if (thumbs.size < liveItems.length) return
    cacheCaptured = true
    setTimeout(() => {
      void shotFrames(liveItems)
    }, 150)
  }

  const shotFrames = async (liveItems: WindowPreviewItem[]): Promise<void> => {
    const w = win
    if (disposed || !w || w.isDestroyed() || !lastState?.open) return
    try {
      const winRect = w.getBounds()
      const display = screen.getDisplayMatching(winRect)
      const scale = display.scaleFactor || 1
      const physW = Math.round(display.bounds.width * scale)
      const physH = Math.round(display.bounds.height * scale)
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physW, height: physH } })
      const source = sources.find((s) => String(s.display_id) === String(display.id)) ?? sources[0]
      const full = source && source.thumbnail
      if (!full || full.isEmpty()) return
      const originX = Math.round((winRect.x - display.bounds.x) * scale)
      const originY = Math.round((winRect.y - display.bounds.y) * scale)
      const frames: Array<{ hwnd: number; dataUrl: string; width: number; height: number }> = []
      for (const item of liveItems) {
        const r = thumbRects.get(item.hwnd)
        if (!r) continue
        const x = Math.max(0, originX + r.left)
        const y = Math.max(0, originY + r.top)
        const width = Math.min(r.right - r.left, physW - x)
        const height = Math.min(r.bottom - r.top, physH - y)
        if (width <= 0 || height <= 0) continue
        const crop = full.crop({ x, y, width, height })
        if (!crop || crop.isEmpty()) continue
        frames.push({ hwnd: item.hwnd, dataUrl: crop.toDataURL(), width: crop.getSize().width, height: crop.getSize().height })
      }
      if (disposed || !lastState?.open) return
      // 存证只记帧数（决策 26：不含标题/图像）
      log?.append({ type: 'preview-cache-shot', frames: frames.length })
      ctx.windowPreview?.rememberFrames(frames)
    } catch (err) {
      log?.append({ type: 'preview-cache-shot-failed', message: String(err instanceof Error ? err.message : err) })
    }
  }

  const show = (state: WindowPreviewState): void => {
    if (!win || win.isDestroyed()) win = createWindow()
    if (win.isDestroyed()) return
    cacheCaptured = false
    // 条目已随服务的 preview/changed 经桥订阅到达渲染层；这里只负责把常热窗移到展开位
    win.setBounds(previewBounds())
    win.setAlwaysOnTop(true, 'screen-saver')
    if (!win.isVisible()) win.show()
    win.focus()
    // 上屏存证（验收 200ms 可交互预算：与服务的 preview-open 事件时刻求差）
    log?.append({ type: 'preview-shown' })
    const shown = win
    setTimeout(() => {
      if (disposed || shown.isDestroyed()) return
      log?.append({ type: 'preview-focus', fg: foregroundWindow(), win: hwndOf(shown), focused: shown.isFocused() })
    }, 60)
  }

  const hide = (): void => {
    releaseAll()
    cacheCaptured = false
    if (win && !win.isDestroyed()) {
      // 屏幕外保持可见（渲染层常热）；内容已随 open=false 清空。
      // 非聚焦路径（再点胶囊/Esc/点外）让出前台焦点，不把键盘焦点悬在屏幕外窗口上；
      // 选择进入聚焦时目标已是前台——此时再 blur 会把前台推给别的窗，触发「抢前台即退出」，
      // 所以聚焦态下只移窗不收焦点。
      if (ctx.agentFocus?.state().focused == null) win.blur()
      win.setBounds(parkedBounds())
    }
  }

  const syncWindow = (): void => {
    if (disposed) return
    const want = wantAvailable()
    if (want && (!win || win.isDestroyed())) {
      win = createWindow()
    } else if (!want && win && !win.isDestroyed()) {
      releaseAll()
      win.destroy()
      win = null
      lastState = null
      log?.append({ type: 'preview-window-closed' })
    }
  }

  ctx.on('workspace/changed', () => {
    syncWindow()
  })
  ctx.on('preview/changed', (state: WindowPreviewState) => {
    lastState = state
    if (state.open) {
      syncWindow()
      show(state)
    } else {
      hide()
    }
  })
  // 预览窗被用户关闭（Alt+F4 等）：按点外收起处理，服务状态同步
  ctx.on('dispose', () => releaseAll())
  // 装配期延迟一拍起跑（装配顺序下 desktopWorkspace 可能晚到——胶囊同款）
  setImmediate(syncWindow)

  return {
    dispose(): void {
      disposed = true
      releaseAll()
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    },
    hwnd(): number | null {
      return win && !win.isDestroyed() ? hwndOf(win) : null
    },
  }
}
