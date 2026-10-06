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
  moveInOrder,
  parseDockPinnedNames,
  pinEntry,
  reorderPinned,
  serializeTaskbarStore,
  unpinEntry,
} from '../../src/main/taskbar/layout-store'
import type { MigrationItem, TaskbarLayoutStore } from '../../src/main/taskbar/layout-store'
import type { TaskbarPinnedEntry } from '../../src/main/taskbar/left-plan'

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

  it('推荐位显式序段（工单57）：缺位/形状不符 → 空名单（旧版存储读入不炸）；非字符串项滤除、序保持', () => {
    expect(loadTaskbarStore(null).recommended).toEqual([])
    expect(loadTaskbarStore(JSON.stringify({ version: 1, pinned: [] })).recommended).toEqual([]) // 工单52 旧版存储
    expect(loadTaskbarStore(JSON.stringify({ version: 1, pinned: [], recommended: 'oops' })).recommended).toEqual([])
    const store = loadTaskbarStore(JSON.stringify({ version: 1, pinned: [], recommended: ['B.lnk', 7, 'A.lnk'] }))
    expect(store.recommended).toEqual(['B.lnk', 'A.lnk'])
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
    const store = loadTaskbarStore(serializeTaskbarStore({ version: 1, pinned, recommended: [] }))
    expect(store.pinned).toEqual(pinned)
  })
})

describe('拖拽落位裁决（工单57 纯函数）', () => {
  const pin = (exe: string): TaskbarPinnedEntry => ({ exe, label: exe.replace(/^.*[\\/]/, ''), iconKey: null })
  const storeOf = (exes: string[], recommended: string[] = []): TaskbarLayoutStore =>
    ({ version: 1, pinned: exes.map(pin), recommended })

  it('moveInOrder：name 移到 before 之前；before=null/不在名单 → 末尾；name 不在名单按插入处理（回池落位）', () => {
    expect(moveInOrder(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
    expect(moveInOrder(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a'])
    expect(moveInOrder(['a', 'b'], 'a', 'ghost')).toEqual(['b', 'a'])
    expect(moveInOrder(['a', 'b'], 'x', 'b')).toEqual(['a', 'x', 'b'])
    expect(moveInOrder(['a', 'b'], 'a', 'a')).toEqual(['a', 'b']) // 自落点 = 原序
  })

  it('reorderPinned：左组手钉段内换位，exe 身份归一命中（NTFS 大小写/斜杠不敏感）', () => {
    const store = storeOf(['C:\\Apps\\A.exe', 'C:\\Apps\\B.exe', 'C:\\Apps\\C.exe'])
    const next = reorderPinned(store, 'c:\\apps/a.exe', 'C:\\Apps\\C.exe')
    expect(next.pinned.map((p) => p.exe)).toEqual(['C:\\Apps\\B.exe', 'C:\\Apps\\A.exe', 'C:\\Apps\\C.exe'])
    expect(next.pinned[1].label).toBe('A.exe') // 换位带走展示元数据
    expect(store.pinned.map((p) => p.exe)).toEqual(['C:\\Apps\\A.exe', 'C:\\Apps\\B.exe', 'C:\\Apps\\C.exe']) // 原存储不被改
  })

  it('reorderPinned：落点 null/不在手钉段 → 排到手钉段末尾；非手钉条目（仅运行）原样返回', () => {
    const store = storeOf(['C:\\A.exe', 'C:\\B.exe'])
    expect(reorderPinned(store, 'C:\\A.exe', null).pinned.map((p) => p.exe)).toEqual(['C:\\B.exe', 'C:\\A.exe'])
    expect(reorderPinned(store, 'C:\\A.exe', 'C:\\ghost.exe').pinned.map((p) => p.exe)).toEqual(['C:\\B.exe', 'C:\\A.exe'])
    expect(reorderPinned(store, 'C:\\running-only.exe', null)).toBe(store) // 服务层据此回报 ok:false
    expect(reorderPinned(store, 'C:\\A.exe', 'c:\\a.exe')).toBe(store) // 自落点 = 幂等空转
  })

  it('pinEntry：中→左升手钉——插在落点之前；落点 null/不在手钉段 → 末尾；recommended 名单不动（陈旧名留位）', () => {
    const store = storeOf(['C:\\A.exe', 'C:\\B.exe'], ['x.lnk'])
    const promoted = { exe: 'C:\\Apps\\New.exe', label: '新', iconKey: 'C:\\new.lnk|3' }
    const next = pinEntry(store, promoted, 'C:\\B.exe')
    expect(next.pinned.map((p) => p.exe)).toEqual(['C:\\A.exe', 'C:\\Apps\\New.exe', 'C:\\B.exe'])
    expect(next.pinned[1]).toEqual(promoted)
    expect(next.recommended).toEqual(['x.lnk']) // 升手钉不擦回池位次（解除手钉时旧位复活）
    expect(pinEntry(store, promoted, null).pinned.map((p) => p.exe)).toEqual(['C:\\A.exe', 'C:\\B.exe', 'C:\\Apps\\New.exe'])
    expect(pinEntry(store, promoted, 'C:\\ghost.exe').pinned.map((p) => p.exe)).toEqual(['C:\\A.exe', 'C:\\B.exe', 'C:\\Apps\\New.exe'])
  })

  it('pinEntry：同 exe（归一）已手钉 → 先去重再插（= 换位，不重复上栏）', () => {
    const store = storeOf(['C:\\A.exe', 'C:\\B.exe', 'C:\\C.exe'])
    const next = pinEntry(store, { exe: 'c:\\a.exe', label: '甲新名', iconKey: null }, 'C:\\C.exe')
    expect(next.pinned.map((p) => p.exe)).toEqual(['C:\\B.exe', 'c:\\a.exe', 'C:\\C.exe'])
  })

  it('unpinEntry：左→中解除手钉——归一命中移除、其余序不动；不在手钉 → 原样返回（幂等空转）', () => {
    const store = storeOf(['C:\\A.exe', 'C:\\B.exe', 'C:\\C.exe'], ['y.lnk'])
    const next = unpinEntry(store, 'c:\\b.exe')
    expect(next.pinned.map((p) => p.exe)).toEqual(['C:\\A.exe', 'C:\\C.exe'])
    expect(next.recommended).toEqual(['y.lnk'])
    expect(unpinEntry(store, 'C:\\ghost.exe')).toBe(store)
  })

  it('落位结果可落盘并读回（有序名单持久化形态直通）', () => {
    const store = pinEntry(storeOf(['C:\\A.exe']), { exe: 'C:\\B.exe', label: '乙', iconKey: null }, null)
    const withOrder: TaskbarLayoutStore = { ...store, recommended: moveInOrder([], 'B.lnk', null) }
    expect(loadTaskbarStore(serializeTaskbarStore(withOrder))).toEqual(withOrder)
  })
})
