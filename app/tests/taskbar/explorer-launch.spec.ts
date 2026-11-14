// explorer launch 通道选择（工单482，desktop-routing.spec 同形态 harness）：服务层在
// launch 路径上按路由裁决选通道——explorer.exe 走 spawn 专用通道（无窗新开「此电脑」），
// launchExe（shell.openPath 真源缝）不再被触达；有窗置前路径不受影响；普通应用通道不变。
// fake 源手动驱动，无 Electron/FFI——spawn 真源薄壳由真机验收覆盖（#478 探针已实锤开窗）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { TaskbarService, type TaskbarServiceOptions } from '../../src/main/services/taskbar'
import type { TaskbarWindowInfo } from '../../src/main/taskbar/windows'

const EXPLORER = 'C:\\Windows\\explorer.exe'
const APP = 'C:\\apps\\App.exe'

const win = (exe: string, hwnd: number, over: Partial<TaskbarWindowInfo> = {}): TaskbarWindowInfo => ({
  exe, title: `窗${hwnd}`, hwnd, pid: hwnd, visible: true, ...over,
})

class FakePanelData extends Service {
  constructor(ctx: Context) { super(ctx, 'panelData') }
  desktop() { return { items: [] } }
}

interface Harness {
  svc: TaskbarService
  launches: string[]
  spawns: number[]
  activations: number[]
  cleanup: () => void
}

async function makeHarness(opts: { windows: TaskbarWindowInfo[]; pinned: string }): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t482-'))
  const ctx = new Context()
  ctx.plugin(FakePanelData)
  const windows = opts.windows
  const launches: string[] = []
  const spawns: number[] = []
  const activations: number[] = []
  const store = {
    version: 1,
    pinned: [{ exe: opts.pinned, label: path.basename(opts.pinned, '.exe'), iconKey: null }],
    recommended: [],
    excluded: [],
  }
  const options: TaskbarServiceOptions = {
    enabled: true,
    storeFile: path.join(dir, 'taskbar-layout.json'),
    legacyLayoutFile: path.join(dir, 'layout.json'),
    deps: {
      listWindows: () => windows,
      readStoreText: () => JSON.stringify(store),
      writeStoreText: () => {},
      recommendations: () => [],
      desktopItems: () => [],
      launchExe: async (exe) => { launches.push(exe); return '' },
      spawnExplorerWindow: () => { spawns.push(1) },
      activateWindow: (hwnd) => { activations.push(hwnd); return true },
      minimizeWindow: () => true,
    },
  }
  ctx.plugin(TaskbarService, options)
  await ctx.start()
  const svc = (ctx as unknown as { taskbar: TaskbarService }).taskbar
  return { svc, launches, spawns, activations, cleanup: () => { void ctx.stop(); fs.rmSync(dir, { recursive: true, force: true }) } }
}

describe('explorer launch 通道选择（工单482）', () => {
  it('appClick：explorer 无合格窗（未运行）→ spawn 专用通道，不触 shell.openPath 缝', async () => {
    const h = await makeHarness({ windows: [], pinned: EXPLORER })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(EXPLORER)
      expect(r).toMatchObject({ ok: true, action: 'launched' })
      expect(h.spawns).toEqual([1])
      expect(h.launches).toEqual([])
    } finally { h.cleanup() }
  })

  it('appClick：explorer 有单窗（未前台）→ 置前路径不受特判影响', async () => {
    const h = await makeHarness({ windows: [win(EXPLORER, 11, { title: '此电脑' })], pinned: EXPLORER })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(EXPLORER)
      expect(r).toMatchObject({ ok: true, action: 'activated' })
      expect(h.activations).toEqual([11])
      expect(h.spawns).toEqual([])
      expect(h.launches).toEqual([])
    } finally { h.cleanup() }
  })

  it('appClick：普通应用未运行仍走 launchExe（shell.openPath 缝）不变', async () => {
    const h = await makeHarness({ windows: [], pinned: APP })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(APP)
      expect(r).toMatchObject({ ok: true, action: 'launched' })
      expect(h.launches).toEqual([APP])
      expect(h.spawns).toEqual([])
    } finally { h.cleanup() }
  })

  it('中键新实例（appNewInstance）：explorer 同走 spawn 通道', async () => {
    const h = await makeHarness({ windows: [win(EXPLORER, 11)], pinned: EXPLORER })
    try {
      h.svc.refresh()
      const r = await h.svc.appNewInstance(EXPLORER)
      expect(r).toEqual({ ok: true })
      expect(h.spawns).toEqual([1])
      expect(h.launches).toEqual([])
    } finally { h.cleanup() }
  })

  it('activate-app 动作（activateApp）：explorer 未运行走 spawn 通道', async () => {
    const h = await makeHarness({ windows: [], pinned: EXPLORER })
    try {
      h.svc.refresh()
      const r = await h.svc.activateApp(EXPLORER)
      expect(r).toMatchObject({ ok: true, action: 'launched' })
      expect(h.spawns).toEqual([1])
      expect(h.launches).toEqual([])
    } finally { h.cleanup() }
  })
})
