// 栏布局存储电池残留判别（工单255）：签名谓词与三段扫除的纯逻辑单测。
// 根因域：轮中途硬杀留下的旧轮探针条目永不在下一轮的精确过滤集合内 ⇒ P17②
// 「excluded清空=false」自持红链（2026-10-27 三连红实证）。签名 = label（
// DECK-P16-<时戳>-<A..G>）+ exe 路径形态（deck-p16-cmd/probe-X/usage-seed 目录）。
import { describe, expect, it } from 'vitest'
import {
  isResidueEntry,
  isResidueName,
  stripBatteryResidue,
} from '../../accept/lib/probe-residue'

describe('probe-residue 签名判别', () => {
  it('探针条目（label / exe / 种子路径）全判残留', () => {
    // label = displayOf 的 stem（扩展名隐藏），大小写不敏感
    expect(isResidueEntry({ exe: '', label: 'DECK-P16-1793032573108-F' })).toBe(true)
    expect(isResidueEntry({ exe: '', label: 'deck-p16-1793032573108-a' })).toBe(true)
    // 探针目标 exe：首条 cmd 副本 + 占位体（正反斜杠两侧归一）
    expect(isResidueEntry({ exe: 'C:\\Users\\An W\\AppData\\Local\\Temp\\deck-p16-0p9Trg\\deck-p16-cmd.exe', label: 'x' })).toBe(true)
    expect(isResidueEntry({ exe: 'C:/Users/An W/AppData/Local/Temp/deck-p16-0p9Trg/deck-p16-probe-g.exe', label: 'x' })).toBe(true)
    // usage 种子合成路径（byStem 假 exe）
    expect(isResidueEntry({ exe: 'C:\\deck-p16-usage-seed\\1793032573108\\DECK-P16-1793032573108-B.lnk', label: 'x' })).toBe(true)
  })

  it('用户真实条目不误伤（exe 与 label 都不带电池签名）', () => {
    expect(isResidueEntry({ exe: 'C:\\Program Files\\ZCode\\ZCode.exe', label: 'ZCode' })).toBe(false)
    // 形近但不含时戳锚的 label 不判残留（避免吃掉真实桌面项）
    expect(isResidueEntry({ exe: 'C:\\tools\\deck-p16-cmd.exe.bak', label: 'DECK-P16' })).toBe(false)
    expect(isResidueEntry({ exe: 'C:\\tools\\my-deck-p16-probe-a.exe', label: 'x' })).toBe(false)
    expect(isResidueEntry(null)).toBe(false)
    expect(isResidueEntry({})).toBe(false)
  })

  it('recommended 名单判别：带 .lnk 的探针原始名判残留，真实名不误伤', () => {
    expect(isResidueName('DECK-P16-1793032573108-C.lnk')).toBe(true)
    expect(isResidueName('DECK-P16-1793032573108-C.txt')).toBe(false)
    expect(isResidueName('ZCode.lnk')).toBe(false)
    expect(isResidueName('')).toBe(false)
  })
})

describe('probe-residue 三段扫除', () => {
  it('三段各扫各的，其余内容原样保留，removed 逐条记账', () => {
    const store = {
      version: 1,
      pinned: [
        { exe: 'C:\\Program Files\\ZCode\\ZCode.exe', label: 'ZCode', iconKey: null },
        { exe: 'C:\\Temp\\deck-p16-aBcDeF\\deck-p16-probe-B.exe', label: 'DECK-P16-1793032573108-B', iconKey: null },
      ],
      recommended: ['ZCode.lnk', 'DECK-P16-1793032573108-C.lnk'],
      excluded: [
        { exe: 'C:\\Users\\An W\\AppData\\Local\\Temp\\deck-p16-aBcDeF\\deck-p16-probe-F.exe', label: 'DECK-P16-1793032573108-F', iconKey: 'x' },
        { exe: 'C:\\Program Files\\Kimi Code\\Kimi Code.exe', label: 'Kimi Code', iconKey: null },
      ],
    }
    const { store: next, removed } = stripBatteryResidue(store)
    expect(next.pinned).toHaveLength(1)
    expect(next.pinned![0].label).toBe('ZCode')
    expect(next.recommended).toEqual(['ZCode.lnk'])
    expect(next.excluded).toHaveLength(1)
    expect(next.excluded![0].label).toBe('Kimi Code')
    expect(removed).toEqual([
      'pinned:DECK-P16-1793032573108-B',
      'recommended:DECK-P16-1793032573108-C.lnk',
      'excluded:DECK-P16-1793032573108-F',
    ])
    // 入参不改（纯函数）
    expect(store.pinned).toHaveLength(2)
    expect(store.excluded).toHaveLength(2)
  })

  it('干净存储零扫除（removed 空账、内容原样）', () => {
    const store = {
      version: 1,
      pinned: [{ exe: 'C:\\Windows\\explorer.exe', label: 'explorer', iconKey: null }],
      recommended: [],
      excluded: [],
    }
    const { store: next, removed } = stripBatteryResidue(store)
    expect(removed).toEqual([])
    expect(next).toEqual(store)
  })

  it('段缺位的旧版存储按缺位跳过（逐段自愈口径不抛）', () => {
    const { store: next, removed } = stripBatteryResidue({ version: 1, pinned: [] })
    expect(removed).toEqual([])
    expect(next.pinned).toEqual([])
  })
})
