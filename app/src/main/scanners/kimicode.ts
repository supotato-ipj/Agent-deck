/** kimi code 扫描器：sessions/<工作区>/<会话>/ 目录形态（state.json + agents/main/wire.jsonl 的 mtime）。 */
import fs from 'node:fs'
import path from 'node:path'
import { ACTIVE_WINDOW, RUNNING_WINDOW, dirName, makeSession } from './types'
import type { SessionInfo } from './types'

export function scanKimiCode(root: string, now: number): SessionInfo[] {
  const sessions: SessionInfo[] = []
  const sessionsDir = path.join(root, 'sessions')
  let workspaces: fs.Dirent[]
  try {
    if (!fs.statSync(sessionsDir).isDirectory()) return sessions
    workspaces = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return sessions
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let sessionDirs: fs.Dirent[]
    try {
      sessionDirs = fs.readdirSync(path.join(sessionsDir, ws.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const dir = path.join(sessionsDir, ws.name, sd.name)
      const stateFile = path.join(dir, 'state.json')
      const wireFile = path.join(dir, 'agents', 'main', 'wire.jsonl')
      let state: unknown
      let mtimes: number[]
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        mtimes = [fs.statSync(stateFile).mtimeMs / 1000]
        if (fs.existsSync(wireFile)) mtimes.push(fs.statSync(wireFile).mtimeMs / 1000)
      } catch {
        continue
      }
      // Python 的 state.get 在 try 之外：非对象形态连累整工具跳过，此处保持同语义
      if (typeof state !== 'object' || state === null || Array.isArray(state)) {
        throw new Error(`kimicode state.json 不是对象: ${stateFile}`)
      }
      const age = now - Math.max(...mtimes)
      if (age > ACTIVE_WINDOW) continue
      const running = age <= RUNNING_WINDOW
      sessions.push(makeSession('kimicode', sd.name, dirName((state as Record<string, unknown>)['workDir']), age, running ? 'RUN' : 'DONE'))
    }
  }
  return sessions
}

/**
 * 会话预览行（工单381）：kimicode 的真实标题信号面——`state.json` 的 `title`
 * （工单374 实测 38/38 非空，另有 isCustomTitle）由本行读取；空/缺 → null，UI 降级
 * 「未命名会话」。最近活跃沿用 state.json 与 wire.jsonl 的 mtime 最大值。
 * 只读：readFileSync/statSync，不写源存储。
 */
export interface KimiCodePreviewRow {
  id: string
  title: string | null
  project: string | null
  lastActivityMs: number
}

/** @param nowMs 墙钟毫秒（与 lastActivityMs 同单位） */
export function kimicodePreviewRows(root: string, nowMs: number): KimiCodePreviewRow[] {
  const out: KimiCodePreviewRow[] = []
  const sessionsDir = path.join(root, 'sessions')
  let workspaces: fs.Dirent[]
  try {
    if (!fs.statSync(sessionsDir).isDirectory()) return out
    workspaces = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue
    let sessionDirs: fs.Dirent[]
    try {
      sessionDirs = fs.readdirSync(path.join(sessionsDir, ws.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const sd of sessionDirs) {
      if (!sd.isDirectory()) continue
      const dir = path.join(sessionsDir, ws.name, sd.name)
      const stateFile = path.join(dir, 'state.json')
      const wireFile = path.join(dir, 'agents', 'main', 'wire.jsonl')
      let state: unknown
      let mtimes: number[]
      try {
        state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
        mtimes = [fs.statSync(stateFile).mtimeMs]
        if (fs.existsSync(wireFile)) mtimes.push(fs.statSync(wireFile).mtimeMs)
      } catch {
        continue
      }
      // 非对象 state.json 连累整工具跳过（与 scanKimiCode 同语义）
      if (typeof state !== 'object' || state === null || Array.isArray(state)) {
        throw new Error(`kimicode state.json 不是对象: ${stateFile}`)
      }
      const rec = state as Record<string, unknown>
      const lastActivityMs = Math.round(Math.max(...mtimes))
      if (nowMs / 1000 - lastActivityMs / 1000 > ACTIVE_WINDOW) continue
      const title = typeof rec['title'] === 'string' && rec['title'].trim() ? rec['title'].trim() : null
      out.push({ id: sd.name, title, project: dirName(rec['workDir']) || null, lastActivityMs })
    }
  }
  return out
}

