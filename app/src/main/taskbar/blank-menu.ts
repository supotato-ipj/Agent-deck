// 空白右键菜单浮层宿主（工单196）：五面迁移之三。菜单面 = 开始组/推荐组空白右键
// （系统按钮显隐（工单54）+ 恢复段（工单161）——横排时代两组宿主同一份行集，共用
// menu=blank 适配器，开层 URL 不带域参数即「同一菜单面」）。通用载体（popup.ts）承载，
// 域语义只三样：存证事件名（taskbar-blank-menu-* 家族）、寻址键（?menu=blank）、
// 开层/收层请求（taskbar-blank-menu-open/-close，条带页转发）。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarMenuUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（各面独立标题，窗常驻防寻窗歧义） */
export const BLANK_MENU_TITLE = 'DECK-TASKBAR-BLANK-MENU'

export interface BlankMenuHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/** 空白右键菜单浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startBlankMenuHost(options: { ctx: Context; log: EventLog | null }): BlankMenuHost {
  const { ctx, log } = options
  const carrier = startPopupMenuCarrier({
    ctx,
    log,
    title: BLANK_MENU_TITLE,
    events: { opened: 'taskbar-blank-menu-opened', resized: 'taskbar-blank-menu-resized', closed: 'taskbar-blank-menu-closed' },
    readyEvent: 'taskbar-blank-menu-ready',
    closeEvent: 'taskbar-blank-menu-close',
    diagPrefix: 'blank-menu',
    bridgeChannels: ['taskbar/changed'],
  })

  // 视口帽随工作区下发（app-menu 先例同式；开层首拍才取工作区）
  let maxH = 0
  const menuUrl = (): string => {
    if (!maxH) maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
    return `${taskbarMenuUrl()}?menu=blank&maxH=${maxH}`
  }

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-blank-menu-open') {
        // 右键手势恒开：同 URL = show 即刻重锚定（开始组↔推荐组换宿主也同面——恒重开）
        carrier.open({ url: menuUrl() })
      } else if (type === 'taskbar-blank-menu-close') {
        carrier.close(String((payload as { reason?: unknown } | undefined)?.reason ?? 'request'))
      }
    },
    close(reason) {
      carrier.close(reason)
    },
    dispose() {
      carrier.dispose()
    },
  }
}
