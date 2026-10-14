/**
 * 两块自绘写操作层的**纯裁决**（工单183 = spec166 之⑥）。
 *
 * 钉的是裁决而非接线：什么时候弹、弹出来什么、按哪个键干什么、键盘档什么时候持什么时候放、
 * 一个事件该产生哪些副作用、以及**取消为什么必然没有副作用**。接线（遮罩真的铺了、焦点真的
 * 落到位、申报没申报、卸载摘了哪些节点）在 doc-group-cards-writeops-dom.spec.ts 里钉。
 *
 * 本文件另外钉三样跨缝的东西：
 *   - 键盘档为什么能让内核的六键与 Esc 让位——直接拿内核的**真归约器**（keyboard-gate.ts，纯逻辑）
 *     跑一遍本插件的档名，而不是嘴说「让位」；
 *   - 文件菜单新加的两行落在哪、needs 档是什么；
 *   - 组卡菜单的骨架：行表一填就能出菜单（工单185/186 的接缝），且本票不含 PASTE。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  escapePlan,
  keyRoutingContextOf,
  nextKeyboardGate,
  routeSelectionKey,
} from '../../src/renderer/keyboard-gate'
import { isGroupMenuHit } from '../../plugins/doc-group-cards/interaction'
import {
  CLOSED_MENU,
  FILE_MENU_ROWS,
  GROUP_CARD_MENU_ROWS,
  KEYBOARD_TIER,
  NEED_ANY,
  NEED_PASTEABLE,
  NEED_SINGLE,
  nextMenuShell,
  resolveMenuRows,
} from '../../plugins/doc-group-cards/menu'
import {
  CLOSED_CONFIRM,
  CLOSED_RENAME,
  CONFIRM_BTN_H,
  CONFIRM_KEYBOARD_TIER,
  CONFIRM_LINE_H,
  CONFIRM_MODE_DISSOLVE,
  CONFIRM_MODE_TRASH,
  CONFIRM_PAD_Y,
  CONFIRM_W,
  RENAME_KEYBOARD_TIER,
  confirmBoxOf,
  confirmLinesOf,
  confirmOkLabelOf,
  confirmSizeOf,
  confirmTitleOf,
  nextConfirmLayer,
  nextRenameEditor,
  renameCssOf,
  stemEndOf,
  type ConfirmEvent,
  type ConfirmState,
  type RenameEvent,
  type RenameState,
} from '../../plugins/doc-group-cards/writeops'

const PLUGIN_DIR = path.join(__dirname, '../../plugins/doc-group-cards')

/** 面板窗 = 主显示器全屏 bounds（含任务栏占位） */
const VIEWPORT = { width: 2560, height: 1440 }

const DOCX = '方案.docx'
const PDF = '预算.pdf'
const PATHS = [`C:\\me\\${DOCX}`]

// ---------------------------------------------------------------------------

const kinds = (effects: ReadonlyArray<{ kind: string }>) => effects.map((e) => e.kind)

/** 一个效果表里的全部「写动作」效果——两侧（确认层 / 编辑器 / 菜单壳）共用，故只按 kind 收 */
type AnyRun = { kind: 'run' } & Record<string, unknown>
const runs = (effects: ReadonlyArray<{ kind: string }>): AnyRun[] =>
  effects.filter((e): e is AnyRun => e.kind === 'run')

/** 走一层：闭态 + 一个事件 → 结果 */
function confirm(event: ConfirmEvent, state: ConfirmState = CLOSED_CONFIRM) {
  return nextConfirmLayer(state, event, VIEWPORT)
}

/** 走一层：闭态 + 一个事件 → 结果 */
function rename(event: RenameEvent, state: RenameState = CLOSED_RENAME) {
  return nextRenameEditor(state, event)
}

// ---------------------------------------------------------------------------

