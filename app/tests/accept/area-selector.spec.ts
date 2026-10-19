// 定向验收轮选择器（工单207，spec #201 A2）——纯函数核心的分支穷举。
// seam＝纯函数入口：变更文件集 → 命中域 → 运行计划（哪几块电池整块跑、主电池内哪些段按
// --accept-scope 跑）。纯函数、不依赖真机、不占验收槽。
import { describe, expect, it } from 'vitest'
import { buildGuardCommands, selectPlan } from '../../accept/lib/area-selector'
import type { AcceptPlan, PlanBattery } from '../../accept/lib/area-selector'
import { loadManifest } from '../../accept/lib/report'

/** 夹具清单形状（与真实清单同 schema 子集） */
interface FxManifest {
  version: number
  surfaces: Record<string, string>
  areas: Record<string, string>
  wideAreas: string[]
  sourceRoots: string[]
  pathAreas: { path: string; area: string; wires?: string }[]
  batteries: {
    id: string
    title: string
    entry: string
    script: string
    budgetSeconds: number
    scope?: boolean
    areas?: string[]
    segments: { seg: string; ticket: number; title: string; surfaces: string[]; areas?: string[]; estSeconds: number }[]
  }[]
}

/** 夹具清单：一块逐段标注的主电池（scope 能力）+ 两块电池级覆盖的副电池 */
function fxManifest(): FxManifest {
  return {
    version: 1,
    surfaces: { 'panel-alive': '面板存活', pixel: '像素', 'event-evidence': '事件存证', 'input-injection': '输入注入', 'system-state': '系统状态' },
    areas: { 'panel.core': '面板内核', desktop: '桌面域', taskbar: '任务栏域', cards: '卡片域', accept: '验收域' },
    wideAreas: ['panel.core'],
    sourceRoots: ['app/src'],
    pathAreas: [
      { path: 'app/src', area: 'panel.core' },
      { path: 'app/src/cards', area: 'cards' },
      { path: 'app/src/desktop', area: 'desktop' },
      { path: 'app/src/taskbar', area: 'taskbar' },
      { path: 'app/accept', area: 'accept' },
      { path: 'app/accept/lib', area: 'accept', wires: '*' },
    ],
    batteries: [
      {
        id: 'fx-main', title: '夹具主电池', entry: 'app/accept/fx-main.js', script: 'accept:fx-main',
        budgetSeconds: 100, scope: true,
        segments: [
          { seg: 'A1', ticket: 1, title: '桌面段', surfaces: ['panel-alive'], areas: ['desktop'], estSeconds: 10 },
          { seg: 'A2', ticket: 2, title: '内核段', surfaces: ['panel-alive'], areas: ['panel.core'], estSeconds: 10 },
          { seg: 'A3', ticket: 3, title: '任务栏段', surfaces: ['panel-alive'], areas: ['taskbar'], estSeconds: 10 },
        ],
      },
      {
        id: 'fx-sub', title: '夹具副电池', entry: 'app/accept/fx-sub.js', script: 'accept:fx-sub',
        budgetSeconds: 60, areas: ['taskbar'],
        segments: [{ seg: 'B1', ticket: 4, title: '副段', surfaces: ['system-state'], estSeconds: 10 }],
      },
      {
        id: 'fx-other', title: '夹具另一电池', entry: 'app/accept/fx-other.js', script: 'accept:fx-other',
        budgetSeconds: 60, areas: ['desktop'],
        segments: [{ seg: 'C1', ticket: 5, title: '另一段', surfaces: ['system-state'], estSeconds: 10 }],
      },
    ],
  }
}

const ids = (plan: AcceptPlan) => plan.batteries.map((b) => b.id)
const pick = (plan: AcceptPlan, id: string): PlanBattery | undefined => plan.batteries.find((b) => b.id === id)

