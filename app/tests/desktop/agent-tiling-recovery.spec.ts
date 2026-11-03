// Agent 平铺重启恢复编排测试（工单383，spec #369 决策 13/16）：干净重启恢复顺序/树/
// 浮动几何且授权关闭、崩溃不强制搬窗、桌面 ID/窗口身份/模型不一致安全态、主屏暂不可用
// 暂停并保留模型、持久化隐私断言。deps 全假源 + 真实临时文件（IO 面用生产原子写），
// 零 FFI/Electron。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Context } from 'cordis'
import { AgentTilingService } from '../../src/main/services/agent-tiling'
import type { AgentTilingServiceOptions } from '../../src/main/services/agent-tiling'
import type { AgentLayoutDoc, WindowIdentity } from '../../src/main/desktop/agent-layout'
import { AGENT_LAYOUT_VERSION, identityOf, serializeLayout } from '../../src/main/desktop/agent-layout'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'
import type { TileRect } from '../../src/main/desktop/tiling-plan'
import type { AgentTilingState } from '../../src/shared/contract'

const PRIMARY = { left: 0, top: 0, right: 2560, bottom: 1440 }
const TASKBAR_TOP = 1392
const AREA: TileRect = { left: 0, top: 0, right: 2560, bottom: 1392 }
const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const OTHER = '99999999-8888-7777-6666-555555555555'
const LEFT: TileRect = { left: 0, top: 0, right: 1280, bottom: 1392 }
const RIGHT_TOP: TileRect = { left: 1280, top: 0, right: 2560, bottom: 1392 }
const RIGHT_BOTTOM: TileRect = { left: 1280, top: 696, right: 2560, bottom: 1392 }
const FLOAT: TileRect = { left: 400, top: 300, right: 1100, bottom: 900 }

interface Harness {
  svc: AgentTilingService
  windows: Map<number, { rect: TileRect; iconic: boolean; pid: number; exe: string }>
  writes: Array<{ hwnd: number; target: TileRect; kind: 'restore' | 'tile' }>
  mode: { value: 'normal' | 'agent' | 'unmanaged' }
  primary: { value: TileRect }
  foreground: Set<number>
  prompts: Array<{ hwnd: number }>
  events: AgentTilingState[]
  recovered: Array<{ status: string; reason: string | null }>
  file: string
  displayChange(): void
  cleanup(): void
}

function factOf(hwnd: number, w: { rect: TileRect; iconic: boolean; pid: number; exe: string }): TileWindowFacts {
  return {
    hwnd,
    pid: w.pid,
    exe: w.exe,
    title: `T383 敏感标题 ${hwnd}`,
    visible: true,
    cloaked: false,
    cloakedShell: false,
    toolWindow: false,
    owned: false,
    appWindow: false,
    iconic: w.iconic,
    resizable: true,
    rect: { ...w.rect },
    onCurrentDesktop: true,
  }
}

function identity(hwnd: number, pid = 1000 + hwnd): WindowIdentity {
  return identityOf({
    hwnd, pid, exe: `C:\\apps\\w${hwnd}.exe`, title: `T383 敏感标题 ${hwnd}`,
    visible: true, cloaked: false, cloakedShell: false, toolWindow: false, owned: false,
    appWindow: false, iconic: false, resizable: true, rect: { ...AREA }, onCurrentDesktop: true,
  })
}

function layoutDoc(over: Partial<AgentLayoutDoc> = {}): AgentLayoutDoc {
  const floating = over.floating ?? []
  const floatingRefs = new Set(floating.map((f) => f.ref))
  // 浮动窗不在平铺树内（模型互斥）：默认三窗树在窗 3 浮动时退化为 1/2 两叶
  const tree: AgentLayoutDoc['tree'] = floatingRefs.has(2)
    ? { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 0 }, second: { kind: 'leaf', ref: 1 } }
    : {
      kind: 'split', axis: 'h',
      first: { kind: 'leaf', ref: 0 },
      second: { kind: 'split', axis: 'v', first: { kind: 'leaf', ref: 1 }, second: { kind: 'leaf', ref: 2 } },
    }
  return {
    version: AGENT_LAYOUT_VERSION,
    desktopId: AGENT,
    clean: true,
    order: [identity(1), identity(2), identity(3)],
    tree,
    queue: [1, 0],
    band: [],
    anchor: null,
    floating,
    ...over,
  }
}

