// 常驻事件日志（工单473，ADR-0032）纯函数域与 fs 写入器的离线家族。
// 票面验收标准④钉死：事件族投影与轮转裁决为纯函数域（vitest 既有家族）。
// 断言全部走外部行为：裁决出什么操作、投影出什么字节、盘上剩几个文件——
// 不钉内部定时器/轮询周期（工单纪律：单测不碰内部实现）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RESIDENT_LOG_MAX_FILE_BYTES,
  RESIDENT_LOG_MAX_FILES,
  RESIDENT_LOG_FILE,
  createBootPhaseLogger,
  createResidentEventLog,
  planRotation,
  projectBootPhases,
  projectResidentEvent,
  resolveResidentLogFile,
  rotatedLogName,
} from '../src/main/resident-event-log'

const { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, writeFileSync } = fs
const nodePath = path

describe('常驻事件日志轮转裁决（纯函数）', () => {
  const CAP = 1000
  const FILES = 3

  it('票面口径：单档上限 5MB、连现役共 3 份（磁盘总量有界的两个常数）', () => {
    expect(RESIDENT_LOG_MAX_FILE_BYTES).toBe(5 * 1024 * 1024)
    expect(RESIDENT_LOG_MAX_FILES).toBe(3)
  })

  it('未达上限不轮转', () => {
    expect(planRotation(CAP - 1, [], CAP, FILES)).toBeNull()
    expect(planRotation(0, [1, 2], CAP, FILES)).toBeNull()
  })

  it('现役档达上限且链上无档：只把现役让位为 1 号，无删除', () => {
    expect(planRotation(CAP, [], CAP, FILES)).toEqual({
      removeShifts: [],
      shift: [{ from: 0, to: 1 }],
    })
  })

  it('链上有 1 号：1 号进 2 号、现役进 1 号，仍无删除', () => {
    expect(planRotation(CAP, [1], CAP, FILES)).toEqual({
      removeShifts: [],
      shift: [{ from: 1, to: 2 }, { from: 0, to: 1 }],
    })
  })

  it('链已满（1+2 号）：删最老的 2 号，其余顺移——总量有界的收口动作', () => {
    expect(planRotation(CAP, [1, 2], CAP, FILES)).toEqual({
      removeShifts: [2],
      shift: [{ from: 1, to: 2 }, { from: 0, to: 1 }],
    })
  })

  it('链上有空洞（只剩 2 号）：照删 2 号、现役进 1 号，不为空洞补名', () => {
    expect(planRotation(CAP, [2], CAP, FILES)).toEqual({
      removeShifts: [2],
      shift: [{ from: 0, to: 1 }],
    })
  })

  it('达上限的判据是「达到」不是「超过」：恰等于上限即轮转', () => {
    expect(planRotation(CAP, [], CAP, FILES)).not.toBeNull()
  })

  it('maxFiles < 2 无轮转槽位，属配置错误——拒绝而非静默删数据', () => {
    expect(() => planRotation(CAP, [1], CAP, 1)).toThrow()
  })
})

describe('轮转档命名（纯函数）', () => {
  it('现役名插入序号成轮转档名：events.jsonl → events.1.jsonl', () => {
    expect(rotatedLogName('events.jsonl', 1)).toBe('events.1.jsonl')
    expect(rotatedLogName('events.jsonl', 2)).toBe('events.2.jsonl')
  })

  it('带目录的现役名保持目录不动', () => {
    expect(rotatedLogName(String.raw`C:\u\d\events.jsonl`, 3)).toBe(String.raw`C:\u\d\events.3.jsonl`)
  })

  it('无扩展名或多点扩展名都能插序号', () => {
    expect(rotatedLogName('events', 1)).toBe('events.1')
    expect(rotatedLogName('a.b.events.jsonl', 1)).toBe('a.b.events.1.jsonl')
  })
})

