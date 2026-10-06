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
  // 工单50：设置浮层逃生开关（任务栏接管 toggle）的状态回推——面板页 reconcile 用；
  // 任务栏条带窗经 wireBridgeIpc 的显式事件清单单独订阅，不受影响。
  'taskbar/changed',
]

// ipcMain.handle 是全局单例（二次注册即抛）——面板窗 + 任务栏窗（工单49）共用同一桥，
// invoke 处理器只注册一次（方法与窗口无关）；事件订阅按窗独立，各窗只收自己关心的事件。
let bridgeInvokeRegistered = false

export function wireBridgeIpc(win: BrowserWindow, bridge: BridgeService, events: BridgeEventName[] = FORWARDED_EVENTS): void {
  if (!bridgeInvokeRegistered) {
    bridgeInvokeRegistered = true
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
  }
  const offs = events.map((name) =>
    bridge.subscribe(name, (payload) => {
      if (!win.isDestroyed()) win.webContents.send('deck:bridge-event', name, payload)
    }),
  )
  win.once('closed', () => offs.forEach((off) => off()))
}

/** 窗口宿主通道（非内核契约）：热区声明、键盘模式开关与点击存证。
 * 多窗口（面板 + 工单49 任务栏窗）各自注册——ipcMain.on 是全局通道，
 * 每个处理器按 event.sender 路由到所属窗口；窗口关闭即摘除自己的处理器，不泄漏。
 * hooks.pin：键盘模式进出的 z 序恢复动作——面板钉底（默认），任务栏窗重申置顶。 */
export function wireHostIpc(win: BrowserWindow, tracker: HotzoneTracker, log: EventLog | null, hooks: { pin?: (w: BrowserWindow) => void } = {}): void {
  const pin = hooks.pin ?? pinToBottom
  const onHotzones = (event: Electron.IpcMainEvent, rects: HotzoneRect[]) => {
    if (event.sender !== win.webContents) return
    tracker.setRects(rects)
    log?.append({ type: 'hotzones', rects })
  }
  const onNotify = (event: Electron.IpcMainEvent, msg: { type: string; payload?: Record<string, unknown> }) => {
    if (event.sender !== win.webContents) return
    log?.append({ type: msg?.type, ...(msg?.payload ?? {}) })
  }
  // 键盘模式（工单02）：面板永不激活，需要键盘的场景（搜索输入、设置浮层）经此临时
  // 取得键盘焦点。开 = 临时可聚焦 + 聚焦 + 立即钉底（闸门探针实证：前台/激活态下
  // HWND_BOTTOM 重钉依然生效）；关 = 恢复不可聚焦 + 钉底。退出后键盘焦点悬空、
  // 不自动还原到之前窗口（spec 拍板，与点击真实桌面同款语义）。全程 EventLog 存证。
  const onKeyboardMode = (event: Electron.IpcMainEvent, on: boolean) => {
    if (event.sender !== win.webContents) return
    if (win.isDestroyed()) return
    if (on) {
      win.setFocusable(true)
      win.focus()
      pin(win)
      log?.append({ type: 'keyboard-mode-on' })
    } else {
      win.setFocusable(false)
      pin(win)
      log?.append({ type: 'keyboard-mode-off' })
    }
  }
  ipcMain.on('deck:host-set-hotzones', onHotzones)
  ipcMain.on('deck:host-notify', onNotify)
  ipcMain.on('deck:host-keyboard-mode', onKeyboardMode)
  wireRendererWatchdog(win, log)
  win.once('closed', () => {
    ipcMain.removeListener('deck:host-set-hotzones', onHotzones)
    ipcMain.removeListener('deck:host-notify', onNotify)
    ipcMain.removeListener('deck:host-keyboard-mode', onKeyboardMode)
  })
}

/** 渲染层看门狗（工单59 真机验收挖出）：面板本体永不激活、恒在普通窗之下，渲染层
 * 一旦失能（崩或卡）不会有任何用户可见征兆——面板只是「不响应了」，而常驻件不重启
 * 就是永久失去交互。这里把三种失能形态各自落一条存证：崩溃/退出（Electron 事件）与
 * 「收不到任何渲染层上行」（心跳超时）——后者是静默卡死的唯一可观测信号。 */
function wireRendererWatchdog(win: BrowserWindow, log: EventLog | null): void {
  const wc = win.webContents;
  wc.on('unresponsive', () => log?.append({ type: 'renderer-unresponsive' }));
  wc.on('render-process-gone', (_e, d) => log?.append({ type: 'renderer-gone', reason: d.reason, exitCode: d.exitCode }));
  if (!log) return;
  let lastBeat = Date.now();
  let reported = false;
  const beat = () => { lastBeat = Date.now(); if (reported) reported = false; };
  wc.on('ipc-message', beat);
  // 心跳：靠渲染层真实上行（热区声明/存证）计时，不另加定时器——渲染层死了就没有心跳
  const timer = setInterval(() => {
    if (win.isDestroyed() || wc.isDestroyed()) return;
    if (Date.now() - lastBeat < 5000) return;
    if (reported) return;
    reported = true;
    log.append({
      type: 'renderer-stall',
      quietMs: Date.now() - lastBeat,
      crashed: wc.isCrashed(),
      pid: wc.getOSProcessId(),
    });
  }, 2000);
  win.once('closed', () => clearInterval(timer));
}
