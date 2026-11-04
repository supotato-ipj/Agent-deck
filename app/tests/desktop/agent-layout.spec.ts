// Agent 桌面布局持久化纯模型测试（工单383，spec #369 决策 13 桌面持久化）：
// 白名单解析/序列化、模型一致性拒绝面、恢复规划（保留/丢弃/追加/身份不符安全态）、
// 隐私断言（不含标题/缩略图/手动授权）。零 IO、零 FFI。
import { describe, expect, it } from 'vitest'
import {
  AGENT_LAYOUT_VERSION,
  captureLayout,
  captureShape,
  identityMatches,
  identityOf,
  parseLayout,
  planRestore,
  serializeLayout,
  validateLayout,
} from '../../src/main/desktop/agent-layout'
import type { AgentLayoutDoc, WindowIdentity } from '../../src/main/desktop/agent-layout'
import { createTree, treeFromShape, treeInsert, treePlan } from '../../src/main/desktop/tiling-plan'
import type { TilingTree } from '../../src/main/desktop/tiling-plan'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'

const DESKTOP = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function fact(hwnd: number, over: Partial<TileWindowFacts> = {}): TileWindowFacts {
  return {
    hwnd,
    pid: 1000 + hwnd,
    exe: `C:\\apps\\w${hwnd}.exe`,
    title: `敏感标题 ${hwnd}`,
    visible: true,
    cloaked: false,
    cloakedShell: false,
    toolWindow: false,
    owned: false,
    appWindow: false,
    iconic: false,
    resizable: true,
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
    onCurrentDesktop: true,
    ...over,
  }
}

function identity(hwnd: number): WindowIdentity {
  return identityOf(fact(hwnd))
}

function doc(over: Partial<AgentLayoutDoc> = {}): AgentLayoutDoc {
  return {
    version: AGENT_LAYOUT_VERSION,
    desktopId: DESKTOP,
    clean: true,
    order: [],
    tree: null,
    queue: [],
    band: [],
    anchor: null,
    floating: [],
    ...over,
  }
}

describe('布局文档解析与一致性（工单383）', () => {
  it('缺失 → none；坏 JSON/未知版本/结构不符 → invalid（不猜读）', () => {
    expect(parseLayout(null).kind).toBe('none')
    expect(parseLayout('{')).toMatchObject({ kind: 'invalid', reason: 'json' })
    // v1 = 上一版（迁移接受：band/anchor 缺省）；99 = 未知版本（安全态，不猜读）
    expect(parseLayout(JSON.stringify({ ...doc(), version: 99 }))).toMatchObject({ kind: 'invalid', reason: 'version' })
    expect(parseLayout(JSON.stringify({ ...doc(), desktopId: '' }))).toMatchObject({ kind: 'invalid', reason: 'desktopId' })
    expect(parseLayout(JSON.stringify({ ...doc(), clean: 'yes' }))).toMatchObject({ kind: 'invalid', reason: 'clean' })
  })

  it('合法文档往返：字段保持；未知字段在解析时丢弃（白名单重建）', () => {
    const original = doc({
      order: [identity(1), identity(2)],
      tree: { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 0 }, second: { kind: 'leaf', ref: 1 } },
      queue: [1, 0],
      floating: [],
    })
    const text = JSON.stringify({ ...original, title: '秘密', dataUrl: 'data:image/png;base64,xxx' })
    const parsed = parseLayout(text)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.doc).toEqual(original)
    expect(JSON.stringify(parsed.doc)).not.toContain('秘密')
    expect(JSON.stringify(parsed.doc)).not.toContain('data:image')
    expect(parsed.doc).not.toHaveProperty('title')
  })

  it('模型不一致逐项拒绝：重复 hwnd/树引用越界/队列非叶/浮动与树互斥破坏/坏矩形', () => {
    const goodTree = { kind: 'split' as const, axis: 'h' as const, first: { kind: 'leaf' as const, ref: 0 }, second: { kind: 'leaf' as const, ref: 1 } }
    const base = doc({ order: [identity(1), identity(2)], tree: goodTree, queue: [1, 0] })
    expect(validateLayout(base)).toBeNull()
    expect(validateLayout({ ...base, order: [identity(1), identity(1)] })).toBe('duplicate-hwnd')
    expect(validateLayout({ ...base, tree: { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 9 }, second: { kind: 'leaf', ref: 1 } } })).toBe('tree-ref')
    expect(validateLayout({ ...base, queue: [0, 0] })).toBe('queue-duplicate')
    expect(validateLayout({ ...base, floating: [{ ref: 0, rect: { left: 0, top: 0, right: 10, bottom: 10 } }] })).toBe('floating-in-tree')
    expect(validateLayout({ ...base, floating: [{ ref: 0, rect: { left: 10, top: 0, right: 0, bottom: 10 } }] })).toBe('floating-rect')
  })

  it('身份核对：pid/exe 任一不符即不是同一扇窗', () => {
    const stored = identity(1)
    expect(identityMatches(stored, fact(1))).toBe(true)
    expect(identityMatches(stored, fact(1, { pid: 9999 }))).toBe(false)
    expect(identityMatches(stored, fact(1, { exe: 'C:\\apps\\other.exe' }))).toBe(false)
    expect(identityMatches(stored, fact(2))).toBe(false)
  })
})

