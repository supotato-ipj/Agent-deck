/**
 * 搜索服务状态机测试（工单07，tests/test_search_panel.py + 引擎链路语义移植）：
 * 待机/活动/引擎离线三态迁移、防抖喂词、限流静默退避、离线自动重试、
 * 单飞行作废、动作护栏（path 必须在最近一次结果集内）。全部假源 + 合成时钟。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { SearchService } from '../../src/main/services/search'
import { flush, harness, okPayload, type SearchObservations } from './harness'

/** 挂服务 + 事件观察（cordis 内核直驱；states/results 记录 search/state 与 search/results） */
async function withService(h: ReturnType<typeof harness>, fn: (svc: SearchService, obs: SearchObservations) => Promise<void> | void): Promise<void> {
  const ctx = new Context()
  const states: SearchObservations['states'] = []
  const results: SearchObservations['results'] = []
  ctx.on('search/state', (p) => states.push(p.state))
  ctx.on('search/results', (p) => results.push(p))
  const svc = new SearchService(ctx, { deps: h.deps })
  await ctx.start()
  try {
    await fn(svc, { states, results })
  } finally {
    await ctx.stop()
  }
}

describe('三态迁移（PanelStateMachine 语义移植）', () => {
  it('初始待机；激活转活动并推送 state 事件', async () => {
    const h = harness()
    await withService(h, (svc, { states }) => {
      expect(svc.activate()).toBe('active')
      expect(states).toEqual(['active'])
    })
  })

  it('活动态重复激活幂等（不重推事件）', async () => {
    const h = harness()
    await withService(h, (svc, { states }) => {
      svc.activate()
      expect(svc.activate()).toBe('active')
      expect(states).toEqual(['active'])
    })
  })

  it('ESC/失焦退回待机并清空查询词——再激活后旧词不重发', async () => {
    const h = harness()
    await withService(h, async (svc, { states }) => {
      svc.activate()
      svc.setQuery('旧查询')
      h.advance(300)
      svc.tick()
      await flush()
      expect(svc.deactivate()).toBe('idle')
      expect(states).toEqual(['active', 'idle'])
      svc.activate()
      h.advance(1000)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1) // 只有退待机前那一枪
    })
  })

  it('待机态退待机是幂等空操作', async () => {
    const h = harness()
    await withService(h, (svc, { states }) => {
      expect(svc.deactivate()).toBe('idle')
      expect(states).toEqual([])
    })
  })

  it('离线后退待机再激活：离线徽标不跨激活残留（回活动态，等新查询）', async () => {
    const h = harness()
    await withService(h, async (svc, { states }) => {
      h.goOffline()
      svc.activate()
      svc.setQuery('q')
      h.advance(250)
      svc.tick()
      await flush()
      expect(states).toEqual(['active', 'offline'])
      svc.deactivate()
      expect(svc.activate()).toBe('active')
      expect(states).toEqual(['active', 'offline', 'idle', 'active'])
      h.advance(10_000)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1) // 新激活无查询不重试、不推离线
    })
  })

  it('待机态喂词不被接受（防抖不入队）', async () => {
    const h = harness()
    await withService(h, (svc) => {
      expect(svc.setQuery('abc')).toBe(false)
      h.advance(1000)
      svc.tick()
      expect(h.calls).toHaveLength(0)
    })
  })
})

