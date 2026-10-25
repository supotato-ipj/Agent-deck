/** kimi work 扫描器接缝测试的 TS 回归网：状态 map + 上下文用量文件，降级展示。 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import os from 'node:os'
import { collectSessions } from '../../src/main/scanners'
import { KimiWorkFx } from './fixtures'

let tmp = ''
let now = 0
let fx: KimiWorkFx

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-kw-'))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fresh(): KimiWorkFx {
  now = Date.now() / 1000
  fx = new KimiWorkFx(path.join(tmp, `kw-${Date.now()}-${Math.random()}`), now)
  return fx
}

function collect(fixture: KimiWorkFx) {
  fixture.write()
  return collectSessions({ kimiwork: fixture.root }, fixture.now)
}

describe('kimi work 扫描器', () => {
  it('新近完成的会话为 RUN 且降级（无项目无任务）', () => {
    const f = fresh()
    f.add('c1', 30)
    const [s] = collect(f)
    expect(s.tool).toBe('kimiwork')
    expect(s.id).toBe('c1')
    expect(s.state).toBe('RUN')
    expect(s.project).toBe('')
    expect(s.tasks_done).toBeNull()
  })

  it('旧的已完成会话为 DONE', () => {
    const f = fresh()
    f.add('c1', 300)
    expect(collect(f)[0].state).toBe('DONE')
  })

  it('未知状态为 IDLE', () => {
    const f = fresh()
    f.add('c1', 300, 'weird-future-value')
    expect(collect(f)[0].state).toBe('IDLE')
  })

  it('状态无用量记录排除', () => {
    const f = fresh()
    f.add('c1', 30)
    f.dropUsage('c1')
    expect(collect(f)).toEqual([])
  })

  it('用量无状态记录排除', () => {
    const f = fresh()
    f.add('c1', 30)
    f.dropStatus('c1')
    expect(collect(f)).toEqual([])
  })

  it('超活跃窗排除', () => {
    const f = fresh()
    f.add('c1', 601)
    expect(collect(f)).toEqual([])
  })

  it('缺文件整工具跳过', () => {
    fresh()
    const empty = path.join(tmp, 'nope')
    fs.mkdirSync(empty, { recursive: true })
    expect(collectSessions({ kimiwork: empty }, now)).toEqual([])
  })

  it('用量文件损坏整工具跳过', () => {
    const f = fresh()
    f.add('c1', 30)
    f.write()
    fs.writeFileSync(path.join(f.root, 'conversation-context-usage.json'), '{ bad', 'utf8')
    expect(collectSessions({ kimiwork: f.root }, f.now)).toEqual([])
  })
})
