// Agent 会话预览的纯视图映射（工单381）：状态/工具文案与卡片降级规则——不碰 DOM，
// 由渲染页与单测共用（渲染层其余部分只做 createElement 接线）。
// 诚实分态（spec 决策 22）：五态文案一一对应，渲染层不做任何状态推断；
// 标题降级（决策 23）：无真实标题显示「未命名会话」，项目名与短 ID 分列。
import type { SessionPreviewCard, SessionPreviewTool } from '../shared/contract'

/** 工具短标（卡片左上角；组相对顺序固定 = 流中出现顺序） */
export const SESSION_PREVIEW_TOOL_LABELS: Readonly<Record<SessionPreviewTool, string>> = {
  qodercn: 'QD',
  zcode: 'ZC',
  kimicode: 'KC',
  minimaxcode: 'MM',
  dsh: 'DSH',
}

/** 工具全名（title/aria-label） */
export const SESSION_PREVIEW_TOOL_NAMES: Readonly<Record<SessionPreviewTool, string>> = {
  qodercn: 'Qoder CN',
  zcode: 'ZCode',
  kimicode: 'Kimi Code',
  minimaxcode: 'MiniMax Code',
  dsh: 'DSH',
}

/** 状态文案（五态，不混报） */
export const SESSION_PREVIEW_STATUS_LABELS = {
  running: '执行中',
  active: '最近活跃',
  waiting: '等待询问',
  'suspected-waiting': '疑似等待',
  unknown: '未知',
} as const

export interface SessionPreviewCardView {
  toolLabel: string
  toolName: string
  statusLabel: string
  /** 标题文本（无真实标题时 = 「未命名会话」） */
  title: string
  /** true = 无真实标题（UI 弱化样式） */
  unnamed: boolean
  /** 项目名（缺 = '—'） */
  project: string
  projectMissing: boolean
  shortId: string
}

export function cardView(card: SessionPreviewCard): SessionPreviewCardView {
  return {
    toolLabel: SESSION_PREVIEW_TOOL_LABELS[card.tool],
    toolName: SESSION_PREVIEW_TOOL_NAMES[card.tool],
    statusLabel: SESSION_PREVIEW_STATUS_LABELS[card.status],
    title: card.title ?? '未命名会话',
    unnamed: !card.title,
    project: card.project ?? '—',
    projectMissing: !card.project,
    shortId: card.shortId,
  }
}
