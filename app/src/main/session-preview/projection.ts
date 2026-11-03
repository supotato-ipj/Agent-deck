/**
 * Agent 会话预览投影（工单381，spec #369 决策 20-23 —— 纯逻辑，无 IO）。
 *
 * 输入是四工具各自的**只读信号行**：qodercn/zcode/kimicode 来自文件扫描器，
 * dsh 来自面板内 ConversationSessionView。输出是契约 SessionPreviewState 的 groups：
 *   - 工具相对顺序固定（SESSION_PREVIEW_TOOL_ORDER），空工具整组不占位；
 *   - 组内按最近活跃降序；
 *   - 只保留活动子集（完成/空闲过滤），五态诚实分派：
 *       running          = 明确执行信号（只有 DSH busy）
 *       waiting          = 真实等待（只有 DSH pendingPermission）
 *       suspected-waiting= 启发式（只有 Qoder 末条 assistant 以 tool_use 收尾）
 *       active           = 只有最近活跃时间（mtime/updated_at 一律落这里）
 *       unknown          = 来源可读但状态不可判
 *
 * 标题语义：只透传来源的真实标题；无标题 = null（UI 显示「未命名会话」），绝不拿
 * 项目名/目录名冒充标题。项目名与短 ID 是分列的次级信息。
 */
import type {
  ConversationSessionView,
  SessionPreviewCard,
  SessionPreviewStatus,
  SessionPreviewTool,
  SessionPreviewToolGroup,
} from '../../shared/contract'
import { SESSION_PREVIEW_TOOL_ORDER } from '../../shared/contract'
import { ACTIVE_WINDOW } from '../scanners/types'
import type { KimiCodePreviewRow } from '../scanners/kimicode'
import type { QoderPreviewRow } from '../scanners/qoder'
import type { ZcodePreviewRow } from '../scanners/zcode'

/** 活跃池窗（毫秒）：与扫描器 90 秒 RUNNING / 10 分钟活跃池同口径 */
export const ACTIVE_WINDOW_MS = ACTIVE_WINDOW * 1000

/** 短会话 ID：取 id 前 8 字符（短于 8 原样）；纯展示用，身份仍是完整 (tool, id) */
export function shortSessionId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/** 会话仍处于活跃池（最近活跃时间缺失 = 不算活跃——不拿未知时间冒充新鲜） */
function isActive(lastActivityMs: number | null, nowMs: number): boolean {
  return lastActivityMs !== null && nowMs - lastActivityMs <= ACTIVE_WINDOW_MS
}

function card(
  tool: SessionPreviewTool,
  id: string,
  title: string | null,
  project: string | null,
  status: SessionPreviewStatus,
  lastActivityMs: number | null,
): SessionPreviewCard {
  return { tool, id, title, project, shortId: shortSessionId(id), status, lastActivityMs }
}

/**
 * Qoder CN（启发式来源）：末条 assistant 以 tool_use 收尾 = 疑似等待；assistant 文本收尾
 * = 完成（过滤）；末条 user = 最近活跃；无可解析尾 = 未知。Qoder 的 CONFIRM 绝不升级成
 * 「执行中」或「等待询问」（spec 决策 22）。
 */
export function qoderCards(rows: QoderPreviewRow[], nowMs: number): SessionPreviewCard[] {
  const out: SessionPreviewCard[] = []
  for (const row of rows) {
    if (!isActive(row.lastActivityMs, nowMs)) continue
    let status: SessionPreviewStatus
    if (row.lastKind === 'tool') status = 'suspected-waiting'
    else if (row.lastKind === 'text') continue // 完成：不占卡片
    else if (row.lastKind === 'user') status = 'active'
    else status = 'unknown'
    out.push(card('qodercn', row.id, null, row.project, status, row.lastActivityMs))
  }
  return out
}

/** zcode：只有最近活跃时间（title 是真实标题；执行/等待均无诚实信号 → 不推断） */
export function zcodeCards(rows: ZcodePreviewRow[], nowMs: number): SessionPreviewCard[] {
  const out: SessionPreviewCard[] = []
  for (const row of rows) {
    if (!isActive(row.lastActivityMs, nowMs)) continue
    out.push(card('zcode', row.id, row.title, row.project, 'active', row.lastActivityMs))
  }
  return out
}

