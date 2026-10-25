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
