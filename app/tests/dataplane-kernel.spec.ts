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
      expect(snap.desktop.plan.docs).toEqual([]) // 工单59：应用条目不再由桌面承载编排
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
      expect(ctx.desktop.move('B.lnk', 'doc', null)).toEqual({ ok: true })
      await new Promise((r) => setTimeout(r, 60))
      const snap = snapshots[snapshots.length - 1]
      expect(snap.desktop.items.find((i) => i.name === 'B.lnk')?.zone).toBe('doc')
      expect(snap.desktop.plan.docs.map((d) => d.name)).toEqual(['B.lnk'])
    } finally {
      await ctx.stop()
    }
  })

  it('删除写路径在数据面内核内可用（工单27）：trash 清摆位并随下一拍快照收敛，同名复活不归位', async () => {
    const dir = tmpDir()
    const bPath = path.join(dir, 'user', 'B.lnk')
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(bPath, 'stub')

    const snapshots: DataplaneSnapshot[] = []
    const opts = desktopOpts(dir)
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
      desktop: {
        ...opts,
        deps: {
          ...opts.deps,
          // 回收站假源：真删盘面文件（模拟 shell.trashItem 的盘面效果；生产侧该源经主进程代理）
          trash: async (p: string) => {
            fs.unlinkSync(p)
            return ''
          },
        },
      },
      tickIntervalMs: 10,
      hardwareIntervalMs: 0,
      usageIntervalMs: 0,
      onSnapshot: (s) => snapshots.push(s),
    })
    await ctx.start()
    try {
      expect(ctx.desktop.move('B.lnk', 'doc', null)).toEqual({ ok: true })
      await new Promise((r) => setTimeout(r, 60))
      expect(snapshots[snapshots.length - 1].desktop.plan.docs.map((d) => d.name)).toEqual(['B.lnk'])
      const r = await ctx.desktop.trash([bPath])
      expect(r).toEqual({ ok: true, trashed: ['B.lnk'], failed: [] })
      await new Promise((r) => setTimeout(r, 60))
      expect(snapshots[snapshots.length - 1].desktop.items.map((i) => i.name)).toEqual(['A.lnk'])
      // 同名复活不归位（摆位清除的防复活语义）：重建同名文件，回扫描器默认分区而非摆位分区
      fs.writeFileSync(bPath, 'stub')
      await new Promise((r) => setTimeout(r, 60))
      expect(snapshots[snapshots.length - 1].desktop.items.find((i) => i.name === 'B.lnk')?.zone).toBe('app')
      expect(snapshots[snapshots.length - 1].desktop.plan.docs.map((d) => d.name)).toEqual([])
    } finally {
      await ctx.stop()
    }
  })

  it('重命名写路径在数据面内核内可用（工单28）：rename 真落盘、摆位同拍迁移并随下一拍快照收敛（位置不丢）', async () => {
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
      desktop: desktopOpts(dir), // rename/entryExists 走默认真源（fs.promises.rename / statSync）
      tickIntervalMs: 10,
      hardwareIntervalMs: 0,
      usageIntervalMs: 0,
      onSnapshot: (s) => snapshots.push(s),
    })
    await ctx.start()
    try {
      expect(ctx.desktop.move('B.lnk', 'doc', null)).toEqual({ ok: true })
      await new Promise((r) => setTimeout(r, 60))
      expect(snapshots[snapshots.length - 1].desktop.plan.docs.map((d) => d.name)).toEqual(['B.lnk'])
      // 显示名输入（不带 .lnk）→ 内核补回原扩展；盘面真改名
      expect(await ctx.desktop.rename('B.lnk', 'Renamed')).toEqual({ ok: true, to: 'Renamed.lnk' })
      expect(fs.existsSync(path.join(dir, 'user', 'B.lnk'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'user', 'Renamed.lnk'))).toBe(true)
      await new Promise((r) => setTimeout(r, 60))
      // 摆位同拍迁移：文档区摆位身份随新名延续（面板发起的改名不丢位置）
      expect(snapshots[snapshots.length - 1].desktop.plan.docs.map((d) => d.name)).toEqual(['Renamed.lnk'])
    } finally {
      await ctx.stop()
    }
  })

  it('粘贴写路径在数据面内核内可用（工单30）：剪贴板假源注入（生产经主进程 clipboard-read 代理），copy 落盘并随下一拍快照收敛', async () => {
    const dir = tmpDir()
    const staging = path.join(dir, 'staging')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(staging, 'P.txt'), 'paste-me')

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
      desktop: {
        ...desktopOpts(dir),
        deps: {
          ...desktopOpts(dir).deps,
          // 剪贴板假源（生产侧该源经 clipboard-read-req/res 反向代理伸回主进程）
          readClipboardFiles: async () => ({ paths: [path.join(staging, 'P.txt')], effect: 'copy' as const }),
        },
      },
      tickIntervalMs: 10,
      hardwareIntervalMs: 0,
      usageIntervalMs: 0,
      onSnapshot: (s) => snapshots.push(s),
    })
    await ctx.start()
    try {
      expect(await ctx.desktop.clipboardState()).toEqual({ pasteable: true })
      expect(await ctx.desktop.paste()).toEqual({ ok: true, pasted: ['P.txt'], failed: [] })
      expect(fs.existsSync(path.join(dir, 'user', 'P.txt'))).toBe(true)
      await new Promise((r) => setTimeout(r, 60))
      expect(snapshots[snapshots.length - 1].desktop.items.map((i) => i.name)).toEqual(['P.txt'])
    } finally {
      await ctx.stop()
    }
  })
})
