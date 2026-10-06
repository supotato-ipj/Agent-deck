/**
 * 任务栏布局存储与 dock 迁移纯逻辑测试（工单52）：
 * 存储自愈（desktop/layout-store 同款纪律）；迁移 = 旧 dock 手钉名单（显示名序）
 * 经桌面项池解析为 exe 身份的栏手钉清单，顺序保持。
 */
import { describe, expect, it } from 'vitest'
import {
  TASKBAR_FACTORY_STORE,
  loadTaskbarStore,
  migrateDockPinned,
  parseDockPinnedNames,
  serializeTaskbarStore,
} from '../../src/main/taskbar/layout-store'
import type { MigrationItem } from '../../src/main/taskbar/layout-store'

const item = (name: string, over: Partial<MigrationItem> = {}): MigrationItem => ({
  name,
  path: `C:\\Users\\u\\Desktop\\${name}`,
  kind: 'shortcut',
  display: name.replace(/\.(lnk|url)$/i, ''),
  iconKey: `C:\\Users\\u\\Desktop\\${name}|7`,
  ...over,
})

describe('任务栏布局存储（自愈）', () => {
  it('缺失/损坏/结构不符 → 出厂态', () => {
    expect(loadTaskbarStore(null)).toEqual(TASKBAR_FACTORY_STORE)
    expect(loadTaskbarStore('{ 坏json')).toEqual(TASKBAR_FACTORY_STORE)
    expect(loadTaskbarStore('"str"')).toEqual(TASKBAR_FACTORY_STORE)
    expect(loadTaskbarStore('{"version":1,"pinned":"oops"}')).toEqual(TASKBAR_FACTORY_STORE)
  })

  it('形状不符的手钉条目滤除、序保持；序列化 round-trip', () => {
    const store = loadTaskbarStore(JSON.stringify({
      version: 1,
      pinned: [
        { exe: 'C:\\a.exe', label: '甲', iconKey: 'C:\\a.exe|1' },
        { exe: '', label: '空身份' },
        'junk',
        { exe: 'C:\\b.exe', label: '乙', iconKey: null },
      ],
    }))
    expect(store.pinned.map((p) => p.exe)).toEqual(['C:\\a.exe', 'C:\\b.exe'])
    expect(loadTaskbarStore(serializeTaskbarStore(store))).toEqual(store)
  })
})

describe('dock 迁移（旧 dock 手钉 → 栏手钉，顺序保持）', () => {
  it('dock layout.json 的 pinned 名单解析：顺序保持；缺失/损坏/非字符串数组 → 空', () => {
    const text = JSON.stringify({ version: 1, pinned: ['B.lnk', 'A.lnk'], dock: [], docs: [] })
    expect(parseDockPinnedNames(text)).toEqual(['B.lnk', 'A.lnk'])
    expect(parseDockPinnedNames(null)).toEqual([])
    expect(parseDockPinnedNames('{ 坏')).toEqual([])
    expect(parseDockPinnedNames('{"version":1,"pinned":[1,2]}')).toEqual([])
  })

  it('快捷方式解析目标为 exe 身份；label/iconKey 捕获桌面项元数据；顺序保持', () => {
    const targets = new Map([['C:\\Users\\u\\Desktop\\B.lnk', 'D:\\Apps\\Beta.exe']])
    const out = migrateDockPinned(
      ['B.lnk', 'A.lnk'],
      [item('A.lnk'), item('B.lnk', { display: '贝塔' })],
      (p) => targets.get(p) ?? null,
    )
    expect(out).toEqual([
      { exe: 'D:\\Apps\\Beta.exe', label: '贝塔', iconKey: 'C:\\Users\\u\\Desktop\\B.lnk|7' },
      { exe: 'C:\\Users\\u\\Desktop\\A.lnk', label: 'A', iconKey: 'C:\\Users\\u\\Desktop\\A.lnk|7' },
    ])
  })

  it('解析不出目标的快捷方式以 lnk 路径为身份（栏位不丢，运行态合并不上）；非快捷方式以自身路径为身份', () => {
    const out = migrateDockPinned(
      ['dead.lnk', 'tool.exe'],
      [item('dead.lnk'), item('tool.exe', { kind: 'file', display: 'tool.exe' })],
      () => null,
    )
    expect(out.map((p) => p.exe)).toEqual([
      'C:\\Users\\u\\Desktop\\dead.lnk',
      'C:\\Users\\u\\Desktop\\tool.exe',
    ])
  })

  it('池外名字（条目已删）跳过；归一后同身份的条目去重（首个胜）', () => {
    const out = migrateDockPinned(
      ['gone.lnk', 'A.lnk', 'alias.lnk'],
      [item('A.lnk'), item('alias.lnk', { display: '别名' })],
      () => 'C:\\Apps\\A.exe', // 两个 lnk 指向同一目标
    )
    expect(out.map((p) => [p.exe, p.label])).toEqual([['C:\\Apps\\A.exe', 'A']])
  })

  it('迁移产物可落盘并读回（存储形态直通）', () => {
    const pinned = migrateDockPinned(['A.lnk'], [item('A.lnk')], () => 'C:\\Apps\\A.exe')
    const store = loadTaskbarStore(serializeTaskbarStore({ version: 1, pinned }))
    expect(store.pinned).toEqual(pinned)
  })
})
