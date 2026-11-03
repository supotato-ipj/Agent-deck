// 逐窗几何授权提示窗（工单378，spec #369 决策 10/25）：首次用户几何操作被复原后显示
// 「调整窗口 / 保持平铺」。默认与 Esc 保持平铺（只授权「下一次重新发起的操作」；确认
// 本身不写几何、不重排——决策 9），没有「以后不再提示」（决策 10 / out-of-scope）。
//
// 承载形态沿用内核既有置顶浮层（决策 25：不引入第二套 UI 框架）：无边框透明置顶小窗，
// 可聚焦（取焦才能收到 Esc 与按钮点击；窗口已被复原，用户须确认后重新发起操作）。
// 提示窗只承载两个按钮与一句说明——窗口标题等内容不上屏（隐私面，决策 26）。
//
// 生命周期：订阅 tiling/authorize-request 建窗（带 hwnd 查询参数），订阅
// tiling/authorize-closed 收窗；同时最多一扇（多窗排队，逐个提示——每窗独立授权）。
// 切出 Agent 桌面即收窗（撤销授权由服务层完成，本控制器只负责界面）。
import { BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import { wireBridgeIpc } from '../panel-ipc'
import type { EventLog } from '../panel-ipc'
import { tilePromptUrl } from '../plugins/protocol'
import { hwndOf } from '../win32'

/** 提示窗标题：验收控制器按标题寻窗（CAPSULE_TITLE 先例） */
export const TILE_PROMPT_TITLE = 'DECK-TILE-PROMPT'

/** 提示窗几何（DIP）：容得下两个按钮一行 */
const PROMPT_W = 360
const PROMPT_H = 84

interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** 物理 px 目标几何 → 提示窗 DIP 位置（目标窗水平居中、顶边下方；夹在主屏内） */
function promptBoundsFor(rect: Rect | null): { x: number; y: number; width: number; height: number } {
  const d = screen.getPrimaryDisplay()
  const scale = d.scaleFactor || 1
  const area = d.bounds
  const cxPhys = rect ? (rect.left + rect.right) / 2 : (area.x + area.width / 2) * scale
  const topPhys = rect ? rect.top + 48 * scale : area.y * scale + 96 * scale
  const x = Math.round(cxPhys / scale - PROMPT_W / 2)
  const y = Math.round(topPhys / scale)
  const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
  return {
    x: clamp(x, area.x + 8, area.x + area.width - PROMPT_W - 8),
    y: clamp(y, area.y + 8, area.y + area.height - PROMPT_H - 8),
    width: PROMPT_W,
    height: PROMPT_H,
  }
}

function createPromptWindow(hwnd: number, rect: Rect | null, log: EventLog | null): BrowserWindow {
  const win = new BrowserWindow({
    ...promptBoundsFor(rect),
    title: TILE_PROMPT_TITLE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    // 可聚焦：Esc 与按钮点击都要求窗口能收键盘/鼠标（目标窗已在格上，确认后须重新操作）
    focusable: true,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) log?.append({ type: 'tile-prompt-renderer-console', level, message, line, sourceId })
  })
  win.webContents.on('did-fail-load', (_event, code, description, url) => {
    log?.append({ type: 'tile-prompt-load-failed', code, description, url })
  })
  return win
}

export interface TilePromptController {
  dispose(): void
  /** 当前提示窗原生句柄（诊断用；不在场 = null） */
  hwnd(): number | null
}

interface PromptRequest {
  hwnd: number
  rect: Rect
}

/**
 * 授权提示控制器：同一时刻一扇提示窗；多窗并发请求排队逐个提示（每窗独立授权）。
 * 提示窗打开即取焦（Esc 可收），窗内按钮经桥 tiling/authorize 回到服务层。
 */
export function startTilePromptController(options: { ctx: Context; log: EventLog | null }): TilePromptController {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  let current: PromptRequest | null = null
  let pending: PromptRequest[] = []
  let disposed = false

  const destroy = (): void => {
    if (win && !win.isDestroyed()) win.destroy()
    win = null
    current = null
  }

  const show = (req: PromptRequest): void => {
    if (disposed) return
    destroy()
    current = req
    win = createPromptWindow(req.hwnd, req.rect, log)
    wireBridgeIpc(win, ctx.bridge, [])
    const created = win
    created.once('closed', () => {
      if (win === created) {
        win = null
        current = null
      }
    })
    void created.loadURL(tilePromptUrl(req.hwnd))
    created.once('ready-to-show', () => {
      if (!created.isDestroyed()) {
        created.show()
        created.focus()
      }
    })
    win.show()
    win.focus()
    log?.append({ type: 'tile-prompt-created', hwnd: req.hwnd })
  }

  const next = (): void => {
    if (disposed || win) return
    const item = pending.shift()
    if (item) show(item)
  }

  const onRequest = (payload: PromptRequest): void => {
    if (disposed) return
    if (current?.hwnd === payload.hwnd) return
    if (pending.some((p) => p.hwnd === payload.hwnd)) return
    if (win) pending.push(payload)
    else show(payload)
  }

  const onClosed = (payload: { hwnd: number }): void => {
    pending = pending.filter((p) => p.hwnd !== payload.hwnd)
    if (current?.hwnd !== payload.hwnd) return
    log?.append({ type: 'tile-prompt-closed', hwnd: payload.hwnd })
    destroy()
    next()
  }

  ctx.on('tiling/authorize-request', onRequest)
  ctx.on('tiling/authorize-closed', onClosed)
  // 切出 Agent 桌面：提示不再有意义（服务层已撤销授权）——收窗零残留
  ctx.on('workspace/changed', (state) => {
    if (state.current !== 'agent') {
      pending = []
      destroy()
    }
  })

  return {
    dispose(): void {
      disposed = true
      pending = []
      destroy()
    },
    hwnd(): number | null {
      return win && !win.isDestroyed() ? hwndOf(win) : null
    },
  }
}
