// 托盘右键回放的条带让位闸门状态机（工单194，ADR-0013「托盘自带菜单让位」方向）：
// 条带是 WS_EX_TOPMOST 带且有 500ms keepalive、热区离开重申、全屏让位恢复拍三处
// 置顶重申点，应用右键弹的菜单（#32768 或自绘面板）诞生在普通带、重叠区压不过——
// 回放右键期间条带临时降非置顶，菜单关闭即恢复。
// 本模块只做裁决：让位窗口期内的「菜单已关闭」三路侦测（目标 pid 的 #32768 菜单窗
// 消失 / 前台窗变化 / 超时上限）与恢复时机。FFI 枚举与置顶切换是效果层
// （taskbar/window.ts 控制器 + taskbar/native.ts 绑定），真机人工验收覆盖不进单测；
// 本状态机纯逻辑零 Win32，喂快照出决策（yield.spec.ts 的 shouldYieldToFullscreen 同形）。
//
// 三路侦测的盲区口径（票面在案）：自绘托盘面板不产生 #32768 菜单窗、也可能不取前台
// ——两路探测双双落空时超时上限兜底恢复，保证不让位卡死。

/** 超时上限（明确值，票面验收口径「有明确值并断言」）：菜单打开的合理阅读时长之上、
 * 盲区误伤（条带久居非置顶带）之下。 */
export const TRAY_YIELD_TIMEOUT_MS = 10_000

/** 三路侦测轮询间隔：恢复要跟手（菜单一关条带立即回顶），150ms 五拍内必达。 */
export const TRAY_YIELD_POLL_MS = 150

/** 一拍侦测快照（FFI 采集，喂给状态机） */
export interface TrayYieldProbe {
  /** 目标 pid 当拍的 #32768 可见菜单窗数（pid 未知时恒 0） */
  menuCount: number
  /** 当拍前台窗属主 pid（无前台窗 = 0） */
  fgPid: number
  now: number
}

export type TrayYieldRestoreReason = 'menu-closed' | 'foreground-changed' | 'timeout'

export type TrayYieldDecision =
  | { action: 'hold'; menuSeen: boolean }
  | { action: 'restore'; reason: TrayYieldRestoreReason; elapsedMs: number }

/** begin 返回：'yield' = 首拍让位（条带降非置顶）；'extend' = 让位中再次右键，
 * 已在非置顶带，只换监视目标续时限。 */
export type TrayYieldBeginMode = 'yield' | 'extend'

/**
 * 单目标让位窗口：一次回放右键一个监视 pid。让位中再右键（换图标）= 重开一窗——
 * 前一菜单会被第二次点击收走（原生菜单焦点语义），以新目标为准换监视账，避免
 * 旧目标的菜单账（永远等不到的 menu-closed）把新菜单的恢复拖到超时。
 */
export class TrayYieldMachine {
  private watchedPid = 0
  private fgBaseline = 0
  private fgSawWatched = false
  private sawMenu = false
  private beganAt = 0
  private deadline = 0
  private isActive = false
  private ownPid = 0

  get active(): boolean {
    return this.isActive
  }

  /** 当前监视的目标 pid（未知 = 0） */
  get pid(): number {
    return this.watchedPid
  }

  /** 是否已见过目标 pid 的菜单窗（存证用） */
  get menuSeen(): boolean {
    return this.sawMenu
  }

  /**
   * 回放右键起拍。pid = 托盘图标属主进程（hwnd 解析缺位 = 0，盲区口径：菜单/前台
   * 两路都停用——pid 未知分不清前台是否落到菜单应用，只靠超时兜底）；fgPid =
   * 起拍时的前台属主（前台变化判据的基线）。
   */
  begin(pid: number, fgPid: number, ownPid: number, now: number): TrayYieldBeginMode {
    const mode: TrayYieldBeginMode = this.isActive ? 'extend' : 'yield'
    this.watchedPid = pid
    this.ownPid = ownPid
    this.fgBaseline = fgPid
    // 基线本身已落在目标 pid 上（上一轮菜单进程仍持前台）：视同已见目标
    this.fgSawWatched = pid !== 0 && fgPid === pid && fgPid !== ownPid
    this.sawMenu = false
    this.beganAt = now
    this.deadline = now + TRAY_YIELD_TIMEOUT_MS
    this.isActive = true
    return mode
  }

  /**
   * 一拍侦测。优先级：超时（防死锁硬顶）→ 菜单窗消失（最精确归因）→ 前台变化
   * （启发式兜底）。无窗前台（0）与自家进程前台不算变化——条带不可聚焦、面板永不
   * 激活，自家前台不构成「用户已去别处交互」的证据。
   */
  poll(probe: TrayYieldProbe): TrayYieldDecision {
    if (!this.isActive) return { action: 'hold', menuSeen: false }
    const { menuCount, fgPid, now } = probe
    if (this.watchedPid !== 0) {
      if (menuCount > 0) this.sawMenu = true
      if (fgPid === this.watchedPid) this.fgSawWatched = true
    }
    const elapsed = now - this.beganAt
    if (now >= this.deadline) {
      this.isActive = false
      return { action: 'restore', reason: 'timeout', elapsedMs: elapsed }
    }
    if (this.sawMenu && menuCount === 0) {
      this.isActive = false
      return { action: 'restore', reason: 'menu-closed', elapsedMs: elapsed }
    }
    const fgAlive = fgPid !== 0 && fgPid !== this.ownPid
    if (fgAlive && this.watchedPid !== 0 && fgPid === this.watchedPid) {
      return { action: 'hold', menuSeen: this.sawMenu } // 目标应用持前台（菜单在场常态）
    }
    // 前台变化路径要求目标 pid 已知：pid 未知时分不清「前台落到了菜单应用」与
    // 「前台真被别处夺走」，宁可靠超时恢复也不误判收闸把菜单再压回条带之下。
    if (fgAlive && this.watchedPid !== 0 && (this.fgSawWatched || fgPid !== this.fgBaseline)) {
      this.isActive = false
      return { action: 'restore', reason: 'foreground-changed', elapsedMs: elapsed }
    }
    return { action: 'hold', menuSeen: this.sawMenu }
  }

  /** 条带销毁/任务栏禁用等 teardown 路径：不强判恢复原因，直接回 idle。 */
  reset(): void {
    this.isActive = false
  }
}
