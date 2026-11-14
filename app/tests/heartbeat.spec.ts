/**
 * 单一心跳调度器（工单477 束④）接缝测试：采集族多周期任务合并到单一心跳后的
 * 派发契约——「每任务按自身周期到期才跑，不是每拍都跑；错过多拍的合并成一拍一次；
 * 单任务抛错不连累别的任务」。时钟注入合成钟、手动推进拍，不断言定时器内部。
 */
import { describe, expect, it } from 'vitest'
import { Heartbeat } from '../src/main/heartbeat'

function fakeClock() {
  let t = 0
  return {
    now: () => t,
    advance: (ms: number) => { t += ms },
  }
}

describe('Heartbeat（单一心跳派发契约，工单477 束④）', () => {
  it('任务按自身周期到期才派发：1s 拍上 everyMs=4s 的任务 8 拍只跑 2 次（不是每拍都跑）', () => {
    const clock = fakeClock()
    const hb = new Heartbeat(1000, clock.now)
    let runs = 0
    hb.add({ everyMs: 4000, run: () => { runs += 1 } })
    for (let i = 0; i < 8; i++) {
      clock.advance(1000)
      hb.beat()
    }
    expect(runs).toBe(2)
  })

  it('多任务各按各的周期独立派发：8 拍内 1s 任务跑 8 次、4s 任务跑 2 次、8s 任务跑 1 次', () => {
    const clock = fakeClock()
    const hb = new Heartbeat(1000, clock.now)
    const counts = { fast: 0, mid: 0, slow: 0 }
    hb.add({ everyMs: 1000, run: () => { counts.fast += 1 } })
    hb.add({ everyMs: 4000, run: () => { counts.mid += 1 } })
    hb.add({ everyMs: 8000, run: () => { counts.slow += 1 } })
    for (let i = 0; i < 8; i++) {
      clock.advance(1000)
      hb.beat()
    }
    expect(counts).toEqual({ fast: 8, mid: 2, slow: 1 })
  })

  it('错过多拍合并为一拍一次：一次跳过 10 个周期只补跑 1 次（语义对齐旧 setInterval 的错拍合并）', () => {
    const clock = fakeClock()
    const hb = new Heartbeat(1000, clock.now)
    let runs = 0
    hb.add({ everyMs: 1000, run: () => { runs += 1 } })
    clock.advance(1000)
    hb.beat()
    expect(runs).toBe(1)
    clock.advance(10_000) // 停摆 10 拍
    hb.beat()
    expect(runs).toBe(2) // 补一次，不按错过的拍数连跑
  })

  it('单任务抛错不连累其余任务：其余照常派发，错误经 onError 上报', () => {
    const clock = fakeClock()
    const errors: string[] = []
    const hb = new Heartbeat(1000, clock.now, (_task, err) => { errors.push(String(err)) })
    let good = 0
    hb.add({ everyMs: 1000, label: 'bad', run: () => { throw new Error('采集任务炸了') } })
    hb.add({ everyMs: 1000, label: 'good', run: () => { good += 1 } })
    clock.advance(1000)
    hb.beat()
    expect(good).toBe(1)
    expect(errors).toEqual(['Error: 采集任务炸了'])
  })

  it('stop 后真实定时器停拍：起跳期计数在涨，stop 后计数冻结（真实短拍实测）', async () => {
    const hb = new Heartbeat(5)
    let runs = 0
    hb.add({ everyMs: 5, run: () => { runs += 1 } })
    hb.start()
    await new Promise((r) => setTimeout(r, 40))
    const during = runs
    expect(during).toBeGreaterThan(0)
    hb.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(runs).toBe(during) // 停拍后不再增长
  })
})
