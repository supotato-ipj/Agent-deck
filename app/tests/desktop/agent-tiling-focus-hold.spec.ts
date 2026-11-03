/**
 * Agent 平铺：聚焦挂起与预览成员快照（工单379，spec #369 决策 15/16）：
 * 聚焦目标被平铺账挂起（不写窗、不做授权判定，最大化不被当成用户改几何），其余成员
 * 保持原位；解除挂起后恢复常规落位；previewMembers 与计数同口径（含标题）。
 * deps 全假源，零 FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { AgentTilingService } from '../../src/main/services/agent-tiling'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'
import type { TileRect } from '../../src/main/desktop/tiling-plan'

const PRIMARY = { left: 0, top: 0, right: 2560, bottom: 1440 }
const TASKBAR_TOP = 1392
const AREA: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }

interface Harness {
  svc: AgentTilingService
  windows: Map<number, { rect: TileRect; iconic: boolean }>
  writes: number[]
  prompts: number[]
  mode: { value: 'normal' | 'agent' | 'unmanaged' }
  foreground: Set<number>
  run(): Promise<void>
}

function harness(): Harness {
  const windows = new Map<number, { rect: TileRect; iconic: boolean }>()
  const writes: number[] = []
  const prompts: number[] = []
  const mode = { value: 'agent' as 'normal' | 'agent' | 'unmanaged' }
  const foreground = new Set<number>()

  const factsOf = (): TileWindowFacts[] =>
    [...windows.entries()].map(([hwnd, w]) => ({
      hwnd,
      exe: 'C:\\Windows\\System32\\notepad.exe',
      title: `预览标题 ${hwnd}`,
      visible: true,
      cloaked: false,
      cloakedShell: false,
      toolWindow: false,
      owned: false,
      appWindow: true,
      iconic: w.iconic,
      resizable: true,
      rect: { ...w.rect },
      onCurrentDesktop: true,
    }))

  const ctx = new Context()
  ctx.on('tiling/authorize-request', (p: { hwnd: number }) => prompts.push(p.hwnd))
  const svc = new AgentTilingService(ctx, {
    enabled: true,
    batchMs: 0,
    settleMs: 40,
    deps: {
      currentMode: () => mode.value,
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => ({ ...PRIMARY }),
      taskbarTop: () => TASKBAR_TOP,
      collectFacts: factsOf,
      readRect: (hwnd) => ({ ...(windows.get(hwnd)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      restoreRect: (hwnd, target) => {
        writes.push(hwnd)
        const w = windows.get(hwnd)
        if (w) w.rect = { ...target }
        return true
      },
      isForeground: (hwnd) => foreground.has(hwnd),
      startWatch: () => () => undefined,
      onDisplayChanged: () => () => undefined,
    },
  })
  svc.start()
  return {
    svc,
    windows,
    writes,
    prompts,
    mode,
    foreground,
    run: () => svc.runPass(),
  }
}

function addWindow(h: Harness, hwnd: number, rect: TileRect): void {
  h.windows.set(hwnd, { rect: { ...rect }, iconic: false })
}

describe('预览成员快照（与胶囊计数同口径）', () => {
  it('Agent 桌面返回主屏合格窗口事实（含标题/最小化）；普通桌面为空', () => {
    const h = harness()
    addWindow(h, 0x101, { left: 10, top: 10, right: 400, bottom: 300 })
    addWindow(h, 0x102, { left: -32000, top: -32000, right: -31000, bottom: -31900 })
    h.windows.get(0x102)!.iconic = true
    const members = h.svc.previewMembers()
    expect(members.map((m) => m.hwnd)).toEqual([0x101, 0x102])
    expect(members[0].title).toContain('预览标题')
    expect(members[1].iconic).toBe(true)
    h.mode.value = 'normal'
    expect(h.svc.previewMembers()).toEqual([])
  })
})

describe('聚焦挂起：目标窗不参与写窗与授权判定', () => {
  it('挂起期间目标被最大化（几何偏离平铺格）不写回、不弹授权；其余成员照常', async () => {
    const h = harness()
    addWindow(h, 0x101, { left: 0, top: 0, right: 100, bottom: 100 })
    addWindow(h, 0x102, { left: 0, top: 0, right: 100, bottom: 100 })
    h.foreground.add(0x101)
    h.svc.setHeldWindow(0x101)
    // 模拟真实最大化：目标几何变成整屏
    h.windows.get(0x101)!.rect = { left: 0, top: 0, right: 2560, bottom: 1440 }
    h.writes.length = 0
    await h.run()
    expect(h.writes).not.toContain(0x101) // 挂起窗不写
    expect(h.prompts).not.toContain(0x101) // 最大化不是「用户改几何」
    expect(h.svc.state().count).toBe(2) // 计数仍含聚焦目标
  })

  it('解除挂起后恢复常规落位（目标回到平铺格）', async () => {
    const h = harness()
    addWindow(h, 0x101, { left: 0, top: 0, right: 100, bottom: 100 })
    addWindow(h, 0x102, { left: 0, top: 0, right: 100, bottom: 100 })
    h.svc.setHeldWindow(0x101)
    h.windows.get(0x101)!.rect = { left: 0, top: 0, right: 2560, bottom: 1440 }
    await h.run()
    h.svc.setHeldWindow(null)
    h.writes.length = 0
    await h.run()
    expect(h.writes).toContain(0x101)
    expect(h.windows.get(0x101)!.rect.right - h.windows.get(0x101)!.rect.left).toBeLessThanOrEqual(2560)
  })

  it('切出 Agent 桌面清除挂起（不把挂起状态带进普通桌面）', async () => {
    const h = harness()
    addWindow(h, 0x101, { left: 0, top: 0, right: 100, bottom: 100 })
    h.svc.setHeldWindow(0x101)
    h.mode.value = 'normal'
    h.svc.syncActivation()
    h.mode.value = 'agent'
    h.svc.syncActivation()
    h.windows.get(0x101)!.rect = { left: 50, top: 50, right: 150, bottom: 150 }
    h.foreground.add(0x101)
    h.writes.length = 0
    await h.run()
    // 挂起已清：外部改窗走常规用户操作路径（复原/提示），而不是被静默跳过
    expect(h.writes.length + h.prompts.length).toBeGreaterThan(0)
  })
})
