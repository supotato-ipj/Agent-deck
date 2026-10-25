/**
 * 使用频次打分测试（工单06，tests/test_usage_score.py 移植）：衰减数学、启动计数、
 * UserAssist 值解析（ROT13 + 布局偏移）、路径→条目映射、先验与日志融合（冷启动先验）。
 */
import { describe, expect, it } from 'vitest'
import {
  countStarts,
  decay,
  fuseScores,
  mapScoresToItems,
  parseUserAssistEntry,
  priorScores,
  rot13,
  scoreStarts,
  type PriorEntry,
  type ScoreItem,
} from '../../src/main/usage/score'
import { parseUserAssistRegExport } from '../../src/main/usage/userassist'
import type { UsageEvent } from '../../src/main/usage/log'

const DAY = 86400_000
const NOW = Date.UTC(2026, 8, 23, 12, 0)

const ev = (daysAgo: number, exe: string): UsageEvent => ({ tsMs: NOW - daysAgo * DAY, exe })

describe('decay（半衰期 14 天）', () => {
  it('14 天恰半衰', () => expect(decay(14)).toBeCloseTo(0.5))
  it('零龄满权重', () => expect(decay(0)).toBeCloseTo(1))
  it('两个半衰期', () => expect(decay(28)).toBeCloseTo(0.25))
})

describe('scoreStarts / countStarts', () => {
  it('单次启动按龄衰减', () => {
    expect(scoreStarts([ev(14, 'a.exe')], NOW).get('a.exe')).toBeCloseTo(0.5)
  })
  it('多次启动的衰减独立求和', () => {
    const s = scoreStarts([ev(0, 'a.exe'), ev(14, 'a.exe'), ev(0, 'b.exe')], NOW)
    expect(s.get('a.exe')).toBeCloseTo(1.5)
    expect(s.get('b.exe')).toBeCloseTo(1)
  })
  it('当前时间是参数不是内部读取', () => {
    expect(scoreStarts([ev(14, 'a.exe')], NOW + 14 * DAY).get('a.exe')).toBeCloseTo(0.25)
  })
  it('计数按键小写折叠', () => {
    const c = countStarts([ev(0, 'A.exe'), ev(0, 'a.exe')])
    expect(c.get('a.exe')).toBe(2)
  })
})

describe('parseUserAssistEntry（ROT13 + 值布局）', () => {
  function blob(count: number, filetime: number): Uint8Array {
    const data = new Uint8Array(72)
    new DataView(data.buffer).setUint32(0, 145, true) // 会话/版本常量字段，非次数
    new DataView(data.buffer).setUint32(4, count, true)
    new DataView(data.buffer).setBigUint64(60, BigInt(filetime), true)
    return data
  }

  it('ROT13 名还原 + 次数 + 最后执行时间', () => {
    const plain = 'C:\\Program Files\\app\\app.exe'
    const ft = 133000000000000000n
    const parsed = parseUserAssistEntry(rot13(plain), blob(145, Number(ft)))
    expect(parsed!.path).toBe(plain)
    expect(parsed!.count).toBe(145)
    expect(parsed!.lastMs).toBeGreaterThan(0)
  })

  it('过短值拒绝', () => {
    expect(parseUserAssistEntry('abc', new Uint8Array(10))).toBeNull()
  })

  it('零 FILETIME 拒绝（无最后执行时间无从衰减）', () => {
    expect(parseUserAssistEntry('abc', blob(3, 0))).toBeNull()
  })
})

describe('priorScores（先验折算）', () => {
  it('count × decay(age(last))', () => {
    const prior = new Map([['c:\\p\\kimi.exe', { count: 10, lastMs: NOW - 14 * DAY } as PriorEntry]])
    expect(priorScores(prior, NOW).get('c:\\p\\kimi.exe')).toBeCloseTo(5)
  })
})

