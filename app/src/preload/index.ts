import { contextBridge, ipcRenderer } from 'electron'

/**
 * 渲染层唯一入口 window.deck：
 * - bridge：内核桥接契约（spec 内核契约缝，后续工单只扩展此契约）
 * - host：窗口宿主机制（热区声明、键盘模式、点击存证），与 bridge 同走一对 IPC 通道
 */
contextBridge.exposeInMainWorld('deck', {
  bridge: {
    invoke: (method: string, payload?: unknown) =>
      ipcRenderer.invoke('deck:bridge-invoke', { method, payload }).then((envelope) => {
        if (envelope && envelope.ok) return envelope.result
        throw new Error(envelope?.error?.message ?? 'bridge invoke failed')
      }),
    on: (event: string, listener: (payload: unknown) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, name: string, payload: unknown) => {
        if (name === event) listener(payload)
      }
      ipcRenderer.on('deck:bridge-event', handler)
      return () => { ipcRenderer.removeListener('deck:bridge-event', handler) }
    },
  },
  host: {
    setHotZones: (rects: unknown) => { ipcRenderer.send('deck:host-set-hotzones', rects) },
    // 键盘模式开关（工单02）：开 = 面板临时可聚焦+聚焦+钉底；关 = 恢复不可聚焦+钉底
    setKeyboardMode: (on: boolean) => { ipcRenderer.send('deck:host-keyboard-mode', on) },
    notify: (type: string, payload?: Record<string, unknown>) => {
      ipcRenderer.send('deck:host-notify', { type, payload })
    },
  },
})
