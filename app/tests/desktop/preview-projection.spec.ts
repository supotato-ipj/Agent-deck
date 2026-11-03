/**
 * 窗口预览条目投影（工单379，spec #369 决策 15 / GLOSSARY「窗口预览」）：
 * 可见窗优先实时缩略图、最小化窗用最近缓存、无缓存最小化窗回退图标+标题；
 * 条目序 = 主屏合格窗口成员序（确定性），标题只作上屏载荷。
 */
import { describe, expect, it } from 'vitest'
import { decidePreviewMode, projectPreviewItems } from '../../src/main/desktop/preview-projection'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'

function fact(hwnd: number, over: Partial<TileWindowFacts> = {}): TileWindowFacts {
  return {
    hwnd,
    exe: 'C:\\Program Files\\App\\app.exe',
    title: `窗 ${hwnd}`,
    visible: true,
    cloaked: false,
    cloakedShell: false,
    toolWindow: false,
    owned: false,
    appWindow: true,
    iconic: false,
    resizable: true,
    rect: { left: 0, top: 0, right: 100, bottom: 100 },
    onCurrentDesktop: true,
    ...over,
  }
}

describe('预览条目模式裁决', () => {
  it('可见窗 → 实时缩略图', () => {
    expect(decidePreviewMode({ iconic: false, hasCache: false })).toBe('live')
    // 缓存在场也不改变可见窗的实时优先级（缓存只在最小化时兜底）
    expect(decidePreviewMode({ iconic: false, hasCache: true })).toBe('live')
  })

  it('最小化窗有缓存 → 最近缓存；无缓存 → 图标+标题回退', () => {
    expect(decidePreviewMode({ iconic: true, hasCache: true })).toBe('cached')
    expect(decidePreviewMode({ iconic: true, hasCache: false })).toBe('icon')
  })
})

describe('预览条目投影', () => {
  it('按成员序产出条目，携带标题与 hwnd；模式逐窗裁决（缓存只影响最小化窗）', () => {
    const members = [fact(11), fact(12, { iconic: true }), fact(13, { iconic: true })]
    const items = projectPreviewItems(members, (hwnd) => hwnd === 12)
    expect(items.map((x) => x.hwnd)).toEqual([11, 12, 13])
    expect(items.map((x) => x.mode)).toEqual(['live', 'cached', 'icon'])
    expect(items[0].title).toBe('窗 11')
    expect(items[1].title).toBe('窗 12')
  })

  it('空成员 → 空条目（预览始终可打开，只是没有条目）', () => {
    expect(projectPreviewItems([], () => false)).toEqual([])
  })
})
