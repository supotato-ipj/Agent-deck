/**
 * 两块自绘写操作层的**接线**（工单183 = spec166 之⑥）。
 *
 * 上一份测试（doc-group-cards-writeops.spec.ts）钉的是裁决：效果数组的次序、取消为什么必然
 * 没有副作用、键盘档为什么让内核六键与 Esc 让位。本份钉的是接线——那些裁决在 card.js 里真的
 * 落到 DOM 与宿主上了吗？
 *   - DELETE 行的点击**不发任何契约调用**，只弹自建的确认层；确认才走 desktop/trash；
 *   - 取消四路（取消钮 / Esc / 层外点击）连一次契约调用都没有，屏幕上一个节点都不留；
 *   - 确认层遮罩真的是一张 class='card' 的全屏元素，且铺了撤了都申报热区；
 *   - RENAME 行点出来的是格子里**原地顶替标签**的输入框，焦点真的落到了它上面，且落在
 *     键盘档持拿**之后**（宿主与契约里没有「聚焦某元素」的 API，档让窗口可聚焦是第一步）；
 *   - 编辑器关闭与卸载时键盘档都被放掉，且持放平衡；
 *   - 删除成功后下一拍该文件从卡上消失，改了扩展名则重新归到正确的组卡上。
 *
 * DOM 桩与工单181/182 的接线测试共用同一份（doc-group-cards-dom-shim.ts）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, beforeEach } from 'vitest'
import { CELL_CLASS, EXPANDED_CLASS } from '../../plugins/doc-group-cards/interaction'
import { MENU_STYLE_ID, OVERLAY_ID, PANEL_ID, ROW_CLASS } from '../../plugins/doc-group-cards/menu'
import {
  CONFIRM_BOX_ID,
  CONFIRM_CANCEL_ID,
  CONFIRM_OK_ID,
  CONFIRM_OVERLAY_ID,
  CONFIRM_STYLE_ID,
  CONFIRM_TEXT_ID,
  RENAME_INPUT_CLASS,
  confirmBoxOf,
  confirmSizeOf,
} from '../../plugins/doc-group-cards/writeops'
import plugin, { STYLE_ID, type Host, type HostDesktopItem, type HostView } from '../../plugins/doc-group-cards/card'
import { Element, EventTarget, focusLog, newDom, walk } from './doc-group-cards-dom-shim'

// ---------------------------------------------------------------------------
// 宿主桩
// ---------------------------------------------------------------------------

const ITEMS: HostDesktopItem[] = [
  { name: '方案.docx', kind: 'file', path: 'C:\\me\\方案.docx', iconKey: 'k1' },
  { name: '纪要.docx', kind: 'file', path: 'C:\\me\\纪要.docx', iconKey: 'k2' },
  { name: '预算.pdf', kind: 'file', path: 'C:\\me\\预算.pdf', iconKey: 'k3' },
]

function viewWith(items: HostDesktopItem[]): HostView {
  return { desktop: { items } }
}

type Call = { method: string; payload: unknown }

let dom: ReturnType<typeof newDom>
let win: EventTarget & { innerWidth: number; innerHeight: number }
let h: {
  host: Host
  domChanges: number[]
  invokes: Call[]
  tiers: string[]
  notes: Array<{ type: string; payload?: Record<string, unknown> }>
  /** 持档那一刻焦点流水有多长——用来证明「档先持、focus 在后」 */
  focusAtHold: number[]
}

