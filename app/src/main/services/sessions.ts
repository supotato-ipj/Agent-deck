import { Service } from 'cordis'
import type { Context } from 'cordis'
import { collectSessions, defaultSessionRoots, qoderStatus } from '../scanners'
import type { QoderStatus, SessionInfo, SessionRoots } from '../scanners'

/**
 * 会话数据服务：五工具扫描（1Hz 随桥接 tick 刷新）。
 * 单工具失败在 collectSessions 内静默跳过；整轮意外失败沿用 Python deck_state 语义——
 * 本轮给空表（不缓存旧值，避免僵尸会话）。
 */
export class SessionsService extends Service {
  private readonly roots: SessionRoots
  private sessions: SessionInfo[] = []
  private qoder: QoderStatus = { active_sessions: 0, session: null }

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
    try {
      this.qoder = qoderStatus(this.roots.qoder ?? '', now)
    } catch {
      this.qoder = { active_sessions: 0, session: null }
    }
  }

  current(): SessionInfo[] {
    return this.sessions
  }

  qoderState(): QoderStatus {
    return this.qoder
  }
}
