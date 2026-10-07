// 报告状态机清单元数据（工单114，spec #109 seam①）：报告启动加载清单元数据，
// 段注册行与账目带工单号/失效面标注、段实测墙钟时长、范围段标注。
// 纯模块直测（manifest 以夹具注入，零 IO）——清单与代码的静态同步校验归 #115 校验器。
import { describe, expect, it, vi } from 'vitest'
import { Report, loadManifest } from '../../accept/lib/report'

/** 五枚举失效面（与 app/accept/manifest.json 的 surfaces 键一致） */
const MANIFEST = {
  version: 1,
  surfaces: {
    'panel-alive': '面板存活',
    'pixel': '像素',
    'event-evidence': '事件存证',
    'input-injection': '输入注入',
    'system-state': '系统状态',
  },
  batteries: [
    {
      id: 't',
      title: '测试电池',
      entry: 'app/accept/battery.js',
      script: 'accept',
      budgetSeconds: 720,
      lastMeasuredSeconds: null,
      lastMeasuredAt: null,
      segments: [
        { seg: 'P1', ticket: 3, title: '启动面板', surfaces: ['panel-alive'], estSeconds: 15 },
        { seg: 'P2', ticket: 3, title: '透明合成', surfaces: ['pixel'], estSeconds: 15 },
        { seg: 'P4', ticket: 3, title: '热区接收+重钉', surfaces: ['input-injection', 'event-evidence'], estSeconds: 20 },
        { seg: 'P9B', ticket: 9, title: '会话行直达', surfaces: ['input-injection', 'panel-alive'], estSeconds: 25 },
      ],
    },
  ],
}

/** 纯内存报告（不落证据盘）+ 夹具清单注入 */
const ledger = (name = 't', opts: { scope?: string[]; manifest?: unknown } = {}) =>
  new Report(name, { file: null, scope: opts.scope, manifest: (opts.manifest === undefined ? MANIFEST : opts.manifest) as never })

/** 收集控制台输出（beginSegment/verdict 行经 console.log 走控制台） */
const capture = (fn: () => void): string[] => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
  try { fn(); return spy.mock.calls.map((c) => String(c[0])) } finally { spy.mockRestore() }
}

describe('清单元数据：段注册行标注（工单号/失效面）', () => {
  it('beginSegment 命中清单条目 → SEG 行带标题、工单号与失效面标注', () => {
    const lines = capture(() => { ledger().beginSegment('P2') })
    const seg = lines.find((l) => l.includes('SEG')) ?? ''
    expect(seg).toContain('P2')
    expect(seg).toContain('透明合成')
    expect(seg).toContain('工单3')
    expect(seg).toContain('失效面=像素')
  })

  it('多失效面段按清单枚举序全列（+ 连接）', () => {
    const lines = capture(() => { ledger().beginSegment('P4') })
    const seg = lines.find((l) => l.includes('SEG')) ?? ''
    expect(seg).toContain('失效面=输入注入+事件存证')
  })

  it('段号不在清单 → 不炸，退回调用方传入的标题（告警不阻断）', () => {
    const lines = capture(() => { ledger().beginSegment('PX', '清单外段') })
    const seg = lines.find((l) => l.includes('SEG')) ?? ''
    expect(seg).toContain('PX')
    expect(seg).toContain('清单外段')
    expect(seg).not.toContain('工单')
  })

  it('电池无清单条目（副电池未登记/名字不符）→ 与无清单同：传入标题原样', () => {
    const lines = capture(() => { ledger('unknown-battery').beginSegment('P1', '副电池段') })
    const seg = lines.find((l) => l.includes('SEG')) ?? ''
    expect(seg).toContain('P1')
    expect(seg).toContain('副电池段')
  })

  it('显式传入标题优先于清单标题（调用方口径为准）', () => {
    const lines = capture(() => { ledger().beginSegment('P2', '调用方标题') })
    const seg = lines.find((l) => l.includes('SEG')) ?? ''
    expect(seg).toContain('调用方标题')
    expect(seg).toContain('工单3')
  })

  it('manifest=null（未加载到清单）→ 行为与工单110 完全一致（不标注、不炸）', () => {
    const lines = capture(() => { ledger('t', { manifest: null }).beginSegment('P1', '原始标题') })
    const seg = lines.find((l) => l.includes('SEG')) ?? ''
    expect(seg).toContain('P1 原始标题')
    expect(seg).not.toContain('工单')
  })
})

