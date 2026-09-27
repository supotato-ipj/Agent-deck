import { BrowserWindow } from 'electron'
import path from 'node:path'
import type { PanelGeometry } from './config'

export interface PanelWindowOptions {
  geometry: PanelGeometry
}

/**
 * 独立面板窗口：透明无边框、默认鼠标穿透（热区跟踪器随后接管）。
 * 透明合成 GO 的结论与窗口参数来自工单01 探针（transparent+frameless，不走 alpha 降级）。
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
  win.setIgnoreMouseEvents(true, { forward: true })
  return win
}
