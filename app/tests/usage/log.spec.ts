/**
 * 使用日志测试（工单06，tests/test_usage_log.py 移植）：启动差分、聚焦差分、
 * 按天文件与滚动清理、记录字段隐私断言（只有 ts 与 exe）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendEvent,
  detectFocus,
  detectStarts,
  pruneOldDays,
  readStartEvents,
} from '../../src/main/usage/log'

const DAY = 86400_000
const NOW = Date.UTC(2026, 8, 23, 12, 0) // 2026-09-23T12:00:00Z（Python 测试 NOW 同值）

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deck-usage-'))
}

const dirs: string[] = []

describe('detectStarts（pid 差分）', () => {
  it('新 pid 即一次启动', () => {
    expect(detectStarts(new Map([[1, 'a.exe']]), new Map([[1, 'a.exe'], [2, 'b.exe']]))).toEqual(['b.exe'])
  })
  it('退出后重启（换 pid）计一次', () => {
    expect(detectStarts(new Map([[1, 'a.exe']]), new Map([[2, 'a.exe']]))).toEqual(['a.exe'])
  })
  it('同路径第二实例计一次（按 pid 不按路径）', () => {
    expect(detectStarts(new Map([[1, 'a.exe']]), new Map([[1, 'a.exe'], [2, 'a.exe']]))).toEqual(['a.exe'])
  })
  it('退出不是启动', () => {
    expect(detectStarts(new Map([[1, 'a.exe'], [2, 'b.exe']]), new Map([[1, 'a.exe']]))).toEqual([])
  })
  it('空到空', () => {
    expect(detectStarts(new Map(), new Map())).toEqual([])
  })
})

describe('detectFocus（前台差分）', () => {
  it('切换上报新前台', () => {
    expect(detectFocus('a.exe', 'b.exe')).toBe('b.exe')
  })
  it('同前台不上报', () => {
    expect(detectFocus('a.exe', 'a.exe')).toBeNull()
  })
  it('无前台不上报', () => {
    expect(detectFocus('a.exe', null)).toBeNull()
  })
})

describe('appendEvent / readStartEvents / pruneOldDays', () => {
  afterEach(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  it('记录恰好只有 ts 与 exe 两个字段（隐私断言盯真实产物）', () => {
    const dir = tmpDir(); dirs.push(dir)
    appendEvent(dir, 'start', 'C:\\p\\a.exe', NOW)
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('start-'))
    expect(files).toHaveLength(1)
    const record = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8').trim())
    expect(Object.keys(record).sort()).toEqual(['exe', 'ts'])
    expect(record.exe).toBe('C:\\p\\a.exe')
  })

  it('start 与 focus 各写各的按天文件', () => {
    const dir = tmpDir(); dirs.push(dir)
    appendEvent(dir, 'start', 'a.exe', NOW)
    appendEvent(dir, 'focus', 'a.exe', NOW)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('start-'))).toHaveLength(1)
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('focus-'))).toHaveLength(1)
  })

  it('写入失败被吞（日志不能拖死服务）', () => {
    const blocker = path.join(tmpDir(), 'blockfile'); dirs.push(path.dirname(blocker))
    fs.writeFileSync(blocker, 'x')
    expect(() => appendEvent(path.join(blocker, 'sub'), 'start', 'a.exe', NOW)).not.toThrow()
  })

  it('读回：坏行跳过、未来时间戳忽略', () => {
    const dir = tmpDir(); dirs.push(dir)
    fs.writeFileSync(path.join(dir, 'start-20260923.jsonl'), [
      JSON.stringify({ ts: new Date(NOW - DAY).toISOString(), exe: 'a.exe' }),
      '{ 坏行',
      JSON.stringify({ ts: new Date(NOW + DAY).toISOString(), exe: 'future.exe' }),
      JSON.stringify({ ts: new Date(NOW).toISOString(), exe: 'b.exe' }),
      JSON.stringify({ no: 'fields' }),
      '',
    ].join('\n') + '\n')
    const events = readStartEvents(dir, NOW)
    expect(events.map((e) => e.exe).sort()).toEqual(['a.exe', 'b.exe'])
  })

  it('目录缺失读回空表', () => {
    expect(readStartEvents(path.join(tmpDir(), 'gone'), NOW)).toEqual([])
  })

  it('滚动清理只删过期按天文件（start/focus 一并）', () => {
    const dir = tmpDir(); dirs.push(dir)
    appendEvent(dir, 'start', 'old.exe', NOW - 91 * DAY)
    appendEvent(dir, 'focus', 'old.exe', NOW - 91 * DAY)
    appendEvent(dir, 'start', 'new.exe', NOW - 89 * DAY)
    pruneOldDays(dir, NOW, 90)
    const remain = fs.readdirSync(dir).sort()
    expect(remain.filter((f) => f.includes('old')).length).toBe(0)
    expect(remain).toHaveLength(1)
  })
})

describe('隐私守卫（ADR-0002：不读窗口标题）', () => {
  // ADR-0007 书面口子（工单52）：窗口标题仅任务栏链路内存即时读取（tooltip/多窗口
  // 列表），永不持久化。口子只开在 taskbar/windows.ts 一个文件；其余 src/main 边界不变。
  const TITLE_READ_ALLOWLIST = new Set(['src/main/taskbar/windows.ts'])
  it('src/main 全部源码不出现 GetWindowText / window_title（任务栏窗口枚举模块为 ADR-0007 唯一例外）', () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((de) => {
        const p = path.join(dir, de.name)
        return de.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
      })
    const root = path.resolve(__dirname, '../../src/main')
    for (const file of walk(root)) {
      const rel = path.relative(path.resolve(__dirname, '../..'), file).split(path.sep).join('/')
      const source = fs.readFileSync(file, 'utf8')
      if (TITLE_READ_ALLOWLIST.has(rel)) continue
      expect(source, file).not.toContain('GetWindowText')
      expect(source, file).not.toContain('window_title')
    }
  })

  it('任务栏标题口子永不持久化：窗口枚举模块不写盘，栏编排/栏布局模块不读标题', () => {
    const win = fs.readFileSync(path.resolve(__dirname, '../../src/main/taskbar/windows.ts'), 'utf8')
    expect(win).not.toMatch(/writeFileSync|appendFileSync|appendFile|createWriteStream/)
    for (const rel of ['src/main/taskbar/left-plan.ts', 'src/main/taskbar/layout-store.ts']) {
      const src = fs.readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')
      expect(src, `${rel} 不得读窗口标题`).not.toContain('GetWindowText')
    }
    // 栏布局存储形态无标题字段（落盘面的结构性保证；行为级断言在 contract.spec 工单52 块）
    const store = fs.readFileSync(path.resolve(__dirname, '../../src/main/taskbar/layout-store.ts'), 'utf8')
    expect(store).not.toMatch(/title/)
  })
})

describe('UsageService 采集状态机（假源驱动）', () => {
  it('collect：首轮建基线不记事件；新 pid 与前台切换各落各盘，只有 start 进打分事件', async () => {
    vi.resetModules()
    const { Context } = await import('cordis')
    const { UsageService } = await import('../../src/main/services/usage')
    const dir = tmpDir()
    const pids = new Map([[1, 'C:\\p\\a.exe'], [2, 'C:\\p\\b.exe']])
    const ctx = new Context()
    const svc = new UsageService(ctx, {
      dir,
      deps: {
        runningPidExes: () => new Map(pids),
        foregroundExe: () => 'C:\\p\\a.exe',
        readPrior: async () => new Map(),
      },
    })
    dirs.push(dir)
    await ctx.start()
    try {
      // 首轮建 pid 基线；前台从无到有记一次 focus（Python Collector 同义）
      expect(svc.collect(NOW).map((e) => e.exe)).toEqual(['C:\\p\\a.exe'])
      pids.set(3, 'C:\\p\\c.exe')
      const events = svc.collect(NOW + 2000)
      expect(events.map((e) => e.exe)).toEqual(['C:\\p\\c.exe']) // 新 pid 记 start，前台未变不记
      const startFile = fs.readFileSync(path.join(dir, 'start-20260923.jsonl'), 'utf8')
      const startRecords = startFile.trim().split('\n').map((l) => JSON.parse(l))
      expect(startRecords.every((r) => Object.keys(r).sort().join() === 'exe,ts')).toBe(true)
      const focusFiles = fs.readdirSync(dir).filter((f) => f.startsWith('focus-'))
      expect(focusFiles).toHaveLength(1)
      expect(svc.snapshotForTest().events).toBe(1) // 只有 start 进打分事件
    } finally {
      await ctx.stop()
    }
  })
})
