// 有界 settle 等待 helper（工单123，spec #125 Phase 0）：注入式轮询/时钟打外部契约——
// 只断言收敛结果与有界性（ok/value/attempts/elapsedMs），不断言内部调用序列；
// 缝位循 battery-config helper 同款（spec #125 Testing Decisions「不另立」）。
// 时钟注入 = now() 返回虚拟时间、sleep(ms) 推进虚拟时间，用例确定性零真等。
import { describe, expect, it } from 'vitest'
import { waitForProbe } from '../../accept/lib/bounded-wait'

/** 虚拟时钟夹具：sleep 同步推进虚拟时间，等待有界性可用整数毫秒断言 */
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms },
  }
}

describe('waitForProbe 有界 settle 等待（工单123）', () => {
  it('首探即中：立即收敛返回值，不空耗轮询（attempts=1、时钟未走）', async () => {
    const clock = fakeClock()
    const r = await waitForProbe(
      async () => 'CPU 12% GPU 79%',
      { timeoutMs: 10_000, intervalMs: 150, ...clock },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe('CPU 12% GPU 79%')
    expect(r.attempts).toBe(1)
    expect(r.elapsedMs).toBe(0)
  })

  it('缺位后到位：null 两拍后命中——按 intervalMs 节奏重试至收敛（2×150=300ms）', async () => {
    const clock = fakeClock()
    const reads = [null, null, '重渲染完成']
    const r = await waitForProbe(
      async () => reads.shift() ?? null,
      { timeoutMs: 10_000, intervalMs: 150, ...clock },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe('重渲染完成')
    expect(r.attempts).toBe(3)
    expect(r.elapsedMs).toBe(300)
  })

  it('恒缺位：有界超时停（不糊绿）——手推 1000ms/150ms 拍 = t=0,150,…,900 共 7 探，总耗 ≤ 界+一拍', async () => {
    const clock = fakeClock()
    const r = await waitForProbe(
      async () => null,
      { timeoutMs: 1000, intervalMs: 150, ...clock },
    )
    expect(r.ok).toBe(false)
    expect(r.value).toBeNull()
    expect(r.attempts).toBe(7)
    expect(r.elapsedMs).toBeLessThanOrEqual(1000 + 150)
  })

  it('probe 抛错按未命中：瞬态抖动界内重试（抛两次后命中），不把读侧异常放大成中止', async () => {
    const clock = fakeClock()
    let n = 0
    const r = await waitForProbe(
      async () => {
        n += 1
        if (n <= 2) throw new Error('CDP evaluate 失败')
        return 'CPU 12%'
      },
      { timeoutMs: 10_000, intervalMs: 150, ...clock },
    )
    expect(r.ok).toBe(true)
    expect(r.value).toBe('CPU 12%')
    expect(r.attempts).toBe(3)
    expect(r.elapsedMs).toBe(300)
  })

  it('退化界 timeoutMs=0：零探测即超界返回 ok=false（有界原则的极限形态，不探不抛）', async () => {
    const clock = fakeClock()
    let probes = 0
    const r = await waitForProbe(
      async () => { probes += 1; return 'x' },
      { timeoutMs: 0, intervalMs: 150, ...clock },
    )
    expect(r.ok).toBe(false)
    expect(probes).toBe(0)
    expect(r.attempts).toBe(0)
  })
})
