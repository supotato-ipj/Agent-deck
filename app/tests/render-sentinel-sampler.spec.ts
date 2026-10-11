/**
 * 渲染层哨兵的采数与接线（工单94 建，#91 定案判据）。级别裁决本身在
 * render-sentinel.ts 的纯函数里离线穷举（工单93），本文件只盯接线这一层：
 * 采心跳、复位上报态、把裁决结果落成存证。接线错了纯函数白算——故这些用例断言的
 * 是「给定一串心跳与时间推进，落了哪几条存证、每条自带哪个标记」，不是内部字段。
 *
 * 全程假时钟（做法参照 wind-restore.spec.ts）：哨兵是 2s 采样 + Date.now 计时的轮询体，
 * 真时钟跑不出「刚好卡在阈值前一拍」这种边界格，而那一格正是本轮不能动的口径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RenderSentinelSampler,
  RENDER_SENTINEL_POLL_MS,
  RENDER_SENTINEL_QUIET_MS,
} from '../src/main/render-sentinel-sampler'
import type { FrozenRecord, SilentRecord, UnfrozenRecord } from '../src/main/render-sentinel-sampler'

interface HarnessOptions {
  thresholdMs?: number
  heartbeatArmed?: boolean
  windowDestroyed?: () => boolean
  rendererDestroyed?: () => boolean
}

/** 起一个哨兵：三类存证各收一桶，其余开关按用例需要传 */
function harness(options: HarnessOptions = {}): {
  records: SilentRecord[]
  frozen: FrozenRecord[]
  unfrozen: UnfrozenRecord[]
  run: RenderSentinelSampler
} {
  const records: SilentRecord[] = []
  const frozen: FrozenRecord[] = []
  const unfrozen: UnfrozenRecord[] = []
  const run = new RenderSentinelSampler({
    ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
    ...(options.heartbeatArmed === undefined ? {} : { heartbeatArmed: options.heartbeatArmed }),
    ...(options.windowDestroyed === undefined ? {} : { isWindowDestroyed: options.windowDestroyed }),
    ...(options.rendererDestroyed === undefined ? {} : { isRendererDestroyed: options.rendererDestroyed }),
    onQuiet: (record) => records.push(record),
    onFrozen: (record) => frozen.push(record),
    onUnfrozen: (record) => unfrozen.push(record),
  })
  return { records, frozen, unfrozen, run }
}

