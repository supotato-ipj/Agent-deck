/**
 * 会话预览源存储只读性证明（工单381 验收第 6 条）：三个文件扫描器的预览行读取在
 * 合成夹具树上的 sha256+mtime 清单前后逐字节一致；zcode 的只读连接拒绝写入。
 * 夹具全部合成（tests/scanners/fixtures.ts），不触用户真实会话存储。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { kimicodePreviewRows } from '../../src/main/scanners/kimicode'
import { minimaxcodePreviewRows } from '../../src/main/scanners/minimaxcode'
import { qoderPreviewRows } from '../../src/main/scanners/qoder'
import { zcodePreviewRows } from '../../src/main/scanners/zcode'
import { openReadOnly } from '../../src/main/scanners/sqlite'
import { KimiCodeFx, MinimaxFx, QoderFx, ZcodeFx, rec } from '../scanners/fixtures'

let tmp = ''
const open: Array<{ close(): void }> = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-sp-ro-'))
})
afterAll(() => {
  for (const f of open) {
    try { f.close() } catch { /* 尽力 */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄滞后容忍残留 */ }
})

/** 全树逐文件 (相对路径 → size|sha256|mtimeMs) 清单 */
function snapshot(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      const st = fs.statSync(p)
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      out.push(`${path.relative(root, p)}|${st.size}|${h}|${st.mtimeMs}`)
    }
  }
  walk(root)
  return out.sort()
}

describe('会话预览行读取的只读性（源存储零修改）', () => {
  it('qodercn：预览行读取前后夹具全树逐字节一致', () => {
    const root = path.join(tmp, 'q')
    const f = new QoderFx(root)
    f.now = Date.now() / 1000
    f.addSession('q1', 5, [rec('assistant', 'tool', 'D:/work/alpha')])
    f.addTask('q1', 't1', 'completed')
    const before = snapshot(root)
    const rows = qoderPreviewRows(root, f.now * 1000)
    expect(rows).toHaveLength(1)
    expect(snapshot(root)).toEqual(before)
  })

  it('zcode：预览行读取前后夹具全树逐字节一致', () => {
    const root = path.join(tmp, 'z')
    const f = new ZcodeFx(root, Date.now() / 1000)
    open.push(f)
    f.add('sess_1', 20_000, { title: '真标题' })
    const before = snapshot(root)
    const rows = zcodePreviewRows(root, f.now * 1000)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('真标题')
    expect(snapshot(root)).toEqual(before)
  })

  it('kimicode：预览行读取前后夹具全树逐字节一致', () => {
    const root = path.join(tmp, 'k')
    const f = new KimiCodeFx(root, Date.now() / 1000)
    f.addSession('k1', 20, { title: 'kimi 标题' })
    const before = snapshot(root)
    const rows = kimicodePreviewRows(root, f.now * 1000)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('kimi 标题')
    expect(snapshot(root)).toEqual(before)
  })

  it('minimaxcode（工单382）：预览行读取前后夹具全树逐字节一致', () => {
    const root = path.join(tmp, 'mx')
    const f = new MinimaxFx(root, Date.now())
    open.push(f)
    f.add('mvs_aaaaaaaa4f2c4a67b2d9a6c1e8f0d123', { ageMin: 2, project: 'mu', title: 'MiniMax 真标题' })
    const before = snapshot(root)
    const rows = minimaxcodePreviewRows(root, f.nowMs)
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('MiniMax 真标题')
    expect(snapshot(root)).toEqual(before)
  })

  it('zcode 只读连接拒绝写入（INSERT 即抛）', () => {
    const root = path.join(tmp, 'z2')
    const f = new ZcodeFx(root, Date.now() / 1000)
    open.push(f)
    f.add('sess_ro', 10_000)
    const db = openReadOnly(path.join(root, 'cli', 'db', 'db.sqlite'))
    try {
      expect(() => db.prepare('INSERT INTO session (id, directory, title, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?)').run('x', 'd', 't', 1, 2, null)).toThrow()
    } finally {
      db.close()
    }
  })
})
