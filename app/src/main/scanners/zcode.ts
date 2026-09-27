/** zcode 扫描器：cli/db/db.sqlite（session + todo 表）。子代理会话噪音过大（票 07）不入列。 */
import path from 'node:path'
import { openReadOnly } from './sqlite'
import { ACTIVE_WINDOW, RUNNING_WINDOW, dirName, makeSession } from './types'
import type { SessionInfo } from './types'

export const ZCODE_SUBAGENT_PREFIX = 'sess_subagent_'

interface ZcodeSessionRow {
  id: unknown
  directory: unknown
  time_updated: unknown
  time_archived: unknown
}

interface TodoRow {
  session_id: unknown
  done: unknown
  total: unknown
}

export function scanZcode(root: string, now: number): SessionInfo[] {
  const db = openReadOnly(path.join(root, 'cli', 'db', 'db.sqlite'))
  let rows: ZcodeSessionRow[]
  let todoRows: TodoRow[]
  try {
    rows = db.prepare('SELECT id, directory, time_updated, time_archived FROM session').all() as unknown as ZcodeSessionRow[]
    // 列别名只为 node:sqlite 的结果对象命名，聚合语义与 Python 完全一致
    todoRows = db.prepare(
      "SELECT session_id AS session_id, SUM(status = 'completed') AS done, COUNT(*) AS total FROM todo GROUP BY session_id",
    ).all() as unknown as TodoRow[]
  } finally {
    db.close()
  }
  const counts = new Map<string, [number | null, number]>()
  for (const t of todoRows) {
    // SUM 对全 NULL 组返回 NULL——Python 侧同样落 None，保持空值语义
    counts.set(String(t.session_id), [
      t.done === null || t.done === undefined ? null : Number(t.done),
      Number(t.total ?? 0),
    ])
  }
  const sessions: SessionInfo[] = []
  for (const row of rows) {
    const sid = String(row.id)
    if (row.time_archived || row.time_updated === null || row.time_updated === undefined
      || sid.startsWith(ZCODE_SUBAGENT_PREFIX)) continue
    if (typeof row.time_updated !== 'number') throw new Error(`zcode 会话 ${sid} 更新时间非数值`)
    const age = now - row.time_updated / 1000
    if (age > ACTIVE_WINDOW) continue
    const running = age <= RUNNING_WINDOW
    sessions.push(makeSession('zcode', sid, dirName(row.directory), age, running ? 'RUN' : 'DONE', {
      tasks: counts.get(sid) ?? [0, 0],
    }))
  }
  return sessions
}