function makeHarness(initial?: {
  doc?: AgentLayoutDoc | null
  raw?: string
  windows?: number[]
  mode?: 'normal' | 'agent'
  primary?: TileRect
  cleanShutdownWrites?: (docText: string) => void
}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t383-'))
  const file = path.join(dir, 'agent-layout.json')
  if (initial?.raw !== undefined) fs.writeFileSync(file, initial.raw)
  else if (initial?.doc) fs.writeFileSync(file, serializeLayout(initial.doc))
  const windows = new Map<number, { rect: TileRect; iconic: boolean; pid: number; exe: string }>()
  for (const hwnd of initial?.windows ?? []) {
    windows.set(hwnd, {
      rect: { left: 50 + hwnd, top: 60 + hwnd, right: 600 + hwnd, bottom: 500 + hwnd },
      iconic: false,
      pid: 1000 + hwnd,
      exe: `C:\\apps\\w${hwnd}.exe`,
    })
  }
  const writes: Harness['writes'] = []
  const prompts: Array<{ hwnd: number }> = []
  const events: AgentTilingState[] = []
  const recovered: Array<{ status: string; reason: string | null }> = []
  const mode = { value: initial?.mode ?? ('agent' as 'normal' | 'agent') }
  const primary = { value: initial?.primary ?? { ...PRIMARY } }
  const foreground = new Set<number>()
  const displayCbs: Array<() => void> = []
  const ctx = new Context()
  const writeLayoutText = (f: string, text: string): void => {
    fs.mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, f)
    initial?.cleanShutdownWrites?.(text)
  }
  const opts: AgentTilingServiceOptions = {
    enabled: true,
    batchMs: 0,
    settleMs: 30,
    layoutFile: file,
    deps: {
      currentMode: () => mode.value,
      ownExes: () => ['C:\\apps\\agent-deck\\agentdeck.exe'],
      primaryRect: () => ({ ...primary.value }),
      taskbarTop: () => TASKBAR_TOP,
      onDisplayChanged: (cb) => {
        displayCbs.push(cb)
        return () => {
          const i = displayCbs.indexOf(cb)
          if (i >= 0) displayCbs.splice(i, 1)
        }
      },
      collectFacts: () => [...windows.entries()].map(([h, w]) => factOf(h, w)),
      readRect: (h) => ({ ...(windows.get(h)?.rect ?? { left: 0, top: 0, right: 0, bottom: 0 }) }),
      restoreRect: (hwnd, target) => {
        writes.push({ hwnd, target: { ...target }, kind: 'restore' })
        const w = windows.get(hwnd)
        if (w) w.rect = { ...target }
        return true
      },
      isForeground: (h) => foreground.has(h),
      startWatch: () => () => undefined,
      agentDesktopId: () => AGENT,
      writeLayoutText,
    },
  }
  const svc = new AgentTilingService(ctx, opts)
  ctx.on('tiling/changed', (payload: AgentTilingState) => events.push(payload))
  ctx.on('tiling/authorize-request', (payload: { hwnd: number }) => prompts.push(payload))
  ctx.on('tiling/recovery', (payload: { status: string; reason: string | null }) => recovered.push(payload))
  svc.start()
  return {
    svc,
    windows,
    writes,
    mode,
    primary,
    foreground,
    prompts,
    events,
    recovered,
    file,
    displayChange: () => {
      for (const cb of [...displayCbs]) cb()
    },
    cleanup: () => {
      try { void ctx.stop() } catch { /* 已在测试中停止 */ }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function settle(ms = 40): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

function readDoc(h: Harness): AgentLayoutDoc {
  return JSON.parse(fs.readFileSync(h.file, 'utf8')) as AgentLayoutDoc
}

describe('正常重启恢复（工单383 验收①）', () => {
  it('干净文档：按持久顺序/树/浮动几何恢复，手动授权全部关闭', async () => {
    const h = makeHarness({
      doc: layoutDoc({ floating: [{ ref: 2, rect: FLOAT }] }),
      windows: [1, 2, 3],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'restored', reason: null })
      expect(h.writes.some((w) => w.hwnd === 1 && JSON.stringify(w.target) === JSON.stringify(LEFT))).toBe(true)
      expect(h.writes.some((w) => w.hwnd === 2 && JSON.stringify(w.target) === JSON.stringify(RIGHT_TOP))).toBe(true)
      expect(h.windows.get(3)!.rect).toEqual(FLOAT) // 浮动几何写回
      expect(h.svc.memberOrderForTest()).toEqual([1, 2]) // 浮动窗不进平铺成员序
      expect(h.svc.floatingRectForTest(3)).toEqual(FLOAT)
      expect(h.svc.state()).toMatchObject({
        count: 3, placed: 2, floating: 1, prompting: 0, authorized: 0,
        recovery: 'restored', recoveryReason: null,
      })
      expect(h.prompts).toEqual([]) // 恢复写窗不是用户操作，不弹授权
    } finally { h.cleanup() }
  })

  it('无持久文档：按活事实正常平铺（recovery=none），首次拍落盘为 dirty', async () => {
    const h = makeHarness({ windows: [1] })
    try {
      await h.svc.runPass()
      await settle(40)
      expect(h.svc.recoveryForTest().status).toBe('none')
      expect(h.windows.get(1)!.rect).toEqual(AREA)
      const doc = readDoc(h)
      expect(doc.clean).toBe(false)
      expect(doc.order.map((w) => w.hwnd)).toEqual([1])
    } finally { h.cleanup() }
  })

  it('干净退出写入 clean=true；运行中落盘为 clean=false（崩溃判据）', async () => {
    const h = makeHarness({ windows: [1, 2] })
    try {
      await h.svc.runPass()
      await settle(40)
      expect(readDoc(h).clean).toBe(false)
      h.svc.shutdown()
      expect(readDoc(h).clean).toBe(true)
    } finally { h.cleanup() }
  })
})

describe('安全态（工单383 验收④：不猜、不无限重试、停止改窗）', () => {
  it('崩溃标记（clean=false）：不应用旧布局、零窗口写入', async () => {
    const h = makeHarness({
      doc: layoutDoc({ clean: false, floating: [{ ref: 2, rect: FLOAT }] }),
      windows: [1, 2, 3],
    })
    try {
      const before = new Map([...h.windows].map(([k, v]) => [k, { ...v.rect }]))
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'safe', reason: 'crash' })
      expect(h.svc.safeForTest()).toBe(true)
      expect(h.writes).toEqual([])
      for (const [hwnd, rect] of before) expect(h.windows.get(hwnd)!.rect).toEqual(rect)
      const restored = await h.svc.restoreTiling()
      expect(restored.ok).toBe(false)
    } finally { h.cleanup() }
  })

  it('桌面 ID 不一致：安全态 desktop-id，零写入', async () => {
    const h = makeHarness({ doc: layoutDoc({ desktopId: OTHER }), windows: [1, 2, 3] })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'safe', reason: 'desktop-id' })
      expect(h.writes).toEqual([])
    } finally { h.cleanup() }
  })

  it('窗口身份不符（同 hwnd 被别的进程复用）：安全态 window-identity，零写入', async () => {
    const bad = layoutDoc()
    bad.order = [identity(1, 4242), identity(2), identity(3)]
    const h = makeHarness({ doc: bad, windows: [1, 2, 3] })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'safe', reason: 'window-identity' })
      expect(h.writes).toEqual([])
    } finally { h.cleanup() }
  })

  it('模型不一致（树引用越界）：安全态 model，零写入', async () => {
    const bad = layoutDoc({
      tree: { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 9 }, second: { kind: 'leaf', ref: 1 } },
    })
    const h = makeHarness({ raw: serializeLayout(bad), windows: [1, 2, 3] })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'safe', reason: 'model' })
      expect(h.writes).toEqual([])
    } finally { h.cleanup() }
  })

  it('安全态退出：干净标记覆盖为 true 且模型清空（不把不可信旧布局再喂给恢复路径）', async () => {
    const h = makeHarness({ doc: layoutDoc({ clean: false }), windows: [1, 2, 3] })
    try {
      await h.svc.runPass()
      await settle(40)
      h.svc.shutdown()
      const doc = readDoc(h)
      expect(doc.clean).toBe(true)
      expect(doc.order).toEqual([])
      expect(doc.tree).toBeNull()
    } finally { h.cleanup() }
  })
})