beforeEach(() => {
  win = Object.assign(new EventTarget(), { innerWidth: 2560, innerHeight: 1440 })
  ;(globalThis as unknown as Record<string, unknown>).window = win
  // 每条用例换一份全新的文档与宿主，但 card.js 是**同一个模块实例**（同一 URL import 一次）。
  // 宿主契约是「重挂必先卸载」，故先卸载把上一条留下的模块级状态清干净。
  plugin.unmount?.()
  dom = newDom()
  const container = new Element('div', 'deck-plugin')
  dom.body.appendChild(container)
  const domChanges: number[] = []
  const invokes: Call[] = []
  const tiers: string[] = []
  const notes: Array<{ type: string; payload?: Record<string, unknown> }> = []
  const focusAtHold: number[] = []
  const stub = {
    el: container,
    view: viewWith(ITEMS),
    util: {},
    notify: (type: string, payload?: Record<string, unknown>) => { notes.push({ type, payload }) },
    invoke: (method: string, payload: unknown) => {
      invokes.push({ method, payload })
      return Promise.resolve(method === 'desktop/icon' ? { dataUrl: null } : { ok: true })
    },
    on: () => () => {},
    holdKeyboardTier: (tier: string) => {
      tiers.push(`hold:${tier}`)
      focusAtHold.push(focusLog.length)
    },
    releaseKeyboardTier: (tier: string) => { tiers.push(`release:${tier}`) },
    onDomChanged: () => { domChanges.push(1) },
  }
  h = {
    host: stub as unknown as Host,
    domChanges,
    invokes,
    tiers,
    notes,
    focusAtHold,
  }
  ;(globalThis as unknown as Record<string, unknown>).document = dom.documentShim
})

// ---------------------------------------------------------------------------
// 取件
// ---------------------------------------------------------------------------

const viewport = () => ({ width: win.innerWidth, height: win.innerHeight })

function cards(): Element[] {
  return walk(dom.body).filter((n) => n.classList.contains('card') && n.id !== OVERLAY_ID && n.id !== CONFIRM_OVERLAY_ID)
}
function cellsOf(card: Element): Element[] {
  return walk(card).filter((n) => n.classList.contains(CELL_CLASS))
}
function cardOf(id: string): Element {
  const c = cards().find((n) => n.id === id)
  if (!c) throw new Error(`没有 ${id} 这张卡`)
  return c
}
const docxCard = () => cardOf('dgc-docx')
const pdfCard = () => cardOf('dgc-pdf')
function nameOf(card: Element): string[] {
  return walk(card).filter((n) => n.className.split(/\s+/).includes('dgc-name')).map((n) => n.textContent)
}

/** 在一个文件格上右键（先选中它，再弹文件菜单） */
function rightClick(cell: Element, x = 800, y = 600): void {
  cell.dispatch('contextmenu', cell, { clientX: x, clientY: y })
}
function rowsOf(): Element[] {
  const p = dom.documentShim.getElementById(PANEL_ID)
  return p ? p.querySelectorAll(`.${ROW_CLASS}`) : []
}
function rowById(id: string): Element {
  const row = rowsOf().find((r) => r.dataset.row === id)
  if (!row) throw new Error(`菜单上没有 ${id} 行`)
  return row
}
const byId = (id: string): Element | null => dom.documentShim.getElementById(id)
// 排除两类与写操作无关的噪声：desktop/icon（取图标）与 plugin-config/*（工单185 起装载时
// 经插件私有状态通道读一次组定义——那是本插件的状态通道，不是菜单动作）。
const menuInvokes = () => h.invokes.filter((c) => c.method !== 'desktop/icon' && !c.method.startsWith('plugin-config/'))
const writeInvokes = () => menuInvokes().filter((c) => c.method === 'desktop/trash' || c.method === 'desktop/rename')
const classesOf = (n: Element) => n.className.split(/\s+/).filter(Boolean)

/** 确认层开着时点 DELETE 行 */
function openConfirmViaMenu(): void {
  plugin.mount(h.host)
  rightClick(cellsOf(docxCard())[0])
  rowById('delete').dispatch('click')
}
/** 确认层开着时点 RENAME 行，返回那一格的输入框 */
function openRenameViaMenu(): Element {
  plugin.mount(h.host)
  rightClick(cellsOf(docxCard())[0])
  rowById('rename').dispatch('click')
  return renameInput()
}
function renameInput(): Element {
  const input = walk(dom.body).find((n) => n.classList.contains(RENAME_INPUT_CLASS))
  if (!input) throw new Error('编辑器没铺出来')
  return input
}
function pressEsc(): void {
  win.dispatch('keydown', dom.body, { key: 'Escape' })
}