describe('删除确认层：开层（工单183：DELETE 前必须先问过用户）', () => {
  it('开层的效果次序即纪律：档先持 → 建 DOM → 申报热区 → 存证', () => {
    const { effects } = confirm({ type: 'open', names: [DOCX], paths: PATHS })
    expect(kinds(effects)).toEqual(['tier', 'show', 'hotzones', 'notify'])
    expect(effects[0]).toEqual({ kind: 'tier', held: true })
  })

  it('**开层不发任何写动作**：效果表里根本没有 run —— 「先问过用户」是结构事实', () => {
    const { effects } = confirm({ type: 'open', names: [DOCX], paths: PATHS })
    expect(runs(effects)).toEqual([])
  })

  it('开层时冻结清单：桌面此后怎么变，确认层要删的仍是开层那一份', () => {
    const { state } = confirm({ type: 'open', names: [DOCX], paths: PATHS })
    // 工单186 起确认层多带一个用途（mode，默认 trash）与一个解散目标（cardId，trash 恒空串）
    expect(state).toEqual({ open: true, mode: CONFIRM_MODE_TRASH, names: [DOCX], paths: PATHS, cardId: '' })
    // 入参被原样拷进去：调用方之后再往数组里塞东西也影响不到已冻结的状态
    const src = [DOCX]
    const frozen = confirm({ type: 'open', names: src, paths: src }).state
    src.push(PDF)
    expect(runs(confirm({ type: 'confirm' }, frozen).effects)[0].paths).toEqual([DOCX])
  })

  it('空清单不开层（没有可确认的东西时弹一只空框毫无意义）', () => {
    const { state, effects } = confirm({ type: 'open', names: [], paths: [] })
    expect(state).toBe(CLOSED_CONFIRM)
    expect(effects).toEqual([])
  })

  it('已在层里时再 open 不重入（与内核 openTrashConfirm 的早退同款）', () => {
    const opened = confirm({ type: 'open', names: [DOCX], paths: PATHS }).state
    const { state, effects } = confirm({ type: 'open', names: [PDF], paths: [PDF] }, opened)
    expect(effects).toEqual([])
    expect(state).toBe(opened)
  })
})

describe('删除确认层：确认 = 唯一会产生写动作的那一路', () => {
  it('确认：撤层 → 重申报热区 → 放档 → 送回收站 → 存证（动作在层已收之后）', () => {
    const opened = confirm({ type: 'open', names: [DOCX], paths: PATHS }).state
    const { state, effects } = confirm({ type: 'confirm' }, opened)
    expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier', 'run', 'notify'])
    expect(state).toBe(CLOSED_CONFIRM)
    expect(effects[2]).toEqual({ kind: 'tier', held: false })
    expect(runs(effects)).toEqual([{ kind: 'run', op: 'trash', paths: PATHS, cardId: '' }])
  })

  it('送回收站走的是内核既有契约 desktop/trash（插件不自己 shell.trashItem）', () => {
    const opened = confirm({ type: 'open', names: [DOCX], paths: PATHS }).state
    expect(runs(confirm({ type: 'confirm' }, opened).effects)[0].op).toBe('trash')
  })
})

describe('删除确认层：取消四路一律无副作用（票面验收：取消则无副作用）', () => {
  const opened = confirm({ type: 'open', names: [DOCX], paths: PATHS }).state
  const CANCELS: Array<[string, ConfirmEvent]> = [
    ['取消钮', { type: 'cancel', reason: 'button' }],
    ['Esc', { type: 'esc' }],
    ['点层外', { type: 'outside' }],
    ['整排重画（条目没了）', { type: 'cancel', reason: 'rebuild' }],
  ]

  for (const [label, event] of CANCELS) {
    it(`${label}：没有 run —— 即没有 desktop/trash，也就没有任何落盘动作`, () => {
      const { state, effects } = confirm(event, opened)
      expect(runs(effects)).toEqual([])
      expect(state).toBe(CLOSED_CONFIRM)
      // 一样要收干净：撤层、重申报热区、放档（档不放窗口就一直可聚焦）
      expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier', 'notify'])
      expect(effects[2]).toEqual({ kind: 'tier', held: false })
    })
  }

  it('闭态下的取消/确认是迟到噪声（无转移、无效果；没持就放是噪声）', () => {
    for (const event of CANCELS.map(([, e]) => e).concat([{ type: 'confirm' } as ConfirmEvent])) {
      const { state, effects } = confirm(event)
      expect(effects).toEqual([])
      expect(state).toBe(CLOSED_CONFIRM)
    }
  })
})

