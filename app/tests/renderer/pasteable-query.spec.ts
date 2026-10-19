/** 可贴态查询超时（工单30 真机 (c) 挂起形态）：查询链路上任何一环挂起都不得挡开层——
 * 超时按「查败置灰」归约。归约出口是纯函数（离线测试穷举：即达/拒绝/超时/迟到回执）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PASTEABLE_QUERY_TIMEOUT_MS, pasteableWithinTimeout } from '../../src/renderer/pasteable-query'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('pasteableWithinTimeout', () => {
  it('查询即达：如实返回 pasteable，且定时器收尾（不空等超时档）', async () => {
    const settle = expect(pasteableWithinTimeout(Promise.resolve({ pasteable: true }), 1000)).resolves.toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await settle
    expect(vi.getTimerCount()).toBe(0)
    const no = expect(pasteableWithinTimeout(Promise.resolve({ pasteable: false }), 1000)).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    await no
  })

  it('查询拒绝：归约为不可贴（查败置灰），不向外抛', async () => {
    const settle = expect(
      pasteableWithinTimeout(Promise.reject(new Error('数据面子进程不在场')), 1000),
    ).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    await settle
  })

  it('查询挂起：到超时档归约为不可贴（开层不被无界 await 挡住）', async () => {
    const hung = new Promise<{ pasteable: boolean }>(() => {})
    const settle = expect(pasteableWithinTimeout(hung, PASTEABLE_QUERY_TIMEOUT_MS)).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(PASTEABLE_QUERY_TIMEOUT_MS - 1)
    let settled = false
    void settle.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    await settle
    expect(settled).toBe(true)
  })

  it('迟到回执：超时归约后查询才落定，结果不变、拒绝也被吞（无 unhandled rejection）', async () => {
    let rejectQuery!: (err: Error) => void
    const late = new Promise<{ pasteable: boolean }>((_, reject) => { rejectQuery = reject })
    const settle = expect(pasteableWithinTimeout(late, 1000)).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(1000)
    await settle
    rejectQuery(new Error('迟到的失败'))
    await vi.advanceTimersByTimeAsync(0)
    // 无断言即通过：迟到拒绝未逃逸为 unhandled rejection
  })
})
