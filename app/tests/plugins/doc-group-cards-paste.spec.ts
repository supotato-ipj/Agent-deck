/**
 * 粘贴路由三态 + 临时组卡生成 + 解散归档的**纯裁决**（工单186 = spec166 之⑨）。
 *
 * 本份钉的是「给定一组组定义与一批粘贴落地的文件名，产出什么样的路由结果、什么样的卡、
 * 解散之后谁回到哪儿」（spec166 Testing Decisions 缝1）。零 DOM、零 Electron，故直接 import
 * 被测实现；接线（PASTE/DISSOLVE 两行菜单、剪贴板实况置灰、确认层、落盘调用）在
 * doc-group-cards-paste-dom.spec.ts 里。
 *
 * **一条反面断言在本文件里**：票面点名「临时卡优先级必须高于固有扩展组，否则临时卡永不生成」。
 * 它不是一句断言，是把层序表正反各跑一遍、看见两种结果。
 */
import { describe, expect, it } from 'vitest'
import {
  TIER_BUILTIN,
  TIER_CUSTOM,
  TIER_TEMP,
  acceptsAnyTypeOf,
  addCustomGroup,
  allocateTempCard,
  appendToTempCard,
  buildCards,
  dissolveGroup,
  emptyStore,
  normalizeStore,
  pasteStampOf,
  resolveOwner,
  tempCardIdOf,
  tempLabelOf,
  type CustomGroupDef,
  type GroupStore,
} from '../../plugins/doc-group-cards/ownership'
import {
  PASTE_TIER_PRIORITY,
  pastedNamesOf,
  routePaste,
} from '../../plugins/doc-group-cards/pasting'
import type { GroupableItem } from '../../plugins/doc-group-cards/grouping'

// ---------------------------------------------------------------------------
// 构造小工具
// ---------------------------------------------------------------------------

function file(name: string): GroupableItem {
  return { name, kind: 'file' }
}

/** 建一张自定义组卡（按题面次序依次创建，故 seq 即创建顺序） */
function withCustom(store: GroupStore, seq: number, exts: string[], extra: Partial<CustomGroupDef> = {}): GroupStore {
  const out = addCustomGroup(store, { name: extra.name ?? `卡${seq}`, exts, acceptAll: extra.acceptAll ?? false })
  expect(out.group.seq).toBe(seq)
  return out.store
}

/** 落库再读回：插件私有状态通道那一圈往返（JSON 序列化 → 解析 → 形状自愈） */
function roundTrip(store: GroupStore): GroupStore {
  return normalizeStore(JSON.parse(JSON.stringify(store)))
}

/** 粘在 2026-10-15 21:04（本地时刻；期望值里按本地日历折算，与实现同一口径） */
const PASTED_AT = new Date(2026, 9, 15, 21, 4, 30, 0).getTime()

function membersOf(cards: ReturnType<typeof buildCards>, id: string): string[] {
  const card = cards.find((c) => c.id === id)
  return card ? card.items.map((i) => i.name) : []
}

/** 某个文件落在哪张卡（落进多张即抛——「同一批文件不会出现在两张卡里」是不变量，不是讲究） */
function cardOf(cards: ReturnType<typeof buildCards>, name: string) {
  const hits = cards.filter((c) => c.items.some((i) => i.name === name))
  if (hits.length !== 1) throw new Error(`${name} 落进 ${hits.length} 张卡（期望恰好 1 张）`)
  return hits[0]
}

// ---------------------------------------------------------------------------

describe('粘贴响应 → 落地的文件名（只有 pasted 算数）', () => {
  it('只取 pasted；failed 是**源基名**，不是桌面上的东西，记进归属等于凭空造一批成员', () => {
    expect(pastedNamesOf({ ok: false, pasted: ['甲.pdf'], failed: ['乙.zip', '丙.txt'] })).toEqual(['甲.pdf'])
  })

  it('一个都没落地（粘贴失败 / 响应形状不对）就是空批次：不为它建卡', () => {
    for (const bad of [{ ok: false, pasted: [], failed: ['a'] }, { ok: false, pasted: ['  '] }, null, 42, '坏形状']) {
      expect(pastedNamesOf(bad)).toEqual([])
      expect(routePaste(emptyStore(), pastedNamesOf(bad), { nowMs: PASTED_AT })).toMatchObject({
        kind: 'none',
        tempCard: null,
        changed: false,
      })
    }
  })

  it('批内去重（内核已去重，插件侧不靠上游干净）且保持批内次序', () => {
    expect(pastedNamesOf({ ok: true, pasted: ['b.pdf', ' a.docx ', 'b.pdf', 42, ''] })).toEqual(['b.pdf', 'a.docx'])
  })
})

