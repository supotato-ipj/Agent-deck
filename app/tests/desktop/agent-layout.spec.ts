// Agent 桌面布局持久化纯模型测试（工单383，spec #369 决策 13 桌面持久化）：
// 白名单解析/序列化、模型一致性拒绝面、恢复规划（保留/丢弃/追加/身份不符安全态）、
// 隐私断言（不含标题/缩略图/手动授权）。零 IO、零 FFI。
import { describe, expect, it } from 'vitest'
import {
  AGENT_LAYOUT_VERSION,
  captureLayout,
  identityMatches,
  identityOf,
  parseLayout,
  planRestore,
  serializeLayout,
  validateLayout,
} from '../../src/main/desktop/agent-layout'
import type { AgentLayoutDoc, WindowIdentity } from '../../src/main/desktop/agent-layout'
import { createTree, treeInsert, treePlan } from '../../src/main/desktop/tiling-plan'
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
    floating: [],
    ...over,
  }
}

describe('布局文档解析与一致性（工单383）', () => {
  it('缺失 → none；坏 JSON/未知版本/结构不符 → invalid（不猜读）', () => {
    expect(parseLayout(null).kind).toBe('none')
    expect(parseLayout('{')).toMatchObject({ kind: 'invalid', reason: 'json' })
    expect(parseLayout(JSON.stringify({ ...doc(), version: 2 }))).toMatchObject({ kind: 'invalid', reason: 'version' })
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
    // 字段白名单：只有恢复必需的六类键
    expect(Object.keys(captured).sort()).toEqual(['clean', 'desktopId', 'floating', 'order', 'queue', 'tree', 'version'])
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
