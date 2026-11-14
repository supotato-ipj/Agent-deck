import { Service } from 'cordis'
import type { Context } from 'cordis'
import { collectSessions, defaultSessionRoots, SqlitePool } from '../scanners'
import type { SessionInfo, SessionRoots } from '../scanners'

/**
 * 会话数据服务：五工具扫描（采样拍随内核心跳驱动，工单477 束①降到 3~5 秒）。
 * 单工具失败在 collectSessions 内静默跳过；整轮意外失败沿用 Python deck_state 语义——
 * 本轮给空表（不缓存旧值，避免僵尸会话）。
 * 会话 SQLite 连接池随服务持有（束②）：扫描间复用只读连接不再每轮重开，
 * 服务拆卸即 closeAll 清账。
 * Qoder 状态快照（qoderState）随工单03 状态块退役移除；qoder 会话行走 collectSessions。
 */
export class SessionsService extends Service {
  private readonly roots: SessionRoots
  private readonly pool = new SqlitePool()
  private sessions: SessionInfo[] = []

  constructor(ctx: Context, options: { roots?: SessionRoots } = {}) {
    super(ctx, 'sessions')
    this.roots = options.roots ?? defaultSessionRoots()
    ctx.on('dispose', () => this.pool.closeAll())
  }

  /** 一个采样轮：墙钟秒驱动全量扫描（数毫秒级；扫描拍长由内核心跳编排） */
  refresh(now: number = Date.now() / 1000): void {
    try {
      this.sessions = collectSessions(this.roots, now, { pool: this.pool })
    } catch (err) {
      console.warn(`deck-sessions: 本轮扫描意外失败，给空表：${err instanceof Error ? err.message : err}`)
      this.sessions = []
    }
  }

  current(): SessionInfo[] {
    return this.sessions
  }
}
