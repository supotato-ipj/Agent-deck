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
import type { Scanner, SessionInfo, SessionRoots } from './types'

export { scanQoder, taskStats, projectName, sessionLast, sessionState } from './qoder'
export { scanHermes } from './hermes'
export { scanZcode, ZCODE_SUBAGENT_PREFIX } from './zcode'
export { scanKimiCode } from './kimicode'
export { scanKimiWork } from './kimiwork'
export { ACTIVE_WINDOW, RUNNING_WINDOW, dirName } from './types'
export type { Scanner, SessionInfo, SessionRoots } from './types'

export const SCANNERS: Record<string, Scanner> = {
  qoder: scanQoder,
  hermes: scanHermes,
  zcode: scanZcode,
  kimicode: scanKimiCode,
  kimiwork: scanKimiWork,
}

/** 五工具默认数据根（Python server.SESSION_ROOTS 平移；主检出/测试可注入替身） */
export function defaultSessionRoots(home: string = os.homedir()): SessionRoots {
  return {
    qoder: path.join(home, '.qoder-cn'),
    hermes: path.join(home, 'AppData', 'Local', 'hermes'),
    zcode: path.join(home, '.zcode'),
    kimicode: path.join(home, '.kimi-code'),
    kimiwork: path.join(home, 'AppData', 'Roaming', 'kimi-desktop', 'kimi-agent'),
  }
}

export function collectSessions(roots: SessionRoots, now: number): SessionInfo[] {
  const sessions: SessionInfo[] = []
  for (const [tool, root] of Object.entries(roots)) {
    const scanner = SCANNERS[tool]
    if (scanner === undefined) continue
    try {
      sessions.push(...scanner(root, now))
    } catch (err) {
      console.warn(`agent-sessions: ${tool} 扫描失败，跳过：${err instanceof Error ? err.message : err}`)
    }
  }
  sessions.sort((a, b) => a.age - b.age)
  return sessions
}