describe('恢复规划（工单383）', () => {
  const f1 = fact(1)
  const f2 = fact(2)
  const f3 = fact(3)

  it('干净重启：保留命中成员、丢弃已消失成员、按现序追加新成员；树/队列/浮动按新下标重映射', () => {
    const d = doc({
      order: [identity(1), identity(2), identity(3)],
      tree: {
        kind: 'split', axis: 'h',
        first: { kind: 'leaf', ref: 0 },
        second: { kind: 'leaf', ref: 1 },
      },
      queue: [1, 0],
      floating: [{ ref: 2, rect: { left: 500, top: 100, right: 900, bottom: 500 } }],
    })
    // 窗 2 已关闭；窗 4 是面板停摆期间新开的
    const f4 = fact(4)
    const plan = planRestore(d, [f1, f3, f4], [f1, f3, f4])
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    expect(plan.order.map((w) => w.hwnd)).toEqual([1, 3, 4])
    expect(plan.dropped).toBe(1)
    expect(plan.floating).toEqual([{ ref: 1, rect: { left: 500, top: 100, right: 900, bottom: 500 } }])
    // 原树 left(1) / right(2 gone) → 兄弟上移：树退化为单叶 1
    expect(plan.shape).toEqual({ kind: 'leaf', ref: 0 })
    expect(plan.queue).toEqual([0])
  })

  it('同 hwnd 身份不符 → 安全态（不猜测接管未知窗口）', () => {
    const d = doc({ order: [identity(1)], tree: { kind: 'leaf', ref: 0 } })
    const plan = planRestore(d, [fact(1, { pid: 7777 })], [fact(1, { pid: 7777 })])
    expect(plan).toEqual({ kind: 'safe', reason: 'window-identity' })
  })

  it('无树文档（tree=null）→ 按成员序重建，不崩、不猜树形', () => {
    const d = doc({ order: [identity(1), identity(2)], tree: null, queue: [] })
    const plan = planRestore(d, [f1, f2], [f1, f2])
    expect(plan).toMatchObject({ kind: 'apply', shape: null, queue: [] })
  })

  it('存储窗口全消失 → 空计划（不判故障）；当前新窗按现序加入', () => {
    const d = doc({ order: [identity(9)], tree: { kind: 'leaf', ref: 0 }, queue: [] })
    const plan = planRestore(d, [f1, f2], [f1, f2])
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    expect(plan.order.map((w) => w.hwnd)).toEqual([1, 2])
    expect(plan.dropped).toBe(1)
  })
})

