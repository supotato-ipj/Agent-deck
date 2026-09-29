/**
 * 数据面内核装配测试（鼠标卡顿修复工单）：createDataplaneKernel 在进程内以假源
 * 装配四个采集服务——短间隔定时器真实驱动，断言快照出口形状与写路径行为。
 * 子进程入口（src/main/dataplane.ts）只是 parentPort 胶水，由验收电池覆盖。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDataplaneKernel } from '../src/main/kernel'
import type { HardwareSources } from '../src/main/services/hardware'
import type { DataplaneSnapshot } from '../src/main/dataplane-protocol'
import { QoderFx, rec } from './scanners/fixtures'

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-dp-'))
  fs.mkdirSync(path.join(d, 'user'), { recursive: true })
  fs.mkdirSync(path.join(d, 'common'), { recursive: true })
  return d
}

const fakeHardware = (): HardwareSources => ({
  cpuTimes: () => ({ idle: 1000, total: 2000 }),
  memory: () => ({ total: 16 * 2 ** 30, free: 8 * 2 ** 30 }),
  net: () => new Map(),
  gpu: () => ({ gpu_usage: 42 }),
  monotonic: () => 0,
})

function desktopOpts(dir: string) {
  let storeText: string | null = null
  return {
    roots: { user: path.join(dir, 'user'), common: path.join(dir, 'common') },
    deps: {
      extractIcon: null, // 数据面装配：无 Electron 图标面
      readShortcutTarget: () => null,
      readStoreText: () => storeText,
      writeStoreText: (_f: string, text: string) => {
        storeText = text
      },
    },
  }
}

describe('数据面内核（采集子进程的服务装配）', () => {
  it('采样轮出口给完整快照段：时钟/会话/硬件/桌面（图标面缺席不影响扫描编排；qoder 段随工单03 退役）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    const root = path.join(dir, 'qoder')
    const fx = new QoderFx(root)
    fx.now = Date.now() / 1000
    fx.addSession('s1', 5, [rec('assistant', 'text', 'D:/work/alpha')])
    fx.addTask('s1', 't1', 'completed')
    fx.addTask('s1', 't2', 'in_progress', '正在跑的活')

    const snapshots: DataplaneSnapshot[] = []
    const ctx = createDataplaneKernel({
      sessionRoots: { qoder: root },
      hardwareSources: fakeHardware(),
      usage: {
        dir: path.join(dir, 'usage'),
        deps: {
          runningPidExes: () => new Map<number, string>(),
          foregroundExe: () => null,
          readPrior: async () => new Map(),
        },
      },
      desktop: desktopOpts(dir),
      tickIntervalMs: 10,
      hardwareIntervalMs: 10,
      usageIntervalMs: 0,
      onSnapshot: (s) => snapshots.push(s),
    })
    await ctx.start()
    try {
      await new Promise((r) => setTimeout(r, 60)) // 至少一个采样轮
      expect(snapshots.length).toBeGreaterThan(0)
      const snap = snapshots[snapshots.length - 1]
      expect(snap.clock.epochMs).toBeGreaterThan(0)
      expect(snap.sessions.map((s) => s.project)).toEqual(['alpha'])
      expect('qoder' in snap).toBe(false)
      expect(snap.hardware.gauges.gpu_usage).toBe(42)
      expect(snap.desktop.items.map((i) => i.name)).toEqual(['Probe.lnk'])
      expect(snap.desktop.plan.dock.map((d) => d.name)).toEqual(['Probe.lnk'])
    } finally {
      await ctx.stop()
    }
  })

  it('桌面承载写路径在数据面内核内可用：move 落盘并随下一拍快照携带新编排', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.lnk'), 'stub')

    const snapshots: DataplaneSnapshot[] = []
    const ctx = createDataplaneKernel({
      hardwareSources: fakeHardware(),
      usage: {
        dir: path.join(dir, 'usage'),
        deps: {
          runningPidExes: () => new Map<number, string>(),
          foregroundExe: () => null,
          readPrior: async () => new Map(),
        },
      },
      desktop: desktopOpts(dir),
      tickIntervalMs: 10,
      hardwareIntervalMs: 0,
      usageIntervalMs: 0,
      onSnapshot: (s) => snapshots.push(s),
    })
    await ctx.start()
    try {
      expect(ctx.desktop.move('B.lnk', 'app', 'A.lnk')).toEqual({ ok: true })
      await new Promise((r) => setTimeout(r, 60))
      const snap = snapshots[snapshots.length - 1]
      expect(snap.desktop.plan.dock.map((d) => [d.name, d.source]))
        .toEqual([['B.lnk', 'placed'], ['A.lnk', 'recommended']])
    } finally {
      await ctx.stop()
    }
  })
})
