// 对话窗（工单332，GLOSSARY「对话窗」）：独立面板内置的对话小窗，属内核 UI——只做
// 呈现与输入。普通可聚焦窗（用户要在里面打字），与面板本体（永不激活、钉底穿透）不同域。
//
// 生命周期语义（ADR-0018「窗口可见性不等于生命周期」）：
// - 关窗只收起：WM_CLOSE → preventDefault + hide（进程不动、会话继续在跑）；
// - 显式「结束会话」（conversation/end）或面板退出（dispose）才回收每会话进程；
// - 面板退出前若有在途 turn，弹一次确认（ADR-0018「退出不确认」的反对理由），确认后
//   全部会话随内核 dispose 终止，不留后台孤儿（Job Object kill-on-close 兜底）。
//
// 页面经 deck-plugin:// 协议加载（与面板页/条带页同源同通道），桥接事件按窗订阅
// conversation/changed（wireBridgeIpc 的显式事件清单）。

import { app, BrowserWindow, dialog } from 'electron'
import path from 'node:path'
import type { Context } from 'cordis'
import { conversationUrl } from '../plugins/protocol'
import { wireBridgeIpc } from '../panel-ipc'
import type { EventLog } from '../panel-ipc'

export const CONVERSATION_WINDOW_TITLE = 'DECK-CONVERSATION'

export interface ConversationWindowOptions {
  ctx: Context
  log?: EventLog | null
}

export interface ConversationWindowController {
  /** 唤起对话窗（已开则显示+置前）；可带目标会话（无 = 最近活跃） */
  show(sessionId?: string): void
  /** 面板退出钩子（before-quit 前调）：有在途 turn 时同步确认，false = 用户取消退出 */
  confirmQuitIfBusy(): boolean
  dispose(): void
}

export function startConversationWindow(options: ConversationWindowOptions): ConversationWindowController {
  const { ctx } = options
  const log = options.log ?? null
  let win: BrowserWindow | null = null
  let quitting = false

  function ensureWindow(): BrowserWindow {
    if (win && !win.isDestroyed()) return win
    win = new BrowserWindow({
      title: CONVERSATION_WINDOW_TITLE,
      width: 480,
      height: 640,
      minWidth: 360,
      minHeight: 420,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#141820',
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    // 关窗只收起（ADR-0018）：窗口可见性不是会话生命周期
    win.on('close', (e) => {
      if (quitting) return
      e.preventDefault()
      win?.hide()
      log?.append({ type: 'conversation-window-hidden', sessionId: activeSessionId() })
    })
    // 渲染层标题自绘会顶掉设定：保持固定窗口标题（电池按它寻窗）
    win.on('page-title-updated', (e) => e.preventDefault())
    // 桥接事件按窗订阅（工单334 修复：此前 wireBridgeIpc 只 import 未调用——窗收不到
    // 任何推送，对话流式/安装提案全靠启动首拉，窗内 UI 停滞）：会话流 + 安装提案两通道
    wireBridgeIpc(win, ctx.bridge, ['conversation/changed', 'install/changed'])
    win.once('ready-to-show', () => win?.showInactive())
    void win.loadURL(conversationUrl())
    return win
  }

  function activeSessionId(): string | null {
    const sessions = ctx.conversation?.sessions() ?? []
    const running = sessions.find((s) => s.status === 'ready' || s.status === 'busy' || s.status === 'starting')
    return running?.id ?? sessions[0]?.id ?? null
  }

  function show(sessionId?: string): void {
    ensureWindow()
    if (win!.isMinimized()) win!.restore()
    win!.show()
  }

  function confirmQuitIfBusy(): boolean {
    const busy = ctx.conversation?.hasInFlightTurns() ?? false
    if (!busy) return true
    const choice = dialog.showMessageBoxSync({
      type: 'question',
      buttons: ['终止会话并退出', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: 'AGENT DECK',
      message: '有会话正在回复中。退出面板会终止全部后端会话进程（正文由后端保存，可续接）。',
    })
    if (choice === 1) {
      log?.append({ type: 'quit-aborted', reason: 'conversation-busy' })
      return false
    }
    return true
  }

  function dispose(): void {
    quitting = true
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }

  return { show, confirmQuitIfBusy, dispose }
}

/** 面板退出序列接线：before-quit 一道闸——在途 turn 确认 + 对话窗销毁标记 */
export function wireConversationQuitGuard(controller: ConversationWindowController): void {
  app.on('before-quit', (e) => {
    if (!controller.confirmQuitIfBusy()) {
      e.preventDefault()
      return
    }
    controller.dispose()
  })
}
