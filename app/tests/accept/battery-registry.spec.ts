// 电池接入表（工单214，spec #203 决策 1/2/5/6）——接线六项校验的负例单测 ＋ 真仓库现状全绿。
//
// 被测缝：段级清单的**电池级条目**（接线五字段：flag/entry/hintBar/cdpPort/kind）与
// 其余登记处（package.json 的 npm scripts 与旗标、accept 目录在场的电池脚本）之间的
// 完备性与一致性。期望值来源：工单214 验收标准逐字记下的六项校验 ＋ 真仓库现状——
// 不是把实现的表达式原样抄一遍（故不构成同义反复）。
//
// 口径与 tests/accept/manifest-check.spec.ts 同款（静态交叉校验真实登记处，零真机依赖）。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { deriveScriptName, validateManifest, validateRegistry } from '../../accept/lib/manifest-check'
import { loadManifest } from '../../accept/lib/report'

/** 仓库根（app/ 的上一级） */
const REPO_ROOT = resolve(__dirname, '../../..')

/** 夹具清单里的电池条目（接线五字段 ＋ 段级字段） */
interface FxBattery {
  id: string
  title: string
  entry: string
  flag: string
  hintBar: boolean
  cdpPort: number | null
  kind: string | null
  budgetSeconds?: number
  areas?: string[]
  segments?: { seg: string; ticket: number; title: string; surfaces: string[]; areas?: string[]; estSeconds: number }[]
}

interface FxManifest {
  version: number
  surfaces: Record<string, string>
  areas: Record<string, string>
  wideAreas: string[]
  sourceRoots: string[]
  pathAreas: { path: string; area: string }[]
  batteries: FxBattery[]
}

/** 夹具清单：单电池，电池级接线五字段齐备（工单214 终集） */
function fxManifest(): FxManifest {
  return {
    version: 1,
    surfaces: { 'panel-alive': '面板存活', pixel: '像素', 'event-evidence': '事件存证', 'input-injection': '输入注入', 'system-state': '系统状态' },
    areas: { 'panel.core': '面板内核', accept: '验收域' },
    wideAreas: [],
    sourceRoots: [],
    pathAreas: [{ path: 'app/src', area: 'panel.core' }],
    batteries: [{
      id: 'fx', title: '夹具电池', entry: 'app/accept/fx.js', flag: '--accept-fx', hintBar: true, cdpPort: 9241,
      kind: null, budgetSeconds: 100, areas: ['accept'],
      segments: [{ seg: 'F1', ticket: 1, title: '首段', surfaces: ['panel-alive'], areas: ['accept'], estSeconds: 30 }],
    }],
  }
}

/** 夹具登记处：accept 目录在场文件、顶层电池脚本、package.json scripts */
function fxRegistryFacts() {
  return {
    acceptFiles: ['app/accept/fx.js'],
    presentEntries: ['app/accept/fx.js'],
    scripts: { 'accept:fx': 'npm run build && electron . --accept-fx' } as Record<string, string>,
  }
}

