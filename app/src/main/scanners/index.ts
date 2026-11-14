/**
 * 会话列表的唯一接缝 collectSessions(roots, now)（Python agent_sessions.collect_sessions 平移）。
 * 每工具一个严格只读的扫描器；任一工具扫描失败静默跳过、只记日志（ADR-0003）。
 */
import os from 'node:os'
import path from 'node:path'
import { scanQoder } from './qoder'
import { scanHermes } from './hermes'
import { scanZcode } from './zcode'
import { scanKimiCode } from './kimicode'
import { scanKimiWork } from './kimiwork'
import type { SqlitePool } from './sqlite'
import type { Scanner, SessionInfo, SessionRoots } from './types'

export { scanQoder, taskStats, projectName, sessionLast, sessionState } from './qoder'
export { scanHermes } from './hermes'
export { scanZcode, ZCODE_SUBAGENT_PREFIX } from './zcode'
export { scanKimiCode } from './kimicode'
export { scanKimiWork } from './kimiwork'
export { SqlitePool, SQLITE_POOL_MAX_AGE_MS, openReadOnly } from './sqlite'
export { ACTIVE_WINDOW, RUNNING_WINDOW, dirName } from './types'
export type { Scanner, SessionInfo, SessionRoots } from './types'

export const SCANNERS: Record<string, Scanner> = {
  qoder: scanQoder,
  hermes: scanHermes,
  zcode: scanZcode,
  kimicode: scanKimiCode,
  kimiwork: scanKimiWork,
}

/**
 * 默认数据根（Python server.SESSION_ROOTS 平移；主检出/测试可注入替身）。
 * `minimaxcode`（工单382）只供会话预览投影读取——它不进 SCANNERS/collectSessions，
 * 因为 MiniMax 没有诚实的执行/等待信号，不参与旧会话列表的 RUN/DONE 判定。
 */
export function defaultSessionRoots(home: string = os.homedir()): SessionRoots {
  return {
    qoder: path.join(home, '.qoder-cn'),
    hermes: path.join(home, 'AppData', 'Local', 'hermes'),
    zcode: path.join(home, '.zcode'),
    kimicode: path.join(home, '.kimi-code'),
    kimiwork: path.join(home, 'AppData', 'Roaming', 'kimi-desktop', 'kimi-agent'),
    minimaxcode: path.join(home, '.minimax'),
  }
}

export interface CollectSessionsDeps {
  /** 会话 SQLite 连接池（工单477 束②）：常驻扫描传入复用连接；缺省每轮开合（离线一次性用） */
  pool?: SqlitePool
}

export function collectSessions(roots: SessionRoots, now: number, deps: CollectSessionsDeps = {}): SessionInfo[] {
  const sessions: SessionInfo[] = []
  for (const [tool, root] of Object.entries(roots)) {
    const scanner = SCANNERS[tool]
    if (scanner === undefined) continue
    try {
      sessions.push(...scanner(root, now, deps.pool))
    } catch (err) {
      console.warn(`agent-sessions: ${tool} 扫描失败，跳过：${err instanceof Error ? err.message : err}`)
    }
  }
  sessions.sort((a, b) => a.age - b.age)
  return sessions
}