// ---------------------------------------------------------------------------

describe('DELETE：菜单行只开层，不落盘（票面：DELETE 前弹出自建确认层）', () => {
  it('点 DELETE 行的瞬间**零契约调用**——「先问过用户」是这一行的全部语义', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(docxCard())[0])
    rowById('delete').dispatch('click')
    expect(menuInvokes()).toEqual([])
    expect(byId(CONFIRM_OVERLAY_ID)).not.toBeNull()
  })

  it('确认层遮罩是 class="card" 的一张全屏元素（热区扫掠只认这个类，不挂则整屏仍穿透）', () => {
    openConfirmViaMenu()
    const ov = byId(CONFIRM_OVERLAY_ID)!
    expect(classesOf(ov)).toContain('card')
    // 渲染层的扫掠路径：document.querySelectorAll('.card') —— 遮罩必须出现在这条路径的结果里
    expect(dom.documentShim.querySelectorAll('.card').map((n) => n.id)).toContain(CONFIRM_OVERLAY_ID)
    // id 唯一（热区扫掠对重复 id 不去重）：遮罩 id 与两张组卡的 id、以及菜单遮罩的 id 互不相撞
    const ids = dom.documentShim.querySelectorAll('.card').map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('')
  })

  it('遮罩铺满视口（零尺寸矩形会被热区滤掉）', () => {
    openConfirmViaMenu()
    const ov = byId(CONFIRM_OVERLAY_ID)!
    expect([ov.style.left, ov.style.top]).toEqual(['0px', '0px'])
    expect([ov.style.width, ov.style.height]).toEqual([`${win.innerWidth}px`, `${win.innerHeight}px`])
  })

  it('对话框摆的就是纯模块算出的那个盒子（落位与画法同源，存证里报的按钮矩形不会与真点到的那一枚分家）', () => {
    openConfirmViaMenu()
    const box = confirmBoxOf(viewport(), ['方案.docx'])
    const dialog = byId(CONFIRM_BOX_ID)!
    expect([dialog.style.left, dialog.style.top]).toEqual([`${box.left}px`, `${box.top}px`])
    expect([dialog.style.width, dialog.style.height]).toEqual([`${box.width}px`, `${box.height}px`])
    expect(box).toEqual(confirmBoxOf(viewport(), ['方案.docx']))
    expect(box.height).toBe(confirmSizeOf(['方案.docx']).height)
    expect(box.top + box.height).toBeLessThanOrEqual(win.innerHeight)
  })

  it('文案 = 标题 + 文件名清单（标题措辞出自纯模块，不在 card.js 里另写）', () => {
    openConfirmViaMenu()
    expect(byId(CONFIRM_TEXT_ID)!.textContent).toBe('DELETE 1 ITEM?\n方案.docx')
  })

  it('两钮在位且各有唯一 id（真机目视与电池按 id 定位）', () => {
    openConfirmViaMenu()
    expect(byId(CONFIRM_OK_ID)!.textContent).toBe('DELETE')
    expect(byId(CONFIRM_CANCEL_ID)!.textContent).toBe('CANCEL')
  })

  it('菜单样式已摘、确认层样式已插：head 里**换**了一枚，不是叠了两枚（#181「装载后 head 恰有一个子节点」的纪律在闭态仍成立）', () => {
    openConfirmViaMenu()
    // 菜单那枚已随关层摘掉，剩下的正是组卡自己的样式 + 确认层这一枚（共两枚）；确认层关掉后回到一枚
    expect(byId(MENU_STYLE_ID)).toBeNull()
    expect(byId(CONFIRM_STYLE_ID)).not.toBeNull()
    expect(dom.head.children).toHaveLength(2)
    expect(byId(STYLE_ID)).not.toBeNull()
    byId(CONFIRM_CANCEL_ID)!.dispatch('click')
    expect(dom.head.children).toHaveLength(1)
  })

  it('铺了撤了都申报热区（撤遮罩不申报，全屏热区会残留到确认层关闭之后）', () => {
    openConfirmViaMenu()
    const afterOpen = h.domChanges.length
    expect(afterOpen).toBeGreaterThan(0)
    byId(CONFIRM_OVERLAY_ID)!.dispatch('click')
    expect(h.domChanges.length).toBe(afterOpen + 1)
  })

  it('确认 → 走内核既有删除契约送回收站，载荷是开层时冻结的选区', () => {
    openConfirmViaMenu()
    byId(CONFIRM_OK_ID)!.dispatch('click')
    expect(writeInvokes()).toEqual([{ method: 'desktop/trash', payload: { paths: ['C:\\me\\方案.docx'] } }])
  })

  it('确认收层后：遮罩、对话框、样式、窗口监听一个都不剩', () => {
    openConfirmViaMenu()
    const keydownBefore = win.listenerCount('keydown')
    expect(keydownBefore).toBeGreaterThan(0)
    byId(CONFIRM_OK_ID)!.dispatch('click')
    expect(byId(CONFIRM_OVERLAY_ID)).toBeNull()
    expect(byId(CONFIRM_BOX_ID)).toBeNull()
    expect(byId(CONFIRM_STYLE_ID)).toBeNull()
    expect(win.listenerCount('keydown')).toBe(keydownBefore - 1)
    expect(dom.head.children).toHaveLength(1)
  })
})