/** kimicode：同 zcode——真实标题 + 最近活跃，不推断执行/等待 */
export function kimicodeCards(rows: KimiCodePreviewRow[], nowMs: number): SessionPreviewCard[] {
  const out: SessionPreviewCard[] = []
  for (const row of rows) {
    if (!isActive(row.lastActivityMs, nowMs)) continue
    out.push(card('kimicode', row.id, row.title, row.project, 'active', row.lastActivityMs))
  }
  return out
}

/** DSH 最近活跃：会话创建/结束与转写末条时间的最大值（转写仅内存） */
function dshLastActivity(session: ConversationSessionView): number {
  let last = session.createdAt
  if (session.endedAt !== null && session.endedAt > last) last = session.endedAt
  const tail = session.transcript.length ? session.transcript[session.transcript.length - 1] : null
  if (tail && typeof tail.at === 'number' && tail.at > last) last = tail.at
  return last
}

/**
 * DSH（真实信号来源）：pendingPermission → 等待询问（真实等待）；busy → 执行中（真实）；
 * starting → 未知（握手/启动中，状态不可判）；ready/ended/failed → 空闲/完成，过滤。
 * label 是创建时用户命名的真实 label，原样作标题；cwd 末段作项目名。
 */
export function dshCards(sessions: ConversationSessionView[], nowMs: number): SessionPreviewCard[] {
  const out: SessionPreviewCard[] = []
  for (const session of sessions) {
    if (session.status === 'ended' || session.status === 'failed') continue // 完成
    if (session.status === 'ready') continue // 空闲：不占卡片
    let status: SessionPreviewStatus
    if (session.pendingPermission) status = 'waiting'
    else if (session.status === 'busy') status = 'running'
    else status = 'unknown'
    const label = typeof session.label === 'string' && session.label.trim() ? session.label.trim() : null
    const project = typeof session.cwd === 'string' && session.cwd.trim()
      ? session.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null
      : null
    const lastActivityMs = dshLastActivity(session)
    // 真实执行/真实等待本身就是活动事实（不受 10 分钟活跃池约束）；未知态才需要新鲜度
    // 兜底——否则一条长回合且转写稀疏的 busy 会话会被误判成空闲。
    if (status === 'unknown' && !isActive(lastActivityMs, nowMs)) continue
    out.push(card('dsh', session.id, label, project, status, lastActivityMs))
  }
  return out
}

export interface SessionPreviewInputs {
  qoder: QoderPreviewRow[]
  zcode: ZcodePreviewRow[]
  kimicode: KimiCodePreviewRow[]
  dsh: ConversationSessionView[]
}

/** 组内最近活跃降序（时间缺失置末；同刻按 id 稳定序，避免 1Hz 刷新画面抖动） */
function sortCards(cards: SessionPreviewCard[]): SessionPreviewCard[] {
  return cards.slice().sort((a, b) => {
    const ta = a.lastActivityMs ?? Number.NEGATIVE_INFINITY
    const tb = b.lastActivityMs ?? Number.NEGATIVE_INFINITY
    if (tb !== ta) return tb - ta
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 全量投影 → 固定工具相对序的组集（空组不占位） */
export function buildSessionPreviewGroups(input: SessionPreviewInputs, nowMs: number): SessionPreviewToolGroup[] {
  const byTool: Record<SessionPreviewTool, SessionPreviewCard[]> = {
    qodercn: sortCards(qoderCards(input.qoder, nowMs)),
    zcode: sortCards(zcodeCards(input.zcode, nowMs)),
    kimicode: sortCards(kimicodeCards(input.kimicode, nowMs)),
    dsh: sortCards(dshCards(input.dsh, nowMs)),
  }
  return SESSION_PREVIEW_TOOL_ORDER
    .map((tool) => ({ tool, cards: byTool[tool] }))
    .filter((group) => group.cards.length > 0)
}