describe('布局捕获与隐私白名单（工单383）', () => {
  it('树/队列/浮动全部映射为 order 下标；序列化不含标题、缩略图与授权字段', () => {
    const tree = createTree({ left: 0, top: 0, right: 1000, bottom: 800 })
    treeInsert(tree, '1')
    treeInsert(tree, '2')
    treeInsert(tree, '3')
    const captured = captureLayout({
      desktopId: DESKTOP,
      clean: false,
      order: [identity(1), identity(2), identity(3), identity(4)],
      tree,
      floating: [{ hwnd: 4, rect: { left: 10, top: 20, right: 300, bottom: 400 } }],
    })
    expect(captured.version).toBe(AGENT_LAYOUT_VERSION)
    expect(captured.tree).not.toBeNull()
    expect(captured.queue.length).toBeGreaterThan(0)
    expect(captured.floating).toEqual([{ ref: 3, rect: { left: 10, top: 20, right: 300, bottom: 400 } }])
    expect(validateLayout(captured)).toBeNull()
    const text = serializeLayout(captured)
    expect(text).not.toContain('敏感标题')
    expect(text).not.toContain('data:image')
    for (const forbidden of ['title', 'prompt', 'armed', 'authorized', 'thumbnail', 'image']) {
      expect(text.includes(`"${forbidden}"`)).toBe(false)
    }
    // 字段白名单：只有恢复必需的键（工单406 增屏外顺序与锚窗身份）
    expect(Object.keys(captured).sort()).toEqual(['anchor', 'band', 'clean', 'desktopId', 'floating', 'order', 'queue', 'tree', 'version'])
  })

  it('树模型与成员序一致：三窗树的 placements 恢复顺序与原建树一致', () => {
    const tree = createTree({ left: 0, top: 0, right: 1000, bottom: 800 })
    for (const id of ['1', '2', '3']) treeInsert(tree, id)
    const captured = captureLayout({ desktopId: DESKTOP, clean: true, order: [identity(1), identity(2), identity(3)], tree, floating: [] })
    const plan = planRestore(captured, [fact(1), fact(2), fact(3)], [fact(1), fact(2), fact(3)])
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    // 恢复后的形状叶序与原树叶序（1,2,3）一致
    const leaves: number[] = []
    const walk = (n: NonNullable<typeof plan.shape>): void => {
      if (n.kind === 'leaf') { if (n.ref !== null) leaves.push(n.ref); return }
      walk(n.first)
      walk(n.second)
    }
    if (plan.shape) walk(plan.shape)
    expect(leaves).toEqual([0, 1, 2])
    expect(treePlan(tree).placements.map((p) => p.id)).toEqual(['1', '2', '3'])
  })
})

// ————————————————————————————————————————————————————————————
// 工单406（spec #403 决策「持久化布局关系而非旧像素」）：布局文档 v2 扩展
// 屏外顺序（band）与锚窗身份（anchor）——v1 迁移、白名单核验、恢复规划重映射。
// ————————————————————————————————————————————————————————————

