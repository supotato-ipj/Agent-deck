/**
 * 中组推荐位编排纯函数测试（工单54）：推荐位 = 应用区条目 ∩ 正分条目，
 * 分数降序（同分按名）、上限 8；零分条目与文档条目不占位。
 * 工单59：候选不再经 dock 推荐段，直接取自桌面条目池的 zone=app 段。
 */
import { describe, expect, it } from 'vitest'
import { applyRecommendationOrder, planTaskbarRecommendations, RECOMMENDATION_LIMIT } from '../../src/main/taskbar/plan'
import type { DesktopItem, TaskbarRecommendation } from '../../src/shared/contract'

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

describe('中组推荐位编排（工单54 纯函数）', () => {
  it('按使用频次分数降序填充，超出上限 8 截断（低分让位）', () => {
    const names = Array.from({ length: 10 }, (_, i) => `App${i}.lnk`)
    const items = names.map((n) => appItem(n))
    // 分数与名字反序：App9 最高分、App0 最低分——断言排序跟分数而非输入序
    const scores = new Map(names.map((n, i) => [n.replace(/\.lnk$/, ''), i + 1]))
    const recs = planTaskbarRecommendations(items, scores)
    expect(recs).toHaveLength(RECOMMENDATION_LIMIT)
    expect(recs.map((r) => r.display)).toEqual(['App9', 'App8', 'App7', 'App6', 'App5', 'App4', 'App3', 'App2'])
    expect(recs[0]).toEqual({ name: 'App9.lnk', display: 'App9', path: 'C:\\Desktop\\App9.lnk' })
  })

  it('同分按名稳定排序（与旧 planDock 推荐段同规则）', () => {
    const items = [appItem('b.lnk', 'Beta'), appItem('a.lnk', 'Alpha')]
    const scores = new Map([['Beta', 3], ['Alpha', 3]])
    expect(planTaskbarRecommendations(items, scores).map((r) => r.name)).toEqual(['a.lnk', 'b.lnk'])
  })

  it('零分与无分条目不占推荐位（无使用证据 = 不推荐，「无推荐」边界才可达）', () => {
    const items = [appItem('hot.lnk', 'Hot'), appItem('cold.lnk', 'Cold'), appItem('never.lnk', 'Never')]
    const scores = new Map([['Hot', 2], ['Cold', 0]])
    expect(planTaskbarRecommendations(items, scores).map((r) => r.name)).toEqual(['hot.lnk'])
  })

  it('文档条目即便有分也不占推荐位（不是应用入口）', () => {
    const items = [
      appItem('rec.lnk', 'Rec'),
      { ...appItem('note.docx', 'Note'), kind: 'file' as const, zone: 'doc' as const },
    ]
    const scores = new Map([['Note', 99], ['Rec', 1]])
    expect(planTaskbarRecommendations(items, scores).map((r) => r.name)).toEqual(['rec.lnk'])
  })

  it('池外名字（分数里有、条目池里没有）不占位', () => {
    const items = [appItem('alive.lnk', 'Alive')]
    const scores = new Map([['Alive', 5], ['Ghost', 100]])
    expect(planTaskbarRecommendations(items, scores).map((r) => r.name)).toEqual(['alive.lnk'])
  })

  it('空池 → 空推荐位', () => {
    expect(planTaskbarRecommendations([], new Map())).toEqual([])
    expect(planTaskbarRecommendations([], new Map([['A', 9]]))).toEqual([])
  })
})

describe('推荐位显式序套用（工单57 纯函数）', () => {
  const rec = (name: string): TaskbarRecommendation => ({ name, display: name.replace(/\.lnk$/i, ''), path: `C:\\Desktop\\${name}` })

  it('显式序内的条目按名单次前排（用户拖出的序压过分数序）；序外条目保持原序随后', () => {
    const recs = [rec('a.lnk'), rec('b.lnk'), rec('c.lnk'), rec('d.lnk')] // 分数序 a>b>c>d
    expect(applyRecommendationOrder(recs, ['c.lnk', 'a.lnk']).map((r) => r.name))
      .toEqual(['c.lnk', 'a.lnk', 'b.lnk', 'd.lnk'])
  })

  it('显式序的陈旧名（当前推荐位不在场）跳过；空显式序 = 原样返回', () => {
    const recs = [rec('a.lnk'), rec('b.lnk')]
    expect(applyRecommendationOrder(recs, ['ghost.lnk', 'b.lnk']).map((r) => r.name)).toEqual(['b.lnk', 'a.lnk'])
    expect(applyRecommendationOrder(recs, [])).toEqual(recs)
  })

  it('不改动入参（纯函数纪律）', () => {
    const recs = [rec('a.lnk'), rec('b.lnk')]
    applyRecommendationOrder(recs, ['b.lnk'])
    expect(recs.map((r) => r.name)).toEqual(['a.lnk', 'b.lnk'])
  })
})
