/** zcode 扫描器接缝测试的 TS 回归网：临时 SQLite（session + todo），不碰真实数据。 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import { collectSessions } from '../../src/main/scanners'
import { ZcodeFx } from './fixtures'

let tmp = ''
let now = 0
const open: ZcodeFx[] = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-zcode-'))
})
afterAll(() => {
  for (const f of open) {
    try { f.close() } catch { /* 尽力 */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄释放滞后时容忍残留 */ }
})

function fresh(): ZcodeFx {
  now = Date.now() / 1000
  const f = new ZcodeFx(path.join(tmp, `z-${Date.now()}-${Math.random()}`), now)
  open.push(f)
  return f
}

function collect(fixture: ZcodeFx) {
  return collectSessions({ zcode: fixture.root }, fixture.now)
}

describe('zcode 扫描器', () => {
  it('新会话为 RUN 且带项目名', () => {
    const f = fresh()
    f.add('sess_1', 30_000)
    const [s] = collect(f)
    expect(s.tool).toBe('zcode')
    expect(s.id).toBe('sess_1')
    expect(s.state).toBe('RUN')
    expect(s.project).toBe('delta')
    expect(s.age).toBe(30)
    f.close()
  })

  it('旧会话为 DONE', () => {
    const f = fresh()
    f.add('sess_1', 300_000)
    expect(collect(f)[0].state).toBe('DONE')
    f.close()
  })

  it('todo 计数', () => {
    const f = fresh()
    f.add('sess_1', 30_000)
    f.addTodo('sess_1', 1, 'completed')
    f.addTodo('sess_1', 2, 'completed')
    f.addTodo('sess_1', 3, 'in_progress')
    f.addTodo('sess_1', 4, 'pending')
    const [s] = collect(f)
    expect([s.tasks_done, s.tasks_total]).toEqual([2, 4])
    f.close()
  })

  it('无 todo 的会话为 0/0', () => {
    const f = fresh()
    f.add('sess_1', 30_000)
    const [s] = collect(f)
    expect([s.tasks_done, s.tasks_total]).toEqual([0, 0])
    f.close()
  })

  it('归档会话排除', () => {
    const f = fresh()
    f.add('sess_1', 30_000, { archived: true })
    expect(collect(f)).toEqual([])
    f.close()
  })

  it('超活跃窗排除', () => {
    const f = fresh()
    f.add('sess_1', 601_000)
    expect(collect(f)).toEqual([])
    f.close()
  })

  it('subagent 会话排除', () => {
    const f = fresh()
    f.add('sess_subagent_agent_1', 30_000)
    f.add('sess_main', 40_000)
    const ids = collect(f).map((s) => s.id)
    expect(ids).toEqual(['sess_main'])
    f.close()
  })

  it('缺库时整工具跳过', () => {
    fresh()
    const empty = path.join(tmp, 'nope')
    fs.mkdirSync(empty, { recursive: true })
    expect(collectSessions({ zcode: empty }, now)).toEqual([])
  })

  it('损坏库整工具跳过', () => {
    const f = fresh()
    fs.writeFileSync(path.join(f.root, 'cli', 'db', 'db.sqlite'), 'not a sqlite file at all')
    expect(collectSessions({ zcode: f.root }, f.now)).toEqual([])
    f.close()
  })

  it('按 age 排序', () => {
    const f = fresh()
    f.add('sess_old', 300_000)
    f.add('sess_new', 10_000)
    const ids = collect(f).map((s) => s.id)
    expect(ids).toEqual(['sess_new', 'sess_old'])
    f.close()
  })
})
