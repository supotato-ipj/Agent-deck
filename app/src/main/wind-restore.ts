/**
 * Win+D 防抖自动恢复（工单03）：面板被「显示桌面」类操作最小化/隐藏后，防抖窗口内不动作，
 * 期满仍处于收起态才恢复——再按一次 Win+D（shell 自己还原面板）或托盘/second-instance 唤回
 * 都会在窗口期内解除收起态、取消恢复。轮询重复命中不重置防抖计时（iconic 期间每轮都命中，
 * 重置将永不恢复）。
 */

export const WIN_D_POLL_MS = 250
export const WIN_D_DEBOUNCE_MS = 1500

export interface WinDRestorerHooks {
  /** 收起态首次命中（防抖窗口起点，存证点） */
  onMinimized?: (why: string) => void
  /** 防抖期满且仍处于收起态：执行恢复 */
  onRestore?: (why: string, afterMs: number) => void
}

/** 返回收起原因，未收起返回 null（spec 只要求最小化恢复：Win+D 最小化、SW_MINIMIZE 等） */
export type IsDownFn = () => 'minimized' | 'hidden' | null

export class WinDRestorer {
  private pending: NodeJS.Timeout | null = null
  private episodeStart = 0
  private why = ''
  private disposed = false
  private readonly pollTimer: NodeJS.Timeout

  constructor(
    private readonly isDown: IsDownFn,
    private readonly hooks: WinDRestorerHooks = {},
    private readonly debounceMs = WIN_D_DEBOUNCE_MS,
    pollMs = WIN_D_POLL_MS,
  ) {
    this.pollTimer = setInterval(() => this.pump(), pollMs)
  }

  dispose(): void {
    this.disposed = true
    clearInterval(this.pollTimer)
    this.cancel()
  }

  private cancel(): void {
    if (this.pending) {
      clearTimeout(this.pending)
      this.pending = null
    }
  }

  private pump(): void {
    if (this.disposed) return
    const why = this.isDown()
    if (why !== null) this.markDown(why)
    else this.cancel()
  }

  private markDown(why: string): void {
    if (this.pending) return
    this.why = why
    this.episodeStart = Date.now()
    this.hooks.onMinimized?.(why)
    this.pending = setTimeout(() => {
      this.pending = null
      if (this.disposed) return
      if (this.isDown() !== null) {
        this.hooks.onRestore?.(this.why, Date.now() - this.episodeStart)
      }
    }, this.debounceMs)
  }
}
