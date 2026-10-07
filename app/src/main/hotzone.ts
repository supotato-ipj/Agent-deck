import { BrowserWindow, screen } from 'electron'
import type { HotzoneRect } from '../shared/contract'
import { panelLabels } from './lag-sentinel'

const POLL_MS = 25
/** 离开判定确认拍数：连续两拍不命中才恢复穿透——边界光标抖动不翻转窗口样式 */
const LEAVE_CONFIRM_POLLS = 2

export interface HotzoneHooks {
  /** 离开热区：恢复穿透后触发（生产语义 = 重新钉扎，探针01-C：热区点击会顶起 z 序） */
  onLeave?: () => void
  /** 穿透状态切换（供存证日志） */
  onTransition?: (hot: boolean) => void
}

/**
 * 交互热区跟踪：主进程持有渲染层声明的热区矩形，GetCursorPos 轮询（25ms 量级）命中切换
 * setIgnoreMouseEvents——机制经工单01 探针B 12/12 实证。
 * 恢复穿透一律不带 forward：低级鼠标钩子会让主线程阻塞波及全系统鼠标输入。
 */
export class HotzoneTracker {
  private rects: HotzoneRect[] = []
  private hot = false
  private missCount = 0
  private readonly timer: NodeJS.Timeout
  private disposed = false

  constructor(private readonly win: BrowserWindow, private readonly hooks: HotzoneHooks = {}) {
    this.timer = setInterval(() => this.poll(), POLL_MS)
  }

  setRects(rects: HotzoneRect[]): void {
    this.rects = rects
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    clearInterval(this.timer)
  }

  private poll(): void {
    if (this.disposed) return
    if (this.win.isDestroyed()) {
      this.dispose()
      return
    }
    // 滞后哨兵（工单117）：穿透翻转是触碰窗口全局态的动作（H2；final4 轮事件尾终点）。
    // 25ms 的常态读（光标/几何）不挂标签——span 落盘量与主线程开销都按「动作」而非「节拍」计。
    const cursor = screen.getCursorScreenPoint()
    const bounds = this.win.getBounds()
    const px = cursor.x - bounds.x
    const py = cursor.y - bounds.y
    const hit = this.rects.some(r =>
      px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h)
    if (hit) {
      this.missCount = 0
      if (!this.hot) {
        this.hot = true
        panelLabels.run('hotzone-toggle', () => this.win.setIgnoreMouseEvents(false))
        this.hooks.onTransition?.(true)
      }
      return
    }
    this.missCount += 1
    if (this.hot && this.missCount >= LEAVE_CONFIRM_POLLS) {
      this.hot = false
      panelLabels.run('hotzone-toggle', () => this.win.setIgnoreMouseEvents(true))
      this.hooks.onLeave?.()
      this.hooks.onTransition?.(false)
    }
  }
}
