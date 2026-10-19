/** agent_sessions 接缝测试的 TS 回归网：给定 fixture 数据根与固定 now，断言会话列表外部行为。 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import { ACTIVE_WINDOW, RUNNING_WINDOW, SCANNERS, collectSessions } from '../../src/main/scanners'
import type { SessionRoots } from '../../src/main/scanners'
import { QoderFx, rec } from './fixtures'

let tmp = ''
let now = 0
let fixture: QoderFx

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-scan-'))
})
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})
beforeEach(() => {
  now = Date.now() / 1000
  fixture = new QoderFx(path.join(tmp, `q-${Date.now()}-${Math.random()}`))
  fixture.now = now
})

function collect(roots?: SessionRoots) {
  return collectSessions(roots ?? { qoder: fixture.root }, now)
}

// ---- 基本映射 ----

describe('collect_sessions 接缝（qoder 基础）', () => {
  it('新会话为 RUN 且字段齐全', () => {
    fixture.addSession('s1', 5, [rec('assistant', 'text', 'D:/work/alpha')])
    const [s] = collect()
    expect(s.tool).toBe('qoder')
    expect(s.id).toBe('s1')
    expect(s.state).toBe('RUN')
    expect(s.running).toBe(true)
    expect(s.project).toBe('alpha')
    expect(s.age).toBe(5)
  })

  it('无 cwd 时项目名回退目录名', () => {
    fixture.addSession('s1', 5, [rec('assistant')], 'myproj')
    const [s] = collect()
    expect(s.project).toBe('myproj')
  })

  // ---- 四态判定 ----

  it('时间窗外工具调用尾为 CONFIRM', () => {
    fixture.addSession('s1', 120, [rec('assistant', 'tool')])
    const [s] = collect()
    expect(s.state).toBe('CONFIRM')
    expect(s.running).toBe(false)
  })

  it('assistant 文本尾为 DONE', () => {
    fixture.addSession('s1', 120, [rec('assistant', 'text')])
    expect(collect()[0].state).toBe('DONE')
  })

  it('user 尾为 IDLE', () => {
    fixture.addSession('s1', 120, [rec('user')])
    expect(collect()[0].state).toBe('IDLE')
  })

  it('90 秒内 tool_use 尾也是 RUN', () => {
    fixture.addSession('s1', 30, [rec('assistant', 'tool')])
    expect(collect()[0].state).toBe('RUN')
  })

  // ---- 时间窗边界 ----

  it('RUNNING 窗边界（恰好 90 秒）仍为 RUN', () => {
    const jf = fixture.addSession('s1', 90, [rec('assistant', 'text')])
    const at = fs.statSync(jf).mtimeMs / 1000 + RUNNING_WINDOW
    const [s] = collectSessions({ qoder: fixture.root }, at)
    expect(s.state).toBe('RUN')
  })

  it('ACTIVE 窗边界（恰好 600 秒）仍计入', () => {
    const jf = fixture.addSession('s1', 600, [rec('assistant', 'text')])
    const at = fs.statSync(jf).mtimeMs / 1000 + ACTIVE_WINDOW
    const sessions = collectSessions({ qoder: fixture.root }, at)
    expect(sessions).toHaveLength(1)
  })

  it('超 ACTIVE 窗排除', () => {
    fixture.addSession('s1', 601, [rec('assistant', 'text')])
    expect(collect()).toEqual([])
  })

  // ---- 任务进度 ----

  it('任务进度 completed/in_progress/pending 计数', () => {
    fixture.addSession('s1', 5, [rec('assistant')])
    fixture.addTask('s1', 't1', 'completed')
    fixture.addTask('s1', 't2', 'in_progress')
    fixture.addTask('s1', 't3', 'pending')
    const [s] = collect()
    expect([s.tasks_done, s.tasks_total]).toEqual([1, 3])
  })

  it('无 tasks 目录为 0/0', () => {
    fixture.addSession('s1', 5, [rec('assistant')])
    const [s] = collect()
    expect([s.tasks_done, s.tasks_total]).toEqual([0, 0])
  })

  // ---- 排序与多会话 ----

  it('按 age 升序', () => {
    fixture.addSession('old', 300, [rec('assistant')])
    fixture.addSession('new', 10, [rec('assistant')])
    const ids = collect().map((s) => s.id)
    expect(ids).toEqual(['new', 'old'])
  })

  // ---- roots 注入与容错 ----

  it('根目录不存在给空表', () => {
    expect(collect({ qoder: path.join(tmp, 'nonexistent') })).toEqual([])
  })

  it('未知工具键被忽略', () => {
    fixture.addSession('s1', 5, [rec('assistant')])
    const sessions = collect({ qoder: fixture.root, nosuchtool: tmp })
    expect(sessions.map((s) => s.tool)).toEqual(['qoder'])
  })

  it('单工具扫描失败静默跳过、其余工具存活', () => {
    fixture.addSession('s1', 5, [rec('assistant')])
    const boom = () => {
      throw new Error('locked')
    }
    const original = { ...SCANNERS }
    SCANNERS['broken'] = boom
    try {
      const sessions = collect({ broken: tmp, qoder: fixture.root })
      expect(sessions.map((s) => s.tool)).toEqual(['qoder'])
    } finally {
      delete SCANNERS['broken']
      Object.assign(SCANNERS, original)
    }
  })

  it('垃圾 jsonl 不崩（无状态字段、目录名兜底）', () => {
    const d = path.join(fixture.root, 'projects', 'p')
    fs.mkdirSync(d, { recursive: true })
    const jf = path.join(d, 'bad.jsonl')
    fs.writeFileSync(jf, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(' not json at all')]))
    const t = now - 5
    fs.utimesSync(jf, t, t)
    const [s] = collect()
    expect(s.id).toBe('bad')
    expect(s.project).toBe('p')
  })
})