describe('常驻投影：敏感内容与高频帧的入口滤除（纯函数，票面验收标准⑤）', () => {
  it('技术事件原样通过：type/数值/布尔/矩形数组一字不动', () => {
    const e = { type: 'renderer-stall', quietMs: 5213, recovered: true, crashed: false, pid: 4242, rects: [{ x: 1, y: 2, w: 3, h: 4 }] }
    expect(projectResidentEvent(e)).toEqual(e)
  })

  it('高频数据帧族整体滤除：右组 1Hz 状态帧与桌面 1Hz 重建帧不入常驻日志', () => {
    expect(projectResidentEvent({ type: 'taskbar-right-status', clock: '12:00', values: {} })).toBeNull()
    expect(projectResidentEvent({ type: 'desktop-rendered', n: 7, names: ['a.txt'] })).toBeNull()
  })

  it('文件名/窗口标题/查询词字段整值抹除（含嵌套）', () => {
    const out = projectResidentEvent({
      type: 'taskbar-window-pick',
      hwnd: 101,
      title: '机密报告.docx - 记事本',
      inner: { query: '工资单', path: 'C:\\u\\x', names: ['a.txt', 'b.txt'] },
    })
    expect(out).toEqual({
      type: 'taskbar-window-pick',
      hwnd: 101,
      title: '[redacted]',
      inner: { query: '[redacted]', path: '[redacted]', names: '[redacted]' },
    })
  })

  it('兜底网：不认识字段名时，字符串值里的盘符路径/UNC/file URL 照抹', () => {
    const out = projectResidentEvent({
      type: 'autostart-failed',
      message: "EPERM: rename 'C:\\Users\\an\\config.json.tmp' -> '\\\\srv\\share\\x.json' at file:///D:/y/z.js",
    }) as { message: string }
    expect(out.message).not.toMatch(/C:\\Users|srv\\share|file:/)
    expect(out.message).toContain('<path>')
    expect(out.message).toContain('<url>')
  })

  it('普通报错文案不受路径抹除误伤', () => {
    const out = projectResidentEvent({ type: 'quit-busy-bypassed', message: 'turn in flight; auto-terminated' }) as { message: string }
    expect(out.message).toBe('turn in flight; auto-terminated')
  })
})

describe('落点解析（纯函数，票面验收标准①的落点半边）', () => {
  it('零注入 = 生产默认：userData 下 events.jsonl', () => {
    expect(resolveResidentLogFile(undefined, 'C:\\ud')).toBe('C:\\ud\\' + RESIDENT_LOG_FILE)
    expect(resolveResidentLogFile('', 'C:\\ud')).toBe('C:\\ud\\' + RESIDENT_LOG_FILE)
  })

  it('验收/测试隔离钩子：DECK_RESIDENT_EVENT_LOG 指路即改写落点（只改落点，不改默认开启）', () => {
    expect(resolveResidentLogFile('D:\\iso\\events.jsonl', 'C:\\ud')).toBe('D:\\iso\\events.jsonl')
  })

  it('Kill 开关：off 显式关掉（测试清场用）', () => {
    expect(resolveResidentLogFile('off', 'C:\\ud')).toBeNull()
  })
})

describe('启动阶段族投影（纯函数，票面验收标准①的事件族半边）', () => {
  it('从混排事件磁带里投影出 boot-phase 族：保序、只留相位/耗时戳/时刻', () => {
    const tape = [
      { type: 'boot', pid: 1, t: 1000 },
      { type: 'boot-phase', phase: 'config-loaded', elapsedMs: 12, t: 1012 },
      { type: 'pin', reason: 'startup', t: 1020 },
      { type: 'boot-phase', phase: 'kernel-started', elapsedMs: 400, t: 1400 },
      { type: 'boot-phase', phase: 'panel-visible', elapsedMs: 900, t: 1900 },
    ]
    expect(projectBootPhases(tape)).toEqual([
      { phase: 'config-loaded', elapsedMs: 12, t: 1012 },
      { phase: 'kernel-started', elapsedMs: 400, t: 1400 },
      { phase: 'panel-visible', elapsedMs: 900, t: 1900 },
    ])
  })

  it('无启动段的磁带投影为空数组（不抛错）', () => {
    expect(projectBootPhases([{ type: 'boot', t: 1 }])).toEqual([])
    expect(projectBootPhases([])).toEqual([])
  })

  it('畸形行（缺相位名/缺耗时）剔除不抛错——半行/坏行不污染族投影', () => {
    expect(projectBootPhases([
      { type: 'boot-phase', elapsedMs: 5, t: 10 },
      { type: 'boot-phase', phase: 'ok', t: 11 },
      { type: 'boot-phase', phase: 'ok', elapsedMs: 'x', t: 12 },
      { type: 'boot-phase', phase: 'fine', elapsedMs: 7, t: 13 },
    ])).toEqual([{ phase: 'fine', elapsedMs: 7, t: 13 }])
  })
})

