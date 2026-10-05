// 托盘 spike 验收页 preload（工单48）：只暴露托盘事件订阅一个口子。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('traySpike', {
  onEvent: (fn) => { ipcRenderer.on('tray:event', (_e, ev) => fn(ev)) },
})
