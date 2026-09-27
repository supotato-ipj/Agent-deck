/** hermes 扫描器：state.db（sessions 表）+ runtime/active_sessions.json 租约。 */
import fs from 'node:fs'
import path from 'node:path'
import { openReadOnly } from './sqlite'
import { ACTIVE_WINDOW, RUNNING_WINDOW, dirName, makeSession } from './types'
import type { SessionInfo } from './types'

/** 活跃租约里的会话 id 集合；租约文件坏了只当没有，不连累整工具 */
function hermesLeases(root: string): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'active_sessions.json'), 'utf8')) as {
      entries?: Array<{ session_id?: unknown }>
    }
    const ids = new Set<string>()
    for (const e of data.entries ?? []) {
      if (typeof e.session_id === 'string' && e.session_id) ids.add(e.session_id)
    }
    return ids
  } catch {
    return new Set()
  }
}

interface HermesRow {
  id: unknown
  cwd: unknown
  last_activity_at: unknown
  started_at: unknown
  end_reason: unknown
  archived: unknown
}

export function scanHermes(root: string, now: number): SessionInfo[] {
  const leases = hermesLeases(root)
  const db = openReadOnly(path.join(root, 'state.db'))
  let rows: HermesRow[]
  try {
    rows = db.prepare(
      'SELECT id, cwd, last_activity_at, started_at, end_reason, archived FROM sessions',
    ).all() as unknown as HermesRow[]
  } finally {
    db.close()
  }
  const sessions: SessionInfo[] = []
  for (const row of rows) {
    if (row.archived) continue
    const act = row.last_activity_at ?? row.started_at
    if (act === null || act === undefined) continue
    if (typeof act !== 'number') throw new Error(`hermes 会话 ${String(row.id)} 活跃时间非数值`)
    const age = now - act
    if (age > ACTIVE_WINDOW) continue
    const running = leases.has(String(row.id))
      || (row.end_reason === null && age <= RUNNING_WINDOW)
    const state = running ? 'RUN' : (row.end_reason === null ? 'IDLE' : 'DONE')
    sessions.push(makeSession('hermes', String(row.id), dirName(row.cwd), age, state, { running }))
  }
  return sessions
}
