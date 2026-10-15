/**
 * 组定义与三层归属的**纯裁决**（工单185 = spec166 之⑧）。
 *
 * 本份钉的是「给定桌面项快照与一组卡定义，产出什么样的卡、什么样的归属」（spec166 Testing
 * Decisions 缝1 指定的最高性价比缝）。不测 DOM、不测 CSS、不测渲染顺序：
 *   - 组定义经插件私有状态通道存取的形状与往返自愈；
 *   - 临时卡序号纳入持久化设计后跨重启不撞名；
 *   - 三层归属的**每一个分支**：自定义卡命中、冲突先建先得、被领走的扩展名不再生成固有卡、
 *     未被领走的走固有卡、临时卡不参与自动路由；
 *   - 编辑类型后既有文件的归属随之迁移（无需手动干预）；
 *   - 勾选浮层的类型清单只列桌面上真实存在的扩展名。
 *
 * 模块是纯的：不 import DOM、不 import Electron，因此可以直接 import 被测实现（这是与
 * doc-group-cards-dom.spec.ts 那些接线测试分工的地方）。
 */
import { describe, expect, it } from 'vitest'
import {
  TIER_BUILTIN,
  TIER_CUSTOM,
  TIER_TEMP,
  addCustomGroup,
  allocateTempCard,
  customCardIdOf,
  editCustomGroupTypes,
  emptyStore,
  normalizeStore,
  pasteStampOf,
  presentExtensionsOf,
  resolveOwner,
  storeOf,
  tempCardIdOf,
  tempLabelOf,
  buildCards,
  type CustomGroupDef,
  type GroupStore,
} from '../../plugins/doc-group-cards/ownership'
import type { GroupableItem } from '../../plugins/doc-group-cards/grouping'

// ---------------------------------------------------------------------------
// 桌面项与组定义的构造小工具（内核 DesktopItem 结构上即可满足 GroupableItem）
// ---------------------------------------------------------------------------

function file(name: string): GroupableItem {
  return { name, kind: 'file' }
}

function other(name: string, kind: string): GroupableItem {
  return { name, kind }
}

/** 建一张自定义组卡并返回新 store（按题面给的次序依次创建，故 seq 即创建顺序） */
function withCustom(store: GroupStore, seq: number, exts: string[], extra: Partial<CustomGroupDef> = {}): GroupStore {
  const out = addCustomGroup(store, { name: extra.name ?? `卡${seq}`, exts, acceptAll: extra.acceptAll ?? false })
  expect(out.group.seq).toBe(seq)
  return out.store
}

/** 落库再读回：插件私有状态通道那一圈往返（JSON 序列化 → 解析 → 形状自愈） */
function roundTrip(store: GroupStore): GroupStore {
  return normalizeStore(JSON.parse(JSON.stringify(store)))
}

/** 卡 id → 该卡里的文件名清单 */
function membersOf(cards: ReturnType<typeof buildCards>, id: string): string[] {
  const card = cards.find((c) => c.id === id)
  return card ? card.items.map((i) => i.name) : []
}

function cardOf(cards: ReturnType<typeof buildCards>, name: string) {
  const hits = cards.filter((c) => c.items.some((i) => i.name === name))
  if (hits.length !== 1) throw new Error(`${name} 落进 ${hits.length} 张卡（期望恰好 1 张）`)
  return hits[0]
}

// ---------------------------------------------------------------------------

