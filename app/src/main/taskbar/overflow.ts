// 托盘溢出菜单浮层窗（工单162，工单193 起改乘通用弹窗通路）：自绘竖排菜单面板
// （每行图标+名称）的宿主包装。载体裁定（票内三候选：主面板窗内渲染 / 独立浮层窗 /
// 条带窗扩展）= **独立浮层窗**，裁定论证与窗参数纪律见通用载体 popup.ts 模块头——
// 本票把载体泛化成 startPopupMenuCarrier 后，本模块只剩托盘域的三件事：
// - 存证事件名保持工单162 家族（taskbar-tray-overflow-opened/-resized/-closed，
//   55 电池断言面）；
// - 「⋯」拨动语义：在场浮层遇开层请求即收（toggle，应用组 ⋯ 同款）；
// - 视口帽随工作区下发（红轮实证：560px 固定帽在 25 行溢出时把尾部行推出可点区——
//   名单序尾部恰是探针/新到图标，行不可点即「溢出菜单不可用」）。
// 行内容自足于内核契约：浮层页自取 taskbar/get-state、用与条带同一条溢出拆分纯函数
// （splitTrayOverflow）切尾段——开层请求不携带名单，浮层行与条带栏面永不各判一次。
// 行交互与栏内图标共用同一道 taskbar/tray-click 回放分发（渲染层 dispatchTrayClick）。
import { screen } from 'electron'
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { taskbarOverflowUrl } from '../plugins/protocol'
import { startPopupMenuCarrier } from './popup'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（TASKBAR_TITLE 先例） */
export const TRAY_OVERFLOW_TITLE = 'DECK-TRAY-OVERFLOW'

export interface TrayOverflowHost {
  /** 条带页 host-notify 的转发入口（wireHostIpc onNotify 钩子；open/close 两型） */
  onStripNotify(type: string, payload: Record<string, unknown> | undefined): void
  /** 显式收层（全屏让位等场景；reason 落存证） */
  close(reason: string): void
  /** 条带销毁/控制器退役随行（禁用即销窗） */
  dispose(): void
}

/**
 * 托盘溢出浮层宿主：条带页「⋯」请求开层 → 通用载体（首开建窗 / 再开重定位）→ 页面
 * 自拆名单渲染行 → 实测内容回报（taskbar-tray-overflow-ready）→ 按内容定窗、锚光标
 * 上方弹出（工作区夹取）并取焦。收层 = hide（窗常驻）：blur（点面板外）/ 行点（页
 * 请求）/ 条带点击（页转达）/ 名单拆空（页请求）/ 全屏让位 / 条带销毁（destroy）/
 * 「⋯」再点（拨动 toggle）。
 */
export function startTrayOverflowHost(options: { ctx: Context; log: EventLog | null }): TrayOverflowHost {
  const { ctx, log } = options
  const carrier = startPopupMenuCarrier({
    ctx,
    log,
    title: TRAY_OVERFLOW_TITLE,
    family: 'taskbar-tray-overflow',
    events: { opened: 'taskbar-tray-overflow-opened', resized: 'taskbar-tray-overflow-resized', closed: 'taskbar-tray-overflow-closed' },
    readyEvent: 'taskbar-tray-overflow-ready',
    closeEvent: 'taskbar-tray-overflow-close',
    diagPrefix: 'tray-overflow',
    bridgeChannels: ['taskbar/changed'],
  })

  const open = (): void => {
    // 视口帽随工作区下发（红轮实证：560px 固定帽在 25 行溢出时把尾部行推出可点区——
    // 名单序尾部恰是探针/新到图标，行不可点即「溢出菜单不可用」）：工作区高留足边距，
    // 超长名单（极端机器态）才滚动（先例同式 maxH = max(320, 工作区高 - 80)）
    const maxH = Math.max(320, screen.getPrimaryDisplay().workArea.height - 80)
    const url = `${taskbarOverflowUrl()}?maxH=${maxH}`
    if (carrier.isVisible()) {
      carrier.close('toggle') // 拨动语义（应用组 ⋯ 同款）：在场浮层遇开层请求即收
      return
    }
    carrier.open({ url })
  }

  return {
    onStripNotify(type, payload) {
      if (type === 'taskbar-tray-overflow-open') open()
      else if (type === 'taskbar-tray-overflow-close') carrier.close(String((payload as { reason?: unknown } | undefined)?.reason ?? 'request'))
    },
    close(reason) {
      carrier.close(reason)
    },
    dispose() {
      carrier.dispose()
    },
  }
}
