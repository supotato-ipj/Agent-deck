// 桌面遮罩守望（工单07）：show desktop（任务栏右下角按钮 / Win+D / ToggleDesktop，
// 同一 shell 路径）会把桌面宿主窗 Progman 抬到所有未被最小化窗口之上——面板不在
// 被收之列（skipTaskbar 下 shell 不视其为任务栏窗），却被抬起的 Progman 连带盖住：
// 窗口态一切正常（visible / iconic=false / DWMWA_CLOAKED=0），屏幕上只剩壁纸
// （SendInput 复现 + 逐帧截屏 + z 序枚举实证）。WS_EX_TOOLWINDOW 也挡不住 Progman
// 抬顶（实测 rank 对比），遮挡判定 disable-features 与此无关（合成层全程在提交帧）。
//
// 修法：守望 Progman 与面板的 z 序关系——Progman 压到面板之上时把面板临时提入
// TOPMOST 带（show desktop 态普通窗已全部最小化，不违反「面板在普通窗之下」的
// ADR-0004 语义）；Progman 回底（show desktop 结束）即撤出 TOPMOST 并重钉底部。
// 判定纯函数 coverDecision 可离线测；z 序读取走 win32.ts 的 koffi 绑定。
import type { BrowserWindow } from 'electron'
import { findTopWindowByClass, hasVisibleBelow, hwndOf, isTopmost, pinToBottom, setTopmost, setPinGate, zPrecedes } from './win32'
import type { EventLog } from './panel-ipc'

/** 一次判定的输入快照（全部由调用方侦察所得，纯函数只管裁决） */
export interface CoverSnapshot {
  panelVisible: boolean
  panelMinimized: boolean
  panelTopmost: boolean
  progmanFound: boolean
  /** Progman 在面板之上（可见窗口 z 序）——即面板正被壁纸宿主盖住 */
  progmanAbovePanel: boolean
  /** Progman 之下已无任何可见顶层窗口——show desktop 已结束的判据 */
  progmanBottomMost: boolean
}

export type CoverAction = 'engage' | 'release' | null

/**
 * 裁决：engage = 提入 TOPMOST；release = 撤出并重钉底部；null = 维持现状。
 * - 面板不可见或已最小化：不参与遮罩博弈，TOPMOST 残留即撤（最小化演练时防抖
 *   恢复器接管，回显后若 Progman 仍抬顶会再次 engage）。
 * - 无 Progman（异形 shell）：无从遮罩，TOPMOST 残留即撤。
 * - 未 TOPMOST 且被 Progman 盖住 → engage；TOPMOST 中且 Progman 已回底 → release；
 *   TOPMOST 中且 Progman 仍抬顶（show desktop 进行中）→ 维持。
 */
export function coverDecision(s: CoverSnapshot): CoverAction {
  if (s.panelMinimized || !s.panelVisible) return s.panelTopmost ? 'release' : null
  if (!s.progmanFound) return s.panelTopmost ? 'release' : null
  if (!s.panelTopmost) return s.progmanAbovePanel ? 'engage' : null
  return s.progmanBottomMost ? 'release' : null
}

const POLL_MS = 150

/** 常驻守望：每 150ms 侦察一次（读多写少，engage/release 各自幂等）。 */
export class DesktopCoverWatcher {
  private timer: ReturnType<typeof setInterval> | null = null
  private disposed = false
  private elevated = false

  constructor(
    private readonly win: BrowserWindow,
    private readonly log?: EventLog,
  ) {
    setPinGate(() => this.elevated)
    this.timer = setInterval(() => this.tick(), POLL_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** 面板是否处于 TOPMOST 顶替期（钉扎闸门读此处） */
  isElevated(): boolean {
    return this.elevated
  }

  private tick(): void {
    if (this.disposed || this.win.isDestroyed()) return
    const hwnd = hwndOf(this.win)
    const progman = findTopWindowByClass('Progman')
    const snap: CoverSnapshot = {
      panelVisible: this.win.isVisible(),
      panelMinimized: this.win.isMinimized(),
      panelTopmost: isTopmost(hwnd),
      progmanFound: progman !== null,
      progmanAbovePanel: progman !== null && zPrecedes(progman, hwnd),
      progmanBottomMost: progman !== null && !hasVisibleBelow(progman),
    }
    const action = coverDecision(snap)
    if (action === 'engage') {
      this.elevated = true
      if (setTopmost(hwnd, true)) this.log?.append({ type: 'cover-engaged' })
    } else if (action === 'release') {
      this.elevated = false
      const off = setTopmost(hwnd, false)
      const pinned = pinToBottom(this.win)
      if (off || pinned) this.log?.append({ type: 'cover-released', pinned })
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.elevated = false
    setPinGate(null)
  }
}
