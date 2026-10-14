/**
 * 自绘菜单外壳的纯裁决（工单182 = spec166 之⑤）。
 *
 * 钉的是**裁决**而非接线：行清单是什么、哪一行在当前选区下可不可用、菜单摆在哪不出屏、
 * 一个事件该产生哪些副作用。接线（遮罩真的铺了、真的申报了热区、真的收干净了）在
 * doc-group-cards-menu-dom.spec.ts 里钉。
 *
 * 本文件不 import 任何别的插件或内核模块——「不依赖上下文菜单插件」这条验收标准在下面的
 * 「零依赖」一节里按源码文本钉死，不是靠嘴说。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOSED_MENU,
  DISABLED_CLASS,
  FILE_MENU_ROWS,
  MENU_EDGE,
  MENU_PAD_Y,
  MENU_ROW_H,
  MENU_W,
  NEED_ANY,
  NEED_PASTEABLE,
  NEED_SINGLE,
  ROW_CLASS,
  clampMenuBox,
  menuSizeOf,
  nextMenuShell,
  resolveMenuRows,
  rowEnabledOf,
  rowVisibleOf,
  type MenuCtx,
  type MenuEffect,
  type MenuShellEvent,
} from '../../plugins/doc-group-cards/menu'

const VIEWPORT = { width: 2560, height: 1440 }

/** 单选：菜单是从一个文件上右键弹出来的（本票的常态） */
const ONE: MenuCtx = { paths: ['C:\\me\\方案.docx'] }
/** 两个选中（工单184 的世界；本票只做单选，但置灰裁决必须已经就位） */
const TWO: MenuCtx = { paths: ['C:\\me\\方案.docx', 'C:\\me\\纪要.docx'] }

function openEvent(over: Partial<Extract<MenuShellEvent, { type: 'open' }>> = {}): Extract<MenuShellEvent, { type: 'open' }> {
  return { type: 'open', x: 800, y: 600, viewport: VIEWPORT, specs: FILE_MENU_ROWS, ctx: ONE, ...over }
}

/** 开层并返回状态（省得每条用例都解 effects） */
function open(over?: Partial<Extract<MenuShellEvent, { type: 'open' }>>) {
  return nextMenuShell(CLOSED_MENU, openEvent(over)).state
}

/** 取一条存证副作用（效果是个可辨识联合，先判别再取字段，TS 才认） */
function notifyOf(fx: MenuEffect): { type: string; payload?: Record<string, unknown> } {
  if (fx.kind !== 'notify') throw new Error(`不是存证副作用：${fx.kind}`)
  return fx
}

describe('文件菜单七项（工单182 只读五项 + 工单183 写两项 RENAME/DELETE）', () => {
  it('恰好七项，顺序与文案即 spec166「菜单（自绘外壳）」所列', () => {
    expect(FILE_MENU_ROWS.map((r) => [r.id, r.label])).toEqual([
      ['open', 'OPEN'],
      ['open-location', 'OPEN LOCATION'],
      ['copy-path', 'COPY PATH'],
      ['copy', 'COPY'],
      ['cut', 'CUT'],
      ['rename', 'RENAME'],
      ['delete', 'DELETE'],
    ])
  })

  it('单选时七项全部可用（本票的置灰口径：单选即全可用）', () => {
    expect(resolveMenuRows(FILE_MENU_ROWS, ONE).every((r) => r.enabled)).toBe(true)
  })

  it('行 id 全在本插件命名空间里（热区扫掠对重复 id 不去重，行 id 不参与热区但要可辨识）', () => {
    expect(FILE_MENU_ROWS.every((r) => r.id === r.id.trim() && r.id.length > 0)).toBe(true)
    expect(new Set(FILE_MENU_ROWS.map((r) => r.id)).size).toBe(FILE_MENU_ROWS.length)
  })

  it('没有一行动作回调混进行描述符里（动作不进状态，由 card.js 旁路持有）', () => {
    for (const row of FILE_MENU_ROWS) {
      expect(Object.keys(row).some((k) => k === 'run' || k === 'action')).toBe(false)
    }
  })
})