describe('主屏暂不可用：暂停改窗并保留模型（工单383 验收⑤）', () => {
  it('恢复时主屏退化 → paused 零写入；主屏恢复后 reconciliation 按持久模型落位', async () => {
    const h = makeHarness({
      doc: layoutDoc({ floating: [{ ref: 2, rect: FLOAT }] }),
      windows: [1, 2, 3],
      primary: { left: 0, top: 0, right: 0, bottom: 0 },
    })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'paused', reason: 'display-unavailable' })
      expect(h.writes).toEqual([])
      // 主屏恢复（分辨率变化的过渡态结束）→ 同一拍 reconciliation
      h.primary.value = { ...PRIMARY }
      h.displayChange()
      await settle(80)
      expect(h.svc.recoveryForTest().status).toBe('restored')
      expect(h.windows.get(1)!.rect).toEqual(LEFT)
      expect(h.windows.get(2)!.rect).toEqual(RIGHT_TOP)
      expect(h.windows.get(3)!.rect).toEqual(FLOAT)
    } finally { h.cleanup() }
  })
})

describe('持久化隐私与授权边界（工单383 验收②）', () => {
  it('落盘不含窗口标题/缩略图/manual 授权；armed 阶段不进入文档', async () => {
    const h = makeHarness({ windows: [1, 2] })
    try {
      await h.svc.runPass()
      await settle(40)
      // 让窗 1 进入 armed（确认授权但未重新发起操作）
      h.windows.get(1)!.rect = { ...LEFT, left: LEFT.left + 40, top: LEFT.top + 30 }
      h.foreground.add(1)
      await h.svc.runPass()
      await settle(40)
      expect(h.svc.authPhaseForTest(1)).toBe('prompt')
      h.svc.confirmHwnd(1)
      expect(h.svc.authPhaseForTest(1)).toBe('armed')
      h.svc.flushLayoutForTest()
      const text = fs.readFileSync(h.file, 'utf8')
      expect(text).not.toContain('T383 敏感标题')
      expect(text).not.toContain('data:image')
      for (const forbidden of ['"title"', '"prompt"', '"armed"', '"authorized"', '"thumbnail"']) {
        expect(text.includes(forbidden)).toBe(false)
      }
      expect(Object.keys(readDoc(h)).sort()).toEqual(['anchor', 'band', 'clean', 'desktopId', 'floating', 'order', 'queue', 'tree', 'version'])
    } finally { h.cleanup() }
  })
})