describe('确认层的几何与文案（居中、算出即画出）', () => {
  it('标题单复数与内核同款措辞', () => {
    expect(confirmTitleOf([DOCX])).toBe('DELETE 1 ITEM?')
    expect(confirmTitleOf([DOCX, PDF])).toBe('DELETE 2 ITEMS?')
  })

  it('行数 = 标题一行 + 文件名每件一行；空清单也按一行算（盒子不塌成 0 高）', () => {
    expect(confirmLinesOf([DOCX])).toBe(2)
    expect(confirmLinesOf([DOCX, PDF])).toBe(3)
    expect(confirmLinesOf([])).toBe(2)
  })

  it('尺寸 = 上内边距 + 行数 × 行高 + 间距 + 按钮行高 + 下内边距（与 CSS 里插的是同一批常量）', () => {
    expect(confirmSizeOf([DOCX])).toEqual({
      width: CONFIRM_W,
      height: 2 * CONFIRM_PAD_Y + 2 * CONFIRM_LINE_H + 10 + CONFIRM_BTN_H,
    })
  })

  it('落位在视口正中，且整只盒子落在视口内（存证里报的按钮矩形与用户真点到的那一枚同源）', () => {
    const box = confirmBoxOf(VIEWPORT, [DOCX])
    expect(box.left).toBe(Math.round((VIEWPORT.width - box.width) / 2))
    expect(box.top).toBe(Math.round((VIEWPORT.height - box.height) / 2))
    expect(box.left + box.width).toBeLessThanOrEqual(VIEWPORT.width)
    expect(box.top + box.height).toBeLessThanOrEqual(VIEWPORT.height)
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.top).toBeGreaterThanOrEqual(0)
  })
})

describe('内联重命名编辑器：开层（工单183：RENAME 必须是自建的）', () => {
  it('开层的效果次序即纪律：档先持 → 建 DOM（focus 在 show 里）→ 存证，**不申报热区**', () => {
    const { effects } = rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX })
    expect(kinds(effects)).toEqual(['tier', 'show', 'notify'])
    expect(effects[0]).toEqual({ kind: 'tier', held: true })
    // 不申报是对的：编辑器顶替的是格子里的标签，卡框那两行内联几何一字未动，
    // 热区扫掠读到的 getBoundingClientRect() 就没变（申报当且仅当矩形变了）。
    expect(kinds(effects)).not.toContain('hotzones')
  })

  it('预选扩展名之前的位置：预算.pdf → 2（改名时该被选中的是「名字」不是「后缀」）', () => {
    expect(stemEndOf('预算.pdf')).toBe(2)
    expect(stemEndOf('a.b.c')).toBe(3)
    // 无扩展名 / 点在第 0 位（隐藏文件）都算无扩展名，选中全文——与 grouping.extOf 同一口径
    expect(stemEndOf('README')).toBe(6)
    expect(stemEndOf('.gitignore')).toBe(10)
  })

  it('开层把显示名写进草稿，并把条目身份一并冻结', () => {
    const { state, effects } = rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX })
    expect(state).toEqual({ open: true, name: DOCX, path: PATHS[0], draft: DOCX, stem: stemEndOf(DOCX) })
    expect(effects[1]).toMatchObject({ kind: 'show', path: PATHS[0], value: DOCX, stem: stemEndOf(DOCX) })
  })

  it('开层不发任何写动作', () => {
    expect(runs(rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX }).effects)).toEqual([])
  })

  it('已在编辑时再 open 不重入（与内核 beginRename 同款）', () => {
    const opened = rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX }).state
    const { state, effects } = rename({ type: 'open', name: PDF, path: 'C:\\me\\预算.pdf', display: PDF }, opened)
    expect(effects).toEqual([])
    expect(state).toBe(opened)
  })
})