describe('定向验收轮选择器：纯函数核心（工单207）', () => {
  it('空 diff → 空计划（无改动命中面板域，无需验收轮）', () => {
    const p = selectPlan({ changedFiles: [], manifest: fxManifest() })
    expect(p.areas).toEqual([])
    expect(p.batteries).toEqual([])
    expect(p.conservative).toBe(false)
  })

  it('纯 accept 改动：接线它的电池算进受影响计划（电池代码也会坏）', () => {
    const p = selectPlan({ changedFiles: ['app/accept/fx-main.js'], manifest: fxManifest() })
    expect(ids(p)).toEqual(['fx-main'])
    expect(pick(p, 'fx-main')!.mode).toBe('full')
    expect(p.areas).toContain('accept')
    expect(p.conservative).toBe(false)
  })

  it('纯 accept 共享基建改动（app/accept/lib）→ 全部电池接线受牵连，走保守计划', () => {
    const p = selectPlan({ changedFiles: ['app/accept/lib/report.js'], manifest: fxManifest() })
    expect(ids(p).sort()).toEqual(['fx-main', 'fx-other', 'fx-sub'])
    expect(p.batteries.every((b) => b.mode === 'full')).toBe(true)
    expect(p.conservative).toBe(true)
  })

  it('跨域大改（命中三域）→ 保守计划：全部电池整块跑、不给 scope', () => {
    const p = selectPlan({
      changedFiles: ['app/src/desktop/a.ts', 'app/src/taskbar/b.ts', 'app/src/cards/c.ts'],
      manifest: fxManifest(),
    })
    expect(p.areas.sort()).toEqual(['cards', 'desktop', 'taskbar'])
    expect(ids(p).sort()).toEqual(['fx-main', 'fx-other', 'fx-sub'])
    expect(p.batteries.every((b) => b.mode === 'full')).toBe(true)
    expect(p.conservative).toBe(true)
  })

  it('公共底座域（wideAreas）命中 → 保守计划（波及面未知，多跑不少跑）', () => {
    const p = selectPlan({ changedFiles: ['app/src/main.ts'], manifest: fxManifest() })
    expect(p.areas).toContain('panel.core')
    expect(p.conservative).toBe(true)
    expect(ids(p).sort()).toEqual(['fx-main', 'fx-other', 'fx-sub'])
  })

  it('电池级标签命中：副电池整块跑，主电池只跑对应段', () => {
    const p = selectPlan({ changedFiles: ['app/src/taskbar/window.ts'], manifest: fxManifest() })
    expect(ids(p).sort()).toEqual(['fx-main', 'fx-sub'])
    expect(pick(p, 'fx-sub')!.mode).toBe('full')      // 电池级标签覆盖：整块跑
    expect(pick(p, 'fx-main')!.mode).toBe('scoped')   // 逐段标注：只跑命中段
    expect(pick(p, 'fx-main')!.segments).toEqual(['A3'])
  })

  it('scope 段号拼接：多段命中按清单序拼成逗号串', () => {
    const p = selectPlan({
      changedFiles: ['app/src/taskbar/window.ts', 'app/src/desktop/a.ts'],
      manifest: fxManifest(),
    })
    expect(pick(p, 'fx-main')!.segments).toEqual(['A1', 'A3'])
    const cmds = buildGuardCommands(p, { guard: 'node guard.mjs', holder: 'mcode', purpose: 'accept-sprint' })
    const main = cmds.find((c) => c.includes('accept:fx-main'))!
    expect(main).toContain('--accept-scope A1,A3')
  })

  it('命中段恰为全部段 → 不给 scope（范围段声明无意义）', () => {
    const m = fxManifest()
    m.batteries.push({
      id: 'fx-full', title: '全命中电池', entry: 'app/accept/fx-full.js', script: 'accept:fx-full',
      budgetSeconds: 60, scope: true, areas: ['desktop'],
      segments: [{ seg: 'D1', ticket: 9, title: '单段', surfaces: ['panel-alive'], estSeconds: 10 }],
    })
    const p = selectPlan({ changedFiles: ['app/src/desktop/a.ts'], manifest: m })
    expect(pick(p, 'fx-full')!.mode).toBe('full')
    expect(pick(p, 'fx-full')!.segments).toEqual([])
  })

  it('未被映射表覆盖的源码文件 → 保守计划并指名漏映文件', () => {
    const m = fxManifest()
    m.sourceRoots = ['app/src', 'app/other']
    const p = selectPlan({ changedFiles: ['app/other/x.ts'], manifest: m })
    expect(p.unmapped).toEqual(['app/other/x.ts'])
    expect(p.conservative).toBe(true)
  })

  it('非面板域改动（文档等）→ 忽略，不进计划', () => {
    const p = selectPlan({ changedFiles: ['docs/agents/battery-governance.md', 'GLOSSARY.md'], manifest: fxManifest() })
    expect(p.ignored.sort()).toEqual(['GLOSSARY.md', 'docs/agents/battery-governance.md'])
    expect(p.batteries).toEqual([])
  })

  it('清单缺位 → 判空计划不抛（CLI 侧再报错）', () => {
    expect(() => selectPlan({ changedFiles: ['app/src/a.ts'], manifest: null })).not.toThrow()
    expect(selectPlan({ changedFiles: ['app/src/a.ts'], manifest: null }).batteries).toEqual([])
  })
})

