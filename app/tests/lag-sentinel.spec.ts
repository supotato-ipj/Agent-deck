/**
 * 主进程滞后哨兵核（工单117，spec #109 第四缝）。调度用假定时器、计时用注入时钟：
 * 哨兵的 lag 只能在卡顿结束后的迟到一拍被察觉，「卡顿」在单线程里无法用推进假定时器
 * 模拟（推进即让定时器按点起跑，拍距恒为 250）——故时间走 nowMs 注入缝（手动拨针），
 * 排程走 vi 假定时器，两侧独立驱动才摆得出「卡了 3s 才回到定时器」的边界格。
 * 接线层（attachLagSentinel）用缺省 Date.now 时钟，卡顿由 vi.setSystemTime 独走时钟
 * （只拨 Date 不发定时器）模拟。断言的是外部行为：给定事件与标签序列，落了哪几条
 * lag 事件、每条带哪些标签——不看内部字段。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  CallLabels,
  LagSentinel,
  LAG_SENTINEL_LAST_EVENTS,
  LAG_SENTINEL_POLL_MS,
  LAG_SENTINEL_THRESHOLD_MS,
  attachLagSentinel,
  fileSpanRecorder,
  panelLabels,
  parseLagThresholdMs,
} from '../src/main/lag-sentinel'
import type { LagEventPayload, SpanRecorder } from '../src/main/lag-sentinel'

/** 手动时钟：nowMs 注入缝的测试替身，拨针即模拟主线程卡顿期间的真实时间流逝 */
function manualClock(): { now: () => number; set: (ms: number) => void } {
  let ms = 0
  return { now: () => ms, set: (v: number) => { ms = v } }
}

/** 捕获型 EventLog（EventLog 接口本体在 panel-ipc，那里顶部 import electron——纯 Node 测试不引它，
 * 这里按结构等价自写）：收下全部 append，记录原样保留。 */
function capturingLog(): { events: Array<Record<string, unknown>>; append(event: Record<string, unknown>): void } {
  const events: Array<Record<string, unknown>> = []
  return { events, append(event) { events.push(event) } }
}

describe('滞后哨兵核（工单117）——lag 事件产出', () => {
  const sentinels: LagSentinel[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    sentinels.splice(0).forEach((s) => s.dispose())
    vi.useRealTimers()
  })

  function start(options: { thresholdMs?: number } = {}): {
    records: LagEventPayload[]
    clock: ReturnType<typeof manualClock>
    labels: CallLabels
    /** 常态一拍：手动时钟与假定时器同速前进一档（lastTick 跟随真实节拍） */
    step: (ms?: number) => void
  } {
    const records: LagEventPayload[] = []
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    const s = new LagSentinel({
      onLag: (e) => records.push(e),
      ...(options.thresholdMs === undefined ? {} : { thresholdMs: options.thresholdMs }),
      nowMs: clock.now,
      labels,
    })
    sentinels.push(s)
    const step = (ms = LAG_SENTINEL_POLL_MS) => {
      clock.set(clock.now() + ms)
      vi.advanceTimersByTime(ms)
    }
    return { records, clock, labels, step }
  }

  it('常态拍距（250ms 档）不产出事件', () => {
    const { records, step } = start()
    for (let i = 0; i < 20; i += 1) step()
    expect(records).toEqual([])
  })

  it('滞后超阈值产出一条事件，lagMs 是实测时长而非阈值本身', () => {
    const { records, clock, step } = start({ thresholdMs: 2000 })

    for (let i = 0; i < 8; i += 1) step() // 8 拍常态，上一拍落在 t=2000
    clock.set(5000) // 主线程「卡」3s：真实时间独走，定时器回调跑不了
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS) // 迟到的下一拍才察觉
    expect(records).toEqual([{ lagMs: 3000, liveLabels: [], lastEvents: [] }])
  })

  it('未达阈值（超一拍但不足阈值）不产出', () => {
    const { records, clock, step } = start({ thresholdMs: 2000 })

    for (let i = 0; i < 4; i += 1) step() // 上一拍落在 t=1000
    clock.set(2500) // 拨 1.5s：超一拍但 < 2s
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS)
    expect(records).toEqual([])
  })

  it('一段卡顿只产出一条事件（递归排程，错过的拍不合并成多条）', () => {
    const { records, clock, step } = start()

    step()
    step()
    clock.set(6000)
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS) // 迟到一拍落一条
    vi.advanceTimersByTime(10 * LAG_SENTINEL_POLL_MS) // 此后拍距恢复正常
    expect(records).toEqual([{ lagMs: 5500, liveLabels: [], lastEvents: [] }])
  })

  it('dispose 之后停止采样（摘哨兵不留悬挂定时器）', () => {
    const { records, step } = start()
    const s = sentinels[0]

    step()
    s.dispose()
    for (let i = 0; i < 10; i += 1) vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS)
    expect(records).toEqual([])
  })

  it('lastEvents 环按注深取尾（对齐电池取证 dump 的 slice(-14) 口径）', () => {
    const { records, clock, step } = start()
    const s = sentinels[0]

    for (let i = 1; i <= LAG_SENTINEL_LAST_EVENTS + 6; i += 1) s.noteEvent(`evt-${i}`)
    step()
    clock.set(6000)
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS)
    expect(records[0].lastEvents).toEqual(
      Array.from({ length: LAG_SENTINEL_LAST_EVENTS }, (_, k) => `evt-${k + 7}`),
    )
  })
})

