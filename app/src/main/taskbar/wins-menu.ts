// 多窗选窗列表浮层宿主（工单196）：五面迁移之五。菜单面 = 应用组多窗应用左键点出的
// 选窗列表（工单53；app-click 裁决 window-list 时开层）。通用载体（popup.ts）承载，域
// 语义只三样：存证事件名（taskbar-wins-menu-* 家族）、寻址键（?menu=wins&exe=<enc>——
// 行集由载页按 exe 即席经 taskbar/app-windows 拉取，不进开层请求）、开层/收层请求
// （taskbar-wins-menu-open/-close，条带页转发）。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarMenuUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（各面独立标题，窗常驻防寻窗歧义） */
export const WINS_MENU_TITLE = 'DECK-TASKBAR-WINS-MENU'

export interface WinsMenuHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/** 多窗选窗列表浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startWinsMenuHost(options: { ctx: Context; log: EventLog | null }): WinsMenuHost {
  const { ctx, log } = options
  const carrier = startPopupMenuCarrier({
    ctx,
    log,
    title: WINS_MENU_TITLE,
    events: { opened: 'taskbar-wins-menu-opened', resized: 'taskbar-wins-menu-resized', closed: 'taskbar-wins-menu-closed' },
    readyEvent: 'taskbar-wins-menu-ready',
    closeEvent: 'taskbar-wins-menu-close',
    diagPrefix: 'wins-menu',
    bridgeChannels: ['taskbar/changed'],
  })

  // 视口帽随工作区下发（app-menu 先例同式；开层首拍才取工作区）
  let maxH = 0
  const menuUrl = (exe: string): string => {
    if (!maxH) maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
    return `${taskbarMenuUrl()}?menu=wins&exe=${encodeURIComponent(exe)}&title=${encodeURIComponent(WINS_MENU_TITLE)}&maxH=${maxH}`
  }

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-wins-menu-open') {
        const exe = String((payload as { exe?: unknown } | undefined)?.exe ?? '')
        if (!exe) return // 空身份是噪声：不开层
        // 左键手势恒开：URL 未变（同应用再点）= show 即刻重锚定；换应用 = reload 行集
        carrier.open({ url: menuUrl(exe) })
      } else if (type === 'taskbar-wins-menu-close') {
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