describe('内联重命名编辑器：提交走内核契约，取消不落盘', () => {
  const opened = rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX }).state
  /** 用户把草稿敲成了别的样子 */
  const typed = (draft: string): RenameState => ({ ...opened, draft })

  it('提交：撤层 → 放档 → desktop/rename → 存证；载荷是 trim 后的草稿', () => {
    const { state, effects } = rename({ type: 'submit' }, typed('  新方案.docx  '))
    expect(kinds(effects)).toEqual(['hide', 'tier', 'run', 'notify'])
    expect(state).toBe(CLOSED_RENAME)
    expect(effects[1]).toEqual({ kind: 'tier', held: false })
    expect(runs(effects)).toEqual([{ kind: 'run', op: 'rename', name: DOCX, to: '新方案.docx' }])
  })

  it('提交按**冻结的条目名**走（desktop/rename 是 name-keyed 护栏，名字不能从路径反推）', () => {
    expect(runs(rename({ type: 'submit' }, typed('别的.docx')).effects)[0]).toMatchObject({ name: DOCX })
  })

  it('空草稿也照递：**命名校验不在本插件重写**——空串/非法字符/同名冲突都是内核 desktop/rename 的裁决', () => {
    // 插件替内核判就是两份规则各自漂移的第一现场；这里钉死「原样递过去」
    expect(runs(rename({ type: 'submit' }, typed('   ')).effects)[0]).toMatchObject({ name: DOCX, to: '' })
  })

  const CANCELS: Array<[string, RenameEvent]> = [
    ['Esc', { type: 'esc' }],
    ['点编辑器外', { type: 'outside' }],
    ['改去编辑别的一件', { type: 'cancel', reason: 'reopen' }],
    ['整排重画（格没了）', { type: 'cancel', reason: 'rebuild' }],
  ]

  for (const [label, event] of CANCELS) {
    it(`${label}：没有 run —— 即没有 desktop/rename，也就没有任何落盘动作`, () => {
      const { state, effects } = rename(event, typed('敲了一半.docx'))
      expect(runs(effects)).toEqual([])
      expect(state).toBe(CLOSED_RENAME)
      expect(kinds(effects)).toEqual(['hide', 'tier', 'notify'])
      expect(effects[1]).toEqual({ kind: 'tier', held: false })
    })
  }

  it('闭态下的提交/取消是迟到噪声', () => {
    for (const event of CANCELS.map(([, e]) => e).concat([{ type: 'submit' } as RenameEvent])) {
      const { state, effects } = rename(event)
      expect(effects).toEqual([])
      expect(state).toBe(CLOSED_RENAME)
    }
  })
})

describe('卸载：静默收场（通道随插件消亡，但键盘档一样不漏）', () => {
  it('确认层开着时 unmount：撤层、重申报、放档，且**不发存证**', () => {
    const opened = confirm({ type: 'open', names: [DOCX], paths: PATHS }).state
    const { state, effects } = confirm({ type: 'unmount' }, opened)
    expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier'])
    expect(effects[2]).toEqual({ kind: 'tier', held: false })
    expect(state).toBe(CLOSED_CONFIRM)
  })

  it('编辑器开着时 unmount：撤层、放档（不重申报——它没改过矩形），且**不发存证**', () => {
    const opened = rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX }).state
    const { state, effects } = rename({ type: 'unmount' }, opened)
    expect(kinds(effects)).toEqual(['hide', 'tier'])
    expect(effects[1]).toEqual({ kind: 'tier', held: false })
    expect(state).toBe(CLOSED_RENAME)
  })

  it('两层都没开时 unmount：零效果（没持就放是噪声）', () => {
    expect(confirm({ type: 'unmount' }).effects).toEqual([])
    expect(rename({ type: 'unmount' }).effects).toEqual([])
  })

  it('卸载**不**产生写动作（最后一刻也不偷偷落盘）', () => {
    const c = confirm({ type: 'unmount' }, confirm({ type: 'open', names: [DOCX], paths: PATHS }).state)
    const r = rename({ type: 'unmount' }, rename({ type: 'open', name: DOCX, path: PATHS[0], display: DOCX }).state)
    expect(runs(c.effects)).toEqual([])
    expect(runs(r.effects)).toEqual([])
  })
})

