/**
 * 工单29 文件剪贴板打包纯函数字节布局测试：DROPFILES 结构（CF_HDROP 载荷）与
 * Preferred DropEffect DWORD。真机差分实证（2026-10-06 探针）：fWide 必须落 16 偏移
 * （pFiles0-3 / pt4-11 / fNC12-15 / fWide16-19），落错偏移 DragQueryFile 按 ANSI 解析
 * UTF-16 数据、Get-Clipboard -Format FileDropList 读回空名单。
 */
import { describe, expect, it } from 'vitest'
import { buildDropEffectBuffer, buildDropFilesBuffer } from '../../src/main/desktop/clipboard-files'

describe('工单29 文件剪贴板打包（DROPFILES / Preferred DropEffect 字节布局）', () => {
  it('DROPFILES 头 20 字节：pFiles=20、pt/fNC 空、fWide=1（偏移 16）', () => {
    const buf = buildDropFilesBuffer(['C:\\u\\a.lnk', 'C:\\u\\b.docx'])
    expect(buf.length).toBe(20 + (10 + 1) * 2 + (11 + 1) * 2 + 2)
    expect(buf.readUInt32LE(0)).toBe(20) // pFiles = sizeof(DROPFILES)，文件表紧随结构
    expect(buf.readInt32LE(16)).toBe(1) // fWide=1（宽字符路径表）
    expect([...buf.subarray(4, 16)]).toEqual([...Buffer.alloc(12)]) // pt 与 fNC 不用（全零）
  })

  it('路径表 UTF-16LE 逐条 NUL 结尾、名单序保持、双 NUL 收尾', () => {
    const buf = buildDropFilesBuffer(['C:\\u\\a.lnk', 'C:\\u\\b.docx'])
    expect(buf.toString('utf16le', 20, 20 + 10 * 2)).toBe('C:\\u\\a.lnk')
    expect(buf.toString('utf16le', 20 + 11 * 2, 20 + 11 * 2 + 11 * 2)).toBe('C:\\u\\b.docx')
    // 最后一条自带 NUL + 名单终止 NUL = 收尾 4 字节 0（真桌面同款）
    expect([...buf.subarray(buf.length - 4)]).toEqual([0, 0, 0, 0])
  })

  it('单文件最小形态成立（DragQueryFile 地面真值同布局）', () => {
    const buf = buildDropFilesBuffer(['D:\\x\\y.txt'])
    expect(buf.length).toBe(20 + (10 + 1) * 2 + 2)
    expect(buf.toString('utf16le', 20, 20 + 10 * 2)).toBe('D:\\x\\y.txt')
  })

  it('Preferred DropEffect：copy=1 / move=2（DWORD LE，4 字节）', () => {
    expect([...buildDropEffectBuffer('copy')]).toEqual([1, 0, 0, 0])
    expect([...buildDropEffectBuffer('move')]).toEqual([2, 0, 0, 0])
  })
})
