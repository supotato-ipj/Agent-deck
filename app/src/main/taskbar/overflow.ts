// 托盘溢出菜单浮层窗（工单162）：自绘竖排菜单面板（每行图标+名称）的载体。
// 载体裁定（票内三候选：主面板窗内渲染 / 独立浮层窗 / 条带窗扩展）= **独立浮层窗**：
// - 主面板窗钉底（z 序在普通窗之下），菜单会被任何普通窗口盖住——「随鼠标弹出」不可用；
// - 条带窗扩展（临时加高）与工单158 刚收口的协商带回正守卫/AppBar 重协商相互拉扯
//   （回正守卫 500ms 一拍会把加高的窗口压回 64px 条带），且 focusable:false 的条带
//   永远收不到「点面板外」的 blur 信号；
// - 独立浮层窗 focusable:true + show 取焦，blur 即「点面板外」的全局信号（原生菜单
//   同语义——浮层在场时本就持前台）；生命周期独立，不碰条带几何。
// 行内容自足于内核契约：浮层页自取 taskbar/get-state、用与条带同一条溢出拆分纯函数
// （splitTrayOverflow）切尾段——开层请求不携带名单，浮层行与条带栏面永不各判一次。
// 行交互与栏内图标共用同一道 taskbar/tray-click 回放分发（渲染层 dispatchTrayClick）。
// 窗常驻（红轮实证：每次开层新起渲染进程有秒级 spin-up jank——首点偶发吞点击）：
// 首开惰性建一扇，收层即 hide、再开即重定位 show；行内容由页面随 taskbar/changed
// 常活自拆（隐藏拍跳过渲染，show 拍补一拍），宿主只持最新内容尺寸做开层定位。
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { wireBridgeIpc, wireHostIpc } from '../panel-ipc'
import { taskbarOverflowUrl } from '../plugins/protocol'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（TASKBAR_TITLE 先例） */
export const TRAY_OVERFLOW_TITLE = 'DECK-TRAY-OVERFLOW'

interface OverflowReadyPayload {
  w?: unknown
  h?: unknown
  rows?: unknown
}

export interface TrayOverflowHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/**
 * 浮层窗宿主：条带页「⋯」请求开层 →（首开）建窗载页 /（再开）重定位 show → 页面自拆
 * 名单渲染行 → 实测内容回报（taskbar-tray-overflow-ready）→ 按内容定窗、锚光标上方
 * 弹出（工作区夹取）并取焦。收层 = hide（窗常驻）：blur（点面板外）/ 行点（页请求）/
 * 条带点击（页转达）/ 名单拆空（页请求）/ 全屏让位 / 条带销毁（destroy）。
 */