describe('mapScoresToItems（路径→桌面条目）', () => {
  const kimi: ScoreItem = { display: 'Kimi', kind: 'shortcut', path: 'C:\\u\\Kimi.lnk', target: 'C:\\P\\Kimi.exe' }
  const noResolve = () => null
  const resolveAll = () => 'C:\\P\\Kimi.exe'
  const noExists = () => false // shell 别名路径（盘上不存在）才允许 stem 回退
  const onDisk = () => true

  it('目标反查大小写不敏感', () => {
    expect(mapScoresToItems(new Map([['c:\\p\\kimi.exe', 3]]), [kimi], noResolve, noExists)).toEqual(
      new Map([['Kimi', 3]]),
    )
  })

  it('映射不上的路径不进结果（日志本身不受影响）', () => {
    expect(mapScoresToItems(new Map([['c:\\p\\kimi.exe', 3], ['noise.exe', 9]]), [kimi], noResolve, noExists)).toEqual(
      new Map([['Kimi', 3]]),
    )
  })

  it('非快捷条目永不排名', () => {
    const items: ScoreItem[] = [
      { display: 'a.docx', kind: 'file', path: 'C:\\u\\a.docx', target: null },
      { display: 'Recycle Bin', kind: 'folder', path: 'C:\\u\\rb', target: null },
    ]
    expect(mapScoresToItems(new Map([['x.exe', 5]]), items, noResolve, noExists)).toEqual(new Map())
  })

  it('任务栏 .lnk 先验按 stem 对齐（解析不出目标的 shell 别名路径）', () => {
    expect(mapScoresToItems(new Map([['c:\\x\\taskbar\\kimi.lnk', 2]]), [kimi], noResolve, noExists)).toEqual(
      new Map([['Kimi', 2]]),
    )
  })

  it('盘上存在却解不出目标的 .lnk 不回退 stem（Python 同义：宁可不认不错挂）', () => {
    expect(mapScoresToItems(new Map([['c:\\x\\kimi.lnk', 2]]), [kimi], noResolve, onDisk)).toEqual(new Map())
  })

  it('.lnk 先验能解析出目标时必须目标一致才认（防任务栏同名指到别的 exe）', () => {
    const resolveOther = () => 'C:\\Other\\Thing.exe'
    expect(mapScoresToItems(new Map([['c:\\x\\kimi.lnk', 2]]), [kimi], resolveOther, noExists)).toEqual(new Map())
    expect(mapScoresToItems(new Map([['c:\\x\\kimi.lnk', 2]]), [kimi], resolveAll, noExists)).toEqual(new Map([['Kimi', 2]]))
  })
})

describe('fuseScores（冷启动先验与日志融合）', () => {
  const kimi: ScoreItem = { display: 'Kimi', kind: 'shortcut', path: 'C:\\u\\Kimi.lnk', target: 'C:\\P\\Kimi.exe' }
  const noResolve = () => null
  const noExists = () => false

  it('日志为空时先验仍产出排名（冷启动先验生效，权重 1）', () => {
    const prior = new Map([['c:\\p\\kimi.exe', { count: 100, lastMs: NOW - 7 * DAY }]])
    const fused = fuseScores(prior, [], NOW, [kimi], noResolve, noExists)
    expect(fused.get('Kimi')).toBeGreaterThan(0)
  })

  it('日志充裕时先验被压制（权重 → 1/(1+n)）', () => {
    const prior = new Map([['c:\\p\\kimi.exe', { count: 1000, lastMs: NOW }]])
    const events = Array.from({ length: 99 }, () => ev(0, 'C:\\P\\Kimi.exe'))
    const fused = fuseScores(prior, events, NOW, [kimi], noResolve, noExists)
    expect(fused.get('Kimi')! - 99).toBeLessThan(1000 / 100 + 1e-9)
  })

  it('任务栏 .lnk 先验在条目层面退位（日志只记 .exe，路径层融合会永不退位）', () => {
    const prior = new Map([['{guid}\\taskbar\\kimi.lnk', { count: 50, lastMs: NOW }]])
    const events = Array.from({ length: 9 }, () => ev(0, 'C:\\P\\Kimi.exe'))
    const fused = fuseScores(prior, events, NOW, [kimi], noResolve, noExists)
    expect(fused.get('Kimi')! - 9).toBeLessThan(50 / 10 + 1e-9)
  })

  it('大小写差异不把同一应用裂成两条', () => {
    const prior = new Map([['C:\\P\\KIMI.EXE', { count: 10, lastMs: NOW }]])
    const events = Array.from({ length: 5 }, () => ev(0, 'c:\\p\\kimi.exe'))
    const fused = fuseScores(prior, events, NOW, [kimi], noResolve, noExists)
    expect(fused.size).toBe(1)
    expect(fused.get('Kimi')! - 5).toBeLessThan(10 / 6 + 1e-9)
  })

  it('映射不上的噪音不出现在结果里', () => {
    expect(fuseScores(new Map(), [ev(0, 'noise.exe')], NOW, [kimi], noResolve, noExists)).toEqual(new Map())
  })
})

