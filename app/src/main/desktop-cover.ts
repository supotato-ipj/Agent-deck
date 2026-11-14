// 桌面遮罩守望（工单07）：show desktop（任务栏右下角按钮 / Win+D / ToggleDesktop，
// 同一 shell 路径）会把桌面宿主窗 Progman 抬到所有未被最小化窗口之上——面板不在
// 被收之列（skipTaskbar 下 shell 不视其为任务栏窗），却被抬起的 Progman 连带盖住：
// 窗口态一切正常（visible / iconic=false / DWMWA_CLOAKED=0），屏幕上只剩壁纸
// （SendInput 复现 + 逐帧截屏 + z 序枚举实证）。WS_EX_TOOLWINDOW 也挡不住 Progman
// 抬顶（实测 rank 对比），遮挡判定 disable-features 与此无关（合成层全程在提交帧）。
//
// 修法：守望 Progman 与面板的 z 序关系——Progman 压到面板之上时把面板临时提入
// TOPMOST 带（show desktop 态普通窗已全部最小化，不违反「面板在普通窗之下」的
// ADR-0004 语义）；Progman 回底（show desktop 结束）即撤出并重钉底部。
// 判定纯函数 coverDecision 可离线测；z 序读取走 win32.ts 的 koffi 绑定——真源
// 延迟加载（沿 desktop/adapter 先例）：判定纯函数的离线测试不触碰 koffi。
//
// 工单475（spec #472 用户故事 19，ADR-0032 事件驱动优先于轮询）：旧形态每 150ms
// 全窗 z 序双走查（每秒数千次 user32 调用落在主进程）退役，侦察改**系统窗口事件
// 订阅**驱动——最小化起止 / z 序重排 / 显隐 / 前台变化 / 状态与位置翻转（win-events
// 泵订阅集）到达即再评估，面板自身的显隐/最小化走 Electron 窗口事件。常驻静默期
// 零走查；兜底为 5s 新鲜度全扫（ADR-0032「必须轮询的按新鲜度降级」档，覆盖钩子
// 失能/事件整批漏投——正确性有界，只亏新鲜度）。捕获时延入证：engage/release
// 存证携带 OS 事件时刻→本方裁决的毫秒差（事件径）与触发来源（事件/面板/兜底）。
import type { BrowserWindow } from 'electron'
import type { EventLog } from './panel-ipc'
import { panelLabels } from './lag-sentinel'
import { acquireWindowEventPump } from './win-events'
import type { WindowEventPump } from './win-events'

type Win32 = typeof import('./win32')

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

/** 新鲜度兜底拍距（ADR-0032 新鲜度降级档 3~5s）：钩子失能/事件漏投时的有界侦察 */
const BACKSTOP_MS = 5000

/** 侦察触发来源（存证可读）：win-event=系统窗口事件冲刷；panel-event=面板自身显隐/最小化；backstop=新鲜度兜底拍 */
export type CoverScanSource = 'win-event' | 'panel-event' | 'backstop'

/** 常驻守望：事件订阅驱动（读多写少，engage/release 各自幂等），静默期零走查。 */
export class DesktopCoverWatcher {
  private disposed = false
  private elevated = false
  /** win32 真源延迟加载：离线单测（coverDecision 矩阵）不触碰 koffi */
  private readonly w32: Win32 | null
  private readonly pump: WindowEventPump | null
  private readonly offPump: (() => void) | null
  private readonly panelWin: BrowserWindow
  private readonly onPanelState = (): void => {
    this.scan('panel-event', null)
  }
  private backstopTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    panelWin: BrowserWindow,
    private readonly log?: EventLog,
  ) {
    this.panelWin = panelWin
    const w = require('./win32') as Win32
    this.w32 = w
    w.setPinGate(() => this.elevated)
    // 系统窗口事件订阅（泵单例失败降级为 null——退回兜底拍，不崩不静默）
    let pump: WindowEventPump | null = null
    try {
      pump = acquireWindowEventPump()
    } catch { /* 泵不可用：兜底拍接管 */ }
    this.pump = pump
    this.offPump = pump
      ? pump.subscribe((flush) => this.scan('win-event', flush.osAgeMs))
      : null
    // 面板自身显隐/最小化（Electron 事件）：遮罩快照的 panelVisible/panelMinimized 分量
    panelWin.on('show', this.onPanelState)
    panelWin.on('hide', this.onPanelState)
    panelWin.on('minimize', this.onPanelState)
    panelWin.on('restore', this.onPanelState)
    // 新鲜度兜底拍（unref：守望是正确性保险不是活命理由，退出不该被它拖延）
    this.backstopTimer = setInterval(() => this.scan('backstop', null), BACKSTOP_MS)
    if (typeof this.backstopTimer.unref === 'function') this.backstopTimer.unref()
  }

  /** 面板是否处于 TOPMOST 顶替期（钉扎闸门读此处） */
  isElevated(): boolean {
    return this.elevated
  }

  /** 一拍侦察+裁决+动作：事件径携带捕获时延（泵冲刷时的 OS 事件→裁决毫秒差），兜底/面板径无基点 */
  private scan(source: CoverScanSource, osAgeMs: number | null): void {
    if (this.disposed || this.panelWin.isDestroyed()) return
    const w = this.w32
    if (!w) return
    // 滞后哨兵（工单117）：侦察是同步 z 序走查（事件径已按防抖合并，风暴≤4拍/s），
    // engage/release 是唯一写侧——三段各自挂标签。
    const hwnd = w.hwndOf(this.panelWin)
    const snap = panelLabels.run('cover-scan', () => {
      const progman = w.findTopWindowByClass('Progman')
      return {
        panelVisible: this.panelWin.isVisible(),
        panelMinimized: this.panelWin.isMinimized(),
        panelTopmost: w.isTopmost(hwnd),
        progmanFound: progman !== null,
        progmanAbovePanel: progman !== null && w.zPrecedes(progman, hwnd),
        progmanBottomMost: progman !== null && !w.hasVisibleBelow(progman),
      }
    })
    const action = coverDecision(snap)
    if (action === 'engage') {
      this.elevated = true
      if (panelLabels.run('cover-engage', () => w.setTopmost(hwnd, true))) {
        this.log?.append({ type: 'cover-engaged', trigger: source, osEventAgeMs: osAgeMs })
      }
    } else if (action === 'release') {
      this.elevated = false
      const off = panelLabels.run('cover-release', () => w.setTopmost(hwnd, false))
      const pinned = w.pinToBottom(this.panelWin)
      if (off || pinned) {
        this.log?.append({ type: 'cover-released', pinned, trigger: source, osEventAgeMs: osAgeMs })
      }
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offPump?.()
    this.panelWin.removeListener('show', this.onPanelState)
    this.panelWin.removeListener('hide', this.onPanelState)
    this.panelWin.removeListener('minimize', this.onPanelState)
    this.panelWin.removeListener('restore', this.onPanelState)
    if (this.backstopTimer) clearInterval(this.backstopTimer)
    this.backstopTimer = null
    this.elevated = false
    this.w32?.setPinGate(null)
  }
}
