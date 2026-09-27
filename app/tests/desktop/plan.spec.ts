/**
 * 编排纯逻辑测试（工单06）：zones_plan.py / test_zones_plan_doc.py /
 * test_zones_plan_recommend.py 的自绘世界移植，外加显式摆位与分区覆盖语义。
 */
import { describe, expect, it } from 'vitest'
import { docGroupOf, planDesktop, GROUP_ORDER, planDock } from '../../src/main/desktop/plan'
import type { DesktopItem } from '../../src/shared/contract'

const DAY = 86400_000

function item(name: string, over: Partial<DesktopItem> = {}): DesktopItem {
  const kind = over.kind ?? (name.endsWith('.lnk') ? 'shortcut' : 'file')
  return {
    name,
    display: kind === 'shortcut' || kind === 'url' ? name.replace(/\.(lnk|url)$/i, '') : name,
    kind,
    zone: over.zone ?? (kind === 'shortcut' || kind === 'url' ? 'app' : 'doc'),
    path: `C:\\u\\${name}`,
    iconKey: `C:\\u\\${name}|1`,
    mtimeMs: over.mtimeMs ?? 1,
    ...over,
  }
}

function docAt(name: string, mtimeMs = 1): DesktopItem {
  return item(name, { mtimeMs })
}

const OPTS = { docMaxRows: 8 }

function positionsOf(items: DesktopItem[]) {
  const plan = planDesktop(items, [], { dock: [], docs: [] }, new Map(), OPTS)
  return new Map(plan.docs.map((d) => [d.name, d]))
}

describe('文档组归类（docGroupOf）', () => {
  it('文件夹恒为 folders 组', () => {
    expect(docGroupOf({ kind: 'folder', name: 'proj' })).toBe('folders')
  })
  it('office/pdf/image/archive 扩展名各归其组（大小写不敏感）', () => {
    expect(docGroupOf({ kind: 'file', name: 'a.DOCX' })).toBe('office')
    expect(docGroupOf({ kind: 'file', name: 'b.pdf' })).toBe('pdf')
    expect(docGroupOf({ kind: 'file', name: 'c.PNG' })).toBe('image')
    expect(docGroupOf({ kind: 'file', name: 'd.7z' })).toBe('archive')
  })
  it('未识别扩展名归 other 组', () => {
    expect(docGroupOf({ kind: 'file', name: 'weird.xyz' })).toBe('other')
  })
})

