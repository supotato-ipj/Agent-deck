/**
 * 窗口预览服务（工单379，spec #369 决策 15/16/27）：胶囊展开的条目投影、最小化内存缓存、
 * 失败回退图标+标题、选择进入聚焦、关闭即释放、打开不等待缩略图/图标（200ms 可交互预算）、
 * 标题与图像不进低敏日志。deps 全假源，零 FFI/Electron。
 */
import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { WindowPreviewService } from '../../src/main/services/window-preview'
import type { WindowPreviewServiceOptions } from '../../src/main/services/window-preview'
import type { DesktopMode, WindowPreviewItem, WindowPreviewState } from '../../src/shared/contract'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'

function fact(hwnd: number, over: Partial<TileWindowFacts> = {}): TileWindowFacts {
  return {
    hwnd,
    exe: 'C:\\Windows\\System32\\notepad.exe',
    title: `私密标题-${hwnd}`,
    visible: true,
    cloaked: false,
    cloakedShell: false,
    toolWindow: false,
    owned: false,
    appWindow: true,
    iconic: false,
    resizable: true,
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
    onCurrentDesktop: true,
    ...over,
  }
}

interface Harness {
  svc: WindowPreviewService
  ctx: Context
  mode: { value: DesktopMode }
  members: { value: TileWindowFacts[] }
  focusArgs: number[]
  states: WindowPreviewState[]
  log: Array<Record<string, unknown>>
  iconResult: { value: string | null }
  tick(): Promise<void>
}

function harness(over: Partial<WindowPreviewServiceOptions> = {}): Harness {
  const mode = { value: 'agent' as DesktopMode }
  const members = { value: [fact(101), fact(102), fact(103, { iconic: true })] }
  const focusArgs: number[] = []
  const states: WindowPreviewState[] = []
  const log: Array<Record<string, unknown>> = []
  const iconResult = { value: 'data:image/png;base64,SUNPTg==' as string | null }

  const ctx = new Context()
  ctx.on('preview/changed', (state: WindowPreviewState) => states.push(state))

  const svc = new WindowPreviewService(ctx, {
    enabled: true,
    refreshMs: 0, // 测试手动 refresh（确定性）
    log: (e) => log.push(e),
    ...over,
    deps: {
      currentMode: () => mode.value,
      members: () => members.value,
      iconOf: async () => iconResult.value,
      enterFocus: (hwnd) => {
        focusArgs.push(hwnd)
        return { ok: true, state: { focused: hwnd } }
      },
      ...over.deps,
    },
  })
  svc.start()
  return {
    svc,
    ctx,
    mode,
    members,
    focusArgs,
    states,
    log,
    iconResult,
    tick: () => new Promise((r) => setTimeout(r, 10)),
  }
}

describe('窗口预览：打开与条目投影', () => {
  it('Agent 桌面展开：可见窗实时、最小化无缓存回退图标+标题；open 事件带条目', () => {
    const h = harness()
    const r = h.svc.open()
    expect(r.ok).toBe(true)
    expect(h.svc.state().open).toBe(true)
    expect(h.states.filter((s) => s.open)).toHaveLength(1)
    expect(h.states.at(-1)!.items.map((x) => x.mode)).toEqual(['live', 'live', 'icon'])
    expect(h.states.at(-1)!.items.map((x) => x.hwnd)).toEqual([101, 102, 103])
    expect(h.states.at(-1)!.items[0].title).toContain('私密标题')
  })

  it('非 Agent 桌面/开关关：不展开（普通档零预览）', () => {
    const h = harness()
    h.mode.value = 'normal'
    expect(h.svc.open().ok).toBe(false)
    expect(h.states).toHaveLength(0)
  })

  it('重复展开幂等（胶囊连点不叠开）', () => {
    const h = harness()
    h.svc.open()
    const r = h.svc.toggle()
    expect(r).toEqual({ ok: true, open: false })
    expect(h.states.at(-1)!.open).toBe(false)
  })
})

