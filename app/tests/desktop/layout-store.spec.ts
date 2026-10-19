/**
 * 摆位存储纯逻辑测试（工单06）：出厂态、损坏自愈、拖拽摆位动作、恢复出厂；
 * 工单27 起含删除同拍的摆位清除（forgetItems）、工单28 起含重命名同拍的摆位迁移
 * （renameItemInStore）。工单59 起只余文档区一份名单——手钉与 dock 摆位随应用区退役。
 */
import { describe, expect, it } from 'vitest'
import { FACTORY_STORE, forgetItems, loadStore, moveItem, renameItemInStore, resetFactory, serializeStore } from '../../src/main/desktop/layout-store'

describe('loadStore / serializeStore', () => {
  it('缺失（null）与损坏 JSON 均回出厂态', () => {
    expect(loadStore(null)).toEqual(FACTORY_STORE)
    expect(loadStore('{ 坏掉的')).toEqual(FACTORY_STORE)
    expect(loadStore('42')).toEqual(FACTORY_STORE)
  })

  it('结构不符的字段回出厂（不因手改文件崩）；旧盘上的手钉/dock 名单被忽略而非报错', () => {
    const s = loadStore(JSON.stringify({ version: 1, pinned: 'x', dock: [1, 2], docs: ['a'] }))
    expect(s).toEqual({ version: 1, docs: ['a'] })
  })

  it('roundtrip：序列化再读回无损', () => {
    const s = { version: 1 as const, docs: ['n.txt', 'm.pdf'] }
    expect(loadStore(serializeStore(s))).toEqual(s)
  })
})

describe('moveItem（文档区拖拽摆位动作）', () => {
  const base = { version: 1 as const, docs: ['n.txt', 'm.pdf'] }

  it('区内摆位：插到参照之前', () => {
    expect(moveItem(base, 'ghost.docx', 'doc', 'm.pdf').docs).toEqual(['n.txt', 'ghost.docx', 'm.pdf'])
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
  const base = { version: 1 as const, docs: ['n.txt', 'm.pdf'] }

  it('名单里的条目原位换成新名，其余名字与序不动', () => {
    expect(renameItemInStore(base, 'm.pdf', 'report.pdf').docs).toEqual(['n.txt', 'report.pdf'])
  })

  it('不在名单的名字 = 原样返回（无摆位条目改名不产生摆位）', () => {
    expect(renameItemInStore(base, 'ghost.lnk', 'new.lnk')).toEqual(base)
  })
})

describe('forgetItems（工单27 删除同拍的摆位清除）', () => {
  const base = { version: 1 as const, docs: ['gone.docx', 'n.txt'] }

  it('名字从名单移除，其余序保持', () => {
    expect(forgetItems(base, ['gone.docx'])).toEqual({ version: 1, docs: ['n.txt'] })
  })

  it('不在名单的名字 = 原样返回（幂等空转）', () => {
    expect(forgetItems(base, ['ghost.lnk'])).toEqual(base)
  })

  it('空名单 = 原样返回', () => {
    expect(forgetItems(base, [])).toEqual(base)
  })
})

describe('resetFactory（恢复出厂布局）', () => {
  it('清空显式摆位', () => {
    expect(resetFactory({ version: 1, docs: ['n.txt'] })).toEqual({ version: 1, docs: [] })
  })

  it('出厂态重置仍是出厂态（幂等）', () => {
    expect(resetFactory(FACTORY_STORE)).toEqual(FACTORY_STORE)
  })
})