describe('逐行可用性裁决（工单184 的接缝就在 NEED_SINGLE 那一行）', () => {
  it('needs=any：有选中、无选中都可用（多选也可用——内核那几个契约本就是整批语义）', () => {
    const spec = { id: 'copy', label: 'COPY', needs: NEED_ANY }
    expect(rowEnabledOf(spec, ONE)).toBe(true)
    expect(rowEnabledOf(spec, { paths: [] })).toBe(true)
    expect(rowEnabledOf(spec, TWO)).toBe(true)
  })

  it('needs=single：单选可用，多选置灰（工单184 落地时此处即生效，无需改别处）', () => {
    const spec = { id: 'open-location', label: 'OPEN LOCATION', needs: NEED_SINGLE }
    expect(rowEnabledOf(spec, ONE)).toBe(true)
    expect(rowEnabledOf(spec, TWO)).toBe(false)
  })

  it('needs=single 且无选中时仍可用——票面口径「无选中时全部可用」', () => {
    expect(rowEnabledOf({ id: 'open-location', label: 'X', needs: NEED_SINGLE }, { paths: [] })).toBe(true)
  })

  it('needs=pasteable：只看剪贴板实况，查不到（false / undefined）即置灰，绝不误使能', () => {
    const spec = { id: 'paste', label: 'PASTE', needs: NEED_PASTEABLE }
    expect(rowEnabledOf(spec, ONE)).toBe(false)
    expect(rowEnabledOf(spec, { paths: [], pasteable: false })).toBe(false)
    expect(rowEnabledOf(spec, { paths: [], pasteable: true })).toBe(true)
  })

  it('可见性谓词（工单185 的接缝）：visibleWhen 为假则整行不出现，而不是画一只灰的', () => {
    const specs = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', visibleWhen: () => false },
      { id: 'c', label: 'C', visibleWhen: (c: MenuCtx) => c.paths.length > 0 },
    ]
    expect(resolveMenuRows(specs, ONE).map((r) => r.id)).toEqual(['a', 'c'])
    expect(resolveMenuRows(specs, { paths: [] }).map((r) => r.id)).toEqual(['a'])
    // 缺省即恒可见（不写 visibleWhen 的行不会被误隐藏）
    expect(rowVisibleOf({ id: 'a', label: 'A' }, { paths: [] })).toBe(true)
  })
})

describe('落位钳制（工单182：菜单定位不出屏）', () => {
  const size = menuSizeOf(FILE_MENU_ROWS)

  it('尺寸：宽定死、高 = 行数 × 行高 + 上下内边距（唯一出处，CSS 里插的是同两个常量）', () => {
    expect(size).toEqual({ width: MENU_W, height: 7 * MENU_ROW_H + 2 * MENU_PAD_Y })
    expect(size.height).toBe(194)
  })

  it('不出屏：贴右下角弹出时整块收回视口内（左右两边各留 MENU_EDGE）', () => {
    const box = clampMenuBox({ x: VIEWPORT.width, y: VIEWPORT.height }, size, VIEWPORT)
    expect(box.left).toBe(VIEWPORT.width - MENU_W - MENU_EDGE)
    expect(box.top).toBe(VIEWPORT.height - size.height - MENU_EDGE)
    expect(box.left + box.width).toBeLessThanOrEqual(VIEWPORT.width)
    expect(box.top + box.height).toBeLessThanOrEqual(VIEWPORT.height)
  })

  it('不出屏：负坐标（虚拟屏左边界的框外点）钳到边距下限，绝不给负坐标', () => {
    expect(clampMenuBox({ x: -50, y: -50 }, size, VIEWPORT)).toMatchObject({ left: MENU_EDGE, top: MENU_EDGE })
  })

  it('视口装不下菜单：取「贴边且不出负坐标」这一半，不返回负数也不做变形缩放', () => {
    const box = clampMenuBox({ x: 0, y: 0 }, size, { width: 100, height: 50 })
    expect(box).toMatchObject({ left: MENU_EDGE, top: MENU_EDGE, width: MENU_W, height: size.height })
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.top).toBeGreaterThanOrEqual(0)
  })

  it('视口内不乱动：光标离边还有余量时原样贴着光标（钳制只在该发生时出手）', () => {
    expect(clampMenuBox({ x: 800, y: 600 }, size, VIEWPORT)).toMatchObject({ left: 800, top: 600 })
  })

  it('恰好压在临界点上不动（边界含在视口内即视为没越界）', () => {
    const left = VIEWPORT.width - MENU_W - MENU_EDGE
    expect(clampMenuBox({ x: left, y: 0 }, size, VIEWPORT).left).toBe(left)
  })
})

