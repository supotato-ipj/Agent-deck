import { Service } from 'cordis'
import type { Context } from 'cordis'
import { collectSessions, defaultSessionRoots } from '../scanners'
import type { SessionInfo, SessionRoots } from '../scanners'

/**
 * 会话数据服务：五工具扫描（1Hz 随桥接 tick 刷新）。
 * 单工具失败在 collectSessions 内静默跳过；整轮意外失败沿用 Python deck_state 语义——
 * 本轮给空表（不缓存旧值，避免僵尸会话）。
 * Qoder 状态快照（qoderState）随工单03 状态块退役移除；qoder 会话行走 collectSessions。
 */
export class SessionsService extends Service {
  private readonly roots: SessionRoots
  private sessions: SessionInfo[] = []

  constructor(ctx: Context, options: { roots?: SessionRoots } = {}) {
    super(ctx, 'sessions')
    this.roots = options.roots ?? defaultSessionRoots()
  }

  /** 一个采样轮：墙钟秒驱动全量扫描（阻塞主进程数毫秒，与 Python 1Hz 轮询同量级） */
  refresh(now: number = Date.now() / 1000): void {
    try {
      this.sessions = collectSessions(this.roots, now)
    } catch (err) {
      console.warn(`deck-sessions: 本轮扫描意外失败，给空表：${err instanceof Error ? err.message : err}`)
      this.sessions = []
    }
  }

  current(): SessionInfo[] {
    return this.sessions
  }
}
