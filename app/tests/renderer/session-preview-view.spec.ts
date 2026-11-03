/**
 * 会话卡片纯视图映射（工单381，spec 决策 22/23）：五态文案一一对应、工具短标、
 * 无标题降级「未命名会话」、项目名与短 ID 分列。渲染层不在这里做 DOM 接线。
 */
import { describe, expect, it } from 'vitest'
import type { SessionPreviewCard } from '../../src/shared/contract'
import {
  SESSION_PREVIEW_STATUS_LABELS,
  SESSION_PREVIEW_TOOL_LABELS,
  cardView,
} from '../../src/renderer/session-preview-view'

function card(over: Partial<SessionPreviewCard> = {}): SessionPreviewCard {
  return {
    tool: 'zcode',
    id: '0123456789abcdef',
    title: '真实标题',
    project: 'alpha',
    shortId: '01234567',
    status: 'active',
    lastActivityMs: Date.now(),
    ...over,
  }
}

describe('会话卡片视图映射', () => {
  it('五态文案一一对应，不混报', () => {
    expect(SESSION_PREVIEW_STATUS_LABELS).toEqual({
      running: '执行中',
      active: '最近活跃',
      waiting: '等待询问',
      'suspected-waiting': '疑似等待',
      unknown: '未知',
    })
    for (const status of ['running', 'active', 'waiting', 'suspected-waiting', 'unknown'] as const) {
      expect(cardView(card({ status })).statusLabel).toBe(SESSION_PREVIEW_STATUS_LABELS[status])
    }
  })

  it('工具短标固定（QD/ZC/KC/DSH）', () => {
    expect(SESSION_PREVIEW_TOOL_LABELS).toEqual({ qodercn: 'QD', zcode: 'ZC', kimicode: 'KC', dsh: 'DSH' })
  })

  it('无真实标题显示未命名会话，项目名/短 ID 分列（不拿项目名顶替标题）', () => {
    const v = cardView(card({ title: null, project: 'alpha' }))
    expect(v.title).toBe('未命名会话')
    expect(v.unnamed).toBe(true)
    expect(v.project).toBe('alpha')
    expect(v.shortId).toBe('01234567')
  })

  it('项目名缺失以占位符呈现（不编造）', () => {
    const v = cardView(card({ project: null }))
    expect(v.projectMissing).toBe(true)
    expect(v.project).toBe('—')
  })
})