describe('键盘档：为什么持档期间内核的六键与 Esc 拦截双双让位（不是嘴说，拿内核归约器跑一遍）', () => {
  /** 把本插件的档名按宿主那一侧的命名规则灌进内核的门控（plugins.ts 转交时已带插件 id 命名空间） */
  function gateHolding(tier: string) {
    let gate = nextKeyboardGate(
      { on: false, selectionNonEmpty: false, overlays: [], tiers: [] },
      { type: 'tier-acquired', name: `plugin:doc-group-cards:${tier}` },
    ).state
    // 顺带把「内核选区非空」这一路也点着——那才是六键本来会抢键盘的场景
    gate = nextKeyboardGate(gate, { type: 'selection', nonEmpty: true }).state
    return gate
  }

  for (const tier of [CONFIRM_KEYBOARD_TIER, RENAME_KEYBOARD_TIER, KEYBOARD_TIER]) {
    it(`档「${tier}」在持 → 键盘归本插件：六键不接管、Esc 不拦`, () => {
      const gate = gateHolding(tier)
      const ctx = keyRoutingContextOf(gate, false)
      expect(ctx.overlayOpen).toBe(true)
      // 六键（Del/Enter/Ctrl+A/C/X/V）全部放行
      expect(routeSelectionKey('Delete', false, ctx)).toBeNull()
      expect(routeSelectionKey('Enter', false, ctx)).toBeNull()
      expect(routeSelectionKey('a', true, ctx)).toBeNull()
      expect(routeSelectionKey('c', true, ctx)).toBeNull()
      expect(routeSelectionKey('x', true, ctx)).toBeNull()
      expect(routeSelectionKey('v', true, ctx)).toBeNull()
      // Esc 定序：浮层/档优先 → 双否，内核那段捕获监听放行不拦
      expect(escapePlan(ctx)).toEqual({ closeMenu: false, clearSelection: false })
    })
  }

  it('档不在持时六键照旧接管（反例钉死：上面的放行确实是档带来的，不是内核本来就放行）', () => {
    const gate = nextKeyboardGate(
      { on: false, selectionNonEmpty: false, overlays: [], tiers: [] },
      { type: 'selection', nonEmpty: true },
    ).state
    const ctx = keyRoutingContextOf(gate, false)
    expect(ctx.overlayOpen).toBe(false)
    expect(routeSelectionKey('Delete', false, ctx)).toBe('delete')
    expect(escapePlan(ctx).clearSelection).toBe(true)
  })

  it('三个档名互不相同（档是具名占用的，重名会互相顶掉——菜单还开着就放不掉了）', () => {
    expect(new Set([KEYBOARD_TIER, CONFIRM_KEYBOARD_TIER, RENAME_KEYBOARD_TIER]).size).toBe(3)
  })

  it('档名是自由文本且宿主会加命名空间：插件自己不加前缀（加了就成了 plugin:doc-group-cards:plugin:…）', () => {
    for (const tier of [KEYBOARD_TIER, CONFIRM_KEYBOARD_TIER, RENAME_KEYBOARD_TIER]) {
      expect(tier).not.toContain(':')
      expect(tier.trim()).toBe(tier)
    }
  })
})