describe('组定义：经插件私有状态通道存取的形状与往返（工单185）', () => {
  it('空状态即四件套：版本号、单调计数器、自定义卡表、临时卡表', () => {
    expect(emptyStore()).toEqual({ version: 1, nextSeq: 1, groups: [], temps: [] })
  })

  it('从 plugin-config 响应里取出组定义（响应形状是 { config, warnings }，键名由插件自定）', () => {
    const { store: built } = addCustomGroup(emptyStore(), { name: '合同', exts: ['.docx'], acceptAll: false })
    const read = storeOf({ config: { groups: built }, warnings: [] })
    expect(read.groups).toHaveLength(1)
    expect(read.groups[0]).toMatchObject({ name: '合同', exts: ['.docx'], acceptAll: false })

    // 还没落过盘（文件不存在 / 坏 JSON 视同空对象）也给得出一个可用的空状态，不抛
    expect(storeOf({ config: {}, warnings: ['坏 JSON'] })).toEqual(emptyStore())
    expect(storeOf(undefined)).toEqual(emptyStore())
  })

  it('往返稳定：写出去的形状读回来一模一样（重启后仍在）', () => {
    const s0 = emptyStore()
    const a = withCustom(s0, 1, ['.docx', '.pdf'])
    const b = withCustom(a, 2, ['.png'], { acceptAll: false })
    const t = allocateTempCard(b, 1710000000000)
    const s = t.store

    const back = roundTrip(s)
    expect(back).toEqual(s)
    expect(back.groups.map((g) => [g.name, g.exts])).toEqual([['卡1', ['.docx', '.pdf']], ['卡2', ['.png']]])
    expect(back.temps).toEqual(s.temps)
  })

  it('自愈：坏形状逐项回退而不是整体丢弃（读得回来的部分要留住）', () => {
    const healed = normalizeStore({
      version: 1,
      nextSeq: 9,
      groups: [
        { id: 'dgc-c1', name: '合同', exts: ['.docx'], acceptAll: false, seq: 1 },
        { id: 'dgc-c2', name: '  ', exts: '不是数组', acceptAll: 'yes', seq: 2 }, // 名空/类型全坏
        { id: '', name: '无 id', exts: [], acceptAll: false, seq: 3 }, // 不可寻址
        { name: '无 seq', exts: [], acceptAll: false }, // 序号非正整数
        '不是对象',
        null,
      ],
      temps: [{ id: 'dgc-t4', name: '临时 04', seq: 4 }],
    })

    // 留下唯一一条完好的；名空的那条留着但兜底成可读的名字，类型坏的逐键回退
    expect(healed.groups.map((g) => [g.id, g.name, g.exts, g.acceptAll])).toEqual([
      ['dgc-c1', '合同', ['.docx'], false],
      ['dgc-c2', '组 2', [], false],
    ])
    expect(healed.temps.map((t) => t.id)).toEqual(['dgc-t4'])
    // 计数器被抬到已用序号之后（下一张是 5，不是 4）
    expect(healed.nextSeq).toBe(9)
  })

  it('扩展名一律归一：小写、含点、去重排序；无点形态一律丢弃', () => {
    const { store } = addCustomGroup(emptyStore(), {
      name: '杂项',
      exts: ['.PDF', 'pdf', '.pdf', '.tar.gz', 'docx', '', 42 as unknown as string],
      acceptAll: false,
    })
    // '.tar.gz' 只留末段 → '.gz'（路由侧 extOf('a.tar.gz') 同口径）；'pdf' 不是扩展名形态 → 丢；
    // 空串 = 无扩展名那一组（README）
    expect(store.groups[0].exts).toEqual(['', '.gz', '.pdf'])
  })

  it('顶层不是对象（含坏 JSON 视同空对象）一律给空状态，不抛', () => {
    for (const bad of [undefined, null, '坏 JSON', 42, [], true]) {
      expect(normalizeStore(bad as unknown)).toEqual(emptyStore())
    }
  })
})