describe('文档区落位（Python test_zones_plan_doc 移植）', () => {
  it('单一组占一列', () => {
    const pos = positionsOf([0, 1, 2].map((i) => docAt(`a${i}.docx`, i)))
    expect(new Set([...pos.values()].map((d) => d.col)).size).toBe(1)
  })

  it('组间空一列（col 间隔 = 2）', () => {
    const pos = positionsOf([docAt('a.docx'), docAt('b.pdf')])
    expect(pos.get('b.pdf')!.col - pos.get('a.docx')!.col).toBe(2)
  })

  it('组序固定不随数量（pdf 在 archive 前）', () => {
    const pos = positionsOf([...[0, 1, 2, 3, 4].map((i) => docAt(`z${i}.zip`)), docAt('one.pdf')])
    expect(pos.get('one.pdf')!.col).toBeLessThan(pos.get('z0.zip')!.col)
  })

  it('folders 组恒在最前', () => {
    const pos = positionsOf([docAt('a.docx'), item('proj', { kind: 'folder' })])
    expect(pos.get('proj')!.col).toBe(0)
    expect(pos.get('a.docx')!.col).toBeGreaterThan(0)
  })

  it('空组不占列（office 在第 0 列、pdf 紧跟第 2 列）', () => {
    const pos = positionsOf([docAt('a0.docx'), docAt('a1.docx'), docAt('a2.docx'), docAt('b.pdf')])
    expect(pos.get('a0.docx')!.col).toBe(0)
    expect(pos.get('b.pdf')!.col).toBe(2)
  })

  it('组内新在上（mtime 降序），同值按名稳定', () => {
    const pos = positionsOf([docAt('old.docx', 100), docAt('new.docx', 900)])
    expect(pos.get('new.docx')!.rank).toBe(0)
    expect(pos.get('old.docx')!.rank).toBe(1)
    const tie = positionsOf([docAt('b.docx', 5), docAt('a.docx', 5)])
    expect(tie.get('a.docx')!.rank).toBe(0)
    expect(tie.get('b.docx')!.rank).toBe(1)
  })

  it('满 docMaxRows 折本组右侧相邻列', () => {
    const items = Array.from({ length: 9 }, (_, i) => docAt(`a${i}.docx`, 1))
    const pos = positionsOf(items)
    const cols = [...new Set([...pos.values()].map((d) => d.col))].sort((a, b) => a - b)
    expect(cols).toEqual([0, 1])
    expect(pos.get('a8.docx')!.col).toBe(1)
    expect(pos.get('a8.docx')!.row).toBe(0)
    expect(pos.get('a7.docx')!.row).toBe(7)
  })

  it('折列后组占连续列，后继组在空列之后', () => {
    const items = [...Array.from({ length: 9 }, (_, i) => docAt(`a${i}.docx`, 1)), docAt('b.pdf')]
    const pos = positionsOf(items)
    expect(pos.get('a8.docx')!.col).toBe(1)
    expect(pos.get('b.pdf')!.col).toBe(3) // 0,1 用列 + 1 空列
  })

  it('docMaxRows 可配（4 行折列）', () => {
    const items = Array.from({ length: 5 }, (_, i) => docAt(`a${i}.docx`, 1))
    const pos = new Map(
      planDesktop(items, [], { dock: [], docs: [] }, new Map(), { docMaxRows: 4 }).docs.map((d) => [d.name, d]),
    )
    expect(pos.get('a4.docx')!.col).toBe(1)
    expect(pos.get('a3.docx')!.row).toBe(3)
  })

  it('没有文档时 docs 为空', () => {
    const plan = planDesktop([item('Kimi.lnk')], [], { dock: [], docs: [] }, new Map(), OPTS)
    expect(plan.docs).toEqual([])
  })

  it('显式摆位条目保持其相对顺序且排组首段', () => {
    const items = [docAt('old.docx', 1), docAt('mid.docx', 500), docAt('new.docx', 900)]
    const placed = { dock: [], docs: ['old.docx', 'mid.docx'] }
    const plan = planDesktop(items, [], placed, new Map(), OPTS)
    const ranks = new Map(plan.docs.map((d) => [d.name, d.rank]))
    expect(ranks.get('old.docx')).toBe(0)
    expect(ranks.get('mid.docx')).toBe(1)
    expect(ranks.get('new.docx')).toBe(2)
  })

  it('摆位名单中的陈旧名字被池过滤（文件回来摆位仍在名单）', () => {
    const plan = planDesktop([docAt('a.docx')], [], { dock: [], docs: ['ghost.docx', 'a.docx'] }, new Map(), OPTS)
    expect(plan.docs.map((d) => d.name)).toEqual(['a.docx'])
  })
})