describe('文件菜单新增的两行（工单183 往 FILE_MENU_ROWS 里加）', () => {
  const ids = FILE_MENU_ROWS.map((r) => r.id)
  const specOf = (id: string) => FILE_MENU_ROWS.find((r) => r.id === id)!

  it('恰好七项，末尾两行即 RENAME / DELETE（spec166「菜单（自绘外壳）」的顺序）', () => {
    expect(FILE_MENU_ROWS.map((r) => [r.id, r.label])).toEqual([
      ['open', 'OPEN'],
      ['open-location', 'OPEN LOCATION'],
      ['copy-path', 'COPY PATH'],
      ['copy', 'COPY'],
      ['cut', 'CUT'],
      ['rename', 'RENAME'],
      ['delete', 'DELETE'],
    ])
    expect(ids.slice(5)).toEqual(['rename', 'delete'])
  })

  it('RENAME 走 needs:"single"：desktop/rename 是按名一对一改的，多选天然无解（工单184 落地即自然置灰）', () => {
    expect(specOf('rename').needs).toBe(NEED_SINGLE)
    expect(resolveMenuRows([specOf('rename')], { paths: [] })[0].enabled).toBe(true)
    expect(resolveMenuRows([specOf('rename')], { paths: ['a', 'b'] })[0].enabled).toBe(false)
  })

  it('DELETE 走 needs:"any"：desktop/trash 是整批且全有全无，内核的 Del 在多选下也是弹确认层整批送回收站', () => {
    expect(specOf('delete').needs).toBe(NEED_ANY)
    expect(resolveMenuRows([specOf('delete')], { paths: ['a', 'b'] })[0].enabled).toBe(true)
  })

  it('单选态下两行都可用（此刻只有单选，多选那张票才让两行的差别显形）', () => {
    const rows = resolveMenuRows(FILE_MENU_ROWS, { paths: PATHS })
    expect(rows.every((r) => r.enabled)).toBe(true)
  })
})

describe('解散确认层（工单186：复用删除确认层那块壳与那张效果表，只多一个 mode）', () => {
  const opened = confirm({
    type: 'open',
    mode: CONFIRM_MODE_DISSOLVE,
    cardId: 'dgc-t2',
    names: ['临时 10-15 21:04 02', '杂.zip'],
    paths: ['C:\\me\\杂.zip'],
  }).state

  it('开层门槛不同：解散要**目标卡**（没有定义可删时无从谈起），没有目标就不开层', () => {
    expect(opened.open).toBe(true)
    expect(confirm({ type: 'open', mode: CONFIRM_MODE_DISSOLVE, names: ['卡'], paths: [] })).toEqual({ state: CLOSED_CONFIRM, effects: [] })
  })

  it('标题与钮字是**解散**的措辞，不套用 DELETE（那会骗用户以为要删文件）', () => {
    expect(confirmTitleOf(['临时 10-15 21:04 02'], CONFIRM_MODE_DISSOLVE)).toBe('DISSOLVE CARD?')
    expect(confirmOkLabelOf(CONFIRM_MODE_DISSOLVE)).toBe('DISSOLVE')
    expect(confirmTitleOf([DOCX])).toBe('DELETE 1 ITEM?')
    expect(confirmOkLabelOf(CONFIRM_MODE_TRASH)).toBe('DELETE')
  })

  it("确认 → run 是 {op:'dissolve', cardId}：**零个 desktop/trash**（删的是定义，不是文件）", () => {
    const { state, effects } = confirm({ type: 'confirm' }, opened)
    expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier', 'run', 'notify'])
    expect(state).toBe(CLOSED_CONFIRM)
    expect(runs(effects)).toEqual([{ kind: 'run', op: 'dissolve', paths: ['C:\\me\\杂.zip'], cardId: 'dgc-t2' }])
    // 载荷里只有归属信息，**没有一个路径字段是给内核搬文件用的**（card.js 收到后只改组定义）
    expect(Object.keys(runs(effects)[0]).sort()).toEqual(['cardId', 'kind', 'op', 'paths'])
  })

  it('**取消三路（confirm 之外的一切）一律无副作用**：一张卡都不删', () => {
    for (const event of [{ type: 'cancel', reason: 'button' }, { type: 'esc' }, { type: 'outside' }] as ConfirmEvent[]) {
      const { state, effects } = confirm(event, opened)
      expect(runs(effects), event.type).toEqual([])
      expect(state).toBe(CLOSED_CONFIRM)
    }
  })

  it('闭态下的取消 / 确认是迟到噪声（无转移、无效果）', () => {
    expect(confirm({ type: 'confirm' }, CLOSED_CONFIRM).effects).toEqual([])
    expect(confirm({ type: 'cancel', reason: 'x' }, CLOSED_CONFIRM).effects).toEqual([])
  })

  it('卸载静默收场：遮罩 / 热区 / 键盘档一样不漏地收回', () => {
    const { state, effects } = confirm({ type: 'unmount' }, opened)
    expect(state).toBe(CLOSED_CONFIRM)
    expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier'])
    expect(runs(effects)).toEqual([])
  })
})