describe('DELETE：取消四路连一次契约调用都没有（票面：取消则无副作用）', () => {
  const CANCELS: Array<[string, () => void]> = [
    ['取消钮', () => byId(CONFIRM_CANCEL_ID)!.dispatch('click')],
    ['Esc', () => pressEsc()],
    ['层外点击', () => byId(CONFIRM_OVERLAY_ID)!.dispatch('click')],
  ]

  for (const [label, cancel] of CANCELS) {
    it(`${label}：没有 desktop/trash，确认层与样式一点不留`, () => {
      openConfirmViaMenu()
      cancel()
      expect(writeInvokes()).toEqual([])
      expect(byId(CONFIRM_OVERLAY_ID)).toBeNull()
      expect(byId(CONFIRM_STYLE_ID)).toBeNull()
      expect(cards()).toHaveLength(2)
      expect(nameOf(docxCard())).toEqual(['方案.docx', '纪要.docx'])
    })
  }

  it('取消存证带原因（真机目视与电池分源用）', () => {
    openConfirmViaMenu()
    byId(CONFIRM_CANCEL_ID)!.dispatch('click')
    expect(h.notes.find((n) => n.type === 'doc-group-cards-confirm-closed')?.payload)
      .toMatchObject({ reason: 'button', count: 1 })
  })

  it('取消不外溢：钮自己 stopPropagation，确认一次不会被层外点击改判成取消', () => {
    openConfirmViaMenu()
    const spy = { n: 0 }
    byId(CONFIRM_OVERLAY_ID)!.addEventListener('click', () => { spy.n += 1 })
    byId(CONFIRM_OK_ID)!.dispatch('click')
    expect(spy.n).toBe(0)
    expect(writeInvokes()).toHaveLength(1)
  })
})

