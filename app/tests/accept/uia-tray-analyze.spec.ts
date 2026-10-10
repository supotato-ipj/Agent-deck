// 工单119 取证分析器直测：probe JSONL 解析、三签名分型（A 全空串 / B 焦点冻住 /
// C 真托盘可导航）、双树口径、臂级聚合与判读表归行。判读规则在
// docs/audit/2026-10-11-t119-uia-tray-empty-name.md §预登记——这里测的是
// 「规则按登记执行」，不是「规则对不对」（stall-duel-analyze 同款章法）。
import { describe, expect, it } from 'vitest'
import type { DumpLine, RoundRecord } from '../../accept/experiments/uia-tray-analyze'
import {
  parseProbeOutput,
  classifySteps,
  summarizeDump,
  classifyRound,
  roundHasEmptyNameObservation,
  aggregateRounds,
  verdictRows,
} from '../../accept/experiments/uia-tray-analyze'

const step = (i: number, name: string, fgClass = 'Shell_TrayWnd') =>
  JSON.stringify({ kind: 'step', i, focus: { name, aid: '', class: 'Button', type: 'ControlType.Button', hwnd: 0, pid: 4, exe: 'explorer' }, fg: { hwnd: 196646, class: fgClass, pid: 4, exe: 'explorer' } })

describe('parseProbeOutput：JSONL 容忍解析', () => {
  it('分流 host/dump/step/summary，坏行计数不中断', () => {
    const text = [
      JSON.stringify({ kind: 'host', host: { hwnd: 1, class: 'Shell_TrayWnd', pid: 4, exe: 'explorer' } }),
      'not json',
      step(0, 'Show Hidden Icons'),
      JSON.stringify({ kind: 'summary', steps: 20, firstMatch: -1, emptySteps: 0, distinctNames: 9, allEmpty: false, frozenName: null }),
      '',
    ].join('\r\n')
    const p = parseProbeOutput(text)
    expect(p.hosts).toHaveLength(1)
    expect(p.steps).toHaveLength(1)
    expect(p.summary?.steps).toBe(20)
    expect(p.badLines).toBe(1)
  })

  it('fatal 行单独暴露（探针崩溃自证）', () => {
    const p = parseProbeOutput(JSON.stringify({ kind: 'fatal', message: 'boom' }))
    expect(p.fatal?.message).toBe('boom')
  })
})

describe('classifySteps：三签名分型', () => {
  it('A：每步全空名', () => {
    const r = classifySteps([{ focus: { name: '' } }, { focus: { name: '' } }])
    expect(r.signature).toBe('A-all-empty')
  })

  it('B：单一非空名冻住（Search box 形态）', () => {
    const r = classifySteps([{ focus: { name: 'Search box' } }, { focus: { name: 'Search box' } }])
    expect(r.signature).toBe('B-frozen')
    expect(r.frozenName).toBe('Search box')
  })

  it('C：步名多样（含夹空步的真托盘序列）', () => {
    const r = classifySteps([{ focus: { name: 'Clock' } }, { focus: { name: '' } }, { focus: { name: 'Volume' } }])
    expect(r.signature).toBe('C-navigating')
    expect(r.distinctNames).toBe(3)
  })

  it('无步 → no-steps（探针未产出）', () => {
    expect(classifySteps([]).signature).toBe('no-steps')
  })
})

describe('summarizeDump：双树口径', () => {
  const dump = (items: Array<{ name: string; type?: string }>, host = { hwnd: 1, class: 'Shell_TrayWnd', pid: 4, exe: 'explorer' }): DumpLine =>
    ({ kind: 'dump', when: 'post', host, itemCount: items.length, truncated: false, error: null, items: items.map((it) => ({ type: 'ControlType.Button', ...it })) })

  it('我方图标登记识别 + 末位空名按钮', () => {
    const s = summarizeDump(dump([
      { name: 'Show Hidden Icons' }, { name: 'Clock' }, { name: 'AGENT DECK 独立面板' }, { name: '' },
    ]), 'AGENT DECK')
    expect(s.agentDeckPresent).toBe(true)
    expect(s.agentDeckName).toBe('AGENT DECK 独立面板')
    expect(s.emptyNames).toBe(1)
    expect(s.tailEmptyItem).toBe(true)
  })

  it('结构性容器空名不计入按钮级口径（TaskbarFrame/Image 等天然无名）', () => {
    const s = summarizeDump(dump([
      { name: '', type: 'ControlType.Pane' }, { name: '', type: 'ControlType.Image' }, { name: 'Clock' },
    ]), 'AGENT DECK')
    expect(s.emptyNames).toBe(0)
    expect(s.emptyOtherNames).toBe(2)
    expect(s.tailEmptyItem).toBe(false)
  })

  it('竞争窗树：我方图标不在 explorer 树（签名 C 核心问题）', () => {
    const s = summarizeDump(dump([{ name: 'Clock' }]), 'AGENT DECK')
    expect(s.agentDeckPresent).toBe(false)
    expect(s.tailEmptyItem).toBe(false)
  })
})