describe('组卡菜单（卡片空白右键；工单185 填 NEW GROUP / EDIT TYPES，工单186 再填 PASTE / DISSOLVE）', () => {  it('工单186 补齐 PASTE / DISSOLVE，四行齐了，顺序即 spec166「菜单（自绘外壳）」那一节', () => {
    expect(GROUP_CARD_MENU_ROWS.map((r) => r.id)).toEqual(['paste', 'new-group', 'edit-types', 'dissolve'])
    expect(GROUP_CARD_MENU_ROWS.map((r) => r.label)).toEqual(['PASTE', 'NEW GROUP', 'EDIT TYPES', 'DISSOLVE'])
  })

  it('PASTE 走 needs:pasteable（按剪贴板实况置灰），且**恒可见**——任何一张卡都能接粘贴', () => {
    const paste = GROUP_CARD_MENU_ROWS[0]
    expect(paste.needs).toBe(NEED_PASTEABLE)
    expect(paste.visibleWhen).toBeUndefined()
    expect(resolveMenuRows(GROUP_CARD_MENU_ROWS, { paths: [], cardId: 'dgc-docx', cardKind: 'builtin' }).map((r) => r.id))
      .toEqual(['paste'])
  })

  it('另外三行都带 visibleWhen（可见性裁决只有 rowVisibleOf 一个出口，渲染端不判）', () => {
    expect(GROUP_CARD_MENU_ROWS.slice(1).every((r) => typeof r.visibleWhen === 'function')).toBe(true)
  })

  it('行一填即生效，无需改渲染端：同一副壳、同一套裁决，只换行表与上下文', () => {
    // 拿组卡菜单该有的形状（工单186 的 DISSOLVE）走一遍：出菜单、可见、带 cardId、动作带回 cardId
    const specs = [{ id: 'dissolve', label: 'DISSOLVE' }]
    const { state, effects } = nextMenuShell(CLOSED_MENU, {
      type: 'open', x: 10, y: 20, viewport: VIEWPORT, specs, ctx: { paths: [], cardId: 'dgc-docx' },
    })
    expect(state.open).toBe(true)
    expect(state.cardId).toBe('dgc-docx')
    expect(kinds(effects)).toEqual(['keyboard-tier', 'show', 'hotzones', 'notify'])
    const activated = nextMenuShell(state, { type: 'activate', id: 'dissolve' })
    expect(runs(activated.effects)).toEqual([{ kind: 'run', id: 'dissolve', paths: [], cardId: 'dgc-docx' }])
  })

  it('文件菜单开层时 cardId 为空串（它是文件菜单，不是组卡菜单）', () => {
    const { state } = nextMenuShell(CLOSED_MENU, {
      type: 'open', x: 0, y: 0, viewport: VIEWPORT, specs: FILE_MENU_ROWS, ctx: { paths: PATHS },
    })
    expect(state.cardId).toBe('')
  })

  it('「一可见行都没有就不弹」的规则原样保留：固有扩展组卡上只剩 PASTE 一行（工单185 登记的后果被化解一半）', () => {
    // 工单182 钉死的规则一个字没动。固有扩展组卡是规则生成的，不该被手改，故 NEW GROUP /
    // EDIT TYPES / DISSOLVE 三行都不可见；工单186 的 PASTE 行**恒可见**，于是那张卡上从
    // 「零可见行 → 不出菜单」变成「出一只只有 PASTE 的菜单」。仍不是空壳，故照弹。
    const { state, effects } = nextMenuShell(CLOSED_MENU, {
      type: 'open', x: 0, y: 0, viewport: VIEWPORT, specs: GROUP_CARD_MENU_ROWS, ctx: { paths: [], cardId: 'dgc-docx', cardKind: 'builtin' },
    })
    const rows = resolveMenuRows(GROUP_CARD_MENU_ROWS, { paths: [], cardId: 'dgc-docx', cardKind: 'builtin' })
    expect(rows.map((r) => r.id)).toEqual(['paste'])
    expect(rows[0].enabled).toBe(false) // 没给剪贴板实况 → 查不到即置灰，绝不误使能
    expect(state.open).toBe(true)
    expect(kinds(effects)).toEqual(['keyboard-tier', 'show', 'hotzones', 'notify'])
  })

  it('**同一个壳**在手改得动的卡上就弹得出来了（行到即生效，渲染端一行不改）', () => {
    const ctx = { paths: [], cardId: 'dgc-c1', cardKind: 'custom' as const, pasteable: true }
    expect(resolveMenuRows(GROUP_CARD_MENU_ROWS, ctx).map((r) => r.id)).toEqual(['paste', 'new-group', 'edit-types', 'dissolve'])
    const { state, effects } = nextMenuShell(CLOSED_MENU, {
      type: 'open', x: 10, y: 20, viewport: VIEWPORT, specs: GROUP_CARD_MENU_ROWS, ctx,
    })
    expect(state.open).toBe(true)
    expect(kinds(effects)).toEqual(['keyboard-tier', 'show', 'hotzones', 'notify'])
  })

  it('卡片空白/徽标命中才开组卡菜单；图标格命中不开（那道闸与折叠切换同源，在 interaction.js）', () => {
    expect(isGroupMenuHit('card-blank')).toBe(true)
    expect(isGroupMenuHit('more')).toBe(true)
    expect(isGroupMenuHit('icon')).toBe(false)
    expect(isGroupMenuHit('outside')).toBe(false)
  })
})