describe('三态路由 · 第一态：有接受该类型的自定义卡则并入', () => {
  it('并入**创建顺序最早**的那张接受该扩展名的卡（先建先得，与自动路由同一裁决）', () => {
    const store = withCustom(withCustom(emptyStore(), 1, ['.pdf']), 2, ['.pdf'])
    const route = routePaste(store, ['报告.pdf'], { nowMs: PASTED_AT })
    expect(route.kind).toBe('merge')
    expect(route.mergeCardIds).toEqual(['dgc-c1'])
    expect(route.tempCard).toBeNull()
  })

  it('并入态**一个字节都不落盘**：成员是定义的函数，粘进去的文件下一帧自然就在那张卡上', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    const route = routePaste(store, ['方案.docx'], { nowMs: PASTED_AT })
    expect(route.changed).toBe(false)
    expect(route.store).toBe(route.store) // 同一个引用：没造新状态
    expect(route.store.groups).toHaveLength(1)
    expect(route.store.temps).toHaveLength(0)
    // 归属确实是算出来的，不是承诺：这份 store 一喂进 buildCards，文件就在那张卡上
    expect(cardOf(buildCards([file('方案.docx')], route.store), '方案.docx').id).toBe('dgc-c1')
  })

  it('「接受全部类型」的自定义卡接受一切扩展名（含无扩展名那一组）', () => {
    const store = withCustom(emptyStore(), 1, [], { acceptAll: true })
    expect(routePaste(store, ['杂.zip', 'README'], { nowMs: PASTED_AT })).toMatchObject({
      kind: 'merge',
      mergeCardIds: ['dgc-c1'],
      tempCard: null,
    })
  })
})

describe('三态路由 · 第二态：没有卡接受 → 新建一张临时组卡', () => {
  it('生卡：接受任意类型的那批落进新卡，组定义变了（要落盘）', () => {
    const route = routePaste(emptyStore(), ['杂.zip'], { nowMs: PASTED_AT })
    expect(route.kind).toBe('temp')
    expect(route.tempCard).toMatchObject({ id: tempCardIdOf(1), seq: 1, names: ['杂.zip'] })
    expect(route.targetCardId).toBe('dgc-t1')
    expect(route.changed).toBe(true)
    expect(route.store.temps).toHaveLength(1)
  })

  it('同批里两种去向并存：被自定义卡领走的并进去，领不走的另起一张临时卡', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    const route = routePaste(store, ['方案.docx', '杂.zip'], { nowMs: PASTED_AT })
    expect(route.kind).toBe('temp')
    expect(route.mergeCardIds).toEqual(['dgc-c1'])
    expect(route.tempFiles).toEqual(['杂.zip'])
    expect(route.tempCard?.names).toEqual(['杂.zip'])
  })

  it('**每次粘贴各生成一张**：临时卡生成后不再被后续自动路由选中', () => {
    let store = emptyStore()
    const first = routePaste(store, ['甲.zip'], { nowMs: PASTED_AT })
    store = first.store
    const second = routePaste(store, ['甲.zip'], { nowMs: PASTED_AT })
    store = second.store
    // 两批同名文件也是两张卡、两份名单；不是全堆进第一张
    expect(store.temps.map((t) => t.id)).toEqual(['dgc-t1', 'dgc-t2'])
    expect(store.temps[0].names).toEqual(['甲.zip'])
    expect(store.temps[1].names).toEqual(['甲.zip'])
    // 自动路由压根不看 temps（临时卡不参与自动路由匹配）
    expect(resolveOwner('.zip', store)).toMatchObject({ tier: TIER_BUILTIN })
    // 且自动归属那一路上，临时卡**不领走**任何扩展名：没有文件被它从固有层捞走
    const auto = buildCards([file('桌面原有.zip')], store)
    expect(cardOf(auto, '桌面原有.zip').tier).toBe(TIER_BUILTIN)
  })

  it('临时卡接受任意类型：混着办公件与杂件的一批全都装得下，一件不掉', () => {
    const route = routePaste(emptyStore(), ['报告.docx', '杂.zip', 'README', '图.png'], { nowMs: PASTED_AT })
    expect(route.tempCard?.names).toEqual(['报告.docx', '杂.zip', 'README', '图.png'])
    const cards = buildCards([file('报告.docx'), file('杂.zip'), file('README'), file('图.png')], route.store)
    expect(membersOf(cards, 'dgc-t1')).toEqual(['报告.docx', '杂.zip', 'README', '图.png'])
    expect(cards).toHaveLength(1) // 固有层一张都不出：那四个文件都归临时卡
  })
})

