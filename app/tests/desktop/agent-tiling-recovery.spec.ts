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
  windows: Map<number, { rect: TileRect; iconic: boolean; pid: number; exe: string; minSize?: { w: number; h: number } }>
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
  /** 窗清单：纯 hwnd 或带 minSize 夹取的规格（工单417——minSize 必须在首轮 pass 前就位） */
  windows?: Array<number | { hwnd: number; minSize: { w: number; h: number } }>
  mode?: 'normal' | 'agent'
  primary?: TileRect
  cleanShutdownWrites?: (docText: string) => void
}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-t383-'))
  const file = path.join(dir, 'agent-layout.json')
  if (initial?.raw !== undefined) fs.writeFileSync(file, initial.raw)
  else if (initial?.doc) fs.writeFileSync(file, serializeLayout(initial.doc))
  const windows = new Map<number, { rect: TileRect; iconic: boolean; pid: number; exe: string; minSize?: { w: number; h: number } }>()
  for (const spec of initial?.windows ?? []) {
    const hwnd = typeof spec === 'number' ? spec : spec.hwnd
    windows.set(hwnd, {
      rect: { left: 50 + hwnd, top: 60 + hwnd, right: 600 + hwnd, bottom: 500 + hwnd },
      iconic: false,
      pid: 1000 + hwnd,
      exe: `C:\\apps\\w${hwnd}.exe`,
      ...(typeof spec === 'number' ? {} : { minSize: spec.minSize }),
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
        if (w) {
          // 最小尺寸夹取（工单414/417，与 agent-tiling-service.spec 同款）：写「受理」但
          // 应用按自身 minWidth/minHeight 夹取（WM_GETMINMAXINFO 假身）——回读不达标，
          // 核验天然判 retry → 容量回退路径（spec 413）
          const ms = w.minSize
          w.rect = ms
            ? {
                left: target.left,
                top: target.top,
                right: target.left + Math.max(target.right - target.left, ms.w),
                bottom: target.top + Math.max(target.bottom - target.top, ms.h),
              }
            : { ...target }
        }
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

// ————————————————————————————————————————————————————————————
// 工单410（spec #410 决策「异常退出只废弃旧布局内容」「异常后从当前事实重建」）：
// clean=false 不再进入永久 crash 停写态——布局文档可解析且桌面配对仍可信时，旧成员顺序、
// 树形、队列、屏外顺序、锚窗和浮动记录全部不应用，以当前 Agent 桌面主屏合格窗口及当次
// 事件顺序建立新成员序（正常屏内/屏外规划）；恢复投影如实区分干净恢复（restored）与
// 异常重建（rebuilt）。其他安全闸门不放宽：模型不一致仍 model、桌面 ID 不一致仍
// desktop-id；异常重建不采用旧窗口身份，不因旧句柄消失而阻塞（无 window-identity 判定）。
// ————————————————————————————————————————————————————————————

describe('异常重启重建（工单410）', () => {
  // 三窗默认平铺（成员序 [1,2,3]）：w1 左半、w2 右上、w3 右下（旧常量 RIGHT_TOP 是
  // 两叶恢复布局的「右半满高」，与此处三叶布局不同名不同值）
  const PANE_W2: TileRect = { left: 1280, top: 0, right: 2560, bottom: 696 }
  const PANE_W3: TileRect = { left: 1280, top: 696, right: 2560, bottom: 1392 }

  it('clean=false：旧布局（树/浮动/带/锚）不应用，当前合格窗口重建默认平铺', async () => {
    const h = makeHarness({
      // 崩溃前模型：w1 左半、w2 右半（w3 浮动 @FLOAT）——重建后必须全部不成立
      doc: layoutDoc({ clean: false, floating: [{ ref: 2, rect: FLOAT }] }),
      windows: [1, 2, 3],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      // 恢复投影如实表达：rebuilt ≠ restored ≠ safe
      expect(h.svc.recoveryForTest()).toEqual({ status: 'rebuilt', reason: null })
      expect(h.svc.safeForTest()).toBe(false)
      // 当前三窗按当次事实序重建默认平铺（w1 左半 / w2 右上 / w3 右下）
      expect(h.windows.get(1)!.rect).toEqual(LEFT)
      expect(h.windows.get(2)!.rect).toEqual(PANE_W2)
      expect(h.windows.get(3)!.rect).toEqual(PANE_W3)
      // 旧浮动记录不应用：w3 不在浮动账、几何不是 FLOAT
      expect(h.svc.floatingRectForTest(3)).toBeNull()
      // 恢复写窗不是用户操作：不弹授权
      expect(h.prompts).toEqual([])
      expect(h.svc.state()).toMatchObject({
        count: 3, placed: 3, overflow: 0, floating: 0, prompting: 0, authorized: 0,
        recovery: 'rebuilt', recoveryReason: null,
      })
      // 不永久停用平铺：恢复平铺动作可用（safe 态下 ok:false 的旧语义不再出现）
      const restored = await h.svc.restoreTiling()
      expect(restored.ok).toBe(true)
    } finally { h.cleanup() }
  })

  it('重建后新窗继续受管（story 19）：第 4 窗按既定裂变落格，不是一次性恢复', async () => {
    const h = makeHarness({
      doc: layoutDoc({ clean: false }),
      windows: [1, 2, 3],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest().status).toBe('rebuilt')
      h.windows.set(4, { rect: { left: 60, top: 70, right: 660, bottom: 520 }, iconic: false, pid: 1004, exe: 'C:\\apps\\w4.exe' })
      await h.svc.runPass()
      await settle(60)
      // 成员序 [1,2,3,4]：第 4 窗裂变窗 1 窗格（队首）→ 左列上下分
      expect(h.windows.get(4)!.rect).toEqual({ left: 0, top: 696, right: 1280, bottom: 1392 })
      expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1280, bottom: 696 })
      expect(h.svc.state()).toMatchObject({ count: 4, placed: 4, overflow: 0, recovery: 'rebuilt' })
    } finally { h.cleanup() }
  })

  it('clean=false 但桌面配对不可信：仍安全态 desktop-id（重建不接管未知桌面，story 22）', async () => {
    const h = makeHarness({
      doc: layoutDoc({ clean: false, desktopId: OTHER }),
      windows: [1, 2, 3],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'safe', reason: 'desktop-id' })
      expect(h.writes).toEqual([])
    } finally { h.cleanup() }
  })

  it('重建落盘：新成员序成为持久文档（后续干净重启按重建后模型恢复）', async () => {
    const h = makeHarness({
      doc: layoutDoc({ clean: false, floating: [{ ref: 2, rect: FLOAT }] }),
      windows: [1, 2, 3],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      const doc = readDoc(h)
      expect(doc.clean).toBe(false) // 运行中仍是崩溃判据口径
      expect(doc.order.map((w) => w.hwnd)).toEqual([1, 2, 3])
      expect(doc.floating).toEqual([]) // 旧浮动记录不随重建沉淀
    } finally { h.cleanup() }
  })
})

describe('安全态（工单383 验收④：不猜、不无限重试、停止改窗）', () => {
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
    const bad = layoutDoc({
      tree: { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 9 }, second: { kind: 'leaf', ref: 1 } },
    })
    const h = makeHarness({ raw: serializeLayout(bad), windows: [1, 2, 3] })
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
      // 工单417：尺寸能力证据（minSize 下界/分裂阻断记忆）只在当前会话——持久布局
      // 格式不新增此类字段（spec 413「持久格式不扩张」）
      for (const forbidden of ['"title"', '"prompt"', '"armed"', '"authorized"', '"thumbnail"', '"minSize"']) {
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

// ————————————————————————————————————————————————————————————
// 工单417（spec 413）：新容量语义贯通恢复路径——干净恢复与异常重建都按当前事实重新评估，
// 尺寸能力证据不跨会话（重启/重建）泄漏、持久布局格式不新增此类字段（story 29/30/32）。
// 夹具：宽屏 2560×1392 平铺区（harness 默认主屏）+ minSize 夹取（工单414 同款假身）。
// ————————————————————————————————————————————————————————————
describe('工单417 新容量语义贯通恢复与会话边界（干净恢复/异常重建）', () => {
  /** 五窗布局文档（与 406 describe 的 bandDoc 同款）：树 4 叶 + 带成员 5（锚置空 = 视口起点） */
  function bandDoc417(): AgentLayoutDoc {
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
      anchor: null,
      floating: [],
    }
  }

  it('干净恢复：带成员关系按持久账恢复、无跨会话证据——以当拍写窗事实重学（重新夹取回带，零异常零授权）', async () => {
    const h = makeHarness({
      doc: bandDoc417(),
      windows: [1, 2, 3, 4, { hwnd: 5, minSize: { w: 800, h: 400 } }],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'restored', reason: null })
      // 持久 band=[4] 只恢复关系不携带尺寸证据：窗 5 重试插树 → 分裂目标 640×696 被
      // 夹取 → 容量回退回带（当拍重学，非旧会话记忆）——零异常、零误授权
      expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1, anomalies: 0 })
      expect(h.windows.get(5)!.rect).toEqual({ left: 2528, top: 0, right: 3808, bottom: 1392 })
      // 分裂完全回退：既有四窗保持恢复窗格（无半分裂残留）
      expect(h.windows.get(1)!.rect).toEqual({ left: 0, top: 0, right: 1264, bottom: 696 })
      expect(h.windows.get(2)!.rect).toEqual({ left: 1264, top: 0, right: 2528, bottom: 696 })
      expect(h.prompts).toEqual([])
      // 带关系随下一拍回写持久文档（关系而非像素，不含任何尺寸证据字段）
      const doc = readDoc(h)
      expect(doc.band).toEqual([4])
      expect(JSON.stringify(doc)).not.toContain('minSize')
    } finally { h.cleanup() }
  })

  it('异常重建：clean=false 按当前事实重建，容量语义在重建路径同样生效（不是旧账恢复、不是异常化）', async () => {
    const h = makeHarness({
      doc: layoutDoc({ clean: false }),
      windows: [1, 2, 3, 4, { hwnd: 5, minSize: { w: 800, h: 400 } }],
    })
    try {
      await h.svc.runPass()
      await settle(60)
      expect(h.svc.recoveryForTest()).toEqual({ status: 'rebuilt', reason: null })
      // 重建按成员序 1-5 平铺：1-4 落格，第 5 扇分裂目标被夹取 → 容量回退入带
      expect(h.svc.state()).toMatchObject({ count: 5, placed: 4, overflow: 1, anomalies: 0 })
      expect(h.windows.get(5)!.rect).toEqual({ left: 2528, top: 0, right: 3808, bottom: 1392 })
      expect(h.prompts).toEqual([])
    } finally { h.cleanup() }
  })
})
