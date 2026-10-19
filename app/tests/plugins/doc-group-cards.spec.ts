/**
 * 扩展组分组纯逻辑（工单179 = spec166 之②，tracer bullet）。
 *
 * 测试面 = 投放型插件包 `app/plugins/doc-group-cards/grouping.js` 的公开函数
 * `groupByExtension`——spec166「Testing Decisions §缝1」指定的那道缝：**纯模块、零 DOM、
 * 零 Electron**，插件源码就是投放单元（直接经 deck-plugin:// 原样 import），故逻辑与呈现
 * 必须分家：分组判定在这里，画卡在 card.js。
 *
 * 断言面（逐条对应工单179 验收标准）：kind 过滤、扩展名现推、无扩展名归属、固定组序表 +
 * 表外字母序兜底、空组不占卡、组卡 id 唯一。
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { readManifest } from '../../src/main/plugins/manifest'
import { EXT_GROUP_ORDER, groupByExtension } from '../../plugins/doc-group-cards/grouping'

/** 仓库内那份可安装单元（投放型插件包源码所在处） */
const PKG_DIR = path.join(__dirname, '..', '..', 'plugins', 'doc-group-cards')

/** 纯逻辑只读条目的两个字段；真实桌面项（DesktopItem）结构上即可满足 */
function file(name: string) {
  return { name, kind: 'file' }
}

describe('组卡②的仓库内可安装单元（投放型插件包 = 目录在不在）', () => {
  it('plugin.json 过内核 manifest 校验：入口字段是 entry，写成 main 会被静默丢弃（缺 entry 不装载）', () => {
    const { manifest, error } = readManifest(PKG_DIR)
    expect(error).toBeUndefined()
    expect(manifest?.id).toBe('doc-group-cards')
    expect(manifest?.name).toBe('DOC GROUPS')
    expect(manifest?.capabilities).toEqual(['desktop'])
    expect(manifest?.order).toBe(70)
  })

  it('入口与纯逻辑模块都在包内（安装即整目录拷贝，删目录即完全撤回）', () => {
    expect(fs.existsSync(path.join(PKG_DIR, 'card.js'))).toBe(true)
    expect(fs.existsSync(path.join(PKG_DIR, 'grouping.js'))).toBe(true)
  })
})

describe('扩展组分组（工单179 组卡②：按单个扩展名聚合）', () => {
  it('只收 kind=file 的桌面项：快捷方式、网址文件、文件夹一律不进组卡', () => {
    const groups = groupByExtension([
      { name: 'README.docx', kind: 'file' },
      { name: '工具.lnk', kind: 'shortcut' },
      { name: '看板.url', kind: 'url' },
      { name: '素材', kind: 'folder' },
    ])
    expect(groups.map((g) => g.key)).toEqual(['.docx'])
    expect(groups[0].items.map((i) => i.name)).toEqual(['README.docx'])
  })

  it('分组键由文件名现推（桌面项不带扩展名字段），且大小写归一', () => {
    const groups = groupByExtension([file('A.DOCX'), file('B.docx'), file('C.DocX')])
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('.docx')
    expect(groups[0].items).toHaveLength(3)
  })

  it('无扩展名的文件归「无扩展名」组（不凭空消失）；点开头的隐藏文件同样无扩展名', () => {
    const groups = groupByExtension([file('README'), file('.gitignore'), file('a.docx')])
    expect(groups.map((g) => g.key)).toEqual(['', '.docx'])
    expect(groups[0].items.map((i) => i.name)).toEqual(['README', '.gitignore'])
  })
})

describe('组序（工单179：组序固定 + 表外字母序兜底 + 空组不占卡）', () => {
  it('固定组序表按族推进：办公系 → pdf → image 系 → 压缩系（与字母序无关）', () => {
    const groups = groupByExtension([file('a.zip'), file('b.png'), file('c.pdf'), file('d.docx')])
    expect(groups.map((g) => g.key)).toEqual(['.docx', '.pdf', '.png', '.zip'])
  })

  it('族内次序按表序（`.docx` 在 `.csv` 之前，字母序会反过来）', () => {
    const groups = groupByExtension([file('a.csv'), file('b.docx')])
    expect(groups.map((g) => g.key)).toEqual(['.docx', '.csv'])
  })

  it('表外扩展名按字母序兜底：`.md` 在 `.txt` 之前，与入参顺序无关', () => {
    const groups = groupByExtension([file('b.txt'), file('a.md')])
    expect(groups.map((g) => g.key)).toEqual(['.md', '.txt'])
  })

  it('无扩展名组排在表外兜底之前（不打断固定族序）', () => {
    const groups = groupByExtension([file('README'), file('a.docx'), file('b.zip')])
    expect(groups.map((g) => g.key)).toEqual(['', '.docx', '.zip'])
  })

  it('空组不占卡：组序表里的其余扩展名没有文件就不生成组', () => {
    const groups = groupByExtension([file('a.docx')])
    expect(groups).toHaveLength(1)
    expect(EXT_GROUP_ORDER.length).toBeGreaterThan(1) // 表本身是全的，缺的是文件
    expect(groups.map((g) => g.key)).not.toContain('.pdf')
  })

  it('组卡 id 唯一（热区扫掠对重复 id 不去重）：一张扩展名一张卡一个 id', () => {
    const groups = groupByExtension([file('a.docx'), file('b.docx'), file('c.pdf'), file('README')])
    const ids = groups.map((g) => g.id)
    expect(ids).toEqual(['dgc-noext', 'dgc-docx', 'dgc-pdf'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('扩展名含非标识符字符时 id 仍唯一（净化后撞车则加序号后缀）', () => {
    const groups = groupByExtension([file('a.do cx'), file('b.do-cx')])
    expect(new Set(groups.map((g) => g.id)).size).toBe(2)
  })
})
