import { app, Menu, nativeImage, Tray } from 'electron'
import type { NativeImage } from 'electron'
import { panelLabels } from './lag-sentinel'

/**
 * 托盘常驻件（工单03）：图标程序化绘制（深底 + 琥珀色四点，deck 母题），免二进制资产。
 * 左键单击唤回面板，右键菜单提供「退出面板」；退出后随进程消失（before-quit 显式 destroy）。
 * 琥珀色 #f5a623 也是验收电池在托盘区定位本面板图标的识别色。
 */

const TRAY_TOOLTIP = 'AGENT DECK 独立面板'

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
}

export function createTray(hooks: TrayHooks): Tray {
  // 滞后哨兵（工单117）：Tray 构造即 Shell_NotifyIcon(NIM_ADD)、tooltip/菜单即 NIM_MODIFY——
  // 同步 WM_COPYDATA 打进当届 Shell_TrayWnd 竞争赢家（H3：重启后段主嫌疑），各挂标签。
  const tray = panelLabels.run('tray-add', () => new Tray(buildTrayIcon()))
  panelLabels.run('tray-modify', () => {
    tray.setToolTip(TRAY_TOOLTIP)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '退出面板', click: () => app.quit() },
    ]))
  })
  tray.on('click', () => hooks.onShowPanel())
  return tray
}