describe('标签置/清语义（区间口径）', () => {
  const sentinels: LagSentinel[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    sentinels.splice(0).forEach((s) => s.dispose())
    vi.useRealTimers()
  })

  it('滞后窗口内有活动的标签进 liveLabels：已清场的肇事标签也在场（untilMs ≈ 察觉拍）', () => {
    const records: LagEventPayload[] = []
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    sentinels.push(new LagSentinel({ onLag: (e) => records.push(e), nowMs: clock.now, labels }))

    clock.set(clock.now() + LAG_SENTINEL_POLL_MS)
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS) // 上一拍落定：窗口自此起算
    clock.set(clock.now() + 1000)
    labels.run('pin', () => undefined) // 卡顿中途的同步调用点：置标即清标（区间 1ms 级）
    clock.set(clock.now() + 2000)
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS) // 迟到察觉：窗口罩住 pin 区间
    expect(records[0].liveLabels).toEqual(['pin'])
  })

  it('滞后窗口开启前已清场的标签不在场（区间与窗口不相交）', () => {
    const records: LagEventPayload[] = []
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    sentinels.push(new LagSentinel({ onLag: (e) => records.push(e), nowMs: clock.now, labels }))

    labels.enabled = true
    labels.run('tray-add', () => undefined) // 首拍之前的老账：区间 [0,0]
    clock.set(clock.now() + LAG_SENTINEL_POLL_MS)
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS) // 上一拍：窗口自此起算（t=250）
    clock.set(clock.now() + 3000)
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS)
    expect(records[0].liveLabels).toEqual([])
  })

  it('在录未清的标签（untilMs=null）也判在场——正是卡死在调用点内的形态', () => {
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    labels.enabled = true
    let inside: string[] = []
    labels.run('keyboard-mode-on', () => {
      // 调用点执行中：同步主线程不可能有别的观测者，只能就地看 overlapping 的在录分支
      inside = labels.overlapping(clock.now() - 1000, clock.now())
    })
    expect(inside).toEqual(['keyboard-mode-on'])
  })

  it('多标签去重且按首次置标时序排列', () => {
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    labels.enabled = true
    labels.run('pin', () => undefined)
    clock.set(500)
    labels.run('hotzone-toggle', () => undefined)
    clock.set(600)
    labels.run('pin', () => undefined) // 同标签第二次：去重，取更早的置标时序
    expect(labels.overlapping(0, 600)).toEqual(['pin', 'hotzone-toggle'])
  })

  it('哨兵构造即置记账 enabled（调用点的置/清从构造起生效）', () => {
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    expect(labels.enabled).toBe(false)
    sentinels.push(new LagSentinel({ onLag: () => undefined, nowMs: clock.now, labels }))
    expect(labels.enabled).toBe(true)
  })
})

describe('开关关闭零开销（常规模式）', () => {
  it('未启用的注册表 run 直通：返回值透传、不记账、不置 enabled', () => {
    const labels = new CallLabels()
    expect(labels.enabled).toBe(false)
    expect(labels.run('pin', () => 42)).toBe(42)
    expect(labels.overlapping(0, Number.MAX_SAFE_INTEGER)).toEqual([])
    expect(labels.enabled).toBe(false)
  })

  it('run 抛异常也照常清标（finally 语义），异常原样上抛', () => {
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    labels.enabled = true
    expect(() => labels.run('pin', () => { throw new Error('boom') })).toThrow('boom')
    expect(labels.overlapping(0, Number.MAX_SAFE_INTEGER)).toEqual(['pin'])
  })

  it('DECK_LAG_SENTINEL 未设：attachLagSentinel 原样退回同一引用，零改动可证', () => {
    const log = capturingLog()
    expect(attachLagSentinel(log, undefined)).toBe(log)
    expect(attachLagSentinel(log, '')).toBe(log)
    expect(panelLabels.enabled).toBe(false) // 单例没被点亮——调用点全链路直通
    expect(log.events).toEqual([])
  })
})