describe('渲染层哨兵接线（工单94）', () => {
  const runs: RenderSentinelSampler[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    runs.splice(0).forEach((r) => r.dispose())
    vi.useRealTimers()
  })

  /** 起一个哨兵并登记到 afterEach 统一 dispose（省得每个用例自己收尾） */
  function start(options: HarnessOptions = {}) {
    const h = harness(options)
    runs.push(h.run)
    return h
  }

  it('未达阈值不落存证；达阈值落一条首现静默，且自带 recovered=false', () => {
    const { records } = start()

    vi.advanceTimersByTime(4000) // 4s < 5s：静默未成形
    expect(records).toEqual([])

    vi.advanceTimersByTime(2000) // 累计 6s ≥ 5s
    expect(records).toEqual([{ quietMs: 6000, recovered: false }])
  })

  it('存证带的是实测静默时长，不是阈值本身（否则读的人会以为恰好卡在阈值上达阈）', () => {
    // 阈值给 7s：第一拍达阈的实测时长是 8s。写 7s 就把「达阈那一刻」与「阈值」混成一件事。
    const { records } = start({ thresholdMs: 7000 })

    vi.advanceTimersByTime(8000)
    expect(records).toEqual([{ quietMs: 8000, recovered: false }])
  })

  it('同一轮静默不重复落存证（一个形态一条，不刷屏）', () => {
    const { records } = start()

    vi.advanceTimersByTime(20000) // 连续 10 拍全静默
    expect(records).toEqual([{ quietMs: 6000, recovered: false }])
  })

  it('静默达阈值后很快恢复、随后再次静默 → 再落一条带 recovered=true 的静默，而不是当失能（15:19:15 那次自愈的直接编码）', () => {
    const { records, run } = start()

    vi.advanceTimersByTime(6000)
    expect(records).toEqual([{ quietMs: 6000, recovered: false }])

    vi.advanceTimersByTime(2000)
    run.beat() // 渲染层又上行了一次：这一轮静默已经过去
    vi.advanceTimersByTime(2000)
    expect(records).toHaveLength(1) // 恢复后静默时长归零，还没达阈

    vi.advanceTimersByTime(4000) // 再次静默达阈
    expect(records).toEqual([
      { quietMs: 6000, recovered: false },
      { quietMs: 6000, recovered: true },
    ])
  })

  it('恢复标记的口径：自上次落定以来收到过心跳才带——首条（哨兵起至今没见过心跳）不带，此后每轮都带', () => {
    const { records, run } = start()

    vi.advanceTimersByTime(6000)
    expect(records[0]).toEqual({ quietMs: 6000, recovered: false })

    // 每轮静默之间都收到过心跳 → 每一轮都是「渲染层活过来之后又静默」，故都带标记
    for (let round = 1; round <= 2; round += 1) {
      vi.advanceTimersByTime(2000)
      run.beat()
      vi.advanceTimersByTime(6000)
      expect(records[round]).toEqual({ quietMs: 6000, recovered: true })
    }
  })

  it('面板窗已销毁：不再落任何存证', () => {
    const { records } = start({ windowDestroyed: () => true })

    vi.advanceTimersByTime(20000)
    expect(records).toEqual([])
  })

  it('渲染进程已销毁：不再落任何存证', () => {
    const { records } = start({ rendererDestroyed: () => true })

    vi.advanceTimersByTime(20000)
    expect(records).toEqual([])
  })

  it('未武装（任务栏条带口径）：失能档裁决照判但存证不发（工单94 原样，静默没有失能语义）', () => {
    const { records, frozen, unfrozen } = start({ thresholdMs: 1000 })

    // 阈值 1s：第 1 拍落静默存证，此后每拍都判成 escalate，但未武装一律不发射。
    vi.advanceTimersByTime(30000)
    expect(records).toEqual([{ quietMs: 2000, recovered: false }])
    expect(frozen).toEqual([])
    expect(unfrozen).toEqual([])
  })

  it('dispose 之后停止采样（面板关闭即摘哨兵，不留悬挂定时器）', () => {
    const { records, run } = start()

    vi.advanceTimersByTime(6000)
    expect(records).toHaveLength(1)
    run.dispose()

    vi.advanceTimersByTime(20000)
    expect(records).toHaveLength(1)
  })
})

