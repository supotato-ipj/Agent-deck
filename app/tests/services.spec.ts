/**
 * 内核数据面服务测试：硬件采样状态机（假源）、会话扫描服务（fixture 根）、
 * 快照契约含四类卡片数据（工单04 的桥接扩展）。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Context } from 'cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HardwareService, type HardwareSources } from '../src/main/services/hardware'
import { SessionsService } from '../src/main/services/sessions'
import { createKernel } from '../src/main/kernel'
import type { PanelSnapshot } from '../src/shared/contract'
import { QoderFx, rec } from './scanners/fixtures'

let tmp = ''

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-svc-'))
})

/** 离线内核夹具（工单06 起 usage/desktop 服务进内核）：假源隔离，不触本机真数据 */
function usageOpts() {
  return {
    dir: path.join(tmp, 'usage'),
    deps: {
      runningPidExes: () => new Map<number, string>(),
      foregroundExe: () => null,
      readPrior: async () => new Map(),
    },
  }
}

function desktopOpts() {
  let storeText: string | null = null
  return {
    roots: { user: path.join(tmp, 'empty-user'), common: path.join(tmp, 'empty-common') },
    deps: {
      readStoreText: () => storeText,
      writeStoreText: (_f: string, text: string) => {
        storeText = text
      },
    },
  }
}
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeHardware(): HardwareSources & { tick(cpuBusy: number, cpuIdle: number, dlBytes: number, dtMs: number): void } {
  let t = 0
  let netIn = 0
  const cpus = [{ times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }]
  const base: HardwareSources = {
    cpuTimes: () => {
      const { user, nice, sys, idle, irq } = cpus[0].times
      return { idle, total: user + nice + sys + idle + irq }
    },
    memory: () => ({ total: 16 * 2 ** 30, free: 8 * 2 ** 30 }),
    net: () => new Map([[1, { in: netIn, out: netIn / 2 }]]),
    gpu: () => ({ gpu_usage: 42, gpu_temp: 61, vram_usage: 33.3 }),
    monotonic: () => t,
  }
  return {
    ...base,
    tick(cpuBusy: number, cpuIdle: number, dlBytes: number, dtMs: number) {
      cpus[0].times.user += cpuBusy
      cpus[0].times.idle += cpuIdle
      netIn += dlBytes
      t += dtMs / 1000
    },
  }
}

describe('HardwareService 采样状态机', () => {
  it('逐拍采样：CPU 差值、网络速率、历史曲线滚动', async () => {
    const ctx = new Context()
    const sources = fakeHardware()
    const svc = new HardwareService(ctx, { sources })
    await ctx.start()
    try {
      svc.sample() // 首拍建立基准
      expect(svc.gauges().cpu).toBe(0)
      expect(svc.gauges().download_speed).toBeUndefined()

      sources.tick(1000, 1000, 2048, 1000) // 忙闲各 1s → CPU 50%；入流 2KB/s
      svc.sample()
      const g = svc.gauges()
      expect(g.cpu).toBeCloseTo(50, 5)
      expect(g.memory).toBeCloseTo(50, 5)
      expect(g.memory_gb).toBe('08.00 GB/16.00 GB')
      expect(g.download_speed).toBe(2)
      expect(g.upload_speed).toBe(1)
      expect(g.gpu_usage).toBe(42)
      expect(svc.historySnapshot().cpu).toEqual([0, 50])
      expect(svc.historySnapshot().dl).toEqual([null, 2])

      for (let i = 0; i < 5; i++) {
        sources.tick(0, 1000, 0, 1000)
        svc.sample()
      }
      expect(svc.historySnapshot().cpu).toHaveLength(7)
    } finally {
      await ctx.stop()
    }
  })

  it('任一数据源异常不影响其余采样（工单04 验收第 5 条）', async () => {
    const ctx = new Context()
    const sources = fakeHardware()
    const boom = () => {
      throw new Error('source down')
    }
    const broken: HardwareSources = {
      cpuTimes: sources.cpuTimes,
      memory: sources.memory,
      net: boom,
      gpu: boom,
      monotonic: sources.monotonic,
    }
    const svc = new HardwareService(ctx, { sources: broken })
    await ctx.start()
    try {
      svc.sample()
      sources.tick(1000, 1000, 0, 1000)
      svc.sample()
      const g = svc.gauges()
      expect(g.cpu).toBeCloseTo(50, 5)
      expect(g.memory_gb).toBe('08.00 GB/16.00 GB')
      expect(g.download_speed).toBeUndefined()
      expect(g.gpu_usage).toBeUndefined()
      expect(svc.historySnapshot().gpu).toEqual([null, null])
      expect(svc.historySnapshot().dl).toEqual([null, null])
    } finally {
      await ctx.stop()
    }
  })
})