describe('parseUserAssistRegExport（reg 导出解析）', () => {
  function regText(values: Array<{ section: string; name: string; hex: number[] }>): string {
    const lines = ['Windows Registry Editor Version 5.00', '']
    let last = ''
    for (const v of values) {
      if (v.section !== last) {
        lines.push(`[${v.section}]`)
        last = v.section
      }
      lines.push(`"${v.name}"=hex:${v.hex.map((b) => b.toString(16).padStart(2, '0')).join(',')}`)
    }
    return lines.join('\r\n') + '\r\n'
  }

  function blob(count: number, filetimeMs: number): number[] {
    const data = new Uint8Array(72)
    new DataView(data.buffer).setUint32(4, count, true)
    const ft = BigInt(Math.round(filetimeMs * 1e4)) + 116444736000000000n
    new DataView(data.buffer).setBigUint64(60, ft, true)
    return [...data]
  }

  it('收 \\Count 结节的 hex 值，同路径取次数大者，只收 .exe/.lnk', () => {
    const countKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{GUID}\\Count'
    const otherKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist\\{GUID}'
    const plain = 'C:\\Program Files\\app\\app.exe'
    const text = regText([
      { section: otherKey, name: 'Uninteresting', hex: blob(1, NOW) },
      { section: countKey, name: rot13(plain), hex: blob(145, NOW - DAY) },
      { section: countKey, name: rot13(plain), hex: blob(7, NOW) }, // 同路径取大者
      { section: countKey, name: rot13('C:\\x\\note.txt'), hex: blob(50, NOW) }, // 非 exe/lnk 不收
    ])
    const prior = parseUserAssistRegExport(text)
    expect(prior.size).toBe(1)
    expect(prior.get(plain.toLowerCase())!.count).toBe(145)
    expect(prior.get(plain.toLowerCase())!.lastMs).toBeGreaterThan(0)
  })

  it('折行续接（行尾反斜杠）的 hex 值能完整解析', () => {
    const countKey = 'HKEY_CURRENT_USER\\...\\Count'
    const plain = 'C:\\Program Files\\app\\app.exe'
    const full = `"${rot13(plain)}"=hex:${blob(42, NOW).map((b) => b.toString(16).padStart(2, '0')).join(',')}`
    const cut = 60
    const wrapped = full.slice(0, cut) + '\\\r\n  ' + full.slice(cut)
    const text = ['Windows Registry Editor Version 5.00', '', `[${countKey}]`, wrapped].join('\r\n')
    const prior = parseUserAssistRegExport(text)
    expect(prior.get(plain.toLowerCase())!.count).toBe(42)
  })

  it('值名含转义引号与反斜杠时正确还原', () => {
    const countKey = 'HKEY_CURRENT_USER\\...\\Count'
    const plain = 'C:\\a "b"\\app.exe'
    const escaped = plain.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const text = regText([{ section: countKey, name: rot13(escaped), hex: blob(3, NOW) }])
    const prior = parseUserAssistRegExport(text)
    expect(prior.size).toBe(1)
    // rot13 后再转义再还原：名还原后是转义形态（reg 的转义发生在 ROT13 之后的值名层）
    expect([...prior.keys()][0].endsWith('app.exe')).toBe(true)
  })
})