describe('启动阶段打点器（注入时钟，票面验收标准①的产出半边）', () => {
  it('每个相位落一条 boot-phase，elapsedMs 以启动锚点起算', () => {
    const seen: Array<Record<string, unknown>> = []
    let now = 5000
    const stamp = createBootPhaseLogger((e) => seen.push(e), 4000, () => now)
    stamp('config-loaded')
    now = 4410
    stamp('kernel-started')
    expect(seen).toEqual([
      { type: 'boot-phase', phase: 'config-loaded', elapsedMs: 1000 },
      { type: 'boot-phase', phase: 'kernel-started', elapsedMs: 410 },
    ])
  })
})

describe('常驻事件日志写入器（node:fs 实盘，临时目录）', () => {
  function tmpDir(): string {
    return mkdtempSync(nodePath.join(os.tmpdir(), 'deck473-'))
  }
  function readJsonl(file: string): Array<Record<string, unknown>> {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  }

  it('零投影滤除时逐行落 {t, ...event} JSONL——事件磁带可直接读的行形', () => {
    const dir = tmpDir()
    try {
      const log = createResidentEventLog({ file: nodePath.join(dir, 'events.jsonl'), now: () => 1234 })
      log.append({ type: 'boot', pid: 42 })
      log.append({ type: 'pin', reason: 'startup' })
      expect(readJsonl(nodePath.join(dir, 'events.jsonl'))).toEqual([
        { t: 1234, type: 'boot', pid: 42 },
        { t: 1234, type: 'pin', reason: 'startup' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('投影在写入器边界生效：高频帧不入盘、敏感字段以抹除值落盘', () => {
    const dir = tmpDir()
    try {
      const file = nodePath.join(dir, 'events.jsonl')
      const log = createResidentEventLog({ file, now: () => 1 })
      log.append({ type: 'taskbar-right-status', clock: '12:00' })
      log.append({ type: 'taskbar-window-pick', hwnd: 9, title: '秘密.txt - 记事本' })
      const rows = readJsonl(file)
      expect(rows.some((r) => r.type === 'taskbar-right-status')).toBe(false)
      const pick = rows.find((r) => r.type === 'taskbar-window-pick') as Record<string, unknown>
      expect(pick.title).toBe('[redacted]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('现役档达上限即轮转：旧内容让位 1 号，现役从新行继续（盘面裁决，不读内部状态）', () => {
    const dir = tmpDir()
    try {
      const file = nodePath.join(dir, 'events.jsonl')
      writeFileSync(file, 'x'.repeat(50) + '\n', 'utf8')
      const log = createResidentEventLog({ file, maxFileBytes: 50, maxFiles: 3, now: () => 7 })
      log.append({ type: 'boot', pid: 1 })
      expect(existsSync(nodePath.join(dir, 'events.1.jsonl'))).toBe(true)
      expect(readFileSync(nodePath.join(dir, 'events.1.jsonl'), 'utf8')).toBe('x'.repeat(50) + '\n')
      expect(readJsonl(file)).toEqual([{ t: 7, type: 'boot', pid: 1 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('链满再轮转：最老档被删，档数不超上限——磁盘总量有界（票面验收标准③）', () => {
    const dir = tmpDir()
    try {
      const file = nodePath.join(dir, 'events.jsonl')
      writeFileSync(nodePath.join(dir, 'events.1.jsonl'), '1'.repeat(50) + '\n', 'utf8')
      writeFileSync(nodePath.join(dir, 'events.2.jsonl'), '2'.repeat(50) + '\n', 'utf8')
      writeFileSync(file, 'x'.repeat(50) + '\n', 'utf8')
      const log = createResidentEventLog({ file, maxFileBytes: 50, maxFiles: 3, now: () => 7 })
      log.append({ type: 'boot', pid: 1 })
      // 旧 2 号删除；旧 1 号内容进 2 号；旧现役内容进 1 号；现役重开
      expect(existsSync(nodePath.join(dir, 'events.2.jsonl'))).toBe(true)
      expect(readFileSync(nodePath.join(dir, 'events.2.jsonl'), 'utf8')).toBe('1'.repeat(50) + '\n')
      expect(readFileSync(nodePath.join(dir, 'events.1.jsonl'), 'utf8')).toBe('x'.repeat(50) + '\n')
      expect(readJsonl(file)).toEqual([{ t: 7, type: 'boot', pid: 1 }])
      expect(readdirSync(dir).filter((n) => n.startsWith('events')).length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录不存在时自动创建（userData 首启形态）', () => {
    const dir = tmpDir()
    try {
      const file = nodePath.join(dir, 'nested', 'events.jsonl')
      const log = createResidentEventLog({ file, now: () => 1 })
      log.append({ type: 'boot', pid: 3 })
      expect(readJsonl(file)).toEqual([{ t: 1, type: 'boot', pid: 3 }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
