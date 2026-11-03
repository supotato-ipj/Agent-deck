// 任务栏按桌面路由（工单380，spec #369 决策 6/19）：运行图标按当前桌面过滤（手钉/推荐
// 共享），应用点击当前桌面窗口优先；仅另一配对桌面有窗则切过去激活；多窗复用选窗菜单；
// 未运行才启动；非托管第三桌面的窗口不切桌面。纯逻辑矩阵在 apps-plan.spec.ts（分区判据），
// 这里锁服务层的接线（fake 窗口/桌面事实源手动驱动，无 Electron/FFI）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context, Service } from 'cordis'
import { TaskbarService, type TaskbarServiceOptions } from '../../src/main/services/taskbar'
import type { TaskbarWindowInfo } from '../../src/main/taskbar/windows'

const APP = 'C:\\apps\\App.exe'
const PRESENT = 'C:\\apps\\Present.exe'
const NORMAL_ID = 'normal-desktop-id'
const AGENT_ID = 'agent-desktop-id'
const THIRD_ID = 'third-desktop-id'

const win = (exe: string, hwnd: number, over: Partial<TaskbarWindowInfo> = {}): TaskbarWindowInfo => ({
  exe, title: `窗${hwnd}`, hwnd, pid: hwnd, visible: true, ...over,
})

class FakePanelData extends Service {
  constructor(ctx: Context) { super(ctx, 'panelData') }
  desktop() { return { items: [] } }
}

interface Harness {
  svc: TaskbarService
  windows: TaskbarWindowInfo[]
  onCurrent: Map<number, boolean>
  desktopOf: Map<number, string>
  switches: string[]
  activations: number[]
  launches: string[]
  cleanup: () => void
}

async function makeHarness(opts: {
  windows: TaskbarWindowInfo[]
  pinned?: string
  onCurrent?: Map<number, boolean>
  desktopOf?: Map<number, string>
}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t380-'))
  const ctx = new Context()
  ctx.plugin(FakePanelData)
  const windows = opts.windows
  const onCurrent = opts.onCurrent ?? new Map()
  const desktopOf = opts.desktopOf ?? new Map()
  const switches: string[] = []
  const activations: number[] = []
  const launches: string[] = []
  const store = {
    version: 1,
    pinned: opts.pinned
      ? [{ exe: opts.pinned, label: path.basename(opts.pinned, '.exe'), iconKey: null }]
      : [],
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
      focusExeWindow: () => true,
      isWindowOnCurrent: (hwnd) => onCurrent.get(hwnd) ?? null,
      windowDesktopId: (hwnd) => desktopOf.get(hwnd) ?? null,
      pairedDesktops: () => ({ normalId: NORMAL_ID, agentId: AGENT_ID }),
      switchToDesktop: async (mode) => {
        switches.push(mode)
        // 切换成功：目标桌面及其窗口成为当前桌面（服务随后的 refresh 看到系统事实）
        const target = mode === 'agent' ? AGENT_ID : NORMAL_ID
        for (const [hwnd, id] of desktopOf) onCurrent.set(hwnd, id === target)
        return { ok: true }
      },
      activateWindow: (hwnd) => { activations.push(hwnd); return true },
      minimizeWindow: () => true,
    },
  }
  ctx.plugin(TaskbarService, options)
  await ctx.start()
  const svc = (ctx as unknown as { taskbar: TaskbarService }).taskbar
  return {
    svc, windows, onCurrent, desktopOf, switches, activations, launches,
    cleanup: () => { void ctx.stop(); fs.rmSync(dir, { recursive: true, force: true }) },
  }
}

const exes = (svc: TaskbarService) => svc.state().apps.map((e) => e.exe)

describe('任务栏运行图标按当前桌面过滤（工单380）', () => {
  it('当前桌面窗口上栏；另一桌面的仅运行应用不上栏；手钉共享（在位但 running=false）', async () => {
    const h = await makeHarness({
      windows: [
        win(APP, 1, { cloaked: false }),
        win(PRESENT, 2, { cloaked: true, cloakedShell: true }),
      ],
      pinned: PRESENT,
      onCurrent: new Map([[1, true], [2, false]]),
      desktopOf: new Map([[1, NORMAL_ID], [2, AGENT_ID]]),
    })
    try {
      h.svc.refresh()
      const apps = h.svc.state().apps
      expect(apps.map((e) => e.exe)).toEqual([PRESENT, APP]) // 手钉在前；仅运行的 PRESENT 不在运行段
      const pinned = apps.find((e) => e.exe === PRESENT)!
      expect(pinned.pinned).toBe(true)
      expect(pinned.running).toBe(false) // 窗口在另一桌面：手钉仍在，运行态按当前桌面
      expect(apps.find((e) => e.exe === APP)?.running).toBe(true)
    } finally { h.cleanup() }
  })

  it('IsOnCurrent 不可判（null）不误删：沿用既有合格过滤口径', async () => {
    const h = await makeHarness({
      windows: [win(APP, 1)],
      onCurrent: new Map(), // 全部 null
    })
    try {
      h.svc.refresh()
      expect(exes(h.svc)).toEqual([APP])
    } finally { h.cleanup() }
  })
})

