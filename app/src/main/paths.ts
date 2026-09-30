// 应用数据落点（工单06）：面板的持久化状态（摆位存储、使用日志）住 userData，
// 不进代码目录。Electron 不可用（离线测试未注入路径）时退 LOCALAPPDATA 猜测——
// 与 config.json 留在代码目录的「用户可编辑」语义相反，这里存的是运行态数据。
import path from 'node:path'

/** Electron 运行时之外（离线测试、ELECTRON_RUN_AS_NODE 守护）没有 process.type；
 * 此时绝不能尝试 require('electron')——纯 Node 里它不抛错，而是触发 electron 包的
 * 同步按需下载（dist 缺失时下载整个 ~120MB 二进制，GH 冷 runner 上数秒到数十秒），
 * 把「优雅降级」变成一场把 5s 测试用例拖死的隐藏开销（工单07 CI 三连实证：
 * service.spec 首个未传 storeFile 的用例在下载窗口内超时，缓存暖时又侥幸通过）。 */
function inElectronRuntime(): boolean {
  return (process as { type?: string }).type !== undefined
}

/** userData 下的子路径（如 layout.json、usage/） */
export function userDataPath(...segments: string[]): string {
  const fallback = () => path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'agent-deck-panel', ...segments)
  if (!inElectronRuntime()) return fallback()
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), ...segments)
  } catch {
    return fallback()
  }
}
