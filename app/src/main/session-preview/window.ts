// Agent 会话预览气泡窗控制器（工单381，spec #369 决策 24/25/27）：悬停任务栏模式切换组
// 的 Agent 入口 300ms 后，在图标上方弹出横向会话卡片流。复用既有 Electron 置顶窗承载
// （决策 25：不引入第二套 UI 框架/常驻面板实例）——无边框透明置顶窗，内容页
// session-preview.html，由桥事件 'session-preview/changed' 驱动。
//
// 光标事实来源：任务栏条带窗的热区跟踪器（25ms 光标轮询）把命中的热区 id 经
// 'taskbar/cursor-zone' 报出——Agent 入口的 id 是 'mode:agent'。时间语义归
// hover.ts 的纯状态机（300ms 展开 / 400ms 移入宽限 / Esc 收起），本文件只把它接到
// Electron 窗口上。首版只读：卡片无点击直达，点外（失焦）与 Esc 收起。
//
// 常热承载：Agent 桌面入口可用即预建承载窗停在屏幕外（渲染层常热，展开只做移动+取焦，
// 预览窗同款取舍）；不可用即销窗，零残留。
import { BrowserWindow, globalShortcut, screen } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import type { SessionPreviewState } from '../../shared/contract'
import { wireBridgeIpc, wireHostIpc } from '../panel-ipc'
import type { EventLog } from '../panel-ipc'
import { sessionPreviewUrl } from '../plugins/protocol'
import { hwndOf } from '../win32'
import { SESSION_PREVIEW_ANCHOR_ZONE, initialHoverState, reduceHover } from './hover'
import type { HoverState } from './hover'

/** 气泡窗标题：验收控制器按 pid + 标题寻窗（CAPSULE_TITLE/PREVIEW_TITLE 先例） */
export const SESSION_PREVIEW_TITLE = 'DECK-SESSION-PREVIEW'

/** 状态机泵间隔（与热区跟踪器同频；300/400ms 判定精度 ±25ms） */
const PUMP_MS = 25
/** 气泡底边距锚点上方的间隙（DIP） */
const GAP = 8
/** 任务栏条带高（DIP，taskbar/window 同源常量）：气泡底边始终停在条带上沿之上 */
const TASKBAR_STRIP_H = 48
const MIN_W = 220
const MAX_W = 1000
const DEFAULT_W = 360
const DEFAULT_H = 132
const MIN_H = 72
const MAX_H = 260

interface BubbleSize {
  w: number
  h: number
}

function workArea(): Electron.Rectangle {
  const d = screen.getPrimaryDisplay()
  return d.workArea ?? d.bounds
}

/** 自绘任务栏条带上沿（DIP）：主屏底边向上 48 DIP */
function stripTopDip(): number {
  const d = screen.getPrimaryDisplay()
  return d.bounds.y + d.bounds.height - TASKBAR_STRIP_H
}

/** 关闭态承载位：屏幕外但保持可见（Chromium 会冻结隐藏窗渲染层；预览窗同款取舍） */
function parkedBounds(size: BubbleSize): Electron.Rectangle {
  const area = workArea()
  return { x: area.x - size.w - 64, y: area.y + 64, width: size.w, height: size.h }
}

/**
 * 锚点（光标位）+ 气泡尺寸 → 工作区夹取的展开位：水平居中于锚点；垂直方向**始终停在
 * 任务栏条带上沿之上**（锚点本身就在条带里——只用光标位会把气泡压到条带上）。
 */
export function bubbleAnchorBounds(anchor: { x: number; y: number }, size: BubbleSize, area: Electron.Rectangle, barTop?: number): Electron.Rectangle {
  const w = Math.min(size.w, Math.max(MIN_W, area.width - 40))
  const h = Math.min(size.h, Math.max(MIN_H, area.height - 40))
  const x = Math.max(area.x + 8, Math.min(anchor.x - Math.round(w / 2), area.x + area.width - w - 8))
  const limit = Math.min(barTop === undefined ? area.y + area.height : barTop, area.y + area.height)
  const y = Math.max(area.y + 8, Math.min(anchor.y - h - GAP, limit - h - GAP))
  return { x, y, width: w, height: h }
}

