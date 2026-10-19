// 渲染层通用格式化（工单10）：面板自身与插件共用的呈现小工具。
//
// 为什么经宿主转交而不让插件各自 import：插件资产经协议投递，URL 主机名就是插件 id
// （`deck-plugin://<id>/…`），插件目录之外的兄弟文件在协议寻址里**不存在**——卡片自带的
// 相对导入一旦指向目录外就 404，整条模块图随之加载失败（真机踩过：五卡首跑全灭即此）。
// 故这些共用工具由宿主放在 PluginHost.util 上交给插件：插件保持「单文件、零相对导入」。
/** 两位补零 */
export function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

/** 三位补零（会话计数、百分比） */
export function pad3(n: number): string {
  return String(n).padStart(3, '0')
}

/** 百分比位：null/undefined 落占位符（源不可用时显示 ---，不是 0） */
export function pct(x: number | null | undefined): string {
  return x == null ? '---' : pad3(Math.round(x))
}

/** HTML 转义（会话项目名、任务名等外部文本一律过它再进 innerHTML） */
export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string))
}
