/**
 * MiniMax Code 只读来源探针（工单374 spike，spec #369 决策 21/22/23）。生产接线是工单382 的
 * 会话预览行 `minimaxcodePreviewRows`（接入 Agent 会话预览第五工具）；它仍**不注册进
 * SCANNERS**——旧会话列表的 RUN/DONE 判定需要执行信号，而 MiniMax 没有诚实的执行信号。
 *
 * 本机实测事实（2026-11-03，`~/.minimax`，MiniMax Code CLI——bin 下 minimax.cmd / mcode-tools）：
 * - 会话主账本：`v2/sqlite/runtime-state.sqlite`（活跃 WAL）的 `local_runtime_sessions` 表：
 *   session_id（`mvs_<hex32>`，36 字符）、title、workspace_dir、updated_at_ms（epoch 毫秒）、
 *   status（实测值域 idle/started/aborted/error）、archived。
 * - dated 历史目录：`v2/sessions/YYYY/MM/DD/HH-MM-SS-mmm-session_<base64(session_id)>/`，
 *   内有 manifest.json（schemaVersion/source/layout/paths，其中 ledger/display/snapshot/reports
 *   常为 declared-only 不存在）与 messages.jsonl，每行 `{message_id, turn_id, message}`，
 *   message.role ∈ user/assistant/toolResult/custom，assistant 带可选 stopReason（实测值域
 *   toolUse/stop）；llm-call.json 含 systemPrompt，非必要不读。
 * - status 与活跃时间不相关（实测 started 会话可 162 分钟未动，idle 会话反而 82 分钟新），
 *   不构成执行信号；存储层无任何对等 pendingPermission 的等待记录（permission.json 是
 *   allow/deny/ask 规则集，local_runtime_plugin_miniapp_permission 是插件开关）。
 * - 旧代 `~/.minimax/sessions/mvs_*` 只剩 workspace/ 空壳，`~/.minimax-agent-cn` 只有空
 *   projects/——均无会话事实可读。
 *
 * 严格只读：SQLite 走 openReadOnly（与 zcode/hermes 同一接缝），其余只 readFileSync/statSync；
 * 任何失败返回空集/空值静默跳过（ADR-0003）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { openReadOnly } from './sqlite'
import { readTail } from './qoder'
import { ACTIVE_WINDOW } from './types'

/** MiniMax Code 单条会话的只读探针行（工单374 输入契约；标题/项目缺真值给 null，不拿目录名顶替） */
export interface MinimaxSessionProbe {
  /** 会话稳定身份：DB session_id，形如 mvs_<hex32> */
  id: string
  /** 工具自记标题；空串/NULL/读失败 → null（上层显示「未命名会话」） */
  title: string | null
  /** 项目名 = workspace_dir 末段；workspace_dir 空/缺 → null */
  project: string | null
  /** 最近活跃（DB updated_at_ms，epoch 毫秒）；非数值/缺 → null */
  lastActivityMs: number | null
  /** DB status 原样透传（idle/started/aborted/error/…；值域随上游浮动）——不是执行信号 */
  status: string | null
}

interface MinimaxRow {
  session_id: unknown
  title: unknown
  workspace_dir: unknown
  updated_at_ms: unknown
  status: unknown
  archived: unknown
}

/** 会话主账本路径（root = ~/.minimax 形态的数据根） */
export function minimaxSessionsDb(root: string): string {
  return path.join(root, 'v2', 'sqlite', 'runtime-state.sqlite')
}

/** dated 历史目录名：`session_` + base64url(session_id)（实测双向可逆，本函数只做正向） */
export function minimaxHistoryDirName(sessionId: string): string {
  return `session_${Buffer.from(sessionId, 'utf8').toString('base64')}`
}

/**
 * 只读探针 MiniMax Code 会话主账本。任何一步失败（缺库/坏库/被写方独占）整工具空集，
 * 与既有扫描器的静默跳过同语义。按 lastActivityMs 降序、null 殿后（确定性排序）。
 */
