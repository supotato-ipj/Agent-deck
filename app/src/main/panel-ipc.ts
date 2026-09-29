import { BrowserWindow, ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { BridgeEventName, BridgeMethod, HotzoneRect } from '../shared/contract'
import type { BridgeService } from './services/bridge'
import type { HotzoneTracker } from './hotzone'
import { pinToBottom } from './win32'

/** 存证事件日志：验收电池经 DECK_EVENT_LOG 环境变量启用，主进程关键行为逐行落盘。 */
export interface EventLog {
  append(event: Record<string, unknown>): void
}

export function fileEventLog(file: string | undefined): EventLog | null {
  if (!file) return null
  fs.mkdirSync(path.dirname(file), { recursive: true })
  return {
    append(event) {
      try {
        fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...event }) + '\n')
      } catch { /* 存证尽力而为，不影响面板运行 */ }
    },
  }
}

/**
 * 内核桥接通道：渲染层 invoke → 内核；内核事件推送 → 渲染层。
 * 传输层用 ok/error 信封（IPC 对 Error 序列化不保真），preload 侧解包还原为 reject。
 */
const FORWARDED_EVENTS: BridgeEventName[] = [
  'panel/changed',
  'search/state',
  'search/results',
  'settings/changed',
  'plugins/changed',
]

export function wireBridgeIpc(win: BrowserWindow, bridge: BridgeService): void {
  ipcMain.handle('deck:bridge-invoke', (_event, req: { method: string; payload?: unknown }) => {
    const { method, payload } = req ?? {}
    return bridge.invoke(method as BridgeMethod, payload as never).then(
      (result: unknown) => ({ ok: true, result }),
      (err: unknown) => ({
        ok: false,
        error: { message: err instanceof Error ? err.message : String(err) },
      }),
    )
  })
  const offs = FORWARDED_EVENTS.map((name) =>
    bridge.subscribe(name, (payload) => {
      if (!win.isDestroyed()) win.webContents.send('deck:bridge-event', name, payload)
    }),
  )
  win.once('closed', () => offs.forEach((off) => off()))
}

/** 窗口宿主通道（非内核契约）：热区声明、键盘模式开关与点击存证。 */
export function wireHostIpc(win: BrowserWindow, tracker: HotzoneTracker, log: EventLog | null): void {
  ipcMain.on('deck:host-set-hotzones', (_event, rects: HotzoneRect[]) => {
    tracker.setRects(rects)
    log?.append({ type: 'hotzones', rects })
  })
  ipcMain.on('deck:host-notify', (_event, msg: { type: string; payload?: Record<string, unknown> }) => {
    log?.append({ type: msg?.type, ...(msg?.payload ?? {}) })
  })
  // 键盘模式（工单02）：面板永不激活，需要键盘的场景（搜索输入、设置浮层）经此临时
  // 取得键盘焦点。开 = 临时可聚焦 + 聚焦 + 立即钉底（闸门探针实证：前台/激活态下
  // HWND_BOTTOM 重钉依然生效）；关 = 恢复不可聚焦 + 钉底。退出后键盘焦点悬空、
  // 不自动还原到之前窗口（spec 拍板，与点击真实桌面同款语义）。全程 EventLog 存证。
  ipcMain.on('deck:host-keyboard-mode', (_event, on: boolean) => {
    if (win.isDestroyed()) return
    if (on) {
      win.setFocusable(true)
      win.focus()
      pinToBottom(win)
      log?.append({ type: 'keyboard-mode-on' })
    } else {
      win.setFocusable(false)
      pinToBottom(win)
      log?.append({ type: 'keyboard-mode-off' })
    }
  })
}