describe('临时卡序号：纳入持久化设计，跨重启不撞名（工单185 的占位与不变量）', () => {
  it('序号单调递增：连开两张得 01 / 02，id 与卡面名都不同', () => {
    const a = allocateTempCard(emptyStore(), 1710000000000)
    const b = allocateTempCard(a.store, 1710000001000)
    expect([a.card.seq, b.card.seq]).toEqual([1, 2])
    // 工单186 AC「命名含粘贴时间与序号」：卡面名改带时刻，序号仍在末尾（唯一性依旧只靠序号）
    expect(a.card.name).toBe(tempLabelOf(1, pasteStampOf(1710000000000)))
    expect(b.card.name).toBe(tempLabelOf(2, pasteStampOf(1710000001000)))
    expect(a.card.name).not.toBe(b.card.name)
    expect(a.card.id).not.toBe(b.card.id)
    expect(b.store.temps.map((t) => t.id)).toEqual([a.card.id, b.card.id])
  })

  it('跨重启不撞名：落库读回后再开一张是 02，不是又一张 01', () => {
    const a = allocateTempCard(emptyStore(), 1710000000000)
    const afterRestart = roundTrip(a.store)
    const b = allocateTempCard(afterRestart, 1710000001000)
    expect(b.card.seq).toBe(2)
    expect(b.card.name).toBe(tempLabelOf(2, pasteStampOf(1710000001000)))
    // 与重启前那张不是同一张卡
    expect(b.card.id).not.toBe(a.card.id)
    expect(b.store.temps).toHaveLength(2)
  })

  it('计数器丢了也不撞名：nextSeq 被改回 1，但 seq 7 的卡还在盘上 → 下一张是 08', () => {
    // 这一条是「不撞名」真正的兜底：唯一性不能只依赖计数器被老实存着
    const a = allocateTempCard(emptyStore(), 0)
    const rewound = roundTrip({ ...a.store, nextSeq: 1 })
    expect(rewound.nextSeq).toBe(2) // 已被占用的 01 抬回来了
    const b = allocateTempCard(rewound, 0)
    expect(b.card.seq).toBe(2)
    expect(b.card.id).not.toBe(a.card.id)

    const seven = roundTrip({ ...emptyStore(), nextSeq: 1, temps: [{ id: 'dgc-t7', name: '临时 07', seq: 7, createdAtMs: 0, names: [] }] })
    expect(seven.nextSeq).toBe(8)
    expect(allocateTempCard(seven, 0).card.seq).toBe(8)
  })

  it('自定义卡与临时卡共用一个计数器（两层各自的 id/序号都不会撞）', () => {
    const custom = withCustom(emptyStore(), 1, ['.docx'])
    const temp = allocateTempCard(custom, 0)
    expect(temp.card.seq).toBe(2)
    expect(customCardIdOf(1)).not.toBe(tempCardIdOf(2))
    expect(tempCardIdOf(2)).toBe('dgc-t2')
    expect(customCardIdOf(1)).toBe('dgc-c1')
  })

  it('临时卡定义带创建时刻，**时刻与序号一起进卡面名**（工单186 AC「命名含粘贴时间与序号」）', () => {
    const a = allocateTempCard(emptyStore(), 1710000000000, ['甲.zip'])
    // 工单185 交付时命名「只带序号」（唯一性靠序号）；工单186 按 AC 把粘贴时刻也加进来，
    // 序号仍在末尾——「唯一性靠序号、不靠名字」那条不变量一个字没动。详见 ownership.tempLabelOf。
    expect(a.card).toMatchObject({
      id: 'dgc-t1',
      name: tempLabelOf(1, pasteStampOf(1710000000000)),
      seq: 1,
      createdAtMs: 1710000000000,
      names: ['甲.zip'],
    })
    expect(a.card.name).toContain('01')
    // 时刻缺失时落 0，不猜一个当前时间（编时刻 = 以后没法复现「哪一批」）；名字退化成只带序号
    expect(allocateTempCard(emptyStore(), Number.NaN).card.createdAtMs).toBe(0)
    expect(allocateTempCard(emptyStore(), Number.NaN).card.name).toBe(tempLabelOf(1))
  })
})