describe('壳的转移矩阵（开合、激活、收起、卸载）', () => {
  it('开层：持键盘档 → 建 DOM → 申报热区 → 存证，副作用严格按此序', () => {
    const { state, effects } = nextMenuShell(CLOSED_MENU, openEvent())
    expect(state.open).toBe(true)
    expect(state.paths).toEqual(ONE.paths)
    expect(effects.map((f) => f.kind)).toEqual(['keyboard-tier', 'show', 'hotzones', 'notify'])
    expect(effects[0]).toEqual({ kind: 'keyboard-tier', held: true })
  })

  it('开层：落位按钳制后的盒子算，且行表已解析好（含可用性）', () => {
    const box = clampMenuBox({ x: VIEWPORT.width, y: VIEWPORT.height }, menuSizeOf(FILE_MENU_ROWS), VIEWPORT)
    const { state } = nextMenuShell(CLOSED_MENU, openEvent({ x: VIEWPORT.width, y: VIEWPORT.height }))
    expect(state.box).toEqual(box)
    expect(state.rows.map((r) => [r.id, r.enabled])).toEqual(FILE_MENU_ROWS.map((r) => [r.id, true]))
  })

  it('空壳不弹：一行都**不可见**时不产生任何副作用（弹出空菜单毫无意义）', () => {
    const specs = [{ id: 'paste', label: 'PASTE', visibleWhen: () => false }]
    const { state, effects } = nextMenuShell(CLOSED_MENU, openEvent({ specs, ctx: { paths: [] } }))
    expect(effects).toEqual([])
    expect(state).toBe(CLOSED_MENU)
  })

  it('空壳与「一整张表全置灰」是两回事：全置灰照样弹（用户看得见菜单、点不动，与真菜单同款）', () => {
    const specs = [{ id: 'paste', label: 'PASTE', needs: NEED_PASTEABLE }]
    const { state, effects } = nextMenuShell(CLOSED_MENU, openEvent({ specs, ctx: { paths: [] } }))
    expect(state.open).toBe(true)
    expect(state.rows).toEqual([{ id: 'paste', label: 'PASTE', enabled: false }])
    expect(effects.map((f) => f.kind)).toEqual(['keyboard-tier', 'show', 'hotzones', 'notify'])
  })

  it('点可用行：撤 DOM → 重申报热区 → 放键盘档 → 执行动作 → 存证（菜单先收再动作）', () => {
    const { effects } = nextMenuShell(open(), { type: 'activate', id: 'copy' })
    expect(effects.map((f) => f.kind)).toEqual(['hide', 'hotzones', 'keyboard-tier', 'run', 'notify'])
    expect(effects[2]).toEqual({ kind: 'keyboard-tier', held: false })
    expect(effects[3]).toEqual({ kind: 'run', id: 'copy', paths: ONE.paths, cardId: '' })
  })

  it('点置灰行 / 未知 id：无转移无副作用，菜单**保持开着**（真菜单同款）', () => {
    const opened = open()
    const grey = nextMenuShell({ ...opened, rows: [{ id: 'x', label: 'X', enabled: false }] }, { type: 'activate', id: 'x' })
    expect(grey.effects).toEqual([])
    expect(grey.state.open).toBe(true)
    const unknown = nextMenuShell(opened, { type: 'activate', id: '不存在的行' })
    expect(unknown.effects).toEqual([])
    expect(unknown.state).toBe(opened)
  })

  it('菜单外点击与 Esc：同转移、同收尾，存证 reason 可分（outside / esc）', () => {
    const opened = open()
    const outside = nextMenuShell(opened, { type: 'dismiss', reason: 'outside' })
    const esc = nextMenuShell(opened, { type: 'esc' })
    expect(outside.effects.map((f) => f.kind)).toEqual(['hide', 'hotzones', 'keyboard-tier', 'notify'])
    expect(outside.state).toBe(CLOSED_MENU)
    expect(notifyOf(outside.effects[3]).payload).toMatchObject({ reason: 'outside' })
    expect(notifyOf(esc.effects[3]).payload).toMatchObject({ reason: 'esc' })
    // 存证类型相同、reason 不同——电池分得开是哪一种收起
    expect(notifyOf(outside.effects[3]).type).toBe(notifyOf(esc.effects[3]).type)
  })

  it('闭态下的 dismiss / esc / activate 是迟到噪声：无转移、无副作用、不发存证', () => {
    for (const ev of [{ type: 'dismiss', reason: 'x' }, { type: 'esc' }, { type: 'activate', id: 'copy' }] as MenuShellEvent[]) {
      const { state, effects } = nextMenuShell(CLOSED_MENU, ev)
      expect(effects).toEqual([])
      expect(state).toBe(CLOSED_MENU)
    }
  })

  it('卸载：静默收场（不带存证），但遮罩/热区/键盘档一样不漏地收回', () => {
    const { state, effects } = nextMenuShell(open(), { type: 'unmount' })
    expect(effects.map((f) => f.kind)).toEqual(['hide', 'hotzones', 'keyboard-tier'])
    expect(state).toBe(CLOSED_MENU)
    // 闭态卸载是噪声（nothing to clean）
    expect(nextMenuShell(CLOSED_MENU, { type: 'unmount' }).effects).toEqual([])
  })

  it('动作作用于开层时冻结的选区：菜单开着期间选区变了也不改（状态里的 paths 是那一刻的）', () => {
    const opened = open()
    const ctx: MenuCtx = { paths: ['C:\\me\\别的.docx'] } // 假装选区已经变了
    expect(resolveMenuRows(FILE_MENU_ROWS, ctx)[0].enabled).toBe(true)
    const { effects } = nextMenuShell(opened, { type: 'activate', id: 'copy' })
    expect(effects[3]).toMatchObject({ kind: 'run', paths: opened.paths })
  })

  it('重开：闭态再开得到一份全新的行表与落位（上一轮的坐标不粘着）', () => {
    const first = open({ x: 10, y: 10 })
    const second = nextMenuShell(first, openEvent({ x: 2000, y: 1000 })).state
    expect(second.box.left).toBe(2000)
    expect(second.box.top).toBe(1000)
  })
})

