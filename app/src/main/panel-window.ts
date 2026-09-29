import { BrowserWindow } from 'electron'
import path from 'node:path'
import type { PanelGeometry } from './config'

export interface PanelWindowOptions {
  geometry: PanelGeometry
}

/**
 * 独立面板窗口：透明无边框、默认鼠标穿透（热区跟踪器随后接管）。
 * 透明合成 GO 的结论与窗口参数来自工单01 探针（transparent+frameless，不走 alpha 降级）。
 * 永不激活（工单02）：创建即不可聚焦（Windows 下等价 WS_EX_NOACTIVATE）——点击不激活、
 * 不顶起、不抢键盘焦点；需要键盘的场景（搜索输入、设置浮层）经宿主面「键盘模式」
 * 临时 setFocusable(true)+focus()（闸门探针 probe-focus-gate 6/6 实证稳定到手）。
 */
export function createPanelWindow(options: PanelWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    x: options.geometry.x,
    y: options.geometry.y,
    width: options.geometry.width,
    height: options.geometry.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    hasShadow: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // 默认穿透不带 forward 转发：Electron 在 Windows 上实现 forward 要在主进程装
  // 全局低级鼠标钩子（WH_MOUSE_LL），系统每个鼠标事件都串行等它——主线程任一阻塞
  // 都会拖慢全系统光标（实测采集阻塞每秒 ~300ms，见 .scratch/mouse-lag/ 基线存证）。
  // 热区判定由主进程光标轮询完成，悬停高亮由热区解除穿透后的真实事件驱动。
  win.setIgnoreMouseEvents(true)
  return win
}