describe('span 落盘（终末冻结归因通道）', () => {
  /** 收集型落盘器：open/close 调用记成对 */
  function mockRecorder(): SpanRecorder & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      open: (label, t) => calls.push(`open:${label}@${t}`),
      close: (label, t) => calls.push(`close:${label}@${t}`),
    }
  }

  it('run 进场写 span-open、finally 写 span-close（终末冻结时 sidecar 以无 close 的 open 收尾 = 肇事者签名）', () => {
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    const rec = mockRecorder()
    labels.enabled = true
    labels.attachRecorder(rec)

    clock.set(100)
    labels.run('pin', () => undefined)
    clock.set(300)
    labels.run('keyboard-mode-on', () => undefined)

    expect(rec.calls).toEqual([
      'open:pin@100',
      'close:pin@100',
      'open:keyboard-mode-on@300',
      'close:keyboard-mode-on@300',
    ])
  })

  it('落盘器抛异常被吞掉（尽力而为），run 的返回值与清标不受影响', () => {
    const clock = manualClock()
    const labels = new CallLabels(clock.now)
    labels.enabled = true
    labels.attachRecorder({
      open: () => { throw new Error('disk gone') },
      close: () => { throw new Error('disk gone') },
    })
    expect(labels.run('pin', () => 'ok')).toBe('ok')
    expect(labels.overlapping(0, Number.MAX_SAFE_INTEGER)).toEqual(['pin'])
  })

  it('fileSpanRecorder 落 JSONL：open/close 行各带 pid 与实测时长', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-sentinel-'))
    try {
      const file = path.join(dir, 'spans.jsonl')
      const rec = fileSpanRecorder(file)
      rec.open('pin', 1000)
      rec.close('pin', 1007, 7)
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      expect(lines).toEqual([
        { type: 'span-open', pid: process.pid, label: 'pin', t: 1000 },
        { type: 'span-close', pid: process.pid, label: 'pin', t: 1007, ms: 7 },
      ])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('attachLagSentinel 带 spansFile 时挂 sidecar：调用点经单例 run 即落盘', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lag-sentinel-'))
      try {
        const log = capturingLog()
        const spansFile = path.join(dir, 'spans.jsonl')
        attachLagSentinel(log, '1', spansFile)
        panelLabels.run('pin', () => undefined)
        const lines = fs.readFileSync(spansFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
        expect(lines).toHaveLength(2)
        expect(lines[0]).toMatchObject({ type: 'span-open', pid: process.pid, label: 'pin' })
        expect(lines[1]).toMatchObject({ type: 'span-close', pid: process.pid, label: 'pin' })
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('attachLagSentinel 接线（诊断模式）', () => {
  beforeEach(() => {
    // 接线用缺省时钟 Date.now——假 Date 让它随假定时器走；卡顿由 setSystemTime
    // 独走时钟（只拨 Date 不发定时器）模拟，与核心测试的注入时钟同一语义。
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('设了开关：存证照常落原文件、事件类型喂给 lastEvents 环，lag 事件落同一文件', () => {
    const log = capturingLog()
    const wired = attachLagSentinel(log, '1')
    expect(wired).not.toBe(log)
    expect(panelLabels.enabled).toBe(true)

    wired!.append({ type: 'hotzones', rects: [] })
    wired!.append({ type: 'pin', reason: 'hotzone-leave' })
    expect(log.events.map((e) => e.type)).toEqual(['hotzones', 'pin'])

    vi.advanceTimersByTime(2 * LAG_SENTINEL_POLL_MS) // 两拍常态
    vi.setSystemTime(Date.now() + 2500) // 主线程卡 2.5s：时钟独走，回调跑不了
    vi.advanceTimersByTime(LAG_SENTINEL_POLL_MS) // 迟到的下一拍察觉
    const lags = log.events.filter((e) => e.type === 'main-lag')
    expect(lags).toHaveLength(1)
    expect(lags[0]).toMatchObject({ pid: process.pid, lastEvents: ['hotzones', 'pin'] })
    expect(lags[0].lagMs as number).toBeGreaterThan(LAG_SENTINEL_THRESHOLD_MS)
  })

  it('无事件文件（log=null）时 lag 落控制台兜底，不建 tee', () => {
    const wired = attachLagSentinel(null, '1')
    expect(wired).not.toBeNull()
  })
})

describe('阈值解析（DECK_LAG_SENTINEL 值语义）', () => {
  it('数字且 ≥ 两拍下限才当阈值，其余（含 1/on/垃圾值）一律缺省 2000', () => {
    expect(parseLagThresholdMs(undefined)).toBe(LAG_SENTINEL_THRESHOLD_MS)
    expect(parseLagThresholdMs('1')).toBe(LAG_SENTINEL_THRESHOLD_MS)
    expect(parseLagThresholdMs('on')).toBe(LAG_SENTINEL_THRESHOLD_MS)
    expect(parseLagThresholdMs('-5')).toBe(LAG_SENTINEL_THRESHOLD_MS)
    expect(parseLagThresholdMs('250')).toBe(LAG_SENTINEL_THRESHOLD_MS) // 低于两拍下限：调度抖动带
    expect(parseLagThresholdMs('800')).toBe(800)
    expect(LAG_SENTINEL_THRESHOLD_MS).toBe(2000)
    expect(LAG_SENTINEL_POLL_MS).toBe(250)
  })
})