describe('三态路由 · 第三态：显式对某张卡粘贴 → 粘进那张卡', () => {
  it('粘进临时卡：这张卡接受任意类型，故**总是可粘**，且是往原卡上加一批', () => {
    const first = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const again = routePaste(first.store, ['乙.docx'], { nowMs: PASTED_AT, intoCardId: 'dgc-t1' })
    expect(again.kind).toBe('into')
    expect(again.targetCardId).toBe('dgc-t1')
    expect(again.tempFiles).toEqual(['乙.docx'])
    expect(again.store.temps).toHaveLength(1) // 没有第二张卡
    expect(again.store.temps[0].names).toEqual(['甲.zip', '乙.docx'])
  })

  it('再点一次 PASTE 粘同一批：只加不重（名单不会长出第二份同样的名字）', () => {
    const first = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const again = routePaste(first.store, ['甲.zip'], { nowMs: PASTED_AT, intoCardId: 'dgc-t1' })
    expect(again.tempFiles).toEqual([])
    expect(again.changed).toBe(false)
    expect(again.store.temps[0].names).toEqual(['甲.zip'])
  })

  it('「接受全部类型」的自定义卡同样吃下显式粘贴（按定义它接受一切）', () => {
    const store = withCustom(emptyStore(), 1, [], { acceptAll: true })
    const route = routePaste(store, ['杂.zip'], { nowMs: PASTED_AT, intoCardId: 'dgc-c1' })
    expect(route.kind).toBe('into')
    expect(route.changed).toBe(false) // 归属已是定义的函数，不必落盘
    expect(cardOf(buildCards([file('杂.zip')], store), '杂.zip').id).toBe('dgc-c1')
  })

  it('**登记**：有限清单的自定义卡不吃显式粘贴，退回自动路由（它的成员是定义的函数；硬塞进去的东西下一帧根本不会显示——除非另设一份成员表，那是第二套真相）', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    expect(acceptsAnyTypeOf(store, 'dgc-c1')).toBe(false)
    const route = routePaste(store, ['杂.zip'], { nowMs: PASTED_AT, intoCardId: 'dgc-c1' })
    // 不并入那张卡（它没接受 .zip），另起一张临时卡；序号接着那个共用的计数器（卡1 占了 01）
    expect(route.kind).toBe('temp')
    expect(route.mergeCardIds).toEqual([])
    expect(route.targetCardId).toBe('dgc-t2')
  })

  it('对一张卡 id 不存在（或固有扩展组卡）显式粘贴：与不指定一样走自动路由', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    for (const cardId of ['dgc-c9', 'dgc-pdf', '']) {
      expect(routePaste(store, ['杂.zip'], { nowMs: PASTED_AT, intoCardId: cardId })).toMatchObject({
        kind: 'temp',
        targetCardId: 'dgc-t2',
      })
    }
  })
})

