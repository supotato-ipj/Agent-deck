/**
 * kimi work 扫描器：降级扫描——只有状态与更新时间，没有标题/项目（正文锁在上游私有存储）。
 * conversation-statuses.json + conversation-context-usage.json 两文件取交集。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ACTIVE_WINDOW, RUNNING_WINDOW, makeSession } from './types'
import type { SessionInfo } from './types'

/** ISO 时间串转墙钟秒；非法值抛错（对应 Python fromisoformat 的 ValueError → 整工具跳过） */
function epochFromIso(iso: string): number {
  const ts = new Date(iso).getTime() / 1000
  if (Number.isNaN(ts)) throw new Error(`非法 ISO 时间: ${iso}`)
  return ts
}

export function scanKimiWork(root: string, now: number): SessionInfo[] {
  const statuses = JSON.parse(
    fs.readFileSync(path.join(root, 'conversation-statuses.json'), 'utf8'),
  ) as Record<string, string>
  const usage = JSON.parse(
    fs.readFileSync(path.join(root, 'conversation-context-usage.json'), 'utf8'),
  ) as Record<string, { updatedAt?: unknown }>
  const sessions: SessionInfo[] = []
  for (const [key, status] of Object.entries(statuses)) {
    const entry = usage[key]
    const updated = entry?.updatedAt
    if (typeof updated !== 'string' || !updated) continue
    const age = now - epochFromIso(updated)
    if (age > ACTIVE_WINDOW) continue
    const running = age <= RUNNING_WINDOW
    const state = running ? 'RUN' : (status === 'completed' ? 'DONE' : 'IDLE')
    sessions.push(makeSession('kimiwork', key.slice(key.lastIndexOf(':') + 1), '', age, state))
  }
  return sessions
}