describe('跨桌面应用点击（工单380）：当前桌面优先 / 仅另一桌面有窗则切过去激活', () => {
  it('当前桌面有窗：直接置前，不切桌面', async () => {
    const h = await makeHarness({
      windows: [win(APP, 1, { title: '当前' }), win(APP, 2, { title: '别桌', cloaked: true, cloakedShell: true })],
      onCurrent: new Map([[1, true], [2, false]]),
      desktopOf: new Map([[1, NORMAL_ID], [2, AGENT_ID]]),
    })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(APP)
      expect(r).toMatchObject({ ok: true, action: 'activated' })
      expect(h.activations).toEqual([1])
      expect(h.switches).toEqual([])
      expect(h.launches).toEqual([])
    } finally { h.cleanup() }
  })

  it('仅另一配对桌面有单窗：切到该桌面并激活原窗口（不重复启动）', async () => {
    const h = await makeHarness({
      windows: [win(PRESENT, 2, { cloaked: true, cloakedShell: true })],
      pinned: PRESENT,
      onCurrent: new Map([[2, false]]),
      desktopOf: new Map([[2, AGENT_ID]]),
    })
    try {
      h.svc.refresh()
      expect(h.svc.state().apps.find((e) => e.exe === PRESENT)?.running).toBe(false)
      const r = await h.svc.appClick(PRESENT)
      expect(r).toMatchObject({ ok: true, action: 'activated' })
      expect(h.switches).toEqual(['agent'])
      expect(h.activations).toEqual([2])
      expect(h.launches).toEqual([])
    } finally { h.cleanup() }
  })

  it('仅另一配对桌面有多窗：切过去后复用选窗菜单（行集为那些窗口）', async () => {
    const h = await makeHarness({
      windows: [
        win(PRESENT, 2, { title: '甲', cloaked: true, cloakedShell: true }),
        win(PRESENT, 3, { title: '乙', cloaked: true, cloakedShell: true }),
      ],
      pinned: PRESENT,
      onCurrent: new Map([[2, false], [3, false]]),
      desktopOf: new Map([[2, AGENT_ID], [3, AGENT_ID]]),
    })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(PRESENT)
      expect(r).toMatchObject({ ok: true, action: 'window-list' })
      expect(r.windows).toEqual([{ hwnd: 2, title: '甲' }, { hwnd: 3, title: '乙' }])
      expect(h.switches).toEqual(['agent'])
      expect(h.launches).toEqual([])
      // 切过去后窗口成为当前桌面：选窗行可经既有精确到达通道激活
      expect(h.svc.activateWindowByHwnd(3)).toEqual({ ok: true })
      expect(h.activations).toEqual([3])
    } finally { h.cleanup() }
  })

  it('仅非托管第三桌面有窗：不切桌面（其他桌面不受托管），按未运行启动', async () => {
    const h = await makeHarness({
      windows: [win(PRESENT, 4, { cloaked: true, cloakedShell: true })],
      pinned: PRESENT,
      onCurrent: new Map([[4, false]]),
      desktopOf: new Map([[4, THIRD_ID]]),
    })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(PRESENT)
      expect(r).toMatchObject({ ok: true, action: 'launched' })
      expect(h.switches).toEqual([])
      expect(h.launches).toEqual([PRESENT])
    } finally { h.cleanup() }
  })

  it('完全未运行：启动（不切桌面）', async () => {
    const h = await makeHarness({ windows: [], pinned: PRESENT })
    try {
      h.svc.refresh()
      const r = await h.svc.appClick(PRESENT)
      expect(r).toMatchObject({ ok: true, action: 'launched' })
      expect(h.launches).toEqual([PRESENT])
      expect(h.switches).toEqual([])
    } finally { h.cleanup() }
  })
})
