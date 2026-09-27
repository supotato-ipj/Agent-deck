import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createKernel } from '../src/main/kernel'
import type { PanelSnapshot } from '../src/shared/contract'

/** 内核契约缝（spec：在 Node 中直接驱动 cordis 内核，断言桥接 API 的请求/响应与变更推送）。 */

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-ct-'))
  fs.mkdirSync(path.join(d, 'user'), { recursive: true })
  fs.mkdirSync(path.join(d, 'common'), { recursive: true })
  return d
}

function desktopOpts(dir: string, over: Record<string, unknown> = {}) {
  // 摆位存储一律内存假源：内核级测试绝不触 LOCALAPPDATA 真文件
  let storeText: string | null = null
  const base = {
    roots: { user: path.join(dir, 'user'), common: path.join(dir, 'common') },
    deps: {
      readStoreText: () => storeText,
      writeStoreText: (_f: string, text: string) => {
        storeText = text
      },
    },
  }
  return { ...base, ...over, deps: { ...base.deps, ...((over.deps as object) ?? {}) } }
}

/** 离线 usage：假源 + 空目录（不触 native 真源与本机 LOCALAPPDATA） */
function usageOpts(dir: string) {
  return {
    dir: path.join(dir, 'usage'),
    deps: {
      runningPidExes: () => new Map<number, string>(),
      foregroundExe: () => null,
      readPrior: async () => new Map(),
    },
  }
}

/** 全离线内核选项基座：usage 一并假源化 */
function kernelOpts(dir: string, over: Record<string, unknown> = {}) {
  return { tickIntervalMs: 0, hardwareIntervalMs: 0, usageIntervalMs: 0, desktop: desktopOpts(dir), usage: usageOpts(dir), ...over }
}
describe('内核桥接契约', () => {
  it('panel/snapshot 返回时钟快照', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.clock.epochMs).toBeGreaterThan(0)
      expect(Number.isNaN(Date.parse(snap.clock.iso))).toBe(false)
      expect(Math.abs(snap.clock.epochMs - Date.now())).toBeLessThan(5000)
    } finally {
      await ctx.stop()
    }
  })

  it('panel/changed 订阅推送快照，退订后停止', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      const received: PanelSnapshot[] = []
      const off = ctx.bridge.subscribe('panel/changed', (s) => received.push(s))
      ctx.bridge.tick()
      ctx.bridge.tick()
      expect(received).toHaveLength(2)
      expect(received[1].clock.epochMs).toBeGreaterThanOrEqual(received[0].clock.epochMs)
      off()
      ctx.bridge.tick()
      expect(received).toHaveLength(2)
    } finally {
      await ctx.stop()
    }
  })

  it('未知方法拒绝', async () => {
    const ctx = createKernel(kernelOpts(tmpDir()))
    await ctx.start()
    try {
      await expect(ctx.bridge.invoke('nope' as never, null as never)).rejects.toThrow(/未知桥接方法/)
    } finally {
      await ctx.stop()
    }
  })
})

describe('内核桥接契约（工单05 桌面承载扩展）', () => {
  it('panel/snapshot 含桌面项池（fingerprint + items）；desktop/icon 可取图标', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'note.txt'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async (p: string) => `icon:${path.basename(p)}`,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.items.map((i) => [i.name, i.zone])).toEqual([['Probe.lnk', 'app'], ['note.txt', 'doc']])
      expect(snap.desktop.fingerprint).toBeTruthy()
      const key = snap.desktop.items[0].iconKey
      await expect(ctx.bridge.invoke('desktop/icon', { key })).resolves.toEqual({ dataUrl: `icon:Probe.lnk` })
    } finally {
      await ctx.stop()
    }
  })

  it('panel/snapshot 含编排计划与桌面几何（工单06）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'a.docx'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => d.name)).toEqual(['Probe.lnk'])
      expect(snap.desktop.plan.docs.map((d) => [d.name, d.group])).toEqual([['a.docx', 'office']])
      expect(snap.layout.docMaxRows).toBeGreaterThan(0)
      expect(snap.layout.docZone).toMatchObject({ left: expect.any(Number), top: expect.any(Number), maxWidth: expect.any(Number) })
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/launch：池内路径启动成功，池外路径拒绝（不执行任意路径）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    const opened: string[] = []
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async (p: string) => {
            opened.push(p)
            return ''
          },
        },
      }),
    }))
    await ctx.start()
    try {
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      const target = snap.desktop.items[0].path
      await expect(ctx.bridge.invoke('desktop/launch', { path: target })).resolves.toEqual({ ok: true })
      expect(opened).toEqual([target])
      const outside = await ctx.bridge.invoke('desktop/launch', { path: 'C:\\Windows\\System32\\cmd.exe' })
      expect(outside.ok).toBe(false)
      expect(opened).toHaveLength(1)
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/move：摆位经桥接落位、跨区换区；非法参照拒绝', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'n.docx'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      const moved = await ctx.bridge.invoke('desktop/move', { name: 'B.lnk', zone: 'app', beforeName: 'A.lnk' })
      expect(moved).toEqual({ ok: true })
      let snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => d.name)).toEqual(['B.lnk', 'A.lnk'])
      // 跨区：文档入 dock
      const cross = await ctx.bridge.invoke('desktop/move', { name: 'n.docx', zone: 'app', beforeName: null })
      expect(cross).toEqual({ ok: true })
      snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.items.find((i) => i.name === 'n.docx')?.zone).toBe('app')
      expect(snap.desktop.plan.docs).toEqual([])
      // 非法参照（在另一分区）
      const bad = await ctx.bridge.invoke('desktop/move', { name: 'B.lnk', zone: 'doc', beforeName: 'A.lnk' })
      expect(bad.ok).toBe(false)
      expect(bad.error).toBeTruthy()
    } finally {
      await ctx.stop()
    }
  })

  it('desktop/reset-layout：清摆位回出厂编排', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'A.lnk'), 'stub')
    fs.writeFileSync(path.join(dir, 'user', 'B.lnk'), 'stub')
    const ctx = createKernel(kernelOpts(dir, {
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async () => '',
        },
      }),
    }))
    await ctx.start()
    try {
      await ctx.bridge.invoke('desktop/move', { name: 'B.lnk', zone: 'app', beforeName: 'A.lnk' })
      const r = await ctx.bridge.invoke('desktop/reset-layout', null)
      expect(r).toEqual({ ok: true, cleared: 1 })
      const snap = await ctx.bridge.invoke('panel/snapshot', null)
      expect(snap.desktop.plan.dock.map((d) => [d.name, d.source])).toEqual([['A.lnk', 'recommended'], ['B.lnk', 'recommended']])
    } finally {
      await ctx.stop()
    }
  })
})
