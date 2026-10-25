import { describe, expect, it } from 'vitest'
import { collectDesktopItems, desktopFingerprint, iconKeyOf, pathOfIconKey } from '../../src/main/desktop/scan'
import type { DesktopDirEntry } from '../../src/main/desktop/scan'

function entry(name: string, over: Partial<DesktopDirEntry> = {}): DesktopDirEntry {
  return { name, isDirectory: false, isHidden: false, mtimeMs: 1000, ...over }
}

/** 扫描合并去重核心（工单05 验收：纯逻辑 vitest 覆盖） */
const ROOTS = { user: 'C:\\u', common: 'C:\\c' }

describe('collectDesktopItems', () => {
  it('合并两个桌面并按 (zone, name) 排序，应用区在前', () => {
    const items = collectDesktopItems(
      ROOTS,
      [entry('b.txt'), entry('A.lnk')],
      [entry('c.txt'), entry('B.url')],
    )
    expect(items.map((i) => i.name)).toEqual(['A.lnk', 'B.url', 'b.txt', 'c.txt'])
    expect(items.map((i) => i.zone)).toEqual(['app', 'app', 'doc', 'doc'])
  })

  it('同名条目用户桌面优先（遮蔽公共桌面默认项）', () => {
    const items = collectDesktopItems(
      ROOTS,
      [entry('Kimi Code.lnk', { mtimeMs: 7 })],
      [entry('Kimi Code.lnk', { mtimeMs: 9 })],
    )
    expect(items).toHaveLength(1)
    expect(items[0].path).toBe('C:\\u\\Kimi Code.lnk')
    expect(items[0].iconKey).toBe(iconKeyOf('C:\\u\\Kimi Code.lnk', 7))
  })

  it('hidden/system 属性条目滤除（desktop.ini 不入池）', () => {
    const items = collectDesktopItems(
      ROOTS,
      [entry('desktop.ini', { isHidden: true }), entry('keep.txt')],
      [entry('secret.lnk', { isHidden: true })],
    )
    expect(items.map((i) => i.name)).toEqual(['keep.txt'])
  })

  it('种类判定：lnk/url/folder/file，归类 app/doc', () => {
    const items = collectDesktopItems(
      ROOTS,
      [
        entry('x.lnk'), entry('y.URL'), entry('d', { isDirectory: true }), entry('z.tar.gz'),
      ],
      [],
    )
    expect(items.map((i) => i.kind)).toEqual(['shortcut', 'url', 'folder', 'file'])
    expect(items.map((i) => i.zone)).toEqual(['app', 'app', 'doc', 'doc'])
  })

  it('显示名：.lnk/.url 剥扩展，其余保留原名（含其他扩展名）', () => {
    const items = collectDesktopItems(
      ROOTS,
      [entry('Chrome.lnk'), entry('site.Url'), entry('readme.txt'), entry('d', { isDirectory: true })],
      [],
    )
    const byName = new Map(items.map((i) => [i.name, i.display]))
    expect(byName.get('Chrome.lnk')).toBe('Chrome')
    expect(byName.get('site.Url')).toBe('site')
    expect(byName.get('readme.txt')).toBe('readme.txt')
    expect(byName.get('d')).toBe('d')
  })

  it('iconKey 可逆解析路径（路径不含 |，Windows 禁字符）', () => {
    const key = iconKeyOf('C:\\Users\\An W\\Desktop\\a b.lnk', 1234.5)
    expect(pathOfIconKey(key)).toBe('C:\\Users\\An W\\Desktop\\a b.lnk')
  })
})

describe('desktopFingerprint', () => {
  const base = collectDesktopItems(ROOTS, [entry('a.lnk'), entry('b.txt')], [])

  it('集合不变则指纹不变', () => {
    const again = collectDesktopItems(ROOTS, [entry('b.txt'), entry('a.lnk')], [])
    expect(desktopFingerprint(base)).toBe(desktopFingerprint(again))
  })

  it('新增/删除/改名/mtime 变化（经 iconKey）均翻转指纹', () => {
    expect(desktopFingerprint([...base, entry2()])).not.toBe(desktopFingerprint(base))
    expect(desktopFingerprint(base.slice(0, 1))).not.toBe(desktopFingerprint(base))
    const renamed = base.map((i) => (i.name === 'b.txt' ? { ...i, name: 'c.txt' } : i))
    expect(desktopFingerprint(renamed)).not.toBe(desktopFingerprint(base))
    const touched = collectDesktopItems(ROOTS, [entry('a.lnk'), entry('b.txt', { mtimeMs: 2000 })], [])
    expect(desktopFingerprint(touched)).not.toBe(desktopFingerprint(base))
  })

  function entry2() {
    const i = collectDesktopItems(ROOTS, [entry('new.url')], [])[0]
    return i
  }
})