describe('SessionsService', () => {
  it('refresh 采集会话行（QD 行与行内任务进度保留，工单03）；缺根静默为空', async () => {
    const ctx = new Context()
    const root = path.join(tmp, `q-${Date.now()}`)
    const fx = new QoderFx(root)
    fx.now = Date.now() / 1000
    fx.addSession('s1', 5, [rec('assistant', 'text', 'D:/work/alpha')])
    fx.addTask('s1', 't1', 'completed')
    fx.addTask('s1', 't2', 'in_progress', '正在跑的活')
    const svc = new SessionsService(ctx, { roots: { qoder: root } })
    await ctx.start()
    try {
      svc.refresh(fx.now)
      expect(svc.current()).toHaveLength(1)
      expect(svc.current()[0].project).toBe('alpha')
      // 状态卡虽退役，会话行的行内任务进度仍是五工具通用能力（会话卡 QD 行渲染依据）
      expect(svc.current()[0]).toMatchObject({ tool: 'qoder', tasks_done: 1, tasks_total: 2 })
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核快照契约（工单04 扩展）', () => {
  it('panel/snapshot 含会话/硬件与历史曲线/天气坐标；qoder 段随工单03 退役不在场', async () => {
    const ctx = createKernel({
      tickIntervalMs: 0,
      hardwareIntervalMs: 0,
      usageIntervalMs: 0,
      sessionRoots: { qoder: path.join(tmp, 'definitely-missing') },
      weather: { latitude: 1.5, longitude: 2.5 },
      desktop: desktopOpts(),
      usage: usageOpts(),
    })
    await ctx.start()
    try {
      fs.mkdirSync(path.join(tmp, 'empty-user'), { recursive: true })
      fs.mkdirSync(path.join(tmp, 'empty-common'), { recursive: true })
      ctx.desktop.refresh()
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.clock.epochMs).toBeGreaterThan(0)
      expect(snap.sessions).toEqual([])
      expect('qoder' in snap).toBe(false)
      expect(snap.hardware.gauges.cpu).toBe(0)
      expect(snap.hardware.history.cpu).toEqual([])
      expect(snap.weather).toEqual({ latitude: 1.5, longitude: 2.5 })
      expect(snap.desktop.items).toEqual([])
    } finally {
      await ctx.stop()
    }
  })

  it('panel/changed 推送带新采的会话与硬件数据', async () => {
    const root = path.join(tmp, `q2-${Date.now()}`)
    const fx = new QoderFx(root)
    fx.now = Date.now() / 1000
    fx.addSession('live', 5, [rec('assistant', 'text', 'D:/work/beta')])
    const ctx = createKernel({
      tickIntervalMs: 0,
      hardwareIntervalMs: 0,
      usageIntervalMs: 0,
      sessionRoots: { qoder: root },
      hardwareSources: fakeHardware(),
      desktop: desktopOpts(),
      usage: usageOpts(),
    })
    await ctx.start()
    try {
      ctx.hardware.sample() // 建立 CPU/网络基准
      const received: PanelSnapshot[] = []
      const off = ctx.bridge.subscribe('panel/changed', (s) => received.push(s))
      ctx.bridge.tick()
      ctx.bridge.tick()
      off()
      expect(received).toHaveLength(2)
      expect(received[0].sessions.map((s) => s.id)).toEqual(['live'])
      expect(received[1].hardware.history.cpu.length).toBeGreaterThan(0)
      expect(received[1].clock.epochMs).toBeGreaterThanOrEqual(received[0].clock.epochMs)
    } finally {
      await ctx.stop()
    }
  })
})
