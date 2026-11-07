import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { panelLabels } from './lag-sentinel'
import { probeForegroundWindow } from './taskbar/yield'
import { TRAY_POPUP_POLL_MS, trayPopupVerdict } from './tray-popup'

/**
 * 托盘常驻件（工单03）：图标程序化绘制（深底 + 琥珀色四点，deck 母题），免二进制资产。
 * 左键单击唤回面板，右键菜单提供「退出面板」；退出后随进程消失（before-quit 显式 destroy）。
 * 琥珀色 #f5a623 也是验收电池在托盘区定位本面板图标的识别色。
 */

const TRAY_TOOLTIP = 'AGENT DECK 独立面板'

/** 当前届菜单（tray-modify 时重建；'right-click' 事件取用） */
let trayMenu: Menu | null = null

function buildTrayIcon(): NativeImage {
  const size = 32
  const bg = [0x2e, 0x1f, 0x1a] // #1a1f2e 深底（BGRA）
  const dot = [0x23, 0xa6, 0xf5] // #f5a623 琥珀（BGRA）
  const dots = [[6, 6], [18, 6], [6, 18], [18, 18]] // 每个 8px 方点左上角
  const buf = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const c = dots.some(([dx, dy]) => x >= dx && x < dx + 8 && y >= dy && y < dy + 8) ? dot : bg
      const i = (y * size + x) * 4
      buf[i] = c[0]
      buf[i + 1] = c[1]
      buf[i + 2] = c[2]
      buf[i + 3] = 0xff
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size })
}

export interface TrayHooks {
  onShowPanel: () => void
  /** 对话窗入口（工单332）：无后端也可开窗（窗内自行呈现后端不可用态） */
  onShowConversation?: () => void
}

/**
 * 自控弹出 + 有界验证 + 一拍重试（工单401 A 线）。弃 setContextMenu——Chromium 的
 * 自动 TrackPopupMenu 间歇性静默不弹（真机取证：弹出窗全程零前台变迁、#32768 恒 0）；
 * 'right-click' 事件里自控 menu.popup()，弹出结果用 trayPopupVerdict 有界验证。
 * 重试机会只有一拍（防循环弹骚扰）；两拍均未见菜单窗夺前台时以 span 标签留痕。
 */
function popupTrayMenu(menu: Menu): void {
  const pre = probeForegroundWindow()
  const preFgHwnd = pre?.hwnd ?? 0
  const attempt = (retried: boolean): void => {
    panelLabels.run(retried ? 'tray-popup-retry' : 'tray-popup', () => menu.popup())
    const beginAt = Date.now()
    const timer = setInterval(() => {
      let probe = null
      try {
        probe = probeForegroundWindow()
      } catch { /* 探针抖动按缺位处理（裁决器视同基线在场） */ }
      const v = trayPopupVerdict(preFgHwnd, probe, process.pid, Date.now() - beginAt, retried)
      if (v === 'pending') return
      clearInterval(timer)
      if (v === 'settled') return
      if (v === 'retry') return attempt(true)
      panelLabels.run('tray-popup-giveup', () => {})
    }, TRAY_POPUP_POLL_MS)
  }
  attempt(false)
}

export function createTray(hooks: TrayHooks): Tray {
  // 滞后哨兵（工单117）：Tray 构造即 Shell_NotifyIcon(NIM_ADD)、tooltip/菜单即 NIM_MODIFY——
  // 同步 WM_COPYDATA 打进当届 Shell_TrayWnd 竞争赢家（H3：重启后段主嫌疑），各挂标签。
  const tray = panelLabels.run('tray-add', () => new Tray(buildTrayIcon()))
  panelLabels.run('tray-modify', () => {
    tray.setToolTip(TRAY_TOOLTIP)
    // 菜单不再 setContextMenu（Chromium 自动通路间歇不弹，工单401）——只建不挂，
    // 'right-click' 事件里走 popupTrayMenu 自控弹出。
    trayMenu = Menu.buildFromTemplate([
      ...(hooks.onShowConversation ? [{ label: '对话窗', click: () => hooks.onShowConversation?.() }] : []),
      { label: '退出面板', click: () => app.quit() },
    ])
  })
  tray.on('right-click', () => {
    if (trayMenu) popupTrayMenu(trayMenu)
  })
  tray.on('click', () => hooks.onShowPanel())
  return tray
}
