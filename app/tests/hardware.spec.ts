/** 硬件采样纯逻辑的离线测试：历史环、CPU/网络速率、nvidia-smi 解析与缓存。 */
import { describe, expect, it } from 'vitest'
import { HistoryRing } from '../src/main/hardware/history'
import { aggregateCpuTimes, counterDelta32, cpuPercent, netRates, type CpuTimes } from '../src/main/hardware/rates'
import { GpuQuery, parseNvidiaSmi } from '../src/main/hardware/nvidia'

describe('HistoryRing（300 点滚动窗）', () => {
  it('超过上限后滚动丢弃最旧点', () => {
    const ring = new HistoryRing(3)
    for (const v of [1, 2, 3, 4, 5]) ring.push(v)
    expect(ring.toArray()).toEqual([3, 4, 5])
  })

  it('入环取整 1 位小数；不可用点为 null', () => {
    const ring = new HistoryRing(300)
    ring.push(12.345)
    ring.push(null)
    expect(ring.toArray()).toEqual([12.3, null])
  })

  it('旧契约 300 点上限：推 350 点只留最后 300', () => {
    const ring = new HistoryRing(300)
    for (let i = 0; i < 350; i++) ring.push(i)
    const arr = ring.toArray()
    expect(arr).toHaveLength(300)
    expect(arr[0]).toBe(50)
    expect(arr[299]).toBe(349)
  })
})

describe('CPU 占用计算（os.cpus 差值）', () => {
  const t = (user: number, idle: number): CpuTimes => ({ total: user + idle, idle })

  it('首次采样无基准给 0（psutil 语义）', () => {
    expect(cpuPercent(null, t(100, 100))).toBe(0)
  })

  it('区间差值给占用百分比', () => {
    expect(cpuPercent(t(50, 50), t(100, 100))).toBeCloseTo(50, 5)
    expect(cpuPercent(t(0, 100), t(100, 100))).toBeCloseTo(100, 5)
  })

  it('os.cpus 聚合：各核时间求和', () => {
    const cpus = [
      { times: { user: 10, nice: 1, sys: 2, idle: 87, irq: 0 } },
      { times: { user: 20, nice: 0, sys: 3, idle: 77, irq: 0 } },
    ]
    expect(aggregateCpuTimes(cpus)).toEqual({ idle: 164, total: 200 })
  })
})

describe('网络速率（32 位回绕按接口处理）', () => {
  it('首拍无基准返回 null', () => {
    expect(netRates(null, new Map(), 1)).toBeNull()
  })

  it('差值换算 KB/s 且钳非负', () => {
    const prev = new Map([[1, { in: 1000, out: 2000 }]])
    const cur = new Map([[1, { in: 1124, out: 1500 }]])
    expect(netRates(prev, cur, 1)).toEqual({ download_speed: 0.1, upload_speed: 0 })
  })

  it('接口计数器 32 位回绕按差值取模处理', () => {
    expect(counterDelta32(0xffffff00, 0x00000100)).toBe(0x200)
    const prev = new Map([[1, { in: 0xffffff00, out: 0 }]])
    const cur = new Map([[1, { in: 0x00000100, out: 0 }]])
    expect(netRates(prev, cur, 1)?.download_speed).toBeCloseTo(0x200 / 1024, 3)
  })

  it('回绕差值大得不合常理（计数器重置）归零', () => {
    expect(counterDelta32(1000, 999)).toBe(0)
    expect(counterDelta32(0, 0x80000001)).toBe(0)
  })

  it('多接口分别求差后求和；新增接口不算差', () => {
    const prev = new Map([[1, { in: 0, out: 0 }]])
    const cur = new Map([
      [1, { in: 1024, out: 0 }],
      [2, { in: 99999, out: 99999 }],
    ])
    expect(netRates(prev, cur, 1)).toEqual({ download_speed: 1, upload_speed: 0 })
  })

  it('dt 为 0 无速率', () => {
    const m = new Map([[1, { in: 0, out: 0 }]])
    expect(netRates(m, m, 0)).toBeNull()
  })
})

describe('nvidia-smi 解析', () => {
  it('CSV 首行四值映射 gpu_usage/gpu_temp/vram_usage', () => {
    expect(parseNvidiaSmi('37, 65, 4096, 24576\n')).toEqual({
      gpu_usage: 37,
      gpu_temp: 65,
      vram_usage: 16.7,
    })
  })

  it('无输出抛错（源不可用降级）', () => {
    expect(() => parseNvidiaSmi('   \n')).toThrow()
    expect(() => parseNvidiaSmi('util [MiB], temp\n')).toThrow()
  })

  it('vram 总量为 0 时为 null', () => {
    expect(parseNvidiaSmi('10, 55, 0, 0').vram_usage).toBeNull()
  })
})

describe('GpuQuery 3 秒缓存', () => {
  function fixture() {
    let t = 0
    const calls: string[][] = []
    const q = new GpuQuery(3000, (args, cb) => {
      calls.push(args)
      cb(null, '50, 60, 100, 200')
    }, () => t)
    return {
      q,
      calls,
      advance: (ms: number) => { t += ms },
    }
  }

  it('缓存窗内不重复查询；失败也占满 TTL（Python 语义）', async () => {
    const f = fixture()
    expect(f.q.read()).toEqual({ gpu_usage: 50, gpu_temp: 60, vram_usage: 50 }) // 同步 runner 当拍即得
    await Promise.resolve()
    f.advance(1000)
    expect(f.q.read()).toEqual({ gpu_usage: 50, gpu_temp: 60, vram_usage: 50 })
    expect(f.calls).toHaveLength(1)
  })
})
