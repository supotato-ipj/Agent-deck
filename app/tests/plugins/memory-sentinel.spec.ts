import { describe, expect, it, vi } from 'vitest'
import {
  MEMORY_SENTINEL_CONFIRM_ROUNDS,
  MEMORY_SENTINEL_INTERVAL_MS,
  PACKAGE_SENTINEL_PRIVATE_MEMORY_BUDGET_BYTES,
} from '../../src/main/plugins/budget'
import {
  PackageMemorySentinel,
  PackageMemorySentinelLedger,
  PackagePidRegistry,
  privateBytesOf,
  projectSample,
  type MemorySentinelSampleNote,
  type SentinelAction,
} from '../../src/main/plugins/memory-sentinel'

/**
 * 包内存哨兵单测（工单344，spec 测试决策：纯逻辑账本缝灌罐头读数）——
 * 只测外部行为：给罐头读数序列，断言哨兵吐出的动作（告警时机、停用时机、放行情形）
 * 与事件载荷；不测内部计数器。停用补偿（账/包文件不动、不自动重挂）见
 * service 层测试（memory-disable 补偿段）。
 * 工单452 判据口径切换：工作集 → 私有提交内存（privateBytes），阈值重标定 80MB；
 * 罐头读数样本随新阈值重写（hog 私有读数取诊断实测形态 ~90-100MB、正常包基线 ~40MB）。
 */

const MB = 1024 * 1024
const THRESHOLD = 80 * MB // 与 budget.ts PACKAGE_SENTINEL_PRIVATE_MEMORY_BUDGET_BYTES 同源（此处显式复写便于阅读）

describe('pid→包映射：宿主层对照表的纯逻辑半边（单测矩阵 2）', () => {
  it('激活登记 → 反查命中；换代换 pid → 覆盖旧值', () => {
    const reg = new PackagePidRegistry()
    reg.record('widget-a', 101)
    expect(reg.pidOf('widget-a')).toBe(101)
    expect(reg.size()).toBe(1)
    // 换代：同 id 新渲染进程新 pid，覆盖不残留
    reg.record('widget-a', 202)
    expect(reg.pidOf('widget-a')).toBe(202)
    expect(reg.size()).toBe(1)
    expect(reg.entries()).toEqual([{ packageId: 'widget-a', pid: 202 }])
  })

  it('停用摘除 → 反查落空、entries 出表；未登记 id 落空不编造', () => {
    const reg = new PackagePidRegistry()
    reg.record('widget-a', 101)
    reg.record('widget-b', 202)
    reg.remove('widget-a')
    expect(reg.pidOf('widget-a')).toBeNull()
    expect(reg.pidOf('widget-b')).toBe(202)
    expect(reg.entries()).toEqual([{ packageId: 'widget-b', pid: 202 }])
    expect(reg.pidOf('never-seen')).toBeNull()
    reg.remove('never-seen') // 幂等不抛
    expect(reg.size()).toBe(1)
  })
})

describe('采样投影（单测矩阵 1）：读数 → 每包每轮读数', () => {
  const read = (pid: number): number | null => (pid === 7 ? 90 * MB : pid === 8 ? 40 * MB : null)

  it('在场包按 pid 对照投影读数；pid 缺失 → bytes=null（放行留证）', () => {
    const out = projectSample(['a', 'b', 'c'], [{ packageId: 'a', pid: 7 }, { packageId: 'b', pid: 8 }], read)
    expect(out).toEqual([
      { packageId: 'a', bytes: 90 * MB },
      { packageId: 'b', bytes: 40 * MB },
      { packageId: 'c', bytes: null }, // 在场但对照表没登记 → 放行
    ])
  })

  it('pid 在册但读数函数拿不到私有提交内存（进程刚崩/时序缝隙）→ bytes=null 放行', () => {
    const out = projectSample(['a'], [{ packageId: 'a', pid: 9 }], read)
    expect(out).toEqual([{ packageId: 'a', bytes: null }])
  })
})

describe('privateBytesOf 映射（工单452）：getAppMetrics 条目 → 私有提交内存读数', () => {
  it('条目/字段缺席（undefined）→ null 放行留证，不误杀', () => {
    expect(privateBytesOf(undefined)).toBeNull()
    expect(privateBytesOf({})).toBeNull()
    expect(privateBytesOf({ memory: {} })).toBeNull()
    expect(privateBytesOf({ memory: { privateBytes: undefined } })).toBeNull()
  })

  it('privateBytes 在册 → KB 换算为字节（92160KB = 90MiB；0 = 合法读数）', () => {
    expect(privateBytesOf({ memory: { privateBytes: 92160 } })).toBe(90 * MB)
    expect(privateBytesOf({ memory: { privateBytes: 0 } })).toBe(0)
  })
})