export function probeMinimaxSessions(root: string): MinimaxSessionProbe[] {
  let rows: MinimaxRow[]
  const dbPath = minimaxSessionsDb(root)
  try {
    if (!fs.statSync(dbPath).isFile()) return []
    const db = openReadOnly(dbPath)
    try {
      rows = db.prepare(
        'SELECT session_id, title, workspace_dir, updated_at_ms, status, archived FROM local_runtime_sessions',
      ).all() as unknown as MinimaxRow[]
    } finally {
      db.close()
    }
  } catch {
    return []
  }
  const out: MinimaxSessionProbe[] = []
  for (const row of rows) {
    if (row.archived) continue
    const id = typeof row.session_id === 'string' ? row.session_id : ''
    if (!id) continue
    const title = typeof row.title === 'string' && row.title.trim() ? row.title : null
    const ws = typeof row.workspace_dir === 'string' && row.workspace_dir ? row.workspace_dir : null
    out.push({
      id,
      title,
      project: ws ? path.win32.basename(ws) : null,
      lastActivityMs: typeof row.updated_at_ms === 'number' ? row.updated_at_ms : null,
      status: typeof row.status === 'string' ? row.status : null,
    })
  }
  out.sort((a, b) => (b.lastActivityMs ?? -1) - (a.lastActivityMs ?? -1))
  return out
}

/**
 * 会话预览行（工单382，spec #369 决策 21）：MiniMax Code 接入同一只读投影的唯一读取面。
 * 只携带**已证实**的三类信号——稳定身份（DB session_id）、工具自记标题（空/缺 → null，
 * 上层显示「未命名会话」）、项目名（workspace_dir 末段）与最近活跃（updated_at_ms）。
 * **刻意不含 DB status**：工单374 实测 status 与活跃时间不相关，读进来就可能被上层误当执行
 * 信号；等待在存储层没有任何对等记录 → 本工具的执行与等待一律无从判定（投影只落「最近活跃」）。
 * 活跃池口径与 zcode/kimicode 一致（10 分钟）；缺最近活跃时间的行无法进入活动流，跳过。
 * 只读：openReadOnly + 纯 SELECT；来源不可读 → 空集（ADR-0003 静默跳过语义）。
 */
export interface MinimaxPreviewRow {
  id: string
  title: string | null
  project: string | null
  lastActivityMs: number
}

/** @param nowMs 墙钟毫秒（与 lastActivityMs 同单位） */
export function minimaxcodePreviewRows(root: string, nowMs: number): MinimaxPreviewRow[] {
  const out: MinimaxPreviewRow[] = []
  for (const probe of probeMinimaxSessions(root)) {
    if (probe.lastActivityMs === null) continue
    if (nowMs / 1000 - probe.lastActivityMs / 1000 > ACTIVE_WINDOW) continue
    out.push({
      id: probe.id,
      title: probe.title,
      project: probe.project,
      lastActivityMs: probe.lastActivityMs,
    })
  }
  return out
}

/**
 * 尾部启发式探针（只配「疑似执行」，不是真实执行/等待信号——spec #369 决策 22）。
 * suspectedPendingTool = 末条 assistant 停在 stopReason=toolUse（其后尚无 toolResult 收尾）。
 * 读失败（缺文件/坏行）一律全 null/false，不推断。
 */
export interface MinimaxTailProbe {
  lastRole: string | null
  lastStopReason: string | null
  suspectedPendingTool: boolean
}

export function probeMinimaxTail(messagesFile: string): MinimaxTailProbe {
  let tail: string
  try {
    tail = readTail(messagesFile, 131072)
  } catch {
    return { lastRole: null, lastStopReason: null, suspectedPendingTool: false }
  }
  const lines = tail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"role"')) continue
    let rec: { message?: { role?: unknown; stopReason?: unknown } }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    const msg = rec.message
    const role = typeof msg?.role === 'string' ? msg.role : null
    if (role === null) continue
    const stopReason = typeof msg?.stopReason === 'string' ? msg.stopReason : null
    return { lastRole: role, lastStopReason: stopReason, suspectedPendingTool: role === 'assistant' && stopReason === 'toolUse' }
  }
  return { lastRole: null, lastStopReason: null, suspectedPendingTool: false }
}