// ————————————————————————————————————————————————————————————
// 工单406（spec #403 决策「持久化布局关系而非旧像素」+ 用户故事 30/31）：重启恢复以
// 有效锚窗恢复视口——持久化屏外顺序与锚窗身份，恢复后按当前平铺区重算 fit（不留空白
// 视口、不恢复旧像素偏移）；锚窗已消失 → 回布局起点。
// 夹具：主屏 1200×752 平铺区、容量 4 扇、列宽 600、露边 32（与 agent-tiling-band 同款）。
// ————————————————————————————————————————————————————————————

describe('带与锚窗恢复（工单406）', () => {
  const NARROW = { left: 0, top: 0, right: 1200, bottom: 800 }
  const AREA_NARROW: TileRect = { left: 0, top: 0, right: 1200, bottom: 752 }

  /** 五窗布局文档：树 4 叶（1/4 左列、2/3 右列）+ 带成员 5 + 锚窗 5 */
  function bandDoc(): AgentLayoutDoc {
    return {
      version: AGENT_LAYOUT_VERSION,
      desktopId: AGENT,
      clean: true,
      order: [identity(1), identity(2), identity(3), identity(4), identity(5)],
      tree: {
        kind: 'split', axis: 'h',
        first: {
          kind: 'split', axis: 'v',
          first: { kind: 'leaf', ref: 0 },
          second: { kind: 'leaf', ref: 3 },
        },
        second: {
          kind: 'split', axis: 'v',
          first: { kind: 'leaf', ref: 1 },
          second: { kind: 'leaf', ref: 2 },
        },
      },
      queue: [1, 2, 0, 3],
      band: [4],
      anchor: 4,
      floating: [],
    }
  }

  it('干净重启：以持久锚窗恢复视口（带成员 fit 完整可见，不用旧像素偏移）', async () => {
    const h = makeHarness({ doc: bandDoc(), windows: [1, 2, 3, 4, 5], primary: NARROW })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'restored', reason: null })
      // 树成员按当前平铺区重算（缩窄区 1168 宽、结构原样；夹具条带顶 1392 > 屏高 800
      // → 平铺区高 = 屏高 800，无栏可避）。锚窗 fit 使整组左移 568——树窗推出左屏外
      expect(h.windows.get(1)!.rect).toEqual({ left: -568, top: 0, right: 16, bottom: 400 })
      expect(h.windows.get(4)!.rect).toEqual({ left: -568, top: 400, right: 16, bottom: 800 })
      // 锚窗（带成员 5）按当前几何 fit 完整可见——不是露边位、不是旧像素
      expect(h.windows.get(5)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 800 })
      expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1 })
      expect(h.prompts).toEqual([])
    } finally { h.cleanup() }
  })

  it('锚窗已消失：无锚回布局起点（视口归零、树回满区、零空白）', async () => {
    const d = bandDoc()
    // 窗 5（带成员兼锚窗）面板停摆期间已关闭
    const h = makeHarness({ doc: d, windows: [1, 2, 3, 4], primary: NARROW })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'restored', reason: null })
      // 带空 → 树回满区；无锚 → 视口起点
      expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 600, bottom: 400 })
      expect(h.windows.get(2)!.rect).toEqual({ left: 600, top: 0, right: 1200, bottom: 400 })
      expect(h.svc.state()).toMatchObject({ count: 4, placed: 4, overflow: 0 })
    } finally { h.cleanup() }
  })

  it('恢复落盘回写：band/anchor 随下一拍持久化（关系而非像素）', async () => {
    const h = makeHarness({ doc: bandDoc(), windows: [1, 2, 3, 4, 5], primary: NARROW })
    try {
      await h.svc.runPass()
      await settle(60)
      const doc = readDoc(h)
      expect(doc.version).toBe(AGENT_LAYOUT_VERSION)
      expect(doc.band).toEqual([4])
      expect(doc.anchor).toBe(4)
      expect(doc.order.map((w) => w.hwnd)).toEqual([1, 2, 3, 4, 5])
      expect(JSON.stringify(doc)).not.toContain('敏感标题')
    } finally { h.cleanup() }
  })
})
