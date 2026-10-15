// 推荐组条目菜单浮层宿主（工单196）：五面迁移之二。菜单面 = 推荐位图标右键三行
// （手钉到任务栏/从推荐栏移除/打开文件位置，条目集现状不变）。通用载体（popup.ts）
// 承载，域语义只三样：存证事件名（taskbar-rec-menu-* 家族，勿与别域混用）、寻址键
// （?menu=rec&exe=<enc>&name=<enc>——行集由载页按 exe 自足推导，name 只随动作事件
// 原样回传）、开层/收层请求（taskbar-rec-menu-open/-close，条带页转发）。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarMenuUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（DECK-TASKBAR-MENU 先例；各面独立标题——
 * 窗常驻同 title 多扇会让电池寻窗歧义） */
export const REC_MENU_TITLE = 'DECK-TASKBAR-REC-MENU'

export interface RecMenuHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/** 推荐组条目菜单浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startRecMenuHost(options: { ctx: Context; log: EventLog | null }): RecMenuHost {
  const { ctx, log } = options
  const carrier = startPopupMenuCarrier({
    ctx,
    log,
    title: REC_MENU_TITLE,
    events: { opened: 'taskbar-rec-menu-opened', resized: 'taskbar-rec-menu-resized', closed: 'taskbar-rec-menu-closed' },
    readyEvent: 'taskbar-rec-menu-ready',
    closeEvent: 'taskbar-rec-menu-close',
    diagPrefix: 'rec-menu',
    bridgeChannels: ['taskbar/changed'],
  })

  // 视口帽随工作区下发（app-menu 先例同式；开层首拍才取工作区——宿主装配拍可能早于
  // app ready，screen 未就绪即取会炸）
  let maxH = 0
  const menuUrl = (exe: string, name: string): string => {
    if (!maxH) maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
    return `${taskbarMenuUrl()}?menu=rec&exe=${encodeURIComponent(exe)}&name=${encodeURIComponent(name)}&maxH=${maxH}`
  }

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-rec-menu-open') {
        const p = (payload ?? {}) as { exe?: unknown; name?: unknown }
        const exe = String(p.exe ?? '')
        if (!exe) return // 空身份是噪声：不开层
        // 右键手势恒开：URL 未变（同目标）= show 即刻重锚定；换目标 = reload 行集
        carrier.open({ url: menuUrl(exe, String(p.name ?? '')) })
      } else if (type === 'taskbar-rec-menu-close') {
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
