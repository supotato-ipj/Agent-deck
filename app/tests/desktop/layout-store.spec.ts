/**
 * 摆位存储纯逻辑测试（工单06）：出厂态、损坏自愈、拖拽摆位动作、恢复出厂。
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_STORE, loadStore, moveItem, pinItem, resetFactory, serializeStore, unpinItem } from '../../src/main/desktop/layout-store'

describe('loadStore / serializeStore', () => {
  it('缺失（null）与损坏 JSON 均回出厂态', () => {
    expect(loadStore(null)).toEqual(FACTORY_STORE)
    expect(loadStore('{ 坏掉的')).toEqual(FACTORY_STORE)
    expect(loadStore('42')).toEqual(FACTORY_STORE)
  })

  it('结构不符的字段回出厂（不因手改文件崩）', () => {
    const s = loadStore(JSON.stringify({ version: 1, pinned: 'x', dock: [1, 2], docs: ['a'] }))
    expect(s).toEqual({ version: 1, pinned: [], dock: [], docs: ['a'] })
  })

  it('roundtrip：序列化再读回无损', () => {
    const s = { version: 1 as const, pinned: ['Kimi'], dock: ['a.lnk', 'b.lnk'], docs: ['n.txt'] }
    expect(loadStore(serializeStore(s))).toEqual(s)
  })
})

describe('moveItem（拖拽摆位动作）', () => {
  const base = { version: 1 as const, pinned: ['Kimi'], dock: ['Kimi.lnk', 'a.lnk', 'b.lnk'], docs: ['n.txt', 'm.pdf'] }

  it('区内摆位：插到参照之前', () => {
    const s = moveItem(base, 'b.lnk', 'app', 'a.lnk')
    expect(s.dock).toEqual(['Kimi.lnk', 'b.lnk', 'a.lnk'])
    expect(s.docs).toEqual(['n.txt', 'm.pdf'])
  })

  it('beforeName=null 追加到末尾', () => {
    const s = moveItem(base, 'a.lnk', 'app', null)
    expect(s.dock).toEqual(['Kimi.lnk', 'b.lnk', 'a.lnk'])
  })

  it('跨区拖拽即换区：从两个名单消失、只进目标名单', () => {
    const s = moveItem(base, 'n.txt', 'app', 'a.lnk')
    expect(s.dock).toEqual(['Kimi.lnk', 'n.txt', 'a.lnk', 'b.lnk'])
    expect(s.docs).toEqual(['m.pdf'])
  })

  it('参照不在目标名单按追加处理（服务层先校验，这里是防御性下限）', () => {
    const s = moveItem(base, 'a.lnk', 'app', 'm.pdf')
    expect(s.dock).toEqual(['Kimi.lnk', 'b.lnk', 'a.lnk'])
  })

  it('手钉清单不受拖拽影响（钉住身份非摆位）', () => {
    const s = moveItem(base, 'Kimi.lnk', 'app', null)
    expect(s.pinned).toEqual(['Kimi'])
    expect(s.dock).toEqual(['a.lnk', 'b.lnk', 'Kimi.lnk'])
  })

  it('摆位名单允许陈旧名字（文件回来时位置还在）', () => {
    const s = moveItem(base, 'ghost.docx', 'doc', 'm.pdf')
    expect(s.docs).toEqual(['n.txt', 'ghost.docx', 'm.pdf'])
  })
})

describe('pinItem / unpinItem（工单25 手钉管理动作）', () => {
  const base = { version: 1 as const, pinned: ['Kimi'], dock: ['a.lnk', 'b.lnk'], docs: ['n.txt'] }

  it('钉到应用区：进手钉清单前段，显式摆位名单不动', () => {
    const s = pinItem(base, 'pin.lnk')
    expect(s.pinned).toEqual(['pin.lnk', 'Kimi'])
    expect(s.dock).toEqual(['a.lnk', 'b.lnk'])
    expect(s.docs).toEqual(['n.txt'])
  })

  it('已在清单的条目再钉 = 移到最前（不重复）', () => {
    const s = pinItem(base, 'Kimi')
    expect(s.pinned).toEqual(['Kimi'])
    expect(s.dock).toEqual(['a.lnk', 'b.lnk'])
  })

  it('取消手钉：从清单移除，其余序保持；显式摆位名单不动', () => {
    const s = unpinItem({ ...base, pinned: ['Kimi', 'x.lnk', 'y.lnk'] }, 'x.lnk')
    expect(s.pinned).toEqual(['Kimi', 'y.lnk'])
    expect(s.dock).toEqual(['a.lnk', 'b.lnk'])
    expect(s.docs).toEqual(['n.txt'])
  })

  it('取消不在清单的条目 = 原样返回（幂等空转）', () => {
    const s = unpinItem(base, 'ghost.lnk')
    expect(s).toEqual(base)
  })

  it('空清单钉入/取消 roundtrip 回出厂', () => {
    const s = unpinItem(pinItem(FACTORY_STORE, 'a.lnk'), 'a.lnk')
    expect(s).toEqual(FACTORY_STORE)
  })
})

describe('resetFactory（恢复出厂布局）', () => {
  it('清空显式摆位、保留手钉', () => {
    const s = resetFactory({ version: 1, pinned: ['Kimi'], dock: ['a.lnk'], docs: ['n.txt'] })
    expect(s).toEqual({ version: 1, pinned: ['Kimi'], dock: [], docs: [] })
  })
  it('出厂态重置仍是出厂态（幂等）', () => {
    expect(resetFactory(FACTORY_STORE)).toEqual(FACTORY_STORE)
  })
})