describe('三层归属：自定义卡命中 / 冲突先建先得 / 领走的不再出固有卡 / 其余走固有卡（工单185 核心）', () => {
  it('第一层：自定义组卡命中该扩展名 → 归它（不再走固有组）', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    expect(resolveOwner('.docx', store)).toMatchObject({ tier: TIER_CUSTOM, id: 'dgc-c1', label: '卡1' })
    expect(resolveOwner('.pdf', store)).toMatchObject({ tier: TIER_BUILTIN, id: '' })
  })

  it('第一层：命中创建顺序最早的那张自定义卡（先建先得，与内核「同 id 跨扫描根先到先得」同一惯例）', () => {
    const store = withCustom(withCustom(emptyStore(), 1, ['.docx']), 2, ['.docx'])
    expect(resolveOwner('.docx', store).id).toBe('dgc-c1')

    // **反序证明**：把数组顺序倒过来，裁决不变。若实现按数组下标取第一个，这里会给出 dgc-c2。
    const reversed: GroupStore = { ...store, groups: [...store.groups].reverse() }
    expect(resolvedFirst(reversed)).toBe('dgc-c1')
    expect(resolvedFirst(store)).toBe(resolvedFirst(reversed))
  })

  it('第一层：「接受全部类型」的卡命中一切扩展名（包括无扩展名那一组），但仍先建先得', () => {
    const wide = withCustom(emptyStore(), 1, [], { acceptAll: true })
    expect(resolveOwner('.docx', wide).id).toBe('dgc-c1')
    expect(resolveOwner('.zip', wide).id).toBe('dgc-c1')
    expect(resolveOwner('', wide).id).toBe('dgc-c1')
    // 宽卡把一切领走 → 一个固有组都不剩
    expect(buildCards([file('a.docx'), file('b.pdf'), file('README')], wide).map((c) => c.tier))
      .toEqual([TIER_CUSTOM])

    // 后建的宽卡不夺先建的窄卡已经领走的类型；窄卡没领的，宽卡接着领
    const mixed = withCustom(withCustom(emptyStore(), 1, ['.pdf']), 2, [], { acceptAll: true })
    expect(resolveOwner('.pdf', mixed).id).toBe('dgc-c1') // 先建的窄卡守住 .pdf
    expect(resolveOwner('.docx', mixed).id).toBe('dgc-c2') // 没被领走的落进后建的宽卡
    expect(resolveOwner('', mixed).id).toBe('dgc-c2')
  })

  it('第三层：没被任何自定义卡领走的扩展名走固有扩展组（组序表 + 表外字母序兜底）', () => {
    const store = withCustom(emptyStore(), 1, ['.zip'])
    const items = [
      file('a.docx'), file('b.docx'),
      file('c.pdf'),
      file('d.zip'),
      file('e.unknownext'), file('f.aaaext'), file('g.bbbext'),
    ]
    const cards = buildCards(items, store)
    // 自定义卡排在固有组之前（创建序）；固有组沿用工单179 钉住的那份排法：表外（含无扩展名组）
    // 先按字母序兜底，其后才是固定组序表 —— 见 grouping.sortGroupKeys
    expect(cards.map((c) => c.label)).toEqual(['卡1', 'AAAEXT', 'BBBEXT', 'UNKNOWNEXT', 'DOCX', 'PDF'])
    expect(cards.map((c) => c.tier)).toEqual([
      TIER_CUSTOM, TIER_BUILTIN, TIER_BUILTIN, TIER_BUILTIN, TIER_BUILTIN, TIER_BUILTIN,
    ])
    // 组序表内按表序（.docx 在 .pdf 之前）
    expect(membersOf(cards, cards[4].id)).toEqual(['a.docx', 'b.docx'])
    expect(membersOf(cards, cards[1].id)).toEqual(['f.aaaext'])
    // 被自定义卡领走的 .zip 落在自定义卡上，固有组里不再有它
    expect(membersOf(cards, cards[0].id)).toEqual(['d.zip'])
    expect(cards.some((c) => c.tier === TIER_BUILTIN && c.label === 'ZIP')).toBe(false)
  })

  it('被领走的扩展名不再生成对应固有卡：同一批文件不会出现在两张卡里', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    const cards = buildCards([file('方案.docx'), file('纪要.docx'), file('预算.pdf')], store)

    // 没有一张固有 DOCX 卡
    expect(cards.filter((c) => c.tier === TIER_BUILTIN && c.label === 'DOCX')).toEqual([])
    // 两个 docx 都在自定义卡里，各一次
    expect(membersOf(cards, 'dgc-c1')).toEqual(['方案.docx', '纪要.docx'])
    // 全表逐件核对：没有任何一件文件出现两次
    const all = cards.flatMap((c) => c.items.map((i) => i.name))
    expect(all.slice().sort()).toEqual(['方案.docx', '纪要.docx', '预算.pdf'].sort())
    expect(new Set(all).size).toBe(all.length)
  })

  it('第二层占位：临时组卡**不参与**自动路由（桌面上的文件既不进自定义卡也不进临时卡）', () => {
    const store = allocateTempCard(withCustom(emptyStore(), 1, []), 0).store
    expect(store.temps).toHaveLength(1)
    // 路由裁决里根本没有 temps 这一层：没有自定义卡领走时一律落固有组
    expect(resolveOwner('.docx', store)).toMatchObject({ tier: TIER_BUILTIN })
    const cards = buildCards([file('a.docx')], store)
    // 工单187 裁决①起，自定义卡即便空着也出卡（0 格），临时卡空着不出（它是粘贴的产物，
    // 不属于本次裁决的范围）；本用例要钉的那条——a.docx 既不进自定义卡也不进临时卡——一字未动
    expect(cards.map((c) => [c.id, c.tier, c.items.length])).toEqual([
      ['dgc-c1', TIER_CUSTOM, 0],
      ['dgc-docx', TIER_BUILTIN, 1],
    ])
    expect(membersOf(cards, 'dgc-c1')).toEqual([])
    expect(membersOf(cards, 'dgc-docx')).toEqual(['a.docx'])
  })

  it('工单187 裁决①：空的自定义卡**照样出卡**（0 格、id 唯一、卡面是用户起的名），固有组仍守「空组不占卡」', () => {
    const store = withCustom(withCustom(emptyStore(), 1, ['.zip']), 2, ['.png'])
    const cards = buildCards([file('a.docx')], store)

    // 两张自定义卡此刻都空着 → 都在屏上，且排在固有组之前（自定义段=创建序）
    expect(cards.map((c) => [c.id, c.label, c.tier, c.items.length])).toEqual([
      ['dgc-c1', '卡1', TIER_CUSTOM, 0],
      ['dgc-c2', '卡2', TIER_CUSTOM, 0],
      ['dgc-docx', 'DOCX', TIER_BUILTIN, 1],
    ])
    const ids = cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    // 桌面上的 .docx 照旧归固有组；而「桌面上此刻没有文件」的那种**固有**组（.zip/.png）不出卡
    expect(membersOf(cards, 'dgc-docx')).toEqual(['a.docx'])
    expect(cards.some((c) => c.tier === TIER_BUILTIN && c.items.length === 0)).toBe(false)
  })

  it('工单187 裁决①的由来那条：EDIT TYPES 把勾全取消后，卡**留在屏上**（0 格）——否则界面上再也回不去', () => {
    const before = withCustom(emptyStore(), 1, ['.docx'])
    // 取消勾选 = 用户在这张卡的 EDIT TYPES 里把最后一个类型也摘掉
    const after = editCustomGroupTypes(before, 'dgc-c1', { exts: [], acceptAll: false })
    const cards = buildCards([file('a.docx'), file('b.pdf')], after)

    // 卡还在（id、名字、层都不变），只是空了；文件回落固有组
    const card = cards.find((c) => c.id === 'dgc-c1')!
    expect([card.label, card.tier, card.items.length]).toEqual(['卡1', TIER_CUSTOM, 0])
    expect(membersOf(cards, 'dgc-docx')).toEqual(['a.docx'])
    expect(membersOf(cards, 'dgc-pdf')).toEqual(['b.pdf'])
    // 定义本身没丢：它还在 store 里，重启后仍能算出同一张空卡
    expect(roundTrip(after).groups.map((g) => g.id)).toEqual(['dgc-c1'])
  })

  it('工单187 裁决①：唯一化兜底对 0 格卡一样生效（空卡也占一个 id，撞名照旧被顶开）', () => {
    // '.c1' 净化后正是 dgc-c1 —— 与**空**的自定义卡正面相撞，故 0 格卡也必须被唯一化
    const store = withCustom(emptyStore(), 1, ['.png'])
    const cards = buildCards([file('x.c1')], store)
    const ids = cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(cards.find((c) => c.items.length === 0)!.id).toBe('dgc-c1')
    expect(ids).toContain('dgc-c1-2')
  })

  it('只收 kind 为 file 的条目：快捷方式 / 网址 / 文件夹不进任何卡（与 grouping 同一条过滤）', () => {
    const store = withCustom(emptyStore(), 1, ['.lnk'])
    const cards = buildCards([file('真文件.docx'), other('启动.lnk', 'shortcut'), other('站点.url', 'url'), other('素材', 'folder')], store)
    expect(cards.flatMap((c) => c.items.map((i) => i.name))).toEqual(['真文件.docx'])
  })

  it('无扩展名的文件有归属（自成一组，不凭空消失）', () => {
    const cards = buildCards([file('README'), file('.gitignore')], emptyStore())
    expect(cards.map((c) => c.label)).toEqual(['NO EXTENSION'])
    expect(membersOf(cards, cards[0].id)).toEqual(['README', '.gitignore'])
  })

  it('组卡 DOM id 全表唯一（渲染层扫热区不去重，自定义卡 id 与固有组 id 撞车也不怕）', () => {
    // `.c1` 这个扩展名净化后正是 dgc-c1 —— 与自定义卡的 id 正面相撞，必须由唯一化兜住
    const store = withCustom(emptyStore(), 1, ['.zzz'])
    const cards = buildCards([file('x.c1'), file('y.c1'), file('z.zzz')], store)
    const ids = cards.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('dgc-c1') // 自定义卡排在前面，先到的那个保留基名
    expect(ids).toContain('dgc-c1-2')
    expect(membersOf(cards, 'dgc-c1')).toEqual(['z.zzz'])
    expect(membersOf(cards, 'dgc-c1-2')).toEqual(['x.c1', 'y.c1'])
  })

  it('自定义卡的卡面标签是用户起的名，固有卡才是扩展名大写（两者不混）', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'], { name: '合同' })
    const cards = buildCards([file('a.docx'), file('b.pdf')], store)
    expect(cards.map((c) => [c.label, c.tier])).toEqual([['合同', TIER_CUSTOM], ['PDF', TIER_BUILTIN]])
  })

  it('编辑类型后归属随之迁移，且迁得不重不漏（既有文件不动手即换主）', () => {
    const before = withCustom(emptyStore(), 1, ['.docx'])
    const items = [file('方案.docx'), file('预算.pdf')]

    const before_ = buildCards(items, before)
    expect(cardOf(before_, '方案.docx').id).toBe('dgc-c1')

    // EDIT TYPES：把 .pdf 也划进这张卡
    const after = editCustomGroupTypes(before, 'dgc-c1', { exts: ['.docx', '.pdf'], acceptAll: false })
    const after_ = buildCards(items, after)
    expect(cardOf(after_, '预算.pdf').id).toBe('dgc-c1') // 自动迁移，无需手动干预
    expect(cardOf(after_, '方案.docx').id).toBe('dgc-c1')
    expect(after_.some((c) => c.label === 'PDF')).toBe(false) // 被领走了 → 固有 PDF 卡不再生成
    expect(after_.flatMap((c) => c.items.map((i) => i.name)).sort()).toEqual(['方案.docx', '预算.pdf'].sort())

    // 反向：把 .pdf 摘出去 → 落回固有组
    const back = editCustomGroupTypes(after, 'dgc-c1', { exts: ['.docx'], acceptAll: false })
    const back_ = buildCards(items, back)
    expect(cardOf(back_, '预算.pdf').label).toBe('PDF')
    expect(cardOf(back_, '预算.pdf').tier).toBe(TIER_BUILTIN)
  })

  it('编辑不存在的卡 id 是无操作（不静默新建一张同名卡）', () => {
    const before = withCustom(emptyStore(), 1, ['.docx'])
    expect(editCustomGroupTypes(before, 'dgc-c9', { exts: ['.pdf'], acceptAll: false })).toEqual(before)
  })

  it('迁移在重启之后照样成立：改过的定义落盘读回，归属不变', () => {
    const before = withCustom(emptyStore(), 1, ['.docx'])
    const edited = roundTrip(editCustomGroupTypes(before, 'dgc-c1', { exts: ['.docx', '.pdf'], acceptAll: false }))
    const cards = buildCards([file('a.docx'), file('b.pdf')], edited)
    expect(membersOf(cards, 'dgc-c1').sort()).toEqual(['a.docx', 'b.pdf'])
    expect(cards).toHaveLength(1)
  })
})