describe('应用区栏位分配（Python test_zones_plan_recommend 移植，无栏位上限版）', () => {
  const scores = (entries: Record<string, number>) => new Map(Object.entries(entries))

  it('手钉无论分数恒占前段（按清单序），推荐不被顶替', () => {
    const items = [item('low.lnk'), item('hot.lnk')]
    const dock = planDock(items, ['low.lnk'], [], scores({ hot: 99, low: 0.1 }))
    expect(dock.map((d) => d.name)).toEqual(['low.lnk', 'hot.lnk'])
    expect(dock[0]).toMatchObject({ source: 'pinned' })
    expect(dock[1]).toMatchObject({ source: 'recommended' })
  })

  it('剩余栏位按分数降序填补', () => {
    const items = [item('a.lnk'), item('b.lnk'), item('c.lnk')]
    const dock = planDock(items, [], [], scores({ c: 3, a: 1, b: 2 }))
    expect(dock.map((d) => d.name)).toEqual(['c.lnk', 'b.lnk', 'a.lnk'])
  })

  it('同分按名稳定排序且可复现', () => {
    const items = [item('b.lnk'), item('a.lnk')]
    const s = scores({ a: 1, b: 1 })
    expect(planDock(items, [], [], s).map((d) => d.name)).toEqual(['a.lnk', 'b.lnk'])
    expect(planDock(items, [], [], s).map((d) => d.name)).toEqual(['a.lnk', 'b.lnk'])
  })

  it('无分数的快捷方式仍参与填补（记 0 分）', () => {
    const dock = planDock([item('scored.lnk'), item('ghost.lnk')], [], [], scores({ scored: 2 }))
    expect(dock.map((d) => [d.name, d.source])).toEqual([['scored.lnk', 'recommended'], ['ghost.lnk', 'recommended']])
  })

  it('无分数参数 = 全零（全部按名序）', () => {
    const dock = planDock([item('z.lnk'), item('a.lnk'), item('m.lnk')], [], [], new Map())
    expect(dock.map((d) => d.name)).toEqual(['a.lnk', 'm.lnk', 'z.lnk'])
  })

  it('显式摆位段插在手钉之后、推荐之前', () => {
    const items = [item('pin.lnk'), item('hot.lnk'), item('warm.lnk'), item('cold.lnk')]
    const dock = planDock(items, ['pin.lnk'], ['cold.lnk'], scores({ hot: 9, warm: 5, cold: 1 }))
    expect(dock.map((d) => [d.name, d.source])).toEqual([
      ['pin.lnk', 'pinned'],
      ['cold.lnk', 'placed'],
      ['hot.lnk', 'recommended'],
      ['warm.lnk', 'recommended'],
    ])
  })

  it('手钉条目被拖动仍保持手钉身份（pinned 清单优先）', () => {
    const items = [item('pin.lnk'), item('other.lnk')]
    const dock = planDock(items, ['pin.lnk'], ['pin.lnk'], new Map())
    expect(dock[0]).toMatchObject({ name: 'pin.lnk', source: 'pinned' })
  })

  it('不在池中的手钉名字被过滤、清单去重', () => {
    const items = [item('a.lnk')]
    const dock = planDock(items, ['gone.lnk', 'a.lnk', 'a.lnk'], [], new Map())
    expect(dock.map((d) => d.name)).toEqual(['a.lnk'])
  })
})

describe('分区覆盖（跨区拖拽即换区）', () => {
  it('dock 名单里的文档类条目入应用区（zone 由服务层改写后进编排）', () => {
    // 服务层 applyZoneOverrides 已把 zone 改写为 app——编排只认 zone
    const docAsApp = item('note.txt', { zone: 'app' })
    const plan = planDesktop([docAsApp], [], { dock: ['note.txt'], docs: [] }, new Map(), OPTS)
    expect(plan.dock.map((d) => d.name)).toEqual(['note.txt'])
    expect(plan.docs).toEqual([])
  })
})

describe('组序契约', () => {
  it('GROUP_ORDER 固定六组', () => {
    expect([...GROUP_ORDER]).toEqual(['folders', 'office', 'pdf', 'image', 'archive', 'other'])
  })
})

describe('时间语义（防止 mtime 单位漂移）', () => {
  it('mtime 为 ms 纪元（近今值直接可比）', () => {
    const recent = docAt('new.docx', Date.now())
    const old = docAt('old.docx', Date.now() - 30 * DAY)
    const plan = planDesktop([old, recent], [], { dock: [], docs: [] }, new Map(), OPTS)
    expect(plan.docs[0].name).toBe('new.docx')
  })
})