export function startTrayOverflowHost(options: { ctx: Context; log: EventLog | null }): TrayOverflowHost {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  /** 页面最新内容实测（w/h/行数）：隐藏拍持续更新，开层定位据此 */
  let cache: { w: number; h: number; rows: number } | null = null
  /** 首开页未回报前的 show 挂起标记：ready 回报即定位弹出 */
  let pendingShow = false
  /** 弹出锚点（光标位）：在场拍名单 churn 重定窗只变尺寸不挪位（红轮实证：以实时光标
   * 重锚会把开着的浮层拽到光标处——行点击中途浮层跳走，下一击落空） */
  let anchor: { x: number; y: number } | null = null

  const hide = (reason: string): void => {
    const w = win
    if (!w || w.isDestroyed() || !w.isVisible()) return
    w.hide()
    log?.append({ type: 'taskbar-tray-overflow-closed', reason })
  }

  /** 锚点 + 内容尺寸 → 工作区夹取定窗；隐藏态即弹出取焦，在场态只重定窗不挪锚。 */
  const placeAndShow = (): void => {
    const w = win
    if (!w || w.isDestroyed() || !cache) return
    if (!anchor) {
      const cursor = screen.getCursorScreenPoint()
      anchor = { x: cursor.x, y: cursor.y }
    }
    const wa = screen.getPrimaryDisplay().workArea
    const x = Math.min(Math.max(Math.round(anchor.x - cache.w / 2), wa.x + 4), wa.x + wa.width - cache.w - 4)
    const y = Math.min(Math.max(Math.round(anchor.y - cache.h - 8), wa.y + 4), wa.y + wa.height - cache.h - 4)
    const cur = w.getBounds()
    if (Math.abs(cur.x - x) > 1 || Math.abs(cur.y - y) > 1 || Math.abs(cur.width - cache.w) > 1 || Math.abs(cur.height - cache.h) > 1) {
      w.setBounds({ x, y, width: cache.w, height: cache.h })
    }
    if (!w.isVisible()) {
      w.show() // 取焦：blur 收「点面板外」的前提（原生菜单在场持前台同语义）
      log?.append({ type: 'taskbar-tray-overflow-opened', bounds: w.getBounds(), rows: cache.rows })
    } else {
      log?.append({ type: 'taskbar-tray-overflow-resized', bounds: w.getBounds(), rows: cache.rows })
    }
  }

  const onReady = (payload: OverflowReadyPayload): void => {
    cache = {
      w: Math.max(80, Math.round(Number(payload.w) || 320)),
      h: Math.max(40, Math.round(Number(payload.h) || 80)),
      rows: Array.isArray(payload.rows) ? payload.rows.length : 0,
    }
    const w = win
    if (!w || w.isDestroyed()) return
    if (pendingShow) {
      pendingShow = false
      placeAndShow()
    } else if (w.isVisible()) {
      placeAndShow() // 在场拍名单变化重定窗（尺寸随行数，锚点冻结不挪位）
    }
    // 隐藏拍：只更新 cache（开层时 placeAndShow 消费）
  }

  const open = (): void => {
    if (win) {
      if (win.isVisible()) {
        hide('toggle') // 拨动语义（应用组 ⋯ 同款）：在场浮层遇开层请求即收
        anchor = null
        return
      }
      anchor = null // 重开 = 重新锚定当前光标（上次弹出位不残留）
      placeAndShow()
      return
    }
    const wa = screen.getPrimaryDisplay().workArea
    // 视口帽随工作区下发（红轮实证：560px 固定帽在 25 行溢出时把尾部行推出可点区——
    // 名单序尾部恰是探针/新到图标，行不可点即「溢出菜单不可用」）：工作区高留足边距，
    // 超长名单（极端机器态）才滚动
    const maxH = Math.max(320, wa.height - 80)
    const cursor = screen.getCursorScreenPoint()
    const w = new BrowserWindow({
      width: 320,
      height: 80, // 临时尺寸：页面渲染完按内容实测重定（placeAndShow）
      x: cursor.x,
      y: cursor.y,
      title: TRAY_OVERFLOW_TITLE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: true,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        // 本模块编译产物在 dist/main/taskbar/ → 向上两级到 dist/ 再进 preload/
        //（红轮实证：三级向上出了 dist 落 appRoot/preload，ENOENT → window.deck 未定义，
        // 浮层页静默死——opened 存证永不落，电池臂2/4 连锁红）
        preload: path.join(__dirname, '../../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    win = w
    pendingShow = true
    // 渲染层自诊断（条带页同款纪律：静默不执行时电池只见「存证缺失」——把渲染层错误
    // 与加载失败落进事件流）
    w.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) log?.append({ type: 'tray-overflow-renderer-console', level, message, line, sourceId })
    })
    w.webContents.on('did-fail-load', (_event, code, description, url) => {
      log?.append({ type: 'tray-overflow-load-failed', code, description, url })
    })
    w.webContents.on('preload-error', (_event, _preloadPath, error) => {
      log?.append({ type: 'tray-overflow-preload-error', message: error.message })
    })
    // 名单/档位变化推进浮层页重拆重渲（页自决：拆空即请求收层；隐藏拍页自跳过渲染）
    wireBridgeIpc(w, ctx.bridge, ['taskbar/changed'])
    // 浮层无热区（小窗整体受点，不走条带的穿透机制）；host 通道只为 notify 存证与收层请求
    wireHostIpc(w, null, log, {
      onNotify: (type, payload) => {
        if (type === 'taskbar-tray-overflow-ready') onReady((payload ?? {}) as OverflowReadyPayload)
        else if (type === 'taskbar-tray-overflow-close') hide(String((payload as { reason?: unknown } | undefined)?.reason ?? 'request'))
      },
    })
    // 点面板外 = blur（全局信号：桌面/其他应用任意点击都先夺走浮层焦点）
    w.on('blur', () => hide('blur'))
    w.once('closed', () => {
      if (win === w) win = null
    })
    void w.loadURL(`${taskbarOverflowUrl()}?maxH=${maxH}`)
  }

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-tray-overflow-open') open()
      else if (type === 'taskbar-tray-overflow-close') hide(String((payload as { reason?: unknown } | undefined)?.reason ?? 'request'))
    },
    close(reason) {
      hide(reason)
    },
    dispose() {
      const w = win
      win = null
      if (!w || w.isDestroyed()) return
      w.destroy()
      log?.append({ type: 'taskbar-tray-overflow-closed', reason: 'dispose' })
    },
  }
}
