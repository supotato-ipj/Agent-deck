/** 适配层（工单05）：defaultListDir 的属性与 mtime 读数（真 fs + attrib 置属性，win32 实测缝） */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defaultListDir } from '../../src/main/desktop/adapter'

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