describe('guard hold 命令行拼装（工单207：只打印、不占验收槽）', () => {
  it('每块受影响电池一条 hold 命令行，带持锁身份与用途', () => {
    const p = selectPlan({ changedFiles: ['app/src/taskbar/window.ts'], manifest: fxManifest() })
    const cmds = buildGuardCommands(p, { guard: 'node D:/g/guard.mjs', holder: 'mcode', purpose: 'accept-sprint' })
    expect(cmds).toHaveLength(2)
    for (const c of cmds) {
      expect(c).toContain('node D:/g/guard.mjs hold --as mcode --purpose accept-sprint -- npm run ')
    }
  })

  it('空计划 → 零条命令行（没有要跑的东西就不占槽）', () => {
    const p = selectPlan({ changedFiles: [], manifest: fxManifest() })
    expect(buildGuardCommands(p, { guard: 'node guard.mjs', holder: 'mcode', purpose: 'selftest' })).toEqual([])
  })
})

describe('真仓库清单：选择器对真实登记处可用（工单207）', () => {
  it('改任务栏目录 → 命中 taskbar 域，任务栏族电池进计划（主电池 33 段无 taskbar 归属域，不进）', () => {
    const manifest = loadManifest()
    expect(manifest).not.toBeNull()
    const p = selectPlan({ changedFiles: ['app/src/main/taskbar/window.ts'], manifest })
    expect(p.areas).toContain('taskbar')
    const got = ids(p)
    expect(got).toContain('49-taskbar')
    expect(got).toContain('55-taskbar-right-group')
    expect(got).toContain('50-taskbar-carry')
    expect(got).not.toContain('03-battery')
    expect(p.conservative).toBe(false)
  })

  it('改桌面域 → 主电池按段声明 scope，文档组卡电池整块跑', () => {
    const manifest = loadManifest()
    const p = selectPlan({ changedFiles: ['app/src/main/desktop/scan.ts'], manifest })
    expect(p.areas).toEqual(['desktop'])
    const got = ids(p)
    expect(got).toContain('03-battery')
    expect(got).toContain('166-doc-group-cards')
    const main = pick(p, '03-battery')!
    expect(main.mode).toBe('scoped')
    expect(main.segments).toContain('P5')
    expect(main.segments).toContain('P5.6')
    expect(main.segments).not.toContain('P7S')
    // 段号按清单登记序给出（不是字典序：清单里 P5.5 在 P5.10 之前）
    expect(main.segments.indexOf('P5.5')).toBeLessThan(main.segments.indexOf('P5.10'))
  })

  it('改电池自身代码 → 接线它的电池进计划（03 主电池）', () => {
    const manifest = loadManifest()
    const p = selectPlan({ changedFiles: ['app/accept/battery.js'], manifest })
    expect(ids(p)).toContain('03-battery')
    expect(pick(p, '03-battery')!.mode).toBe('full')
  })

  it('改共享验收基建 → 全部八块电池进计划', () => {
    const manifest = loadManifest()
    const p = selectPlan({ changedFiles: ['app/accept/lib/report.js'], manifest })
    expect(p.batteries).toHaveLength(8)
    expect(p.conservative).toBe(true)
  })
})