describe('引擎链路（防抖 → 内核直连 → 事件回推）', () => {
  it('防抖到期发一次请求（limit 8 / offset 0），结果经事件回推', async () => {
    const h = harness()
    await withService(h, async (svc, { results }) => {
      svc.activate()
      svc.setQuery('rea')
      h.advance(100)
      svc.tick()
      expect(h.calls).toHaveLength(0) // 窗口内
      h.advance(100) // 200ms 到期
      svc.tick()
      await flush()
      expect(h.calls).toEqual([{ query: 'rea', limit: 8, offset: 0 }])
      expect(results).toHaveLength(1)
      expect(results[0].items[0].path).toBe('C:\\rea.txt')
    })
  })

  it('窗口内连续变更合并到最后一词；空查询取消在途且不发请求', async () => {
    const h = harness()
    await withService(h, async (svc, { results }) => {
      svc.activate()
      svc.setQuery('r')
      h.advance(50)
      svc.setQuery('re')
      h.advance(50)
      svc.setQuery('rea')
      h.advance(199)
      svc.tick()
      expect(h.calls).toHaveLength(0)
      h.advance(1)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1)
      expect(h.calls[0].query).toBe('rea')
      expect(results).toHaveLength(1)

      svc.setQuery('rea ') // 新词将到期
      h.advance(250)
      svc.setQuery('') // 清空：取消在途
      h.advance(250)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1)
    })
  })

  it('同词不重发；退待机 reset 后允许重发同词', async () => {
    const h = harness()
    await withService(h, async (svc) => {
      svc.activate()
      svc.setQuery('abc')
      h.advance(250)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1)
      svc.setQuery('abc')
      h.advance(250)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1) // 去重

      svc.deactivate()
      svc.activate()
      svc.setQuery('abc')
      h.advance(250)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(2)
    })
  })

  it('连接失败 → 推引擎离线态；3s 后自动重发同词；恢复后回活动态并出结果', async () => {
    const h = harness()
    await withService(h, async (svc, { states, results }) => {
      h.goOffline()
      svc.activate()
      svc.setQuery('probe')
      h.advance(250)
      svc.tick()
      await flush()
      expect(states).toEqual(['active', 'offline'])
      expect(results).toHaveLength(0)
      expect(h.calls).toHaveLength(1)

      h.advance(2999)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1) // 重试未到期
      h.advance(1)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(2) // 3s 整重发同词
      expect(h.calls[1]).toEqual({ query: 'probe', limit: 8, offset: 0 })
      expect(states).toEqual(['active', 'offline']) // 重试仍离线：不重复推送

      h.respondWith((q) => okPayload([{ path: `C:\\${q}.txt`, name: q }]))
      h.advance(3000)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(3)
      expect(states).toEqual(['active', 'offline', 'active']) // 恢复：回活动态
      expect(results).toHaveLength(1)
    })
  })

  it('限流静默退避：0.5s 起步倍增、不推状态、重发同词', async () => {
    const h = harness()
    await withService(h, async (svc, { states, results }) => {
      h.goRateLimited()
      svc.activate()
      svc.setQuery('q')
      h.advance(250)
      svc.tick()
      await flush()
      expect(states).toEqual(['active']) // 静默：无 offline 推送
      expect(h.calls).toHaveLength(1)

      h.advance(499)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1)
      h.advance(1) // 第一次限流 → 500ms 退避到期
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(2)

      h.advance(999)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(2)
      h.advance(1) // 第二次限流 → 1s 退避到期
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(3)

      h.respondWith((q) => okPayload([{ path: `C:\\${q}.txt`, name: q }]))
      h.advance(2000) // 第三次限流 → 2s 退避到期 → 成功
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(4)
      expect(results).toHaveLength(1)
      expect(states).toEqual(['active'])
    })
  })

  it('引擎在线但行为异常（error）：不冒充离线、不自动重试，等下次输入', async () => {
    const h = harness()
    await withService(h, async (svc, { states, results }) => {
      h.goBroken()
      svc.activate()
      svc.setQuery('q')
      h.advance(250)
      svc.tick()
      await flush()
      expect(states).toEqual(['active'])
      expect(results).toHaveLength(0)
      h.advance(10_000)
      svc.tick()
      await flush()
      expect(h.calls).toHaveLength(1) // 无重试
    })
  })

  it('单飞行：新查询作废旧响应；退待机作废在途响应', async () => {
    const h = harness()
    const deferred: Array<(payload: unknown) => void> = []
    h.respondWith(() => new Promise((resolve) => deferred.push(resolve)))
    await withService(h, async (svc, { results, states }) => {
      svc.activate()
      svc.setQuery('slow')
      h.advance(250)
      svc.tick()
      expect(h.calls).toHaveLength(1)
      svc.setQuery('fast')
      h.advance(250)
      svc.tick()
      expect(h.calls).toHaveLength(2)
      // 第二枪先回：新查询结果生效
      deferred[1](okPayload([{ path: 'C:\\fast.txt', name: 'fast.txt' }]))
      await flush()
      expect(results.map((r) => r.items[0].path)).toEqual(['C:\\fast.txt'])
      // 旧响应迟到：已作废
      deferred[0](okPayload([{ path: 'C:\\stale.txt', name: 'stale.txt' }]))
      await flush()
      expect(results).toHaveLength(1)

      // 退待机作废在途（第三枪挂着）
      svc.setQuery('late')
      h.advance(250)
      svc.tick()
      expect(h.calls).toHaveLength(3)
      svc.deactivate()
      deferred[2](okPayload([{ path: 'C:\\late.txt', name: 'late.txt' }]))
      await flush()
      expect(results).toHaveLength(1)
      expect(states[states.length - 1]).toBe('idle')
    })
  })
})

describe('动作护栏（Enter 打开 / Ctrl+Enter 定位）', () => {
  it('path 在最近一次结果集内才执行；reveal 走资源管理器定位', async () => {
    const h = harness()
    await withService(h, async (svc) => {
      svc.activate()
      svc.setQuery('a')
      h.advance(250)
      svc.tick()
      await flush()
      await expect(svc.action('C:\\a.txt', false)).resolves.toEqual({ ok: true })
      expect(h.opened).toEqual(['C:\\a.txt'])
      await expect(svc.action('C:\\a.txt', true)).resolves.toEqual({ ok: true })
      expect(h.revealed).toEqual(['C:\\a.txt'])
      await expect(svc.action('C:\\elsewhere.txt', false)).resolves.toMatchObject({ ok: false })
      expect(h.opened).toHaveLength(1)
    })
  })

  it('空查询清空结果护栏；打开失败回传 error；退待机后动作拒绝', async () => {
    const h = harness()
    await withService(h, async (svc) => {
      svc.activate()
      svc.setQuery('a')
      h.advance(250)
      svc.tick()
      await flush()
      svc.setQuery('')
      await expect(svc.action('C:\\a.txt', false)).resolves.toMatchObject({ ok: false })
      expect(h.opened).toHaveLength(0)

      svc.setQuery('b')
      h.advance(250)
      h.respondWith(() => okPayload([{ path: 'C:\\b.txt', name: 'b.txt' }]))
      svc.tick()
      await flush()
      h.failOpen('无法打开')
      await expect(svc.action('C:\\b.txt', false)).resolves.toEqual({ ok: false, error: '无法打开' })
      svc.deactivate()
      await expect(svc.action('C:\\b.txt', false)).resolves.toMatchObject({ ok: false })
    })
  })
})