describe('失能档发射与闭合（#91 判据定案）', () => {
  const runs: RenderSentinelSampler[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })
  afterEach(() => {
    runs.splice(0).forEach((r) => r.dispose())
    vi.useRealTimers()
  })

  function start(options: HarnessOptions = {}) {
    const h = harness({ heartbeatArmed: true, ...options })
    runs.push(h.run)
    return h
  }

  it('静默落定后下一拍仍无心跳 → 发射 renderer-frozen，且一轮只发一条（持续静默不刷成存证瀑布）', () => {
    const { records, frozen, unfrozen } = start({ thresholdMs: 1000 })

    vi.advanceTimersByTime(2000) // 第 1 拍：静默落定
    expect(records).toEqual([{ quietMs: 2000, recovered: false }])
    expect(frozen).toEqual([])

    vi.advanceTimersByTime(2000) // 第 2 拍：仍无心跳 → 发射
    expect(frozen).toEqual([{ quietMs: 4000 }])

    vi.advanceTimersByTime(28000) // 之后 14 拍全静默：不重复发射
    expect(frozen).toEqual([{ quietMs: 4000 }])
    expect(unfrozen).toEqual([])
  })

  it('发射后心跳回归 → 闭合 renderer-unfrozen，frozenMs 是冻结全程（冻结前最后心跳到闭合心跳）', () => {
    const { records, frozen, unfrozen, run } = start({ thresholdMs: 1000 })

    vi.advanceTimersByTime(4000) // 静默落定 + 失能发射
    expect(frozen).toEqual([{ quietMs: 4000 }])

    vi.advanceTimersByTime(3000)
    run.beat() // 心跳回归：episode 闭合
    expect(unfrozen).toEqual([{ frozenMs: 7000 }])
    // 闭合即整轮复位：心跳账清零，随后静默达阈按新一轮报（带 recovered=true），再静默照常发射
    vi.advanceTimersByTime(2000)
    expect(records).toEqual([{ quietMs: 2000, recovered: false }, { quietMs: 1000, recovered: true }])
    vi.advanceTimersByTime(2000)
    expect(frozen).toEqual([{ quietMs: 4000 }, { quietMs: 3000 }]) // 第二轮照常发射
  })

  it('静默落定后、发射前心跳回归 → 不发射失能档（这一轮只是静默，不是冻结）', () => {
    const { records, frozen, unfrozen, run } = start({ thresholdMs: 1000 })

    vi.advanceTimersByTime(2000) // 静默落定
    expect(records).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    run.beat() // 发射拍之前心跳回来了：这一轮静默自愈，失能档不出场
    vi.advanceTimersByTime(1000) // 下一拍只够按新一轮再报静默（带 recovered=true），不够发射
    expect(frozen).toEqual([])
    expect(unfrozen).toEqual([])
    expect(records[1]).toEqual({ quietMs: 1000, recovered: true })
  })

  it('冻结中窗/进程销毁：不再发射也不再闭合（观测对象没了，episode 随窗终局）', () => {
    let destroyed = false
    const { records, frozen, unfrozen } = start({
      thresholdMs: 1000,
      windowDestroyed: () => destroyed,
    })

    vi.advanceTimersByTime(4000)
    expect(frozen).toEqual([{ quietMs: 4000 }])
    destroyed = true
    vi.advanceTimersByTime(20000)
    expect(frozen).toHaveLength(1)
    expect(unfrozen).toEqual([])
    expect(records).toEqual([{ quietMs: 2000, recovered: false }])
  })

  it('多轮冻结各自成 episode：每轮一条 frozen、一条 unfrozen，互不串账', () => {
    const { frozen, unfrozen, run } = start({ thresholdMs: 1000 })

    vi.advanceTimersByTime(4000) // 第一轮：静默 + 冻结
    vi.advanceTimersByTime(1000)
    run.beat() // 闭合第一轮（frozenMs=5000）
    vi.advanceTimersByTime(4000) // 第二轮：静默达阈 + 冻结发射
    expect(frozen).toEqual([{ quietMs: 4000 }, { quietMs: 3000 }])
    vi.advanceTimersByTime(2000)
    run.beat() // 闭合第二轮（frozenMs=6000）
    expect(unfrozen).toEqual([{ frozenMs: 5000 }, { frozenMs: 6000 }])
  })
})

describe('哨兵口径常量（工单94：5 秒阈值一个数不动）', () => {
  it('静默判据阈值仍是 5000ms，采样周期仍是 2000ms', () => {
    expect(RENDER_SENTINEL_QUIET_MS).toBe(5000)
    expect(RENDER_SENTINEL_POLL_MS).toBe(2000)
  })

  it('默认接线就按这两个常量采（构造时不给阈值也不改变落存证的拍点）', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const records: SilentRecord[] = []
    const run = new RenderSentinelSampler({ onQuiet: (r) => records.push(r) })
    try {
      vi.advanceTimersByTime(4000)
      expect(records).toEqual([])
      vi.advanceTimersByTime(2000)
      expect(records).toEqual([{ quietMs: 6000, recovered: false }])
    } finally {
      run.dispose()
      vi.useRealTimers()
    }
  })
})