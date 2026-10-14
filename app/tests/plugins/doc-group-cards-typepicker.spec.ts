/**
 * 「接受的类型」勾选浮层的**纯裁决**（工单185 = spec166 之⑧）。
 *
 * 与 doc-group-cards-writeops.spec.ts 同款分工：那份钉删除确认层与内联重命名编辑器，这份钉勾选
 * 浮层——同样是自绘浮层的**转移矩阵**（状态 + 一个事件一次合成 + 效果数组按序执行），同样零 DOM
 * 零 Electron 直接 import 被测实现。
 *
 * 本份钉的是：
 *   - 列表**只**来自桌面上此刻真实存在的扩展名（不存在的类型不列——列了也没文件可放）；
 *   - 顶部「接受全部类型」开关：打开时逐项勾选一律无效果（宽卡不必逐个勾）；
 *   - NEW GROUP 要起名，空名**不产生**落库动作（不是一句承诺，是效果表的结构事实）；
 *   - EDIT TYPES 改的是「接受哪些类型」，不动卡名；
 *   - 取消四路（submit 之外的一切）一律不产生落库动作。
 */
import { describe, expect, it } from 'vitest'
import {
  CLOSED_TYPES,
  PICKER_MAX_ROWS,
  TYPE_CLOSED_NOTIFY,
  TYPE_OPENED_NOTIFY,
  checkedOf,
  isPicked,
  nextTypePicker,
  typePickerBoxOf,
  typePickerSizeOf,
  type TypePickerState,
} from '../../plugins/doc-group-cards/typepicker'

const VIEWPORT = { width: 2560, height: 1440 }

/** 桌面上此刻真实存在的三个类型（无扩展名组也在列：它同样有归属可勾） */
const PRESENT = [
  { ext: '.aaa', label: 'AAA' },
  { ext: '.docx', label: 'DOCX' },
  { ext: '', label: 'NO EXTENSION' },
]

function kinds(effects: Array<{ kind: string }>): string[] {
  return effects.map((e) => e.kind)
}

function runs(effects: Array<{ kind: string }>): Array<Record<string, unknown>> {
  return effects.filter((e) => e.kind === 'run').map((e) => e as unknown as Record<string, unknown>)
}

function notices(effects: Array<{ kind: string; type?: string }>): string[] {
  return effects.filter((e) => e.kind === 'notify').map((e) => e.type ?? '')
}

/** 开层之后连按几个事件（省得每条用例都从 CLOSED_TYPES 手工串一遍） */
function opened(event: Parameters<typeof nextTypePicker>[1]): TypePickerState {
  return nextTypePicker(CLOSED_TYPES, event, VIEWPORT).state
}

function editPicked(exts: string[], acceptAll = false): TypePickerState {
  return opened({ type: 'edit', cardId: 'dgc-c1', label: '合同', exts, acceptAll, present: PRESENT })
}

function createPicked(name = ''): TypePickerState {
  return nextTypePicker(opened({ type: 'create', present: PRESENT }), { type: 'set-name', name }, VIEWPORT).state
}

// ---------------------------------------------------------------------------

describe('几何：尺寸与居中只有一个出处（热区取 getBoundingClientRect，CSS 与 JS 必须同源）', () => {
  it('盒子高度随行数增长；行数再多也只按可见上限算（超出部分滚动，不把盒子撑出视口）', () => {
    const few = typePickerSizeOf({ present: PRESENT, mode: 'edit' })
    const many = typePickerSizeOf({ present: Array.from({ length: 40 }, (_, i) => ({ ext: `.e${i}`, label: `E${i}` })), mode: 'edit' })
    expect(few.height).toBeLessThan(many.height)
    // 40 行与 99 行同高：都按可见上限算，不再长
    expect(many.height).toBe(typePickerSizeOf({ present: Array.from({ length: 99 }, () => ({ ext: '.x', label: 'X' })), mode: 'edit' }).height)
    // 每多一行恰好长出一个行高（尺寸算式与 CSS 里插值的是同一批常量）
    const one = typePickerSizeOf({ present: PRESENT, mode: 'edit' })
    const two = typePickerSizeOf({ present: [...PRESENT, { ext: '.zzz', label: 'ZZZ' }], mode: 'edit' })
    expect(two.height - one.height).toBeGreaterThan(0)
  })

  it('NEW GROUP 比 EDIT TYPES 多一行名字输入框（建卡要起名，编辑不改名）', () => {
    const created = typePickerSizeOf({ present: PRESENT, mode: 'create' })
    const edited = typePickerSizeOf({ present: PRESENT, mode: 'edit' })
    expect(created.height).toBeGreaterThan(edited.height)
  })

  it('落位是视口正中，与删除确认层同款口径（面板窗本就是主显示器全屏 bounds）', () => {
    const box = typePickerBoxOf(VIEWPORT, { present: PRESENT, mode: 'create' })
    const size = typePickerSizeOf({ present: PRESENT, mode: 'create' })
    expect(box).toMatchObject({ width: size.width, height: size.height })
    expect(box.left).toBe(Math.round((VIEWPORT.width - size.width) / 2))
    expect(box.top).toBe(Math.round((VIEWPORT.height - size.height) / 2))
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.top).toBeGreaterThanOrEqual(0)
  })
})

