/** kimi code 扫描器接缝测试的 TS 回归网：临时目录造 sessions 下 工作区/会话 两级形态。 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import { collectSessions } from '../../src/main/scanners'
import { KimiCodeFx } from './fixtures'

let tmp = ''
let now = 0
let fx: KimiCodeFx

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-kc-'))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fresh(): KimiCodeFx {
  now = Date.now() / 1000
  fx = new KimiCodeFx(path.join(tmp, `kc-${Date.now()}-${Math.random()}`), now)
  return fx
}

function collect(fixture: KimiCodeFx) {
  return collectSessions({ kimicode: fixture.root }, fixture.now)
}

describe('kimi code 扫描器', () => {
  it('新会话为 RUN 且带项目名', () => {
    const f = fresh()
    f.addSession('session_a', 20)
    const [s] = collect(f)
    expect(s.tool).toBe('kimicode')
    expect(s.id).toBe('session_a')
    expect(s.state).toBe('RUN')
    expect(s.project).toBe('eps')
    expect(s.age).toBe(20)
  })

  it('wire 比 state 新时以 wire 计龄', () => {
    const f = fresh()
    f.addSession('session_a', 500, { wireAge: 30 })
    const [s] = collect(f)
    expect(s.state).toBe('RUN')
    expect(s.age).toBe(30)
  })

  it('旧会话为 DONE', () => {
    const f = fresh()
    f.addSession('session_a', 300)
    const [s] = collect(f)
    expect(s.state).toBe('DONE')
    expect(s.running).toBe(false)
  })

  it('tasks 字段为 null', () => {
    const f = fresh()
    f.addSession('session_a', 20)
    const [s] = collect(f)
    expect(s.tasks_done).toBeNull()
    expect(s.tasks_total).toBeNull()
  })

  it('坏 state.json 只跳过该会话、不连累整工具', () => {
    const f = fresh()
    f.addSession('session_good', 20)
    const bad = path.join(f.root, 'sessions', 'wd_x', 'session_bad')
    fs.mkdirSync(path.join(bad, 'agents', 'main'), { recursive: true })
    fs.writeFileSync(path.join(bad, 'state.json'), '{ nope', 'utf8')
    fs.writeFileSync(path.join(bad, 'agents', 'main', 'wire.jsonl'), '', 'utf8')
    const sessions = collect(f)
    expect(sessions.map((s) => s.id)).toEqual(['session_good'])
    expect(fs.statSync(path.join(bad, 'state.json')).isFile()).toBe(true)
  })

  it('超活跃窗排除', () => {
    const f = fresh()
    f.addSession('session_a', 601)
    expect(collect(f)).toEqual([])
  })

  it('缺 sessions 目录给空表', () => {
    fresh()
    const empty = path.join(tmp, 'nope')
    fs.mkdirSync(empty, { recursive: true })
    expect(collectSessions({ kimicode: empty }, now)).toEqual([])
  })
})
