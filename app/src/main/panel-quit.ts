// 工单431：--panel-quit 退出语义的纯逻辑模块（无 electron 依赖，单测直测）。
//
// 背景：guard 清场的优雅径原走 WM_CLOSE（taskkill 不带 /F），真机 3 轮全 forced
//（#429 取证 t429-r1/r2/r3.log）——除主窗收 WM_CLOSE 不走关闭链外，更结构性的是
// 外层守卫（disableHardwareAcceleration、零窗口）与渲染/GPU 子进程根本没有顶层窗，
// 15 PID 中 9 个永远收不到窗口消息。本模块提供绕开窗口消息的退出入口：
// 新实例带 --panel-quit 拉起 → 单实例锁把 argv 转发给持锁面板 → 面板 second-instance
// 认旗标走 app.quit() 完整退出链（dispose 链 + 托盘图标注销），面板退 → 外层守卫
// child-exit 跑还原账后自杀 → 渲染/GPU 子进程随 Chromium job 收走——全树优雅退场。
// 决策全记录见 docs/adr/0030-panel-quit-second-instance.md。

/**
 * 退出旗标。与 --panel / --panel-accept 同族命名，但语义是「叫持锁面板退出」的
 * 一次性退出实例：本进程不拉任何 UI、不持锁常驻（拿到锁即还锁即退）。
 */
export const PANEL_QUIT_FLAG = '--panel-quit'

/** argv 是否带 --panel-quit（退出实例端与持锁面板端共用同一判别）。 */
export function hasPanelQuitFlag(argv: string[]): boolean {
  return argv.includes(PANEL_QUIT_FLAG)
}

/**
 * 退出实例的行动计划：无论拿锁成败，本实例都是「即刻退、不拉任何 UI」——
 * 区别只在退出理由（供日志/断言分径）。这钉死共识红线：退出实例绝不反拉新面板。
 */
export type QuitInstancePlan = { outcome: 'no-panel' } | { outcome: 'forwarded' }

/**
 * 拿锁结果 → 退出实例计划。
 * - 拿到锁 = 无常驻面板在跑（含守卫 spawn 面板前的显式让位空窗期）：无事可退，
 *   还锁即退，不拉守卫、不拉面板。
 * - 拿锁失败 = 常驻面板在跑：requestSingleInstanceLock 内部已把本实例 argv 转发给
 *   持锁面板（其 second-instance 认旗标走完整退出链），本实例功成身退。
 */
export function planQuitInstance(lockAcquired: boolean): QuitInstancePlan {
  return lockAcquired ? { outcome: 'no-panel' } : { outcome: 'forwarded' }
}

/** 持锁面板侧 second-instance 的两岔动作（分发器只挑路，不实现动作）。 */
export interface SecondInstanceActions {
  /** 认出 --panel-quit：置闩 + 留痕 + 走完整退出链 */
  quitRequest(): void
  /** 无旗标：既有唤回口径（showPanel） */
  showPanel(): void
}

/**
 * 持锁面板侧 second-instance 统一分发：带 --panel-quit → quitRequest；否则 →
 * showPanel（二次拉起唤回面板的既有行为，一次分发点两径互斥，不再有并列注册）。
 */
export function dispatchSecondInstance(argv: string[], actions: SecondInstanceActions): void {
  if (hasPanelQuitFlag(argv)) actions.quitRequest()
  else actions.showPanel()
}

/**
 * 退出请求闩——进程级单向门：置位即面板本届生命周期已决定退出，不复位。
 * 两个消费方：① second-instance 分发点（置闩 + quit-request 留痕 + app.quit()）；
 * ② 对话窗退出闸（conversation/window.ts confirmQuitIfBusy）——闩置位时旁路在途
 * turn 确认框（无人径等价自动选「终止会话并退出」，正文由后端保存可续接）；
 * 托盘/设置浮层的有人径不走本闩、保留确认框，语义分岔见 ADR-0030。
 */
let quitRequested = false

/** 置闩。首次置位返回 true（调用方只此一次记 quit-request 事件）；重复转发幂等返回 false。 */
export function requestPanelQuit(): boolean {
  if (quitRequested) return false
  quitRequested = true
  return true
}

/** 闩是否已置位（退出单向门：只看，不翻）。 */
export function isPanelQuitRequested(): boolean {
  return quitRequested
}

/** 单测隔离用：复位闩。生产代码禁止调用。 */
export function resetPanelQuitGateForTest(): void {
  quitRequested = false
}