describe('classifyRound + 空名观测口径', () => {
  it('签名 C 无我方图标轮：步级无空名但树有末位空项 → 记空名观测', () => {
    const parsed = parseProbeOutput([
      step(0, 'Clock'), step(1, 'Volume'),
      JSON.stringify({ kind: 'dump', when: 'post', host: { hwnd: 1, class: 'Shell_TrayWnd', pid: 4, exe: 'explorer' }, itemCount: 2, truncated: false, error: null, items: [{ name: 'Clock', type: 'ControlType.Button' }, { name: '', type: 'ControlType.Button' }] }),
    ].join('\n'))
    const r = classifyRound(parsed)
    expect(r.signature).toBe('C-navigating')
    expect(r.firstMatch).toBe(-1)
    expect(r.trees).toHaveLength(1)
    expect(roundHasEmptyNameObservation(r)).toBe(true)
  })

  it('签名 B 轮：无空名步且树净 → 不记空名观测（另行登记为键盘注入面）', () => {
    const parsed = parseProbeOutput([step(0, 'Search box', 'Shell_TrayWnd')].join('\n'))
    const r = classifyRound(parsed)
    expect(r.signature).toBe('B-frozen')
    expect(roundHasEmptyNameObservation(r)).toBe(false)
  })
})

describe('aggregateRounds：臂级聚合率', () => {
  const round = (over: Partial<RoundRecord>): RoundRecord => ({
    signature: 'C-navigating', distinctNames: 3, frozenName: null, stepCount: 20,
    emptySteps: 0, firstMatch: -1, fgClasses: ['Shell_TrayWnd'], fgOnTrayHost: true,
    agentDeckInWalk: false, hostCount: 1, hosts: [], trees: [], probeSummary: null, badLines: 0, fatal: null,
    ...over,
  })

  it('步级/轮级/命中率按口径计算', () => {
    const a = aggregateRounds([
      round({ emptySteps: 4, firstMatch: 2, agentDeckInWalk: true }),
      round({}),
      round({ emptySteps: 0, firstMatch: 0, agentDeckInWalk: true }),
    ])
    expect(a.rounds).toBe(3)
    expect(a.stepEmptyRate).toBeCloseTo(4 / 60, 4)
    expect(a.roundEmptyStepRate).toBeCloseTo(1 / 3, 4)
    expect(a.matchRate).toBeCloseTo(2 / 3, 4)
    expect(a.signatureCounts['C-navigating']).toBe(3)
  })
})

describe('verdictRows：判读表归行（预登记规则）', () => {
  const stats = (rounds: number, emptyObs: number) => ({
    rounds, emptyObsRoundRate: rounds ? emptyObs / rounds : 0,
    stepEmptyRate: 0, treeTailEmptyRate: 0,
  })
  const byArm = (o: Partial<Record<'baseline' | 'idle' | 'broadcast' | 'relaunch', ReturnType<typeof stats>>>) => ({
    baseline: stats(0, 0), idle: stats(0, 0), broadcast: stats(0, 0), relaunch: stats(0, 0), ...o,
  })

  it('R1：裸托盘基线出现空名 → Windows/UIA 本底', () => {
    expect(verdictRows(byArm({ baseline: stats(30, 3), idle: stats(30, 5) })).row).toBe('R1-windows-floor')
  })

  it('R2：基线净、静置面板复现 → 空名独立于停摆成立', () => {
    expect(verdictRows(byArm({ idle: stats(30, 2) })).row).toBe('R2-independent-of-stall')
  })

  it('R3：仅广播轮复现 → 迁移窗口强相关', () => {
    expect(verdictRows(byArm({ broadcast: stats(20, 6) })).row).toBe('R3-migration-window-linked')
  })

  it('R4：仅重启轮复现（重启专属混杂，需复核）', () => {
    expect(verdictRows(byArm({ relaunch: stats(10, 2) })).row).toBe('R4-relaunch-only')
  })

  it('R5：三臂全零 → 不直接关票，回票议系统变量轮', () => {
    const v = verdictRows(byArm({ baseline: stats(30, 0), idle: stats(30, 0), broadcast: stats(20, 0), relaunch: stats(10, 0) }))
    expect(v.row).toBe('R5-no-repro-fallback')
    expect(v.observations.allZero).toBe(true)
  })

  it('电池路径同征：广播轮与重启轮都复现 → 解释链闭合标志', () => {
    const v = verdictRows(byArm({ broadcast: stats(20, 5), relaunch: stats(10, 3) }))
    expect(v.batteryPathConfirmed).toBe(true)
  })
})