describe('阈值滞回（单测矩阵 3）：首次超限=告警、连续 3 轮=停用、中断回落=重新计数', () => {
  interface Harness {
    actions: SentinelAction[]
    missing: MemorySentinelSampleNote[]
    readBy: (pid: number) => number | null
    setRead: (pid: number, bytes: number | null) => void
    sampleOnce: () => void
  }

  /** 起一台薄壳：单包、罐头读数、不开定时器（直接 sampleOnce 驱动） */
  function bootHarness(opts: { thresholdBytes?: number; rounds?: number } = {}): Harness {
    const readTable = new Map<number, number | null>()
    const actions: SentinelAction[] = []
    const missing: MemorySentinelSampleNote[] = []
    const pidReg = new PackagePidRegistry()
    pidReg.record('hog', 7)
    const sentinel = new PackageMemorySentinel(
      {
        livePackageIds: () => ['hog'],
        pidEntries: () => pidReg.entries(),
        readPrivateBytes: (pid) => readTable.get(pid) ?? null,
      },
      {
        onSampleMissing: (notes) => missing.push(...notes),
        onAlert: (a) => actions.push({ type: 'alert', ...a }),
        onDeactivate: (a) => actions.push({ type: 'deactivate', ...a }),
      },
      { thresholdBytes: opts.thresholdBytes ?? THRESHOLD, rounds: opts.rounds ?? 3, intervalMs: 10_000 },
    )
    return {
      actions,
      missing,
      readBy: (pid) => readTable.get(pid) ?? null,
      setRead: (pid, bytes) => readTable.set(pid, bytes),
      sampleOnce: () => sentinel.sampleOnce(),
    }
  }

  it('首次越线 → 告警不处置（用户自己动手的窗口）；连续 3 轮 → 停用（≈30 秒确认窗）', () => {
    const h = bootHarness()
    h.setRead(7, 90 * MB)
    h.sampleOnce()
    expect(h.actions).toEqual([{ type: 'alert', packageId: 'hog', bytes: 90 * MB, thresholdBytes: THRESHOLD }])
    h.sampleOnce()
    expect(h.actions).toHaveLength(1) // 第 2 轮：确认窗继续，无新动作（告警不重复骚扰）
    h.sampleOnce()
    expect(h.actions).toHaveLength(2)
    expect(h.actions[1]).toEqual({ type: 'deactivate', packageId: 'hog', bytes: 90 * MB, thresholdBytes: THRESHOLD, rounds: 3 })
  })

  it('中断回落 → 重新计数；再超线即新 episode（重新告警，再满 3 轮再停用）', () => {
    const h = bootHarness()
    h.setRead(7, 90 * MB)
    h.sampleOnce() // 告警
    h.setRead(7, 40 * MB)
    h.sampleOnce() // 回落：重新计数，无动作
    expect(h.actions).toHaveLength(1)
    h.setRead(7, 100 * MB)
    h.sampleOnce() // 再超线：新 episode，重新告警
    expect(h.actions).toHaveLength(2)
    expect(h.actions[1]?.type).toBe('alert')
    h.sampleOnce()
    h.sampleOnce()
    expect(h.actions).toHaveLength(3)
    expect(h.actions[2]).toMatchObject({ type: 'deactivate', rounds: 3 })
  })

  it('读数缺失（pid 缺失/进程刚崩）→ 放行留证：无动作、不影响既有计数', () => {
    const h = bootHarness()
    h.setRead(7, 90 * MB)
    h.sampleOnce() // 告警（计数 1）
    expect(h.actions).toHaveLength(1)
    h.setRead(7, null)
    h.sampleOnce() // 读数缺失：放行，计数不清零也不前进
    expect(h.actions).toHaveLength(1)
    expect(h.missing).toEqual([{ packageId: 'hog', pid: 7, bytes: null }])
    h.setRead(7, 90 * MB)
    h.sampleOnce()
    h.sampleOnce() // 计数续上：第 3 轮停用
    expect(h.actions).toHaveLength(2)
    expect(h.actions[1]).toMatchObject({ type: 'deactivate', rounds: 3 })
  })

  it('线内读数全程放行：零告警零处置（正常包瞬时尖峰不骚扰）', () => {
    const h = bootHarness()
    h.setRead(7, 79.9 * MB)
    for (let i = 0; i < 5; i++) h.sampleOnce()
    expect(h.actions).toEqual([])
    expect(h.missing).toEqual([])
  })

  it('参数即契约：缺省阈值/轮数取 budget.ts 单一正典（哨兵判据尺 80MB / 3 轮 / 10s，工单452）', () => {
    expect(PACKAGE_SENTINEL_PRIVATE_MEMORY_BUDGET_BYTES).toBe(THRESHOLD)
    expect(MEMORY_SENTINEL_CONFIRM_ROUNDS).toBe(3)
    expect(MEMORY_SENTINEL_INTERVAL_MS).toBe(10_000)
    const ledger = new PackageMemorySentinelLedger()
    expect(ledger.thresholdBytes).toBe(PACKAGE_SENTINEL_PRIVATE_MEMORY_BUDGET_BYTES)
    expect(ledger.rounds).toBe(3)
  })

  it('离场清账（工单344 评审）：中途崩溃/停用离场→forget→换代重灌读数，新 episode 首次超线仍先告警不处置', () => {
    // 模拟生产装配的 dropped-plugins/changed 纪律（index.ts）：在场集变化拍上，
    // 「上一轮在场、本轮不在场」的 id 透传 forget——streak 不许串到重新投放的新 episode
    const readTable = new Map<number, number | null>([[7, 90 * MB]])
    const pidReg = new PackagePidRegistry()
    pidReg.record('hog', 7)
    let live: string[] = ['hog']
    const actions: SentinelAction[] = []
    const sentinel = new PackageMemorySentinel(
      {
        livePackageIds: () => live,
        pidEntries: () => pidReg.entries(),
        readPrivateBytes: (pid) => readTable.get(pid) ?? null,
      },
      { onAlert: (a) => actions.push({ type: 'alert', ...a }), onDeactivate: (a) => actions.push({ type: 'deactivate', ...a }) },
      { thresholdBytes: THRESHOLD, rounds: 3, intervalMs: 10_000 },
    )
    const sample = () => sentinel.sampleOnce()
    // 旧 episode：超线 1 轮（告警）→ 崩溃离场（status≠ok，live 出表 + forget 清账）
    sample()
    expect(actions).toEqual([{ type: 'alert', packageId: 'hog', bytes: 90 * MB, thresholdBytes: THRESHOLD }])
    live = []
    for (const id of ['hog']) if (!live.includes(id)) sentinel.forget(id) // 与 index.ts 同一纪律
    // 换代重投：新 pid 新代次，重灌罐头读数
    pidReg.record('hog', 8)
    readTable.set(8, 90 * MB)
    live = ['hog']
    sample() // 新 episode 首轮超线：必须重新告警（旧 streak=1 不许串账跳过告警）
    expect(actions).toHaveLength(2)
    expect(actions[1]).toEqual({ type: 'alert', packageId: 'hog', bytes: 90 * MB, thresholdBytes: THRESHOLD })
    sample()
    expect(actions).toHaveLength(2) // 第 2 轮：确认窗继续，无动作
    sample()
    expect(actions).toHaveLength(3) // 第 3 轮：停用
    expect(actions[2]).toMatchObject({ type: 'deactivate', rounds: 3 })
  })

  it('refresh：有在场包起表、无包停表（开销有界）；dispose 收表', () => {
    vi.useFakeTimers()
    try {
      const readTable = new Map<number, number | null>([[7, 90 * MB]])
      const pidReg = new PackagePidRegistry()
      pidReg.record('hog', 7)
      let live: string[] = ['hog']
      let alerts = 0
      const sentinel = new PackageMemorySentinel(
        {
          livePackageIds: () => live,
          pidEntries: () => pidReg.entries(),
          readPrivateBytes: (pid) => readTable.get(pid) ?? null,
        },
        { onAlert: () => { alerts += 1 }, onDeactivate: () => {} },
        { intervalMs: 10 },
      )
      sentinel.refresh() // 有在场包：起表
      vi.advanceTimersByTime(10)
      expect(alerts).toBe(1)
      live = []
      sentinel.refresh() // 无在包：停表
      vi.advanceTimersByTime(100)
      expect(alerts).toBe(1) // 停表后不再采样
      live = ['hog']
      // 停表期间读数回落过线（假想用户清了内存）：重启后新 episode 才重新告警；
      // 若读数一直超线，连续计数会接着走（滞回语义不因停表清零）
      readTable.set(7, 40 * MB)
      sentinel.refresh()
      vi.advanceTimersByTime(10)
      expect(alerts).toBe(1) // 回落：无告警
      readTable.set(7, 90 * MB)
      vi.advanceTimersByTime(10)
      expect(alerts).toBe(2) // 再超线：新 episode 重新告警
      sentinel.dispose()
      vi.advanceTimersByTime(100)
      expect(alerts).toBe(2) // dispose 收表
    } finally {
      vi.useRealTimers()
    }
  })
})
