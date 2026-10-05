/** 适配层（工单05）：defaultListDir 的属性与 mtime 读数（真 fs + attrib 置属性，win32 实测缝） */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultListDir, dropEffectOf, parseHDropBuffer } from '../../src/main/desktop/adapter'
import { buildDropFilesBuffer, buildDropEffectBuffer } from '../../src/main/desktop/clipboard-files'

let tmp = ''

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-adapt-'))
  fs.writeFileSync(path.join(tmp, 'plain.txt'), 'x')
  fs.writeFileSync(path.join(tmp, 'hidden.ini'), 'x')
  fs.writeFileSync(path.join(tmp, 'app.lnk'), 'x')
  fs.mkdirSync(path.join(tmp, 'folder'))
  // attrib 置 hidden+system：模拟 desktop.ini 类条目（explorer 桌面不显示）
  execFileSync('attrib', ['+h', '+s', path.join(tmp, 'hidden.ini')])
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('defaultListDir', () => {
  it('读出条目：目录/文件可辨，mtime 为数，hidden+system 标记', () => {
    const entries = defaultListDir(tmp)
    const byName = new Map(entries.map((e) => [e.name, e]))
    expect(byName.get('plain.txt')).toMatchObject({ isDirectory: false, isHidden: false })
    expect(byName.get('app.lnk')).toMatchObject({ isDirectory: false, isHidden: false })
    expect(byName.get('folder')).toMatchObject({ isDirectory: true, isHidden: false })
    expect(byName.get('hidden.ini')).toMatchObject({ isHidden: true })
    for (const e of entries) expect(typeof e.mtimeMs).toBe('number')
  })
})

describe('parseHDropBuffer（工单30 真机修复：fWide 在 DROPFILES 偏移 16，BOOL 非零即真）', () => {
  it('宽字符路径表回环：写向 buildDropFilesBuffer 的缓冲按名单序完整读回', () => {
    const names = ['C:\\u\\a.lnk', 'C:\\u\\b.docx', 'C:\\u\\带 中文.txt']
    expect(parseHDropBuffer(buildDropFilesBuffer(names))).toEqual(names)
  })

  it('PS Set-Clipboard -Path 形态（真机字节转储实锤）：fWide=0xFFFFFFFF 仍按宽字符解析', () => {
    // PS 播种实测（2026-10-06 探针）：pFiles=20，fWide@16 = 0xFFFFFFFF（BOOL TRUE 非零形），
    // 路径表 UTF-16LE——按 ===1 判宽会把 PS/资源管理器源解析成逐字符假名单
    const names = ['C:\\Users\\ANW~1\\AppData\\Local\\Temp\\ps-seed2.txt']
    const buf = buildDropFilesBuffer(names)
    buf.writeUInt32LE(0xffffffff, 16)
    expect(parseHDropBuffer(buf)).toEqual(names)
  })

  it('ANSI 路径表（fWide=0，旧源兜底）：单字节 NUL 分隔照读', () => {
    const list = 'C:\\u\\a.txt\0C:\\u\\b.txt\0\0'
    const buf = Buffer.alloc(20 + list.length)
    buf.writeUInt32LE(20, 0) // pFiles
    buf.writeUInt32LE(0, 16) // fWide=0（ANSI）
    buf.write(list, 20, 'utf8')
    expect(parseHDropBuffer(buf)).toEqual(['C:\\u\\a.txt', 'C:\\u\\b.txt'])
  })

  it('坏形态不炸不出假名单：短缓冲/坏偏移/截断缓冲归空', () => {
    expect(parseHDropBuffer(Buffer.alloc(10))).toEqual([])
    const badOffset = Buffer.alloc(30)
    badOffset.writeUInt32LE(0, 0) // pFiles=0 非法
    expect(parseHDropBuffer(badOffset)).toEqual([])
    const beyond = Buffer.alloc(30)
    beyond.writeUInt32LE(31, 0) // pFiles 越界
    expect(parseHDropBuffer(beyond)).toEqual([])
    const truncated = buildDropFilesBuffer(['C:\\u\\a.lnk']).subarray(0, 28) // 掐掉路径表尾部
    expect(parseHDropBuffer(truncated)).toEqual([])
  })

  it('Preferred DropEffect 语义：move=2 判 move，其余（copy=1/缺格式/短缓冲）归 copy', () => {
    expect(dropEffectOf(buildDropEffectBuffer('move'))).toBe('move')
    expect(dropEffectOf(buildDropEffectBuffer('copy'))).toBe('copy')
    expect(dropEffectOf(undefined)).toBe('copy')
    expect(dropEffectOf(Buffer.from([2, 0, 0]))).toBe('copy') // 不足 4 字节：按复制
  })
})