describe('段实测墙钟时长（User Story 22）', () => {
  it('段登记与 verdict 闭合时段条目带 startedAt/durationMs，且按段序闭合', () => {
    const rep = ledger()
    rep.beginSegment('P1')
    rep.pass('a')
    rep.beginSegment('P2')
    rep.pass('b')
    rep.pass('c')
    const v = rep.verdict()
    expect(rep.segments).toHaveLength(2)
    expect(rep.segments[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(rep.segments[1].durationMs).toBeGreaterThanOrEqual(0)
    expect(v.verdict).toBe('PASS')
  })

  it('verdict 账目段逐行带 took= 时长与工单/失效面标注（真实落盘通道）', async () => {
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'deck-report-manifest-'))
    try {
      const rep = new Report('t', { file: join(dir, 't.log.txt'), manifest: MANIFEST as never })
      rep.beginSegment('P4')
      rep.pass('x')
      rep.verdict()
      const text = readFileSync(join(dir, 't.log.txt'), 'utf8')
      const segLine = text.split('\n').find((l) => l.trim().startsWith('P4')) ?? ''
      expect(segLine).toContain('took=')
      expect(segLine).toContain('工单3')
      expect(segLine).toContain('失效面=输入注入+事件存证')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('范围段标注（这轮在验谁的什么面）', () => {
  it('声明 scope 且清单可解析 → verdict 控制台逐段标注工单与失效面', () => {
    const rep = ledger('t', { scope: ['P2', 'P9B'] })
    rep.beginSegment('P2')
    rep.pass('x')
    const lines = capture(() => { rep.verdict() })
    const scopeNote = lines.filter((l) => l.includes('范围段'))
    expect(scopeNote.join('\n')).toContain('P2')
    expect(scopeNote.join('\n')).toContain('工单3')
    expect(scopeNote.join('\n')).toContain('P9B')
    expect(scopeNote.join('\n')).toContain('工单9')
  })

  it('清单缺位时声明 scope → 不产出范围段标注，原有告警路径不变', () => {
    const rep = ledger('t', { scope: ['P2'], manifest: null })
    const lines = capture(() => { rep.verdict() })
    expect(lines.join('\n')).not.toContain('清单范围段')
    expect(lines.join('\n')).toContain('本轮未实跑任何段')
  })
})

describe('仓库清单自一致性（app/accept/manifest.json，schema 定稿的机器可查面）', () => {
  // 静态源码扫描 ↔ 清单双向比对归 #115 校验器；这里只查清单自身的 schema 完备性与预算约束。
  const SURFACES = ['panel-alive', 'pixel', 'event-evidence', 'input-injection', 'system-state']
  const manifest = loadManifest() as {
    version: number
    surfaces: Record<string, string>
    batteries: Array<{
      id: string; title: string; entry: string; script: string
      budgetSeconds: number; lastMeasuredSeconds: number | null; lastMeasuredAt: string | null
      segments: Array<{ seg: string; ticket: number; title: string; surfaces: string[]; estSeconds: number }>
    }>
  } | null

  it('清单可加载且六电池全部登记', () => {
    expect(manifest).not.toBeNull()
    expect(manifest!.batteries.map((b) => b.id).sort()).toEqual(
      ['03-battery', '48-tray-spike', '49-taskbar', '50-taskbar-carry', '51-taskbar-appbar', '55-taskbar-right-group'].sort(),
    )
  })

  it('五枚举失效面键齐备，段条目字段完备且 surfaces 全在枚举内', () => {
    expect(Object.keys(manifest!.surfaces).sort()).toEqual([...SURFACES].sort())
    for (const b of manifest!.batteries) {
      expect(b.segments.length).toBeGreaterThan(0)
      for (const s of b.segments) {
        expect(String(s.seg)).not.toBe('')
        expect(Number(s.ticket)).toBeGreaterThan(0)
        expect(String(s.title)).not.toBe('')
        expect(s.surfaces.length).toBeGreaterThan(0)
        for (const surf of s.surfaces) expect(SURFACES).toContain(surf)
        expect(s.estSeconds).toBeGreaterThan(0)
      }
    }
  })

  it('段号电池内唯一（P9 撞号已辨析为 P9/P9B 一类）', () => {
    for (const b of manifest!.batteries) {
      const segs = b.segments.map((s) => s.seg)
      expect(new Set(segs).size).toBe(segs.length)
    }
  })

  it('分电池时长预算：估计总和 ≤ 预算；主电池预算 = 12 分钟封顶', () => {
    for (const b of manifest!.batteries) {
      const sum = b.segments.reduce((acc, s) => acc + s.estSeconds, 0)
      expect(sum).toBeLessThanOrEqual(b.budgetSeconds)
      if (b.id === '03-battery') expect(b.budgetSeconds).toBe(720)
    }
  })
})
