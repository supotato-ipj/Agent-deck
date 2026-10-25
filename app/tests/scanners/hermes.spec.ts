/** hermes 扫描器接缝测试的 TS 回归网：临时 SQLite + 租约 JSON，不碰真实数据。 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import { collectSessions } from '../../src/main/scanners'
import { HermesFx } from './fixtures'

let tmp = ''
let now = 0
const open: HermesFx[] = []

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-hermes-'))
})
afterAll(() => {
  for (const f of open) {
    try { f.close() } catch { /* 尽力 */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* Windows 句柄释放滞后时容忍残留 */ }
})

function fresh(): HermesFx {
  now = Date.now() / 1000
  const f = new HermesFx(path.join(tmp, `h-${Date.now()}-${Math.random()}`), now)
  open.push(f)
  return f
}

function collect(fixture: HermesFx) {
  return collectSessions({ hermes: fixture.root }, fixture.now)
}

describe('hermes 扫描器', () => {
  it('未结束的新会话为 RUN', () => {
    const f = fresh()
    f.add('s1', 30)
    const [s] = collect(f)
    expect(s.tool).toBe('hermes')
    expect(s.id).toBe('s1')
    expect(s.state).toBe('RUN')
    expect(s.project).toBe('gamma')
    expect(s.age).toBe(30)
    f.close()
  })

  it('租约让旧的未结束会话保持 RUNNING', () => {
    const f = fresh()
    f.add('s1', 300)
    f.setLeases(['s1'])
    const [s] = collect(f)
    expect(s.state).toBe('RUN')
    f.close()
  })

  it('无租约的旧未结束会话为 IDLE', () => {
    const f = fresh()
    f.add('s1', 300)
    expect(collect(f)[0].state).toBe('IDLE')
    f.close()
  })

  it('已结束会话为 DONE', () => {
    const f = fresh()
    f.add('s1', 300, { ended: true })
    expect(collect(f)[0].state).toBe('DONE')
    f.close()
  })

  it('新近结束的会话不是 RUN', () => {
    const f = fresh()
    f.add('s1', 10, { ended: true })
    expect(collect(f)[0].state).toBe('DONE')
    f.close()
  })

  it('归档会话排除', () => {
    const f = fresh()
    f.add('s1', 30, { archived: 1 })
    expect(collect(f)).toEqual([])
    f.close()
  })

  it('超活跃窗排除', () => {
    const f = fresh()
    f.add('s1', 601)
    expect(collect(f)).toEqual([])
    f.close()
  })

  it('tasks 字段为 null', () => {
    const f = fresh()
    f.add('s1', 30)
    const [s] = collect(f)
    expect(s.tasks_done).toBeNull()
    expect(s.tasks_total).toBeNull()
    f.close()
  })

  it('缺库时整工具跳过', () => {
    fresh()
    const empty = path.join(tmp, 'nope')
    fs.mkdirSync(empty, { recursive: true })
    expect(collectSessions({ hermes: empty }, now)).toEqual([])
  })

  it('租约文件损坏仍可扫描', () => {
    const f = fresh()
    f.add('s1', 300)
    const runtime = path.join(f.root, 'runtime')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'active_sessions.json'), '{ not json', 'utf8')
    const [s] = collect(f)
    expect(s.state).toBe('IDLE')
    f.close()
  })
})