describe('布局文档 v2：屏外顺序与锚窗身份（工单406）', () => {
  const bandDoc = (): AgentLayoutDoc => doc({
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
  })

  it('v1 文档迁移：缺 band/anchor 按缺省重建（空带、无锚），版本规范化为当前版', () => {
    const v1 = JSON.stringify({
      version: 1,
      desktopId: DESKTOP,
      clean: true,
      order: [identity(1), identity(2)],
      tree: { kind: 'split', axis: 'h', first: { kind: 'leaf', ref: 0 }, second: { kind: 'leaf', ref: 1 } },
      queue: [1, 0],
      floating: [],
    })
    const parsed = parseLayout(v1)
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.doc.version).toBe(AGENT_LAYOUT_VERSION)
    expect(parsed.doc.band).toEqual([])
    expect(parsed.doc.anchor).toBeNull()
  })

  it('v2 合法文档往返：band/anchor 字段保持', () => {
    const parsed = parseLayout(serializeLayout(bandDoc()))
    expect(parsed.kind).toBe('ok')
    if (parsed.kind !== 'ok') return
    expect(parsed.doc.band).toEqual([4])
    expect(parsed.doc.anchor).toBe(4)
  })

  it('结构核验：band/anchor 引用越界、重复、与树/浮动互斥破坏逐项拒绝', () => {
    const base = bandDoc()
    expect(validateLayout(base)).toBeNull()
    expect(validateLayout({ ...base, band: '0' })).toBe('band')
    expect(validateLayout({ ...base, band: [9] })).toBe('band-ref')
    expect(validateLayout({ ...base, band: [-1] })).toBe('band-ref')
    expect(validateLayout({ ...base, band: [4, 4] })).toBe('band-duplicate')
    expect(validateLayout({ ...base, band: [0] })).toBe('band-in-tree')
    expect(validateLayout({ ...base, floating: [{ ref: 4, rect: { left: 1, top: 1, right: 9, bottom: 9 } }] })).toBe('band-in-floating')
    expect(validateLayout({ ...base, anchor: 9 })).toBe('anchor-ref')
    expect(validateLayout({ ...base, anchor: 'x' })).toBe('anchor')
    expect(validateLayout({ ...base, floating: [{ ref: 4, rect: { left: 1, top: 1, right: 9, bottom: 9 } }], band: [] })).toBe('anchor-in-floating')
  })

  it('恢复规划：band/anchor 按新下标重映射；消失成员出带、锚失效置空', () => {
    const d = bandDoc()
    // 窗 5（带成员兼锚窗）已关闭；窗 6 是新开的
    const f6 = fact(6)
    const plan = planRestore(d, [fact(1), fact(2), fact(3), fact(4), f6], [fact(1), fact(2), fact(3), fact(4), f6])
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    expect(plan.order.map((w) => w.hwnd)).toEqual([1, 2, 3, 4, 6])
    expect(plan.dropped).toBe(1)
    expect(plan.band).toEqual([]) // 带成员消失 → 出带
    expect(plan.anchor).toBeNull() // 锚窗消失 → 无锚
    // 带成员存活：重映射到新下标
    const d2 = bandDoc()
    const plan2 = planRestore(d2, [fact(1), fact(2), fact(3), fact(4), fact(5)], [fact(1), fact(2), fact(3), fact(4), fact(5)])
    expect(plan2.kind).toBe('apply')
    if (plan2.kind !== 'apply') return
    expect(plan2.band).toEqual([4])
    expect(plan2.anchor).toBe(4)
  })

  it('捕获：band/anchor 映射为 order 下标；锚不在成员序时置空（不落浮动窗为锚）', () => {
    // 640×500 区、minPane 320×240：四窗恰满容量，窗 5 入带
    const tree = createTree({ left: 0, top: 0, right: 640, bottom: 500 })
    for (const id of ['1', '2', '3', '4', '5']) treeInsert(tree, id)
    expect(tree.overflow).toEqual(['5'])
    const captured = captureLayout({
      desktopId: DESKTOP,
      clean: false,
      order: [identity(1), identity(2), identity(3), identity(4), identity(5), identity(9)],
      tree,
      floating: [{ hwnd: 9, rect: { left: 10, top: 20, right: 300, bottom: 400 } }],
      band: [5],
      anchor: 5,
    })
    expect(captured.band).toEqual([4])
    expect(captured.anchor).toBe(4)
    expect(validateLayout(captured)).toBeNull()
    // 锚窗已浮动（不在成员序）→ 置空，不把浮动窗落成锚
    const capturedFloatAnchor = captureLayout({
      desktopId: DESKTOP,
      clean: false,
      order: [identity(1), identity(2), identity(3), identity(4), identity(5), identity(9)],
      tree,
      floating: [{ hwnd: 9, rect: { left: 10, top: 20, right: 300, bottom: 400 } }],
      band: [5],
      anchor: 9,
    })
    expect(capturedFloatAnchor.anchor).toBeNull()
  })
})

// ————————————————————————————————————————————————————————————
// 工单410（spec #410 决策「旧布局向新上限归一」）：干净启动读到合法但超过 8 个屏内
// 窗格的旧模型时，按持久成员顺序保留前段屏内成员，其余按序转入屏外滚动带；模型损坏
// 不按可恢复模型处理（不在本节——损坏文档仍走 invalid → model 安全态）。
// ————————————————————————————————————————————————————————————