describe('电池接入表：接线六项校验（工单214）', () => {
  it('① flag 唯一：两块电池同旗标 → 判红', () => {
    const m = fxManifest()
    m.batteries.push({ ...m.batteries[0], id: 'fx2', entry: 'app/accept/fx2.js' })
    const r = validateRegistry({ manifest: m, ...fxRegistryFacts() })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('--accept-fx') && e.includes('重复'))).toBe(true)
  })

  it('② entry 文件存在：entry 指向不在场的脚本 → 判红', () => {
    const m = fxManifest()
    m.batteries[0].entry = 'app/accept/ghost.js'
    const r = validateRegistry({ manifest: m, ...fxRegistryFacts() })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/accept/ghost.js') && e.includes('不存在'))).toBe(true)
  })

  it('③ script 派生一致：flag 派生的 npm script 不在 package.json → 判红', () => {
    const m = fxManifest()
    const r = validateRegistry({ manifest: m, ...fxRegistryFacts(), scripts: {} })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('accept:fx') && e.includes('package.json'))).toBe(true)
  })

  it('③ script 派生规则：--accept-tray → accept:tray（script 名不存表，由 flag 派生）', () => {
    expect(deriveScriptName('--accept')).toBe('accept')
    expect(deriveScriptName('--accept-tray')).toBe('accept:tray')
    expect(deriveScriptName('--accept-taskbar-right-group')).toBe('accept:taskbar-right-group')
  })

  it('④ cdpPort 唯一：两块电池同端口 → 判红', () => {
    const m = fxManifest()
    m.batteries.push({ ...m.batteries[0], id: 'fx2', entry: 'app/accept/fx2.js', flag: '--accept-fx2' })
    const r = validateRegistry({ manifest: m, ...fxRegistryFacts() })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('9241') && e.includes('重复'))).toBe(true)
  })

  it('⑤ experiment 条目豁免段级校验：无段/无域标签/无预算的取证条目 → 判绿', () => {
    const m = fxManifest()
    m.batteries[0].kind = 'experiment'
    delete (m.batteries[0] as { segments?: unknown }).segments
    delete (m.batteries[0] as { areas?: unknown }).areas
    delete (m.batteries[0] as { budgetSeconds?: unknown }).budgetSeconds
    const r = validateManifest({ manifest: m, sources: { fx: "const rep = new Report('fx', {})\n" } })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('⑤ experiment 豁免不外溢：同款缺项的普通电池 → 仍判红', () => {
    const m = fxManifest()
    delete (m.batteries[0] as { segments?: unknown }).segments
    const r = validateManifest({ manifest: m, sources: { fx: "const rep = new Report('fx', {})\n" } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('段条目为空'))).toBe(true)
  })

  it('⑥ 双向完备（正向）：表内电池缺接线字段 → 判红', () => {
    const m = fxManifest()
    delete (m.batteries[0] as { hintBar?: unknown }).hintBar
    const r = validateRegistry({ manifest: m, ...fxRegistryFacts() })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('hintBar'))).toBe(true)
  })

  it('⑥ 双向完备（反向）：package.json 的旗标无表项 → 判红（接线字段有孤儿）', () => {
    const facts = fxRegistryFacts()
    facts.scripts = { 'accept:fx': 'npm run build && electron . --accept-fx', 'accept:ghost': 'electron . --accept-ghost' }
    const r = validateRegistry({ manifest: fxManifest(), ...facts })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('--accept-ghost') && e.includes('孤儿'))).toBe(true)
  })

  it('⑥ 双向完备（反向）：accept 目录在场电池脚本未入表 → 判红', () => {
    const facts = fxRegistryFacts()
    facts.presentEntries = ['app/accept/fx.js', 'app/accept/rogue.js']
    const r = validateRegistry({ manifest: fxManifest(), ...facts })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('rogue.js') && e.includes('未入'))).toBe(true)
  })

  it('合法夹具 → 判绿零错误', () => {
    const r = validateRegistry({ manifest: fxManifest(), ...fxRegistryFacts() })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })
})

describe('真仓库现状全绿（电池接入表真表，CI 执行力所在）', () => {
  /** accept 目录递归枚举（仓库根相对路径）——entry 存在性校验的输入 */
  function collectAcceptFiles(abs: string, rel: string, out: string[]): string[] {
    for (const name of readdirSync(abs)) {
      const childAbs = resolve(abs, name)
      const childRel = `${rel}/${name}`
      if (statSync(childAbs).isDirectory()) collectAcceptFiles(childAbs, childRel, out)
      else out.push(childRel)
    }
    return out
  }

  it('十项接线登记齐备：九块电池 ＋ stall-duel experiment，字段齐备且六项校验全绿', () => {
    const manifest = loadManifest()
    expect(manifest).not.toBeNull()
    const acceptFiles = collectAcceptFiles(resolve(REPO_ROOT, 'app/accept'), 'app/accept', [])
    const presentEntries = readdirSync(resolve(REPO_ROOT, 'app/accept'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `app/accept/${f}`)
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'app/package.json'), 'utf8')) as { scripts: Record<string, string> }
    const r = validateRegistry({ manifest, acceptFiles, presentEntries, scripts: pkg.scripts })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)

    // 十一条登记：十块电池（kind 缺省＝电池；工单310 增摆位电池、工单332 增对话窗电池）＋ 一条 experiment（取证工具，段级治理豁免）
    const entries = manifest!.batteries as unknown as { id: string; flag: string; entry: string; hintBar: boolean; cdpPort: number | null; kind?: string | null }[]
    expect(entries.length).toBe(11)
    expect(entries.filter((b) => b.kind === 'experiment').map((b) => b.id)).toEqual(['132-stall-duel'])
    for (const b of entries) {
      expect(typeof b.flag).toBe('string')
      expect(b.flag.startsWith('--accept')).toBe(true)
      expect(typeof b.entry).toBe('string')
      expect(typeof b.hintBar).toBe('boolean')
      expect(b.cdpPort === null || Number.isInteger(b.cdpPort)).toBe(true)
    }
    // 控制器旗标全表唯一；端口全表唯一
    expect(new Set(entries.map((b) => b.flag)).size).toBe(entries.length)
    const ports = entries.map((b) => b.cdpPort).filter((p): p is number => p !== null)
    expect(new Set(ports).size).toBe(ports.length)
  })

  it('实验条目不冒充电池：stall-duel 走 experiment 身份，段级治理豁免', () => {
    const manifest = loadManifest()
    const fx = (manifest!.batteries as unknown as { id: string; kind?: string | null; segments?: unknown[] }[]).find((b) => b.id === '132-stall-duel')
    expect(fx).toBeTruthy()
    expect(fx!.kind).toBe('experiment')
    expect(fx!.segments === undefined || fx!.segments.length === 0).toBe(true)
  })
})