describe('删除成功后：文件从卡上消失，下一拍重新归类后落位正确', () => {
  it('确认删除 → 下一拍快照里没有它了 → 那一格连同标签一起没了', () => {
    openConfirmViaMenu()
    byId(CONFIRM_OK_ID)!.dispatch('click')
    expect(nameOf(docxCard())).toEqual(['方案.docx', '纪要.docx'])

    h.host.view = viewWith([ITEMS[1], ITEMS[2]])
    plugin.update?.(h.host)

    expect(nameOf(docxCard())).toEqual(['纪要.docx'])
    expect(nameOf(pdfCard())).toEqual(['预算.pdf'])
  })

  it('删到空组即整张卡消失（空组不产出，grouping.js 的老规矩）', () => {
    openConfirmViaMenu()
    byId(CONFIRM_OK_ID)!.dispatch('click')
    h.host.view = viewWith([ITEMS[0]])
    plugin.update?.(h.host)
    expect(cards().map((c) => c.id)).toEqual(['dgc-docx'])
  })

  it('改名改了扩展名 → 下一拍重新归类：它从 .docx 那张卡挪到了 .pdf 那张卡上', () => {
    openConfirmViaMenu()
    byId(CONFIRM_OK_ID)!.dispatch('click')
    const renamed: HostDesktopItem = { ...ITEMS[0], name: '方案.pdf', path: 'C:\\me\\方案.pdf' }
    h.host.view = viewWith([renamed, ITEMS[2]])
    plugin.update?.(h.host)
    expect(cards().map((c) => c.id)).toEqual(['dgc-pdf'])
    expect(nameOf(pdfCard())).toEqual(['方案.pdf', '预算.pdf'])
  })
})

describe('RENAME：自建的内联编辑器，提交走内核既有契约', () => {
  it('点 RENAME 行的瞬间零契约调用，编辑器顶替的是格子里的文件名标签', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(docxCard())[0])
    rowById('rename').dispatch('click')
    expect(menuInvokes()).toEqual([])
    const cell = cellsOf(docxCard())[0]
    expect(cell.querySelectorAll(`.${RENAME_INPUT_CLASS}`)).toHaveLength(1)
    // 标签确实被顶掉了（它已不在格子的子树里，格子里此刻只有输入框这一个名字载体）
    expect(cell.querySelectorAll('.dgc-name')).toEqual([])
    expect(nameOf(docxCard())).toEqual(['纪要.docx'])
    expect(renameInput().value).toBe('方案.docx')
  })

  it('输入框宽度取 CELL——与 .dgc-name 的 max-width 同源，故编辑器不改卡框的任何一行内联几何', () => {
    openRenameViaMenu()
    const card = docxCard()
    const before = { w: card.style.width, h: card.style.height, l: card.style.left, t: card.style.top }
    expect(renameInput().style.width).toBe('88px')
    expect(before).toEqual({ w: card.style.width, h: card.style.height, l: card.style.left, t: card.style.top })
  })

  it('提交（Enter）→ desktop/rename，载荷是冻结的条目名与 trim 后的草稿', () => {
    const input = openRenameViaMenu()
    input.value = '  新方案.docx  '
    input.dispatch('keydown', input, { key: 'Enter' })
    expect(writeInvokes()).toEqual([{ method: 'desktop/rename', payload: { name: '方案.docx', to: '新方案.docx' } }])
    expect(byId(PANEL_ID)).toBeNull()
  })

  it('提交后标签原样放回格子里（快照是权威，成功后的新名由下一拍换上）', () => {
    const input = openRenameViaMenu()
    input.value = '新方案.docx'
    input.dispatch('keydown', input, { key: 'Enter' })
    expect(nameOf(docxCard())).toEqual(['方案.docx', '纪要.docx'])
  })

  it('空草稿也照递（命名校验是内核 desktop/rename 的裁决，插件不替它猜）', () => {
    const input = openRenameViaMenu()
    input.value = '   '
    input.dispatch('keydown', input, { key: 'Enter' })
    expect(writeInvokes()).toEqual([{ method: 'desktop/rename', payload: { name: '方案.docx', to: '' } }])
  })
})