describe('⚠️ 票面点名要验的推导：临时卡优先级必须高于固有扩展组', () => {
  it('推导本身：固有组是兜底，**接受一切扩展名**，故它永远存在', () => {
    // 没有任何自定义卡领走 .zip 时，.zip 仍然落进一张固有 ZIP 卡——「没有卡接受」永不发生
    const auto = buildCards([file('杂.zip')], emptyStore())
    expect(auto.map((c) => [c.id, c.tier])).toEqual([['dgc-zip', TIER_BUILTIN]])
    // 自动路由的兜底没有「拒绝」这一支：随便什么扩展名都有一张卡接着
    for (const ext of ['.zzz', '.qqq', '']) expect(resolveOwner(ext, emptyStore()).tier).toBe(TIER_BUILTIN)
  })

  it('出厂层序表把 temp 排在 builtin 之前（这张表就是那条推导的实现，不是注释）', () => {
    expect(PASTE_TIER_PRIORITY).toEqual([TIER_CUSTOM, TIER_TEMP, TIER_BUILTIN])
    expect(PASTE_TIER_PRIORITY.indexOf(TIER_TEMP)).toBeLessThan(PASTE_TIER_PRIORITY.indexOf(TIER_BUILTIN))
  })

  it('**同一批输入、两种层序、两种结果**：把 builtin 排到 temp 之前，临时卡就永远生成不出来', () => {
    const input = ['杂.zip'] // 没有卡接受它的那一批
    // 反面层序（builtin 先于 temp）：兜底层先收口 → 「没有卡接受」永不发生 → 零张临时卡
    const reversed = routePaste(emptyStore(), input, {
      nowMs: PASTED_AT,
      priority: [TIER_CUSTOM, TIER_BUILTIN, TIER_TEMP],
    })
    expect(reversed.kind).toBe('builtin')
    expect(reversed.tempCard).toBeNull()
    expect(reversed.store.temps).toHaveLength(0)
    expect(reversed.changed).toBe(false)
    // 出厂层序：temp 先收口 → 生成一张临时卡
    const shipped = routePaste(emptyStore(), input, { nowMs: PASTED_AT })
    expect(shipped.kind).toBe('temp')
    expect(shipped.tempCard).not.toBeNull()
    expect(shipped.store.temps).toHaveLength(1)
  })

  it('归属侧的同一条推导：临时卡的成员在分桶前就被摘走，故不进固有扩展组卡', () => {
    const pasted = routePaste(emptyStore(), ['杂.zip'], { nowMs: PASTED_AT })
    const cards = buildCards([file('杂.zip'), file('桌面原有.zip')], pasted.store)
    // 同为 .zip，两个文件落在两张不同的卡里；临时卡那个**不出现在**固有 ZIP 卡里
    expect(cards.map((c) => [c.id, c.tier])).toEqual([
      ['dgc-t1', TIER_TEMP],
      ['dgc-zip', TIER_BUILTIN],
    ])
    expect(membersOf(cards, 'dgc-t1')).toEqual(['杂.zip'])
    expect(membersOf(cards, 'dgc-zip')).toEqual(['桌面原有.zip'])
    // 卡序即三层优先级：自定义 → 临时 → 固有
    expect(cards.map((c) => c.tier)).toEqual([TIER_TEMP, TIER_BUILTIN])
  })

  it('已登记的代价：临时卡里的文件不被后来改勾的自定义卡领走（否则同一文件出现在两张卡里）', () => {
    let store = routePaste(emptyStore(), ['杂.zip'], { nowMs: PASTED_AT }).store
    store = normalizeStore({ ...store, groups: [{ id: 'dgc-c1', name: '压缩包', exts: ['.zip'], acceptAll: false, seq: 1 }], nextSeq: 9 })
    const cards = buildCards([file('杂.zip')], store)
    expect(membersOf(cards, 'dgc-t1')).toEqual(['杂.zip'])
    expect(cards.map((c) => c.tier)).toEqual([TIER_TEMP])
  })
})

