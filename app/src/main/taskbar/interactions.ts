// 左组交互裁决纯函数（工单53，planLeftGroup 同形态）：左键点击语义——未运行（无窗口）
// → 启动；单窗口未前台 → 置前；单窗口已前台 → 最小化（Win11 任务栏同款三态）；同应用
// 多窗口 → 弹出带窗口标题的列表精确选窗（标题仅内存即时进出，ADR-0007 书面口子，
// 本模块不碰任何持久化）。中键开新实例与右键菜单动作无裁决（恒启动/恒映射），不进本模块。
// 纯函数、零 IO、零 Win32；前台判定与窗口效果由服务依赖缝注入。

/** 参与裁决的窗口快照（hwnd 即时有效；title 仅内存即时显示，空标题归 null） */
export interface TaskbarAppWindow {
  hwnd: number
  title: string | null
}

/** 左键裁决四态：launch=启动；activate=置前；minimize=最小化；pick=多窗口列表精确选窗 */
export type TaskbarClickDecision =
  | { kind: 'launch' }
  | { kind: 'activate'; hwnd: number }
  | { kind: 'minimize'; hwnd: number }
  | { kind: 'pick'; windows: TaskbarAppWindow[] }

/**
 * 左键点击裁决：windows = 该应用（exe 身份）当前的顶层可见窗口快照，foregroundHwnd =
 * 当前前台窗口（0 = 未知，按不在前台处理）。多窗口恒 pick——Win11 在此态也不最小化，
 * 而是给预览选窗；本栏以带标题的 pill 内列表承接（精确到达目标窗口）。
 */
export function decideAppClick(
  windows: readonly TaskbarAppWindow[],
  foregroundHwnd: number,
): TaskbarClickDecision {
  if (windows.length === 0) return { kind: 'launch' }
  if (windows.length === 1) {
    const only = windows[0]
    return only.hwnd === foregroundHwnd ? { kind: 'minimize', hwnd: only.hwnd } : { kind: 'activate', hwnd: only.hwnd }
  }
  return { kind: 'pick', windows: windows.map((w) => ({ hwnd: w.hwnd, title: w.title })) }
}
