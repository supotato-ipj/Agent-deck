/** zcode 扫描器：cli/db/db.sqlite（session + todo 表）。子代理会话噪音过大（票 07）不入列。 */
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { openReadOnly, SqlitePool } from './sqlite'
import { ACTIVE_WINDOW, RUNNING_WINDOW, dirName, makeSession } from './types'
import type { SessionInfo } from './types'

/** 池化读取缺省缝（工单477 束②）：传池复用连接，不传保持逐轮开合（离线一次性用同形） */
function readDb<T>(dbPath: string, pool: SqlitePool | undefined, fn: (db: DatabaseSync) => T): T {
  if (pool) return pool.withReadOnly(dbPath, fn)
  const db = openReadOnly(dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

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

export function scanZcode(root: string, now: number, pool?: SqlitePool): SessionInfo[] {
  const { rows, todoRows } = readDb(path.join(root, 'cli', 'db', 'db.sqlite'), pool, (db) => {
    const sessionRows = db.prepare('SELECT id, directory, time_updated, time_archived FROM session').all() as unknown as ZcodeSessionRow[]
    // 列别名只为 node:sqlite 的结果对象命名，聚合语义与 Python 完全一致
    const todoRows = db.prepare(
      "SELECT session_id AS session_id, SUM(status = 'completed') AS done, COUNT(*) AS total FROM todo GROUP BY session_id",
    ).all() as unknown as TodoRow[]
    return { rows: sessionRows, todoRows }
  })
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

/**
 * 会话预览行（工单381）：zcode 的真实标题信号面——`session.title`（工单374 实测
 * 311/311 非空，title_source 为 custom/first_input/generated）由本行读取；标题空/缺 →
 * null，UI 降级「未命名会话」，绝不拿项目目录名顶替。档案化与子代理会话沿用 scanZcode
 * 的排除口径。只读：openReadOnly（readOnly:true），不写源存储。
 */
export interface ZcodePreviewRow {
  id: string
  title: string | null
  project: string | null
  lastActivityMs: number
}

interface ZcodePreviewSqlRow {
  id: unknown
  directory: unknown
  title: unknown
  time_updated: unknown
  time_archived: unknown
}

/** @param nowMs 墙钟毫秒（与 lastActivityMs 同单位）；@param pool 会话预览服务的池化缝（缺省逐轮开合） */
export function zcodePreviewRows(root: string, nowMs: number, pool?: SqlitePool): ZcodePreviewRow[] {
  const rows = readDb(path.join(root, 'cli', 'db', 'db.sqlite'), pool, (db) =>
    db.prepare('SELECT id, directory, title, time_updated, time_archived FROM session').all() as unknown as ZcodePreviewSqlRow[])
  const out: ZcodePreviewRow[] = []
  for (const row of rows) {
    const sid = String(row.id)
    if (row.time_archived || row.time_updated === null || row.time_updated === undefined
      || sid.startsWith(ZCODE_SUBAGENT_PREFIX)) continue
    if (typeof row.time_updated !== 'number') throw new Error(`zcode 会话 ${sid} 更新时间非数值`)
    const lastActivityMs = Math.round(row.time_updated)
    if (nowMs / 1000 - lastActivityMs / 1000 > ACTIVE_WINDOW) continue
    const title = typeof row.title === 'string' && row.title.trim() ? row.title.trim() : null
    out.push({ id: sid, title, project: dirName(row.directory) || null, lastActivityMs })
  }
  return out
}
