// 投放包视图组装（工单337 收尾）：media 段「解包 / 缺席即删」的单一口径。
// 回归背景：refreshMedia 曾把 mediaView 的 `{ media: DTO }` 包装整包赋给 view.media，
// 卡片读不到 sessions——媒体刷新后回落空态（C7 真机 44/1 的渲染侧根因）。
import { describe, expect, it } from 'vitest'
import { withMediaSegment } from '../../src/main/plugins/package-view'

describe('投放包视图 media 段组装（工单337）', () => {
  it('mediaView 的 {media: DTO} 包装被解包：view.media 即 DTO 本体（sessions/controlGranted 可读）', () => {
    const dto = { generation: 3, available: true, selectedKey: 'k1', sessions: [{ key: 'k1', status: 'PAUSED' }], controlGranted: true }
    const view = withMediaSegment({}, { media: dto })
    expect(view.media).toBe(dto)
    // 双重嵌套即回归：存在 .media.media 说明未解包
    expect((view.media as Record<string, unknown>).media).toBeUndefined()
    expect((view.media as { sessions: unknown[] }).sessions).toHaveLength(1)
  })

  it('mediaView 缺席（未授权/撤销）→ view.media 删除（投影之外是「不存在」）', () => {
    expect(withMediaSegment({ media: { stale: true }, other: 1 }, null)).toEqual({ other: 1 })
    expect(withMediaSegment({ media: { stale: true } }, {})).toEqual({})
    expect(withMediaSegment({}, { media: null })).toEqual({})
  })

  it('不触碰其余段（refreshMedia 在 latestView 副本上增量更新）', () => {
    const view = withMediaSegment({ clock: { now: 1 }, media: { old: true } }, { media: { sessions: [] } })
    expect(view.clock).toEqual({ now: 1 })
    expect(view.media).toEqual({ sessions: [] })
  })
})
