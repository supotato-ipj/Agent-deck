/**
 * 摆位存储纯逻辑测试（工单06；工单310 升版 v2）：出厂态、损坏自愈、拖拽摆位动作、
 * 恢复出厂、卡片手定位表；工单27 起含删除同拍的摆位清除（forgetItems）、工单28 起含
 * 重命名同拍的摆位迁移（renameItemInStore）。工单59 起只余文档区一份名单；
 * 工单310 起 v2 增 cards（手定位格点表），旧版文件按空卡片表自愈读入。
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_STORE, forgetItems, loadStore, moveItem, renameItemInStore, resetFactory, serializeStore, setCardSlot } from '../../src/main/desktop/layout-store'

describe('loadStore / serializeStore', () => {
  it('缺失（null）与损坏 JSON 均回出厂态', () => {
    expect(loadStore(null)).toEqual(FACTORY_STORE)
    expect(loadStore('{ 坏掉的')).toEqual(FACTORY_STORE)
    expect(loadStore('42')).toEqual(FACTORY_STORE)
  })

  it('旧版 v1 文件按空卡片表读入，文档项顺序原样保留（升版自愈）', () => {
    const s = loadStore(JSON.stringify({ version: 1, pinned: 'x', dock: [1, 2], docs: ['a'] }))
    expect(s).toEqual({ version: 2, docs: ['a'], cards: {} })
  })

  it('结构不符的卡片条目丢弃，其余合法条目保留', () => {
    const s = loadStore(JSON.stringify({
      version: 2,
      docs: ['a'],
      cards: {
        clock: { col: 2, row: 3 },
        bad1: { col: -1, row: 0 },
        bad2: { col: 1.5, row: 2 },
        bad3: 'x',
        bad4: { row: 2 },
      },
    }))
    expect(s).toEqual({ version: 2, docs: ['a'], cards: { clock: { col: 2, row: 3 } } })
  })

  it('roundtrip：序列化再读回无损', () => {
    const s = { version: 2 as const, docs: ['n.txt', 'm.pdf'], cards: { clock: { col: 1, row: 2 } } }
    expect(loadStore(serializeStore(s))).toEqual(s)
  })
})

describe('moveItem（文档区拖拽摆位动作）', () => {
  const base = { version: 2 as const, docs: ['n.txt', 'm.pdf'], cards: { clock: { col: 1, row: 1 } } }

  it('区内摆位：插到参照之前，卡片表原样保留', () => {
    const next = moveItem(base, 'ghost.docx', 'doc', 'm.pdf')
    expect(next.docs).toEqual(['n.txt', 'ghost.docx', 'm.pdf'])
    expect(next.cards).toEqual(base.cards)
  })

  it('beforeName=null 追加到末尾', () => {
    expect(moveItem(base, 'ghost.docx', 'doc', null).docs).toEqual(['n.txt', 'm.pdf', 'ghost.docx'])
  })

  it('参照不在目标名单按追加处理（服务层先校验，这里是防御性下限）', () => {
    expect(moveItem(base, 'ghost.docx', 'doc', '不存在.docx').docs).toEqual(['n.txt', 'm.pdf', 'ghost.docx'])
  })

  it('拖出文档区（zone=app）：出名单且不另找落点——桌面不再承载应用区', () => {
    expect(moveItem(base, 'm.pdf', 'app', 'n.txt').docs).toEqual(['n.txt'])
  })

  it('摆位名单允许陈旧名字（文件回来时位置还在）', () => {
    expect(moveItem(base, 'ghost.docx', 'doc', 'm.pdf').docs).toEqual(['n.txt', 'ghost.docx', 'm.pdf'])
  })
})

describe('renameItemInStore（工单28 重命名同拍的摆位迁移）', () => {
  const base = { version: 2 as const, docs: ['n.txt', 'm.pdf'], cards: { clock: { col: 1, row: 1 } } }

  it('名单里的条目原位换成新名，其余名字与序不动、卡片表不动', () => {
    const next = renameItemInStore(base, 'm.pdf', 'report.pdf')
    expect(next.docs).toEqual(['n.txt', 'report.pdf'])
    expect(next.cards).toEqual(base.cards)
  })

  it('不在名单的名字 = 原样返回（无摆位条目改名不产生摆位）', () => {
    expect(renameItemInStore(base, 'ghost.lnk', 'new.lnk')).toEqual(base)
  })
})

describe('forgetItems（工单27 删除同拍的摆位清除）', () => {
  const base = { version: 2 as const, docs: ['gone.docx', 'n.txt'], cards: { clock: { col: 1, row: 1 } } }

  it('名字从名单移除，其余序与卡片表保持', () => {
    expect(forgetItems(base, ['gone.docx'])).toEqual({ version: 2, docs: ['n.txt'], cards: { clock: { col: 1, row: 1 } } })
  })

  it('不在名单的名字 = 原样返回（幂等空转）', () => {
    expect(forgetItems(base, ['ghost.lnk'])).toBe(base)
  })

  it('空名单 = 原样返回', () => {
    expect(forgetItems(base, [])).toBe(base)
  })
})

describe('setCardSlot（工单310 卡片手定位写入）', () => {
  const base = { version: 2 as const, docs: ['n.txt'], cards: { clock: { col: 1, row: 1 } } }

  it('只增改该卡条目，其余卡片与文档名单原样', () => {
    const next = setCardSlot(base, 'search-card', 12, 3)
    expect(next.cards).toEqual({ clock: { col: 1, row: 1 }, 'search-card': { col: 12, row: 3 } })
    expect(next.docs).toEqual(['n.txt'])
    expect(base.cards).toEqual({ clock: { col: 1, row: 1 } }) // 不可变
  })

  it('负数/小数格点按存储层下限归整（调用方本应先夹取）', () => {
    expect(setCardSlot(base, 'x', -3, 2.9).cards.x).toEqual({ col: 0, row: 2 })
  })
})

describe('resetFactory（恢复出厂布局）', () => {
  it('清空显式摆位与卡片手定位（两者同进同退）', () => {
    expect(resetFactory({ version: 2, docs: ['n.txt'], cards: { clock: { col: 1, row: 1 } } })).toEqual({ version: 2, docs: [], cards: {} })
  })

  it('出厂态重置仍是出厂态（幂等）', () => {
    expect(resetFactory(FACTORY_STORE)).toEqual(FACTORY_STORE)
  })
})
