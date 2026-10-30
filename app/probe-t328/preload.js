// probe-t328 preload — 与 #331 生产意图同款：sandbox:true + contextIsolation:true + contextBridge。
// 故意不向 renderer 暴露任何身份参数：身份只由主进程登记表推导。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('host', {
  networkRequest: (payload) => ipcRenderer.invoke('probe:network', payload),
  mountEffect: () => ipcRenderer.send('probe:mount-effect'),
  ping: () => ipcRenderer.invoke('probe:ping')
});