describe('勾选浮层的类型清单：只列桌面上真实存在的扩展名（工单185）', () => {
  it('逐个列出真实存在的扩展名；不存在的类型不列（列了也没文件可放）', () => {
    const list = presentExtensionsOf([file('a.docx'), file('b.docx'), file('c.pdf'), file('d.zip')])
    expect(list).toEqual([
      { ext: '.docx', label: 'DOCX' },
      { ext: '.pdf', label: 'PDF' },
      { ext: '.zip', label: 'ZIP' },
    ])
  })

  it('与卡序同一份排序（表外按字母序兜底在前、其后固定组序表；见 grouping.sortGroupKeys）', () => {
    const list = presentExtensionsOf([file('x.zzz'), file('y.aaa'), file('v.pdf'), file('u.docx'), file('t.mmm')])
    expect(list.map((r) => r.ext)).toEqual(['.aaa', '.mmm', '.zzz', '.docx', '.pdf'])
    // 同一份算式：卡序与清单序对得上（.docx 卡排在 .aaa 卡之后，一如清单里的位置）
    const cards = buildCards([file('x.zzz'), file('y.aaa'), file('v.pdf'), file('u.docx')], emptyStore())
    expect(cards.map((c) => c.id)).toEqual(['dgc-aaa', 'dgc-zzz', 'dgc-docx', 'dgc-pdf'])
  })

  it('快捷方式 / 网址 / 文件夹的类型不进清单（它们根本进不了卡）', () => {
    const list = presentExtensionsOf([file('a.docx'), other('启动.lnk', 'shortcut'), other('站点.url', 'url'), other('素材', 'folder')])
    expect(list.map((r) => r.ext)).toEqual(['.docx'])
  })

  it('无扩展名的文件以 NO EXTENSION 在列（它也有归属可勾）', () => {
    expect(presentExtensionsOf([file('README'), file('a.docx')])).toEqual([
      { ext: '', label: 'NO EXTENSION' },
      { ext: '.docx', label: 'DOCX' },
    ])
  })

  it('清单去重且与入参序无关（同一份桌面无论扫几遍，勾选面是同一张）', () => {
    const a = presentExtensionsOf([file('a.docx'), file('b.pdf')])
    const b = presentExtensionsOf([file('b.pdf'), file('a.docx'), file('c.docx')])
    expect(a).toEqual(b)
  })
})

// ---------------------------------------------------------------------------

/** 先建先得的裁决结果（抽出来只为让上面的反序证明读起来是一句话） */
function resolvedFirst(store: GroupStore): string {
  return resolveOwner('.docx', store).id
}