describe('列表：只列桌面上此刻真实存在的扩展名（工单185）', () => {
  it('开层时冻结那一份清单（勾到一半桌面变了也按冻结这份走，绝不把中途新增的件搭车算进来）', () => {
    const state = opened({ type: 'create', present: PRESENT })
    expect(state.present).toEqual(PRESENT)

    const later = nextTypePicker(state, { type: 'toggle', ext: '.zzz' }, VIEWPORT).state
    expect(later.present).toEqual(PRESENT)
    expect(isPicked(later, '.zzz')).toBe(false) // 没在清单里的类型勾不动
  })

  it('无扩展名组也在列（它同样有归属可勾，标签沿用 grouping 的 NO EXTENSION）', () => {
    const state = opened({ type: 'create', present: PRESENT })
    expect(state.present.map((p) => p.ext)).toEqual(['.aaa', '.docx', ''])
    expect(state.present.map((p) => p.label)).toEqual(['AAA', 'DOCX', 'NO EXTENSION'])
  })

  it('桌面一个文件都没有时清单为空（但仍可开层：用户可以只起个名 + 打开「接受全部类型」）', () => {
    const state = opened({ type: 'create', present: [] })
    expect(state.open).toBe(true)
    expect(state.present).toEqual([])
    expect(typePickerSizeOf({ present: [], mode: 'create' }).height).toBeGreaterThan(0)
  })

  it('可见行数封顶在 PICKER_MAX_ROWS（清单再长盒子也不失控）', () => {
    const long = Array.from({ length: 60 }, (_, i) => ({ ext: `.e${i}`, label: `E${i}` }))
    const size = typePickerSizeOf({ present: long, mode: 'edit' })
    expect(size.height).toBe(typePickerSizeOf({ present: long.slice(0, PICKER_MAX_ROWS), mode: 'edit' }).height)
  })
})

describe('「接受全部类型」开关：宽卡不必逐个勾', () => {
  it('建卡时默认关着，逐项勾才是默认路径', () => {
    expect(opened({ type: 'create', present: PRESENT }).acceptAll).toBe(false)
  })

  it('打开开关后逐项一律显示为已勾，且勾选事件一律无效果（宽卡与逐项互斥，不留半开半关的第三态）', () => {
    const on = nextTypePicker(editPicked(['.docx']), { type: 'toggle-all' }, VIEWPORT).state
    expect(on.acceptAll).toBe(true)
    expect(checkedOf(on, '.aaa')).toBe(true) // 没勾的也显示为勾住
    expect(isPicked(on, '.aaa')).toBe(false) // 但声明里并没有它——显示与声明各归各的

    const after = nextTypePicker(on, { type: 'toggle', ext: '.aaa' }, VIEWPORT).state
    expect(after).toEqual(on) // 点它不动任何东西
  })

  it('关掉开关后回到关之前的勾选（用户逐项勾过的东西不该被一次开关抹掉）', () => {
    const picked = nextTypePicker(editPicked([]), { type: 'toggle', ext: '.docx' }, VIEWPORT).state
    const on = nextTypePicker(picked, { type: 'toggle-all' }, VIEWPORT).state
    const off = nextTypePicker(on, { type: 'toggle-all' }, VIEWPORT).state
    expect(off.acceptAll).toBe(false)
    expect(isPicked(off, '.docx')).toBe(true)
  })

  it('EDIT TYPES 开层时如实带回这张卡「接受全部类型」的开关现状', () => {
    expect(editPicked(['.docx'], true).acceptAll).toBe(true)
  })
})