describe('零依赖（投放型插件包的纪律：只 import 自己目录里的相对模块）', () => {
  const SOURCES = ['card.js', 'writeops.js'].map((f) => ({ f, s: fs.readFileSync(path.join(PLUGIN_DIR, f), 'utf8') }))

  /** 剥掉注释只看代码：注释里当然可以解释为什么不自建删除，代码里出现才是自建 */
  function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }

  it('只 import 自己目录里的相对模块（跨目录 import 即意味着依赖别的包或内核源码）', () => {
    const specs = SOURCES.flatMap(({ s }) => [...codeOnly(s).matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]))
    expect(specs.length).toBeGreaterThan(0)
    expect(specs.filter((spec) => !spec.startsWith('./'))).toEqual([])
  })

  it('反面钉死：写操作两层的裁决真的在 writeops.js 里，入口没自己另写一份', () => {
    const card = SOURCES.find(({ f }) => f === 'card.js')?.s ?? ''
    expect(card).toContain("from './writeops.js'")
    expect(card).toContain('nextConfirmLayer')
    expect(card).toContain('nextRenameEditor')
    // 插件里不出现 shell.trashItem / fs 之类的自建删除与改名实现（只看代码，注释可以解释为什么不自建）
    expect(codeOnly(card)).not.toMatch(/shell\.trashItem|writeFileSync|fs\.rename/)
  })

  it('编辑器样式的作用域根由调用方给（不写死，也不写成样式元素自己的 id——那种写法整表哑规则）', () => {
    const css = renameCssOf('.dgc-card')
    expect(css).toContain('.dgc-card .dgc-rename-input')
    expect(css).not.toContain('#dgc-style')
  })
})
