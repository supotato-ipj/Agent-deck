/**
 * 时钟呈现文本（工单477 束③，用户拍板新鲜度降级「时钟去秒」）：面板时钟卡与任务栏
 * 条带时钟只显时分——秒位不进呈现文本，每秒推送不再产生任何 DOM 文本变化（无秒级重绘）。
 * 两处呈现共用同一实现（单源），条带 formatClock 委托本函数。
 */

function pad2(v: number): string {
  return String(v).padStart(2, '0')
}

/** epochMs → 「HH:MM」（本地时区） */
export function hhmmOf(epochMs: number): string {
  const d = new Date(epochMs)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
