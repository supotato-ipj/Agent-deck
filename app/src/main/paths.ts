// 应用数据落点（工单06）：面板的持久化状态（摆位存储、使用日志）住 userData，
// 不进代码目录。Electron 不可用（离线测试未注入路径）时退 LOCALAPPDATA 猜测——
// 与 config.json 留在代码目录的「用户可编辑」语义相反，这里存的是运行态数据。
import path from 'node:path'

/** userData 下的子路径（如 layout.json、usage/） */
export function userDataPath(...segments: string[]): string {
  try {
    const { app } = require('electron')
    return path.join(app.getPath('userData'), ...segments)
  } catch {
    return path.join(process.env.LOCALAPPDATA ?? process.cwd(), 'agent-deck-panel', ...segments)
  }
}