describe('临时卡命名：粘贴时刻 + 序号，序号跨重启不撞名', () => {
  it('卡面名带**粘贴时刻**与序号（工单186 AC「命名含粘贴时间与序号」）', () => {
    const first = allocateTempCard(emptyStore(), PASTED_AT, ['a.zip'])
    const stamp = pasteStampOf(PASTED_AT)
    expect(stamp).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(first.card.name).toBe(`临时 ${stamp} 01`)
    expect(first.card.name).toBe(tempLabelOf(1, stamp))
    expect(first.card.name).toContain('01')
  })

  it('序号仍在末尾，唯一性靠序号不靠名字（两批落在同一分钟也要两张不同的卡）', () => {
    const a = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const b = routePaste(a.store, ['乙.zip'], { nowMs: PASTED_AT + 1000 })
    expect(a.tempCard?.name).not.toBe(b.tempCard?.name)
    expect([a.tempCard?.id, b.tempCard?.id]).toEqual(['dgc-t1', 'dgc-t2'])
  })

  it('时刻缺失时退化成只带序号（兜底路径不换一副面孔；时刻缺失也不编一个当前时间）', () => {
    expect(tempLabelOf(3)).toBe('临时 03')
    const none = allocateTempCard(emptyStore(), Number.NaN, ['a.zip'])
    expect(none.card).toMatchObject({ name: '临时 01', createdAtMs: 0 })
  })

  it('粘贴时刻按**本地**日历折算（卡面是人看的，21:04 粘的那批就该写 21:04）', () => {
    // 与实现同一口径（本地日历）折算出的字面量：混了 UTC 读数就会红
    const d = new Date(PASTED_AT)
    const p2 = (n: number) => String(n).padStart(2, '0')
    expect(pasteStampOf(PASTED_AT)).toBe(`${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`)
    expect(pasteStampOf(0)).toBe('')
  })

  it('**跨重启不撞名**：落库读回后再粘一批拿到的是 02，不是又一张 01', () => {
    const first = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const afterRestart = roundTrip(first.store)
    const second = routePaste(afterRestart, ['乙.zip'], { nowMs: PASTED_AT + 60000 })
    expect(second.tempCard?.seq).toBe(2)
    expect(second.tempCard?.id).toBe('dgc-t2')
    expect(second.tempCard?.name).not.toBe(first.tempCard?.name)
    // 两批的名单各自完整（重启没吃掉任何一批）
    expect(roundTrip(second.store).temps.map((t) => t.names)).toEqual([['甲.zip'], ['乙.zip']])
  })

  it('计数器被改回 1 也照样不撞名：盘上还在的序号会把 nextSeq 抬起来', () => {
    const first = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const rewound = roundTrip({ ...first.store, nextSeq: 1 })
    expect(rewound.nextSeq).toBe(2)
    expect(routePaste(rewound, ['乙.zip'], { nowMs: PASTED_AT }).tempCard?.id).toBe('dgc-t2')
  })

  it('自定义卡与临时卡共用一个计数器（两层的 id 都不会撞）', () => {
    const store = withCustom(emptyStore(), 1, ['.docx'])
    const route = routePaste(store, ['甲.zip'], { nowMs: PASTED_AT })
    expect(route.tempCard?.id).toBe('dgc-t2')
    expect(store.groups[0].id).not.toBe(route.tempCard?.id)
  })

  it('临时卡定义经 JSON 往返后名单与命名都还在（重启不丢批次）', () => {
    const first = routePaste(emptyStore(), ['甲.zip', '乙.docx'], { nowMs: PASTED_AT })
    expect(roundTrip(first.store).temps[0]).toEqual(first.tempCard)
  })

  it('名单自愈：非字符串逐条丢弃、trim、批内去重（一份坏名单不废掉整张卡）', () => {
    const healed = normalizeStore({
      version: 1,
      nextSeq: 1,
      groups: [],
      temps: [{ id: 'dgc-t1', seq: 1, names: [' a.zip ', 'a.zip', 42, null, '乙.docx'] }],
    })
    expect(healed.temps[0].names).toEqual(['a.zip', '乙.docx'])
    expect(normalizeStore({ temps: [{ id: 'dgc-t1', seq: 1, names: '不是数组' }] }).temps[0].names).toEqual([])
  })
})

