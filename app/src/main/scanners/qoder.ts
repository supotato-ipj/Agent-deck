/**
 * Qoder 扫描器（.qoder-cn 数据根）+ 会话列表共用的 jsonl 尾部解析。
 * 只服务会话列表的 qoder 会话行（QD 标签、运行状态、行内任务进度——五工具通用能力）；
 * 曾共用的 Qoder 状态卡已随工单03 退役（qoderStatus 与 QoderStatus 一并移除）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ACTIVE_WINDOW, RUNNING_WINDOW, makeSession } from './types'
import type { SessionInfo } from './types'

/** 读文件末尾至多 maxBytes 字节，按行返回（去尾部残行由调用方的逐行解析天然兜底） */
function readTail(file: string, maxBytes: number): string {
  const fh = fs.openSync(file, 'r')
  try {
    const size = fs.fstatSync(fh).size
    const start = Math.max(0, size - maxBytes)
    const buf = Buffer.alloc(size - start)
    fs.readSync(fh, buf, 0, buf.length, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fh)
  }
}

/** 会话最近一条 assistant/user 记录的 (role, kind)；读失败返回 (null, null) */
export function sessionLast(jsonlPath: string): { role: string | null; kind: string | null } {
  let tail: string
  try {
    tail = readTail(jsonlPath, 131072)
  } catch {
    return { role: null, kind: null }
  }
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"type"')) continue
    let rec: Record<string, unknown>
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const role = rec['type']
    if (role !== 'assistant' && role !== 'user') continue
    if (role === 'user') return { role, kind: 'user' }
    const content = (rec['message'] as Record<string, unknown> | null | undefined)?.['content']
    if (Array.isArray(content) && content.length > 0) {
      const last = typeof content[content.length - 1] === 'object' && content[content.length - 1] !== null
        ? (content[content.length - 1] as Record<string, unknown>)
        : {}
      return { role, kind: last['type'] === 'tool_use' ? 'tool' : 'text' }
    }
    return { role, kind: 'text' }
  }
  return { role: null, kind: null }
}

export function sessionState(age: number, role: string | null, kind: string | null): string {
  if (age <= RUNNING_WINDOW) return 'RUN'
  if (kind === 'tool') return 'CONFIRM'
  if (role === 'assistant') return 'DONE'
  return 'IDLE'
}

/** 项目名：优先 jsonl 里最近的 cwd 字段，缺省回退会话文件所在目录名 */
export function projectName(jsonlPath: string): string {
  try {
    const tail = readTail(jsonlPath, 65536)
    const lines = tail.split('\n')
    let cwd: unknown
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line.includes('"cwd"')) continue
      try {
        cwd = (JSON.parse(line) as Record<string, unknown>)['cwd']
      } catch {
        continue
      }
      if (cwd) break
    }
    if (typeof cwd === 'string' && cwd) return path.win32.basename(cwd)
  } catch {
    /* 读失败走目录名兜底 */
  }
  return path.win32.basename(path.win32.dirname(jsonlPath))
}

/** 任务进度：tasks/<session_id>/*.json 里 completed 计数、总数与首个 in_progress 主题 */
export function taskStats(sessionId: string, root: string): { done: number; total: number; current: string | null } {
  let done = 0
  let total = 0
  let current: string | null = null
  const tasksDir = path.join(root, 'tasks', sessionId)
  let files: fs.Dirent[]
  try {
    if (!fs.statSync(tasksDir).isDirectory()) return { done, total, current }
    files = fs.readdirSync(tasksDir, { withFileTypes: true })
  } catch {
    return { done, total, current }
  }
  for (const f of files) {
    if (!f.isFile() || !f.name.toLowerCase().endsWith('.json')) continue
    let task: Record<string, unknown>
    try {
      task = JSON.parse(fs.readFileSync(path.join(tasksDir, f.name), 'utf8'))
    } catch {
      continue
    }
    total += 1
    const status = task['status']
    if (status === 'completed') done += 1
    else if (status === 'in_progress' && current === null) current = (task['subject'] as string | undefined) ?? null
  }
  return { done, total, current }
}

export interface QoderRow {
  id: string
  file: string
  mtime: number
  age: number
}

/** 活跃池内的 qoder jsonl 行（scanQoder 的行源） */
export function qoderJsonlRows(root: string, now: number): QoderRow[] {
  const rows: QoderRow[] = []
  const projectsDir = path.join(root, 'projects')
  let projects: fs.Dirent[]
  try {
    if (!fs.statSync(projectsDir).isDirectory()) return rows
    projects = fs.readdirSync(projectsDir, { withFileTypes: true })
  } catch {
    return rows
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue
    let jsonls: fs.Dirent[]
    try {
      jsonls = fs.readdirSync(path.join(projectsDir, proj.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const jf of jsonls) {
      if (!jf.isFile() || !jf.name.toLowerCase().endsWith('.jsonl')) continue
      const file = path.join(projectsDir, proj.name, jf.name)
      let mtime: number
      try {
        mtime = fs.statSync(file).mtimeMs / 1000
      } catch {
        continue
      }
      const age = now - mtime
      if (age > ACTIVE_WINDOW) continue
      rows.push({ id: jf.name.replace(/\.jsonl$/i, ''), file, mtime, age })
    }
  }
  return rows
}

export function scanQoder(root: string, now: number): SessionInfo[] {
  const sessions: SessionInfo[] = []
  for (const row of qoderJsonlRows(root, now)) {
    const { done, total } = taskStats(row.id, root)
    const { role, kind } = sessionLast(row.file)
    sessions.push(makeSession('qoder', row.id, projectName(row.file), row.age, sessionState(row.age, role, kind), {
      tasks: [done, total],
    }))
  }
  return sessions
}