describe('窗口预览：内存缓存与异步填入', () => {
  it('控制器上行最近缓存帧（不阻塞打开）；最小化后刷新改用最近缓存', async () => {
    const h = harness()
    const t0 = Date.now()
    h.svc.open()
    // open 不等待取景：此刻尚无缓存；帧由预览窗控制器在实时缩略图上屏后异步上行
    expect(h.svc.diag().cached).toBe(0)
    h.svc.rememberFrames([{ hwnd: 101, dataUrl: 'data:image/png;base64,Q0FDSEU=', width: 158, height: 104 }])
    expect(h.svc.diag().cached).toBe(1)
    // 窗口 101 最小化 → 刷新：最近缓存上场（image 载荷）
    h.members.value = [fact(101, { iconic: true }), fact(102), fact(103, { iconic: true })]
    h.svc.refresh()
    const item = h.svc.state().items.find((x) => x.hwnd === 101)
    expect(item?.mode).toBe('cached')
    expect(item?.image).toContain('data:image/png')
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('缓存帧只接受当前打开条目的上行（关闭态/未在条目集里的帧丢弃）', () => {
    const h = harness()
    h.svc.rememberFrames([{ hwnd: 101, dataUrl: 'data:image/png;base64,WA==', width: 1, height: 1 }])
    expect(h.svc.diag().cached).toBe(0)
    h.svc.open()
    h.svc.rememberFrames([{ hwnd: 999, dataUrl: 'data:image/png;base64,WA==', width: 1, height: 1 }])
    h.svc.rememberFrames([{ hwnd: 102, dataUrl: 'data:image/png;base64,Q0FDSEU=', width: 1, height: 1 }])
    expect(h.svc.diag().cached).toBe(1)
  })

  it('图标异步填入（先可交互、图标随后到）', async () => {
    const h = harness()
    h.svc.open()
    expect(h.svc.state().items.every((x) => x.icon === null)).toBe(true)
    await h.tick()
    expect(h.svc.state().items.every((x) => x.icon && x.icon.includes('data:image'))).toBe(true)
  })

  it('DWM 注册失败 → 条目回退图标+标题（实时不可用不阻断预览）', async () => {
    const h = harness()
    h.svc.open()
    h.ctx.emit('window-preview/live-failed', { hwnd: 101 })
    const item = h.svc.state().items.find((x) => x.hwnd === 101)
    expect(item?.mode).toBe('icon')
    expect(item?.title).toContain('私密标题')
  })

  it('无缓存帧的最小化窗仍回退图标+标题（预览始终可用）', async () => {
    const h = harness()
    h.svc.open()
    await h.tick()
    expect(h.svc.diag().cached).toBe(0)
    h.members.value = [fact(101, { iconic: true })]
    h.svc.refresh()
    expect(h.svc.state().items[0].mode).toBe('icon')
    expect(h.svc.state().items[0].title).toContain('私密标题')
  })
})

describe('窗口预览：选择进入聚焦与关闭释放', () => {
  it('选择条目：先收预览再进入聚焦（目标真实最大化由聚焦服务承担）', () => {
    const h = harness()
    h.svc.open()
    const r = h.svc.select(102)
    expect(r.ok).toBe(true)
    expect(r.focused).toBe(102)
    expect(h.focusArgs).toEqual([102])
    expect(h.svc.state().open).toBe(false)
    expect(h.states.at(-1)!.open).toBe(false)
  })

  it('选择未知条目：不关闭、不聚焦', () => {
    const h = harness()
    h.svc.open()
    const r = h.svc.select(999)
    expect(r.ok).toBe(false)
    expect(h.svc.state().open).toBe(true)
    expect(h.focusArgs).toEqual([])
  })

  it('关闭预览即释放缓存与条目（diag 归零、关闭事件带原因）', async () => {
    const h = harness()
    h.svc.open()
    h.svc.rememberFrames([{ hwnd: 101, dataUrl: 'data:image/png;base64,Q0FDSEU=', width: 158, height: 104 }])
    await h.tick()
    expect(h.svc.diag().cached).toBeGreaterThan(0)
    h.svc.close('esc')
    expect(h.svc.state().open).toBe(false)
    expect(h.svc.state().items).toEqual([])
    expect(h.svc.diag()).toEqual({ open: false, live: 0, cached: 0 })
    expect(h.states.at(-1)!.open).toBe(false)
    expect(String((h.log.at(-1) || {}).reason)).toContain('esc')
  })

  it('切出 Agent 桌面自动收起（普通档零预览）', () => {
    const h = harness()
    h.svc.open()
    h.mode.value = 'normal'
    h.ctx.emit('workspace/changed', {
      available: true, paired: true, current: 'normal', switching: false, target: null, lastError: null,
    })
    expect(h.svc.state().open).toBe(false)
    expect(h.states.at(-1)!.open).toBe(false)
    expect(String((h.log.at(-1) || {}).reason)).toContain('desktop')
  })
})

describe('窗口预览：隐私边界', () => {
  it('存证只记数量/模式计数，不含窗口标题或图像（ADR-0002 / 决策 26）', async () => {
    const h = harness()
    h.svc.open()
    await h.tick()
    h.svc.refresh()
    h.ctx.emit('window-preview/live-failed', { hwnd: 101 })
    h.svc.select(102)
    const text = JSON.stringify(h.log)
    expect(text).not.toContain('私密标题')
    expect(text).not.toContain('data:image')
    expect(text).not.toMatch(/"title"|"image"/)
  })
})