describe('零依赖（验收标准：菜单外壳自绘，不依赖上下文菜单插件）', () => {
  const SRC_DIR = path.resolve(__dirname, '../../plugins/doc-group-cards')
  const SOURCES = ['card.js', 'menu.js'].map((f) => ({ f, s: fs.readFileSync(path.join(SRC_DIR, f), 'utf8') }))

  /** 剥掉注释只看代码：注释里当然可以解释「为什么不依赖它」，代码里出现才是依赖 */
  function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }

  it('代码里没有任何一处提到 ctxMenu / deckCtxMenu / context-menu（名字出现即依赖）', () => {
    for (const { f, s } of SOURCES) {
      const hit = /ctxMenu|deckCtxMenu|context-menu/.test(codeOnly(s))
      expect({ file: f, hit }).toEqual({ file: f, hit: false })
    }
  })

  it('只 import 自己目录里的相对模块（跨目录 import 即意味着依赖别的包或内核源码）', () => {
    const specs = SOURCES.flatMap(({ s }) => [...codeOnly(s).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]))
    expect(specs.length).toBeGreaterThan(0)
    expect(specs.filter((spec) => !spec.startsWith('./'))).toEqual([])
    // 反面钉死这条缝确实是接上的：入口真的从 menu.js 取裁决，不是自己另写一份
    expect(SOURCES.find(({ f }) => f === 'card.js')?.s).toContain("from './menu.js'")
  })

  it('置灰行有一枚专属类名，且与内核的 .ditem.sel 不是同一个（两条线互不相干）', () => {
    expect(DISABLED_CLASS).not.toBe('sel')
    expect(ROW_CLASS).not.toBe('ditem')
  })
})