describe('RENAME：焦点经键盘档接住（宿主与契约里没有「聚焦某元素」的 API）', () => {
  it('先持档、focus 落在其后：持档那一刻焦点流水还是空的', () => {
    const input = openRenameViaMenu()
    // 菜单那一档先开先关（它是文件菜单的），编辑器那一档后持
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename'])
    // 关键在最后这个 0：持档那一刻焦点流水还空着 —— 档先持、focus 在后
    expect(h.focusAtHold).toEqual([0, 0])
    expect(h.tiers.filter((t) => t === 'hold:rename')).toHaveLength(1)
    expect(focusLog.map((f) => f.tag)).toEqual(['input'])
    expect(focusLog[0].node).toBe(input)
    expect(input.focused).toBe(true)
  })

  it('预选扩展名之前的位置（改名时该被选中的是「名字」不是「后缀」）', () => {
    const input = openRenameViaMenu()
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2])
  })

  it('Esc → 取消：不落盘、标签放回、档放掉', () => {
    const input = openRenameViaMenu()
    input.value = '敲了一半.docx'
    input.dispatch('keydown', input, { key: 'Escape' })
    expect(writeInvokes()).toEqual([])
    expect(nameOf(docxCard())).toEqual(['方案.docx', '纪要.docx'])
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename', 'release:rename'])
  })

  it('点编辑器外 → 取消，且那一击**不**顺手把整卡折起来（收场是编辑器的事，不是折叠切换的事）', () => {
    openRenameViaMenu()
    docxCard().dispatch('click')
    expect(writeInvokes()).toEqual([])
    expect(classesOf(docxCard())).not.toContain(EXPANDED_CLASS)
    expect(nameOf(docxCard())).toEqual(['方案.docx', '纪要.docx'])
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename', 'release:rename'])
  })

  it('点在编辑器里不收场（还要让人接着打字），也不吞掉这次点击', () => {
    openRenameViaMenu()
    const input = renameInput()
    input.dispatch('click')
    expect(rn()).toBe(input)
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename'])
  })
})

/** 编辑器仍在场？ */
function rn(): Element | null {
  return walk(dom.body).find((n) => n.classList.contains(RENAME_INPUT_CLASS)) ?? null
}

describe('RENAME：整排重画时编辑会话收场（格没了，输入框就是悬空的）', () => {
  it('桌面变了 → 编辑器收场、档放掉，且**不**趁最后一刻把半截草稿写进磁盘', () => {
    openRenameViaMenu()
    renameInput().value = '半截.docx'
    h.host.view = viewWith([ITEMS[1], ITEMS[2]])
    plugin.update?.(h.host)
    expect(rn()).toBeNull()
    expect(writeInvokes()).toEqual([])
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename', 'release:rename'])
    expect(h.notes.find((n) => n.type === 'doc-group-cards-rename-closed')?.payload)
      .toMatchObject({ reason: 'rebuild' })
  })
})

