/**
 * 中组推荐位编排纯函数测试（工单54）：推荐位 = dock 推荐段 ∩ 正分条目，
 * 分数降序（同分按名）、上限 8；手钉/显式摆位段与零分条目不占位。
 */
import { describe, expect, it } from 'vitest'
import { planTaskbarRecommendations, RECOMMENDATION_LIMIT } from '../../src/main/taskbar/plan'
import type { DesktopDockEntry, DesktopItem } from '../../src/shared/contract'

function appItem(name: string, display?: string): DesktopItem {
  return {
    name,
    display: display ?? name.replace(/\.lnk$/i, ''),
    kind: 'shortcut',
    zone: 'app',
    path: `C:\\Desktop\\${name}`,
    iconKey: `${name}|0`,
    mtimeMs: 0,
  }
}

function dockOf(entries: Array<[string, DesktopDockEntry['source']]>): DesktopDockEntry[] {
  return entries.map(([name, source]) => ({ name, source }))
}

describe('中组推荐位编排（工单54 纯函数）', () => {
  it('按使用频次分数降序填充，超出上限 8 截断（低分让位）', () => {
    const names = Array.from({ length: 10 }, (_, i) => `App${i}.lnk`)
    const items = names.map((n) => appItem(n))
    // 分数与名字反序：App9 最高分、App0 最低分——断言排序跟分数而非输入序
    const scores = new Map(names.map((n, i) => [n.replace(/\.lnk$/, ''), i + 1]))
    const dock = dockOf(names.map((n) => [n, 'recommended']))
    const recs = planTaskbarRecommendations(dock, items, scores)
    expect(recs).toHaveLength(RECOMMENDATION_LIMIT)
    expect(recs.map((r) => r.display)).toEqual(['App9', 'App8', 'App7', 'App6', 'App5', 'App4', 'App3', 'App2'])
    expect(recs[0]).toEqual({ name: 'App9.lnk', display: 'App9', path: 'C:\\Desktop\\App9.lnk' })
  })

  it('同分按名稳定排序（与 planDock 推荐段同规则）', () => {
    const items = [appItem('b.lnk', 'Beta'), appItem('a.lnk', 'Alpha')]
    const scores = new Map([['Beta', 3], ['Alpha', 3]])
    const dock = dockOf([['b.lnk', 'recommended'], ['a.lnk', 'recommended']])
    expect(planTaskbarRecommendations(dock, items, scores).map((r) => r.name)).toEqual(['a.lnk', 'b.lnk'])
  })

  it('零分与无分条目不占推荐位（无使用证据 = 不推荐，「无推荐」边界才可达）', () => {
    const items = [appItem('hot.lnk', 'Hot'), appItem('cold.lnk', 'Cold'), appItem('never.lnk', 'Never')]
    const scores = new Map([['Hot', 2], ['Cold', 0]])
    const dock = dockOf([['hot.lnk', 'recommended'], ['cold.lnk', 'recommended'], ['never.lnk', 'recommended']])
    expect(planTaskbarRecommendations(dock, items, scores).map((r) => r.name)).toEqual(['hot.lnk'])
  })

  it('手钉与显式摆位段不进推荐位（左组栏位不与中组重复），即使分数最高', () => {
    const items = [appItem('pin.lnk', 'Pin'), appItem('placed.lnk', 'Placed'), appItem('rec.lnk', 'Rec')]
    const scores = new Map([['Pin', 99], ['Placed', 50], ['Rec', 1]])
    const dock = dockOf([['pin.lnk', 'pinned'], ['placed.lnk', 'placed'], ['rec.lnk', 'recommended']])
    expect(planTaskbarRecommendations(dock, items, scores).map((r) => r.name)).toEqual(['rec.lnk'])
  })

  it('dock 名单里的陈旧名字（条目池外）跳过', () => {
    const items = [appItem('alive.lnk', 'Alive')]
    const scores = new Map([['Alive', 5], ['Ghost', 100]])
    const dock = dockOf([['ghost.lnk', 'recommended'], ['alive.lnk', 'recommended']])
    expect(planTaskbarRecommendations(dock, items, scores).map((r) => r.name)).toEqual(['alive.lnk'])
  })

  it('空 dock / 空池 → 空推荐位', () => {
    expect(planTaskbarRecommendations([], [], new Map())).toEqual([])
    expect(planTaskbarRecommendations(dockOf([['a.lnk', 'recommended']]), [], new Map([['A', 9]]))).toEqual([])
  })
})
