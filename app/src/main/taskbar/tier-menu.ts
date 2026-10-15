// 托盘档位菜单浮层宿主（工单196）：五面迁移之四。菜单面 = 右组空白/托盘「⋯」右键的
// 档位菜单（托盘 3/5/8/全部，工单162 条目集现状不变）。通用载体（popup.ts）承载，域
// 语义只三样：存证事件名（taskbar-tier-menu-* 家族，勿与托盘溢出/托盘回放两家族混用）、
// 寻址键（?menu=tier——行集由载页按档位自足推导）、开层/收层请求（taskbar-tier-menu-
// open/-close，条带页转发）。与工单194 托盘让位闸门无触发面交叠：档位菜单是自绘浮层窗
// （原生菜单让位的需求面自绘形态天然消解），闸门只作用于条带窗置顶重申点，浮层自持置顶。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarMenuUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（各面独立标题，窗常驻防寻窗歧义） */
export const TIER_MENU_TITLE = 'DECK-TASKBAR-TIER-MENU'

export interface TierMenuHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/** 托盘档位菜单浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startTierMenuHost(options: { ctx: Context; log: EventLog | null }): TierMenuHost {
  const { ctx, log } = options
  const carrier = startPopupMenuCarrier({
    ctx,
    log,
    title: TIER_MENU_TITLE,
    events: { opened: 'taskbar-tier-menu-opened', resized: 'taskbar-tier-menu-resized', closed: 'taskbar-tier-menu-closed' },
    readyEvent: 'taskbar-tier-menu-ready',
    closeEvent: 'taskbar-tier-menu-close',
    diagPrefix: 'tier-menu',
    bridgeChannels: ['taskbar/changed'],
  })

  // 视口帽随工作区下发（app-menu 先例同式；开层首拍才取工作区）
  let maxH = 0
  const menuUrl = (): string => {
    if (!maxH) maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
    return `${taskbarMenuUrl()}?menu=tier&maxH=${maxH}`
  }

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-tier-menu-open') {
        // 右键手势恒开：同 URL = show 即刻重锚定（两挂点「⋯」/右组空白同面——恒重开，
        // 横排时代的开→右键拨动收层随通路语义退役：右键不是拨动钮）
        carrier.open({ url: menuUrl() })
      } else if (type === 'taskbar-tier-menu-close') {
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
