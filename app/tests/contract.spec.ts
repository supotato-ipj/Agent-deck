import { describe, expect, it } from 'vitest'
import { createKernel } from '../src/main/kernel'
import type { PanelSnapshot } from '../src/shared/contract'

/** 内核契约缝（spec：在 Node 中直接驱动 cordis 内核，断言桥接 API 的请求/响应与变更推送）。 */
describe('内核桥接契约', () => {
  it('panel/snapshot 返回时钟快照', async () => {
    const ctx = createKernel({ tickIntervalMs: 0 })
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.clock.epochMs).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(snap.clock.iso))).toBe(false)
      expect(Math.abs(snap.clock.epochMs - Date.now())).toBeLessThan(5000)
    } finally {
      await ctx.stop()
    }
  })

  it('panel/changed 订阅推送快照，退订后停止', async () => {
    const ctx = createKernel({ tickIntervalMs: 0 })
    await ctx.start()
    try {
      const received: PanelSnapshot[] = []
      const off = ctx.bridge.subscribe('panel/changed', (s) => received.push(s))
      ctx.bridge.tick()
      ctx.bridge.tick()
      expect(received).toHaveLength(2)
      expect(received[1].clock.epochMs).toBeGreaterThanOrEqual(received[0].clock.epochMs)
      off()
      ctx.bridge.tick()
      expect(received).toHaveLength(2)
    } finally {
      await ctx.stop()
    }
  })

  it('未知方法拒绝', async () => {
    const ctx = createKernel({ tickIntervalMs: 0 })
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('nope' as never, null as never)).rejects.toThrow(/未知桥接方法/)
    } finally {
      await ctx.stop()
    }
  })
})