describe('NEW GROUP：建卡并起名（空名不落库是效果表的结构事实，不是一句承诺）', () => {
  it('建卡模式带名字草稿；编辑模式不带（EDIT TYPES 不改卡名）', () => {
    expect(opened({ type: 'create', present: PRESENT })).toMatchObject({ mode: 'create', name: '', cardId: '' })
    expect(editPicked(['.docx'])).toMatchObject({ mode: 'edit', name: '', cardId: 'dgc-c1' })
  })

  it('空名提交：不产生落库动作，层还开着，并把「没名」如实摆出来（不替用户编一个名）', () => {
    const opened_ = nextTypePicker(CLOSED_TYPES, { type: 'create', present: PRESENT }, VIEWPORT)
    const { state, effects } = nextTypePicker(opened_.state, { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([])
    expect(state.open).toBe(true)
    expect(state.nameError).not.toBe('')
  })

  it('全空格的提交与空名同判（不是 trim 之后才判）', () => {
    const { effects } = nextTypePicker(createPicked('   '), { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([])
  })

  it('有名有勾：提交产生一次建卡动作，载荷是 trim 后的名 + 勾中的类型 + 开关', () => {
    let state = createPicked('  合同  ')
    state = nextTypePicker(state, { type: 'toggle', ext: '.docx' }, VIEWPORT).state
    state = nextTypePicker(state, { type: 'toggle', ext: '' }, VIEWPORT).state
    const { state: closed, effects } = nextTypePicker(state, { type: 'submit' }, VIEWPORT)

    expect(runs(effects)).toEqual([
      { kind: 'run', op: 'create-group', name: '合同', exts: ['', '.docx'], acceptAll: false },
    ])
    expect(closed.open).toBe(false)
  })

  it('「接受全部类型」开着时提交：exts 原样带上，开关为真（路由侧以开关为准）', () => {
    let state = createPicked('杂项')
    state = nextTypePicker(state, { type: 'toggle-all' }, VIEWPORT).state
    const { effects } = nextTypePicker(state, { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([
      { kind: 'run', op: 'create-group', name: '杂项', exts: [], acceptAll: true },
    ])
  })

  it('有名字但一个类型都没勾也允许建卡（用户可以先建一张空的卡，或改用「接受全部类型」）', () => {
    const { effects } = nextTypePicker(createPicked('先建着'), { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([
      { kind: 'run', op: 'create-group', name: '先建着', exts: [], acceptAll: false },
    ])
  })
})

describe('EDIT TYPES：改接受的类型，既有文件的归属随之迁移', () => {
  it('提交产生一次改类型动作，带上那张卡的 id；不涉及卡名', () => {
    let state = editPicked(['.docx'])
    state = nextTypePicker(state, { type: 'toggle', ext: '.aaa' }, VIEWPORT).state
    const { effects } = nextTypePicker(state, { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([
      { kind: 'run', op: 'edit-types', cardId: 'dgc-c1', exts: ['.aaa', '.docx'], acceptAll: false },
    ])
  })

  it('取消勾选即摘掉那个类型（迁移的另一头：摘掉的文件落回固有组）', () => {
    let state = editPicked(['.docx'])
    state = nextTypePicker(state, { type: 'toggle', ext: '.docx' }, VIEWPORT).state
    const { effects } = nextTypePicker(state, { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([
      { kind: 'run', op: 'edit-types', cardId: 'dgc-c1', exts: [], acceptAll: false },
    ])
  })

  it('桌面上已经不存在的旧声明不会被这一轮悄悄抹掉（清单只列真实存在的类型，但不清声明）', () => {
    // '.gone' 这类扩展名的文件已被删掉，它不再出现在清单里；用户没碰过它，就不该因保存而丢失
    const state = editPicked(['.docx', '.gone'])
    expect(state.present.map((p) => p.ext)).not.toContain('.gone')
    const { effects } = nextTypePicker(state, { type: 'submit' }, VIEWPORT)
    expect(runs(effects)).toEqual([
      { kind: 'run', op: 'edit-types', cardId: 'dgc-c1', exts: ['.docx', '.gone'], acceptAll: false },
    ])
  })
})

describe('效果表：顺序、持放平衡、取消无副作用（与 writeops 同款纪律）', () => {
  it('开层：档先持 → 再建 DOM → 后申报热区 → 最后存证（遮罩铺满视口，两个方向都要重申报）', () => {
    const { effects } = nextTypePicker(CLOSED_TYPES, { type: 'create', present: PRESENT }, VIEWPORT)
    expect(kinds(effects)).toEqual(['tier', 'show', 'hotzones', 'notify'])
    expect(notices(effects)).toEqual([TYPE_OPENED_NOTIFY])
  })

  it('提交：收层 → 重申报热区 → 放档 → 执行动作 → 存证（动作期间屏幕上不再压着一层壳）', () => {
    const { effects } = nextTypePicker(createPicked('合同'), { type: 'submit' }, VIEWPORT)
    expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier', 'run', 'notify'])
    expect(notices(effects)).toEqual([TYPE_CLOSED_NOTIFY])
  })

  it('取消四路（cancel / Esc / 层外点击）一律不产生落库动作——「取消无副作用」是这张表的结构事实', () => {
    for (const event of [{ type: 'cancel', reason: 'button' }, { type: 'esc' }, { type: 'outside' }] as const) {
      const state = nextTypePicker(createPicked('合同'), { type: 'toggle', ext: '.docx' }, VIEWPORT).state
      const { state: closed, effects } = nextTypePicker(state, event, VIEWPORT)
      expect(runs(effects)).toEqual([])
      expect(closed.open).toBe(false)
      expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier', 'notify'])
    }
  })

  it('持放始终成对（档不放窗口就一直可聚焦，面板再也点不动）', () => {
    const held = nextTypePicker(CLOSED_TYPES, { type: 'create', present: PRESENT }, VIEWPORT).effects
      .filter((e) => e.kind === 'tier')
    const released = nextTypePicker(createPicked('合同'), { type: 'cancel', reason: 'button' }, VIEWPORT).effects
      .filter((e) => e.kind === 'tier')
    expect(held).toEqual([{ kind: 'tier', held: true }])
    expect(released).toEqual([{ kind: 'tier', held: false }])
  })

  it('闭态下的噪声事件（submit / toggle / 关层）既无转移也无效果', () => {
    for (const event of [{ type: 'submit' }, { type: 'toggle', ext: '.docx' }, { type: 'toggle-all' }, { type: 'set-name', name: 'x' }, { type: 'esc' }, { type: 'outside' }] as const) {
      const { state, effects } = nextTypePicker(CLOSED_TYPES, event, VIEWPORT)
      expect(state).toBe(CLOSED_TYPES)
      expect(effects).toEqual([])
    }
  })

  it('已在层里时再 open 不重入（与内核 openTrashConfirm 同款：留在原来那一层，不换清单）', () => {
    const state = editPicked(['.docx'])
    const again = nextTypePicker(state, { type: 'create', present: [] }, VIEWPORT)
    expect(again.state).toBe(state)
    expect(again.effects).toEqual([])
  })

  it('卸载：静默收场——通道随插件消亡，存证没有意义，但热区与键盘档一样不漏地收回', () => {
    const { state, effects } = nextTypePicker(createPicked('合同'), { type: 'unmount' }, VIEWPORT)
    expect(state).toBe(CLOSED_TYPES)
    expect(kinds(effects)).toEqual(['hide', 'hotzones', 'tier'])
    expect(notices(effects)).toEqual([])
  })

  it('卸载时层没开：不发多余的放档噪声（没持就放是噪声）', () => {
    const { effects } = nextTypePicker(CLOSED_TYPES, { type: 'unmount' }, VIEWPORT)
    expect(effects).toEqual([])
  })
})

describe('开层存证：清单与勾选状态一次带全（真机目视与电池按这三样定位）', () => {
  it('存证里带模式、来源卡、清单、已勾与盒子', () => {
    const { effects } = nextTypePicker(CLOSED_TYPES, {
      type: 'edit', cardId: 'dgc-c1', label: '合同', exts: ['.docx'], acceptAll: false, present: PRESENT,
    }, VIEWPORT)
    const note = effects.find((e) => e.kind === 'notify') as unknown as { type: string; payload: Record<string, unknown> }
    expect(note.type).toBe(TYPE_OPENED_NOTIFY)
    expect(note.payload).toMatchObject({
      mode: 'edit',
      cardId: 'dgc-c1',
      label: '合同',
      checked: ['.docx'],
      present: PRESENT,
    })
    expect(note.payload.box).toMatchObject({ width: expect.any(Number), height: expect.any(Number) })
  })

  it('关层存证带原因，供电池分源', () => {
    const cases: Array<[Parameters<typeof nextTypePicker>[1], string]> = [
      [{ type: 'cancel', reason: 'button' }, 'button'],
      [{ type: 'esc' }, 'esc'],
      [{ type: 'outside' }, 'outside'],
    ]
    for (const [event, reason] of cases) {
      const state = nextTypePicker(createPicked('合同'), { type: 'toggle', ext: '.docx' }, VIEWPORT).state
      const { effects } = nextTypePicker(state, event, VIEWPORT)
      const note = effects.find((e) => e.kind === 'notify') as unknown as { payload: Record<string, unknown> }
      expect(note.payload).toMatchObject({ reason })
    }
  })
})