describe('旧布局向屏内上限归一（工单410）', () => {
  /** 旧模型树（无上限时代可合法携带 >8 叶）：maxPanes 注入 99 模拟旧建树 */
  function legacyShape(memberCount: number, area = { left: 0, top: 0, right: 2560, bottom: 1392 }) {
    const tree = createTree(area, { maxPanes: 99 })
    for (let i = 1; i <= memberCount; i++) treeInsert(tree, String(i))
    const refOf = (id: string): number | undefined => {
      const n = Number(id)
      return n >= 1 && n <= memberCount ? n - 1 : undefined
    }
    const shape = captureShape(tree.root, refOf)
    const queue = tree.queue
      .map((leaf) => (leaf.id === null ? undefined : refOf(leaf.id)))
      .filter((r): r is number => r !== undefined)
    return { shape, queue }
  }

  it('九叶旧树：前 8 个成员（按持久成员序）保留在树，第 9 成员按序转入带', () => {
    const { shape, queue } = legacyShape(9)
    const d = doc({
      order: Array.from({ length: 9 }, (_, i) => identity(i + 1)),
      tree: shape,
      queue,
    })
    expect(validateLayout(d)).toBeNull()
    const facts = Array.from({ length: 9 }, (_, i) => fact(i + 1))
    const plan = planRestore(d, facts, facts)
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    const leafRefs: number[] = []
    const walk = (s: typeof plan.shape): void => {
      if (!s) return
      if (s.kind === 'leaf') { if (s.ref !== null) leafRefs.push(s.ref); return }
      walk(s.first)
      walk(s.second)
    }
    walk(plan.shape)
    expect(leafRefs.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]) // 前 8 成员留树
    expect(plan.band).toEqual([8]) // 第 9 成员（下标 8）入带
    // 队列与树自洽：恰含全部树内叶、无越界无重复
    expect([...plan.queue].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('九叶旧树 + 既有带成员：已入带者保持带序，被归一出的成员按成员序追加队尾', () => {
    const { shape, queue } = legacyShape(9)
    const d = doc({
      order: Array.from({ length: 10 }, (_, i) => identity(i + 1)),
      tree: shape,
      queue,
      band: [9], // 第 10 成员（下标 9）旧模型已在带
      anchor: 8, // 锚 = 被归一出的成员（下标 8）——转带后仍是合法锚
    })
    expect(validateLayout(d)).toBeNull()
    const facts = Array.from({ length: 10 }, (_, i) => fact(i + 1))
    const plan = planRestore(d, facts, facts)
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    expect(plan.band).toEqual([9, 8]) // 既有带成员在前、归一转入者按成员序追加
    expect(plan.anchor).toBe(8) // 带成员可以是锚
  })

  it('八叶及以下旧树不归一（上限是迁移判据，不是重排借口）', () => {
    const { shape, queue } = legacyShape(8)
    const d = doc({
      order: Array.from({ length: 8 }, (_, i) => identity(i + 1)),
      tree: shape,
      queue,
    })
    const facts = Array.from({ length: 8 }, (_, i) => fact(i + 1))
    const plan = planRestore(d, facts, facts)
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    expect(plan.band).toEqual([])
    const leafRefs: number[] = []
    const walk = (s: typeof plan.shape): void => {
      if (!s) return
      if (s.kind === 'leaf') { if (s.ref !== null) leafRefs.push(s.ref); return }
      walk(s.first)
      walk(s.second)
    }
    walk(plan.shape)
    expect(leafRefs.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('归一后的计划可被 treeFromShape 重建为合法树（≤8 叶、队列自洽）', () => {
    const { shape, queue } = legacyShape(9)
    const d = doc({
      order: Array.from({ length: 9 }, (_, i) => identity(i + 1)),
      tree: shape,
      queue,
    })
    const facts = Array.from({ length: 9 }, (_, i) => fact(i + 1))
    const plan = planRestore(d, facts, facts)
    expect(plan.kind).toBe('apply')
    if (plan.kind !== 'apply') return
    const tree = treeFromShape(
      plan.shape as NonNullable<typeof plan.shape>,
      { left: 0, top: 0, right: 2560, bottom: 1392 },
      {},
      plan.queue,
      (ref) => String(ref + 1), // 服务侧同款：ref = order 下标 → hwnd
    )
    expect(treePlan(tree).placements.length).toBe(8)
    expect(treePlan(tree).placements.map((p) => p.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => String(i + 1)).sort(),
    )
  })
})