export interface SessionPreviewController {
  dispose(): void
  /** 当前气泡窗原生句柄（不在场 = null） */
  hwnd(): number | null
}

/**
 * 气泡控制器：跟随工作区可用性建/销承载窗，按热区光标事实推进悬停状态机，
 * 在 open/close 动作上调用 SessionPreviewService.open()/close(reason)。
 */
export function startSessionPreviewController(options: { ctx: Context; log: EventLog | null }): SessionPreviewController {
  const { ctx, log } = options
  let win: BrowserWindow | null = null
  let machine: HoverState = initialHoverState()
  let anchor: { x: number; y: number } | null = null
  let size: BubbleSize = { w: DEFAULT_W, h: DEFAULT_H }
  let disposed = false
  /** 自家 hide/show 引发的 blur 不当作「点外收起」 */
  let swallowingBlur = false

  const service = () => ctx.sessionPreview

  const createWindow = (): void => {
    const w = new BrowserWindow({
      ...parkedBounds(size),
      title: SESSION_PREVIEW_TITLE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      hasShadow: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 可聚焦：Esc 与滚轮需要键鼠输入（预览窗同款）；失焦 = 点外收起
      focusable: true,
      webPreferences: {
        preload: path.join(__dirname, '../../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    wireBridgeIpc(w, ctx.bridge, ['session-preview/changed'])
    wireHostIpc(w, null, log, {
      onNotify: (type, payload) => {
        if (type === 'session-preview-size') {
          const w2 = Number((payload as { w?: unknown } | undefined)?.w)
          const h2 = Number((payload as { h?: unknown } | undefined)?.h)
          if (Number.isFinite(w2) && Number.isFinite(h2)) {
            size = {
              w: Math.max(MIN_W, Math.min(MAX_W, Math.round(w2))),
              h: Math.max(MIN_H, Math.min(MAX_H, Math.round(h2))),
            }
            if (win && !win.isDestroyed() && win.isVisible() && anchor) {
              win.setBounds(bubbleAnchorBounds(anchor, size, workArea(), stripTopDip()))
            }
          }
        } else if (type === 'session-preview-pointer') {
          const inside = Boolean((payload as { inside?: unknown } | undefined)?.inside)
          machine = reduceHover(machine, { type: inside ? 'enter-bubble' : 'leave-bubble' }, Date.now()).state
        } else if (type === 'session-preview-esc') {
          closeByUser('esc')
        }
      },
    })
    w.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault()
        closeByUser('esc-key')
      }
    })
    w.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      if (level >= 2) log?.append({ type: 'session-preview-renderer-console', level, message, line, sourceId })
    })
    w.webContents.on('did-fail-load', (_event, code, description, url) => {
      log?.append({ type: 'session-preview-load-failed', code, description, url })
    })
    // 点外收起（失焦）：只在气泡确实展开时收
    w.on('blur', () => {
      if (disposed || swallowingBlur) return
      if (service()?.isOpen()) closeByUser('blur')
    })
    w.once('ready-to-show', () => {
      // 常热：屏幕外保持可见（不取焦）
      if (!disposed && !w.isDestroyed()) w.showInactive()
    })
    void w.loadURL(sessionPreviewUrl())
    log?.append({ type: 'session-preview-window-created' })
    win = w
  }

  const destroyWindow = (reason: string): void => {
    if (!win) return
    unregisterEsc()
    const w = win
    win = null
    if (!w.isDestroyed()) {
      swallowingBlur = true
      w.hide()
      w.destroy()
      swallowingBlur = false
    }
    log?.append({ type: 'session-preview-window-closed', reason })
  }

  const available = (): boolean => Boolean(service()?.state().available)

  const syncWindow = (): void => {
    if (disposed) return
    if (available() && !win) createWindow()
    else if (!available() && win) destroyWindow('unavailable')
  }

  // Esc 收起（spec 决策 24）：气泡是悬停唤起的浮层，Windows 前台锁可能拒绝它取键焦点
  // （悬停只有鼠标移动、没有点击输入）——只在展开期间临时注册 Esc 全局快捷键兜底，
  // 收起即注销（不让全局键长期存在；注册失败如实落存证、窗口取焦路径仍有效）。
  let escRegistered = false
  const registerEsc = (): void => {
    if (escRegistered || disposed) return
    try {
      escRegistered = globalShortcut.register('Escape', () => closeByUser('esc-global'))
      log?.append({ type: escRegistered ? 'session-preview-esc-registered' : 'session-preview-esc-register-failed' })
    } catch (err) {
      escRegistered = false
      log?.append({ type: 'session-preview-esc-register-failed', message: err instanceof Error ? err.message : String(err) })
    }
  }
  const unregisterEsc = (): void => {
    if (!escRegistered) return
    escRegistered = false
    try { globalShortcut.unregister('Escape') } catch { /* 应用退出路径尽力 */ }
    log?.append({ type: 'session-preview-esc-unregistered' })
  }

  const openBubble = (): void => {
    const svc = service()
    if (!svc || !svc.open()) return
    if (!win || win.isDestroyed()) createWindow()
    const w = win
    if (!w || w.isDestroyed()) return
    anchor = screen.getCursorScreenPoint()
    w.setBounds(bubbleAnchorBounds(anchor, size, workArea(), stripTopDip()))
    swallowingBlur = true
    w.show()
    w.focus()
    swallowingBlur = false
    registerEsc()
    log?.append({ type: 'session-preview-window-shown', anchor, bounds: w.getBounds(), cards: cardCount(svc.state()) })
  }

  const closeBubble = (reason: string): void => {
    const svc = service()
    if (svc) svc.close(reason)
    if (win && !win.isDestroyed() && win.isVisible()) {
      swallowingBlur = true
      win.hide()
      swallowingBlur = false
      log?.append({ type: 'session-preview-window-hidden', reason })
    }
    unregisterEsc()
    anchor = null
  }

  const closeByUser = (reason: string): void => {
    machine = initialHoverState()
    closeBubble(reason)
  }

  const applyAction = (action: 'none' | 'open' | 'close'): void => {
    if (action === 'open') openBubble()
    else if (action === 'close') closeBubble('grace')
  }

  const feed = (event: 'enter-anchor' | 'leave-anchor'): void => {
    if (disposed || !available()) return
    const r = reduceHover(machine, { type: event }, Date.now())
    machine = r.state
    applyAction(r.action)
  }

  const pump = (): void => {
    if (disposed) return
    if (machine.phase === 'idle') return
    const r = reduceHover(machine, { type: 'tick' }, Date.now())
    if (r.state !== machine) machine = r.state
    applyAction(r.action)
  }
  const pumpTimer = setInterval(pump, PUMP_MS)

  const onZone = ({ id }: { id: string | null }): void => {
    if (id === SESSION_PREVIEW_ANCHOR_ZONE) feed('enter-anchor')
    else feed('leave-anchor')
  }
  const offZone = ctx.on('taskbar/cursor-zone', onZone)
  const offWorkspace = ctx.on('workspace/changed', () => {
    syncWindow()
    // 锚点消失（开关关/能力不可用）：气泡立即收起，不留孤儿窗
    if (!available() && machine.phase !== 'idle') closeByUser('unavailable')
  })

  syncWindow()

  return {
    hwnd: () => {
      if (!win || win.isDestroyed()) return null
      try {
        return hwndOf(win)
      } catch {
        return null
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearInterval(pumpTimer)
      offZone()
      offWorkspace()
      destroyWindow('dispose')
    },
  }
}

function cardCount(state: SessionPreviewState): number {
  return state.groups.reduce((n, g) => n + g.cards.length, 0)
}