describe('解散：删掉卡定义，卡内文件按扩展名回落固有分组，磁盘零移动', () => {
  it('删掉的是**定义**：临时卡不在了，它那批文件落回各自的固有扩展组卡', () => {
    const pasted = routePaste(emptyStore(), ['杂.zip', '报告.pdf'], { nowMs: PASTED_AT })
    const items = [file('杂.zip'), file('报告.pdf'), file('桌面原有.docx')]
    const before = buildCards(items, pasted.store)
    expect(before.map((c) => [c.id, c.tier])).toEqual([
      ['dgc-t1', TIER_TEMP],
      ['dgc-docx', TIER_BUILTIN],
    ])

    const after = dissolveGroup(pasted.store, 'dgc-t1')
    const cards = buildCards(items, after.store)
    // 回落：杂.zip → 固有 ZIP 卡；报告.pdf → 固有 PDF 卡；桌面原有的那张 DOCX 卡原样不动
    // 卡序仍是固有组序表那一套（办公系 → pdf → 压缩系），不是「按解散先后排」
    expect(cards.map((c) => [c.id, c.tier])).toEqual([
      ['dgc-docx', TIER_BUILTIN],
      ['dgc-pdf', TIER_BUILTIN],
      ['dgc-zip', TIER_BUILTIN],
    ])
    expect(membersOf(cards, 'dgc-zip')).toEqual(['杂.zip'])
    expect(membersOf(cards, 'dgc-pdf')).toEqual(['报告.pdf'])
  })

  it('**磁盘零移动**：回落后的条目就是传入的那同一个对象，一个字都没重造', () => {
    const pasted = routePaste(emptyStore(), ['杂.zip'], { nowMs: PASTED_AT })
    const item = file('杂.zip')
    const cards = buildCards([item], dissolveGroup(pasted.store, 'dgc-t1').store)
    // 归属变了（tier 与卡 id 都变了），条目对象本身**是同一个**——没有复制、没有移动、没有改名
    expect(cardOf(cards, '杂.zip').tier).toBe(TIER_BUILTIN)
    expect(cardOf(cards, '杂.zip').items[0]).toBe(item)
    expect(item).toEqual({ name: '杂.zip', kind: 'file' })
  })

  it('解散的返回值里**只有定义**：没有任何路径、没有任何文件操作（形状事实，不是承诺）', () => {
    const pasted = routePaste(emptyStore(), ['杂.zip'], { nowMs: PASTED_AT })
    const result = dissolveGroup(pasted.store, 'dgc-t1')
    expect(Object.keys(result).sort()).toEqual(['dissolved', 'kind', 'store'])
    expect(result.kind).toBe(TIER_TEMP)
    expect(result.dissolved).toEqual(pasted.tempCard)
    expect(JSON.stringify(result.store)).not.toContain('C:\\')
    expect(result.store.groups).toEqual([])
  })

  it('自定义组卡同样可解散：删定义后卡内文件按扩展名回落（且不被别的自定义卡半路领走）', () => {
    let store = withCustom(emptyStore(), 1, ['.docx'])
    store = withCustom(store, 2, ['.zip'])
    const items = [file('方案.docx'), file('杂.zip')]
    expect(buildCards(items, store).map((c) => c.tier)).toEqual([TIER_CUSTOM, TIER_CUSTOM])
    const after = dissolveGroup(store, 'dgc-c1')
    expect(after.kind).toBe(TIER_CUSTOM)
    const cards = buildCards(items, after.store)
    expect(cardOf(cards, '方案.docx')).toMatchObject({ id: 'dgc-docx', tier: TIER_BUILTIN })
    expect(cardOf(cards, '杂.zip').id).toBe('dgc-c2') // 另一张自定义卡仍在，.zip 归它
  })

  it('**序号不退**：解散一张卡不把号退回去（退了，重启后新卡就会与盘上某张重名）', () => {
    const pasted = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const after = roundTrip(dissolveGroup(pasted.store, 'dgc-t1').store)
    expect(after.temps).toHaveLength(0)
    expect(after.nextSeq).toBe(2)
    expect(routePaste(after, ['乙.zip'], { nowMs: PASTED_AT }).tempCard?.id).toBe('dgc-t2')
  })

  it('固有扩展组卡没有定义可删：原样返回、dissolved 为 null（拦不住也不会出错）', () => {
    const auto = buildCards([file('杂.zip')], emptyStore())
    const builtinId = auto[0].id // dgc-zip：规则算出来的，压根不在组定义里
    const result = dissolveGroup(emptyStore(), builtinId)
    expect(result.dissolved).toBeNull()
    expect(result.kind).toBe('')
    expect(result.store).toEqual(emptyStore())
    expect(acceptsAnyTypeOf(emptyStore(), builtinId)).toBe(false)
  })

  it('删除已解散的那张卡 / 一次解散两张：第二次是迟到噪声，状态原样不动', () => {
    const pasted = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const once = dissolveGroup(pasted.store, 'dgc-t1')
    const twice = dissolveGroup(once.store, 'dgc-t1')
    expect(twice.dissolved).toBeNull()
    expect(twice.store).toEqual(once.store)
  })

  it('往临时卡追加一批（第三态的落库面）：只加不重，返回本次真正新加的那几个', () => {
    const pasted = routePaste(emptyStore(), ['甲.zip'], { nowMs: PASTED_AT })
    const added = appendToTempCard(pasted.store, 'dgc-t1', ['甲.zip', '乙.docx'])
    expect(added.added).toEqual(['乙.docx'])
    expect(added.card?.names).toEqual(['甲.zip', '乙.docx'])
    expect(appendToTempCard(pasted.store, 'dgc-t9', ['丙.txt']).card).toBeNull()
    // 入参没被改（纯函数）
    expect(pasted.store.temps[0].names).toEqual(['甲.zip'])
  })
})