describe('键盘档：开层持拿、关闭与卸载必放（不放窗口就一直可聚焦，面板再也点不动）', () => {
  it('确认层：开层持、确认/取消各放一次，且放的是同一个档名', () => {
    openConfirmViaMenu()
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:delete-confirm'])
    byId(CONFIRM_CANCEL_ID)!.dispatch('click')
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:delete-confirm', 'release:delete-confirm'])
  })

  it('编辑器：开层持、提交/取消各放一次', () => {
    const input = openRenameViaMenu()
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename'])
    input.value = 'x.docx'
    input.dispatch('keydown', input, { key: 'Enter' })
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename', 'release:rename'])
  })

  it('持放始终成对：连开连关若干回，档不多持也不少放', () => {
    plugin.mount(h.host)
    const cell = cellsOf(docxCard())[0]
    for (let i = 0; i < 3; i += 1) {
      rightClick(cell)
      rowById('delete').dispatch('click')
      byId(CONFIRM_CANCEL_ID)!.dispatch('click')
      rightClick(cell)
      rowById('rename').dispatch('click')
      renameInput().dispatch('keydown', renameInput(), { key: 'Escape' })
    }
    const holds = h.tiers.filter((t) => t.startsWith('hold:'))
    const releases = h.tiers.filter((t) => t.startsWith('release:'))
    expect(holds.length).toBe(releases.length)
    // 逐档成对（档名互不相同才是真的各放各的；重名会互相顶掉）
    for (const tier of ['menu', 'delete-confirm', 'rename']) {
      expect(holds.filter((t) => t === 'hold:' + tier).length)
        .toBe(releases.filter((t) => t === 'release:' + tier).length)
    }
  })

  it('三层同时开着也不会互相顶掉：档名互不相同（重名会互相顶掉——菜单还开着就放不掉了）', () => {
    openConfirmViaMenu()
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:delete-confirm'])
  })

  it('卸载时确认层开着：静默收场——遮罩/样式/热区/键盘档一样不漏', () => {
    openConfirmViaMenu()
    plugin.unmount?.()
    expect(byId(CONFIRM_OVERLAY_ID)).toBeNull()
    expect(byId(CONFIRM_STYLE_ID)).toBeNull()
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:delete-confirm', 'release:delete-confirm'])
    expect(cards()).toEqual([])
    expect(dom.head.children).toEqual([])
  })

  it('卸载时编辑器开着：输入框放回标签的位置（节点随卡一起走）、档放掉、不落盘', () => {
    openRenameViaMenu()
    renameInput().value = '半截.docx'
    plugin.unmount?.()
    expect(writeInvokes()).toEqual([])
    expect(h.tiers).toEqual(['hold:menu', 'release:menu', 'hold:rename', 'release:rename'])
    expect(rn()).toBeNull()
    expect(dom.head.children).toEqual([])
  })

  it('什么都没开时卸载：不发多余的放档噪声（没持就放是噪声）', () => {
    plugin.mount(h.host)
    plugin.unmount?.()
    expect(h.tiers).toEqual([])
  })

  it('**未释放的档由宿主兜底回收**：插件进程被杀时宿主按插件 id 强制回收（plugins.ts 的 reclaimPlugin）', () => {
    // 本插件不靠它（每条路径都放了），但那条兜底必须真实存在——按内核源码文本钉死，
    // 端到端的那份断言在 tests/renderer/plugin-unmount-reclaim.spec.ts。
    const src = fs.readFileSync(path.join(__dirname, '../../src/renderer/plugins.ts'), 'utf8')
    expect(src).toContain('reclaimPlugin')
    expect(src).toContain('releaseKeyboardTier')
    expect(src).toContain('.reclaim(')
  })
})

describe('组卡菜单骨架：卡片空白右键走的是组卡那条路，不是文件菜单', () => {
  it('空白处右键**不**弹文件菜单（格子上右键才是文件菜单，两条路互不相串）', () => {
    plugin.mount(h.host)
    docxCard().dispatch('contextmenu', docxCard(), { clientX: 100, clientY: 200 })
    expect(byId(PANEL_ID)).toBeNull()
    expect(byId(OVERLAY_ID)).toBeNull()
  })

  it('图标格右键仍然弹文件菜单七项（含本票新增的 RENAME / DELETE）', () => {
    plugin.mount(h.host)
    rightClick(cellsOf(docxCard())[0])
    expect(rowsOf().map((r) => r.dataset.row)).toEqual([
      'open', 'open-location', 'copy-path', 'copy', 'cut', 'rename', 'delete',
    ])
  })

  it('组卡菜单的行表本票是空的，故此刻不出菜单——行表一填即生效（行归工单185/186）', () => {
    plugin.mount(h.host)
    const before = h.notes.filter((n) => n.type === 'doc-group-cards-menu-opened').length
    docxCard().dispatch('contextmenu', docxCard(), { clientX: 100, clientY: 200 })
    expect(h.notes.filter((n) => n.type === 'doc-group-cards-menu-opened')).toHaveLength(before)
    expect(byId(OVERLAY_ID)).toBeNull()
  })

  it('空白处右键不误触折叠切换（右键不是点空白——那条路归 click）', () => {
    plugin.mount(h.host)
    docxCard().dispatch('contextmenu', docxCard(), { clientX: 100, clientY: 200 })
    expect(classesOf(docxCard())).not.toContain(EXPANDED_CLASS)
  })
})
