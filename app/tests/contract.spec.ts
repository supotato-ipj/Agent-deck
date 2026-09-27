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
  return { roots: { user: path.join(dir, 'user'), common: path.join(dir, 'common') }, ...over }
}
describe('内核桥接契约', () => {
  it('panel/snapshot 返回时钟快照', async () => {
    const ctx = createKernel({ tickIntervalMs: 0, hardwareIntervalMs: 0, desktop: desktopOpts(tmpDir()) })
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
    const ctx = createKernel({ tickIntervalMs: 0, hardwareIntervalMs: 0, desktop: desktopOpts(tmpDir()) })
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
    const ctx = createKernel({ tickIntervalMs: 0, hardwareIntervalMs: 0, desktop: desktopOpts(tmpDir()) })
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
    const ctx = createKernel({
      tickIntervalMs: 0,
      hardwareIntervalMs: 0,
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async (p: string) => `icon:${path.basename(p)}`,
          open: async () => '',
        },
      }),
    })
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

  it('desktop/launch：池内路径启动成功，池外路径拒绝（不执行任意路径）', async () => {
    const dir = tmpDir()
    fs.writeFileSync(path.join(dir, 'user', 'Probe.lnk'), 'stub')
    const opened: string[] = []
    const ctx = createKernel({
      tickIntervalMs: 0,
      hardwareIntervalMs: 0,
      desktop: desktopOpts(dir, {
        deps: {
          extractIcon: async () => null,
          open: async (p: string) => {
            opened.push(p)
            return ''
          },
        },
      }),
    })
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
})
