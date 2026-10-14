// 应用组图标右键菜单浮层（工单193）：任务栏弹窗菜单通路的首个菜单面——从「横排渲染
// 进开始组 pill」（几何受限折衷，ADR-0013 判负：功能项出现在屏幕左端违反右键菜单心智）
// 迁为鼠标位置竖排弹窗。条目集维持现状（手钉/解除手钉、关闭窗口、打开文件位置），
// 动作存证名（taskbar-app-menu-action 族）与几何上报字段不变。
// 载体 = 通用弹窗通路（popup.ts）：独立浮层窗、锚光标上方弹出、工作区夹取、blur/点外
// 即收，窗参数与托盘溢出先例逐字对齐（同一载体实现，结构性对齐不靠抄写）。
// 开层语义 = 右键手势恒（重）开（原生右键菜单同款）：在场遇同目标开层即重锚定（不
// 拨动收层——右键不是拨动钮；换目标重载行集）；行集由载页按 exe 自足推导
// （taskbarAppMenuPopupRows——与条带视图同一份视图模型，永不各判一次）。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarMenuUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（TRAY_OVERFLOW_TITLE 先例） */
export const TASKBAR_MENU_TITLE = 'DECK-TASKBAR-MENU'

export interface AppMenuHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/**
 * 应用组菜单浮层宿主：条带页右键请求开层（携带 exe 身份）→ 通用载体（首开建窗 /
 * 换目标重载 / 同目标重锚定）→ 载页按 exe 推导行集渲染 → 实测回报
 * （taskbar-app-menu-ready）→ 按内容定窗、锚光标上方弹出（工作区夹取）并取焦。
 * 收层 = hide（窗常驻）：blur（点面板外）/ 行点（页请求，动作存证先行、收层殿后）/
 * 条带点击转达 / 条目退场（页自收）/ 全屏让位 / 条带销毁（destroy）。
 */
export function startAppMenuHost(options: { ctx: Context; log: EventLog | null }): AppMenuHost {
  const { ctx, log } = options
  const carrier = startPopupMenuCarrier({
    ctx,
    log,
    title: TASKBAR_MENU_TITLE,
    events: { opened: 'taskbar-app-menu-opened', resized: 'taskbar-app-menu-resized', closed: 'taskbar-app-menu-closed' },
    readyEvent: 'taskbar-app-menu-ready',
    closeEvent: 'taskbar-app-menu-close',
    diagPrefix: 'app-menu',
    bridgeChannels: ['taskbar/changed'],
  })

  // 视口帽随工作区下发（托盘溢出先例同式；应用组行集 ≤3 行远不及帽，极端机器态兜底）
  const maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
  const menuUrl = (exe: string): string =>
    `${taskbarMenuUrl()}?menu=app&exe=${encodeURIComponent(exe)}&maxH=${maxH}`

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-app-menu-open') {
        const exe = String((payload as { exe?: unknown } | undefined)?.exe ?? '')
        if (!exe) return // 空身份是噪声：不开层
        // 右键手势恒开：URL 未变（同目标）= show 即刻重锚定；换目标 = reload 行集
        carrier.open({ url: menuUrl(exe) })
      } else if (type === 'taskbar-app-menu-close') {
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
