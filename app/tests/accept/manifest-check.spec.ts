// 清单校验器（工单115，spec #109 seam③）：夹具源码+夹具清单断言双向缺失/字段缺失/
// 超预算各判红、合法清单判绿；另以真仓库清单+六电池真实源码跑「现状全绿」——
// CI（test.yml 的 npm test）由此静态把关测试集的每次增删改。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractCodeSegments, validateManifest, validateScopeSegments } from '../../accept/lib/manifest-check'
import { loadManifest } from '../../accept/lib/report'

/** 夹具清单：单电池两段，全字段合法 */
function legalManifest() {
  return {
    version: 1,
    surfaces: { 'panel-alive': '面板存活', pixel: '像素', 'event-evidence': '事件存证', 'input-injection': '输入注入', 'system-state': '系统状态' },
    batteries: [{
      id: 'fx', title: '夹具电池', entry: 'accept/fx.js', script: 'accept:fx', budgetSeconds: 100,
      segments: [
        { seg: 'F1', ticket: 1, title: '首段', surfaces: ['panel-alive'], estSeconds: 30 },
        { seg: 'F2', ticket: 2, title: '次段', surfaces: ['pixel', 'system-state'], estSeconds: 40 },
      ],
    }],
  }
}
const legalSource = "rep.beginSegment('F1')\nrep.pass('a')\nrep.beginSegment('F2')\nrep.fail('b')\n"

describe('段号字集提取', () => {
  it('提取保序去重：同段重复起笔只记一次', () => {
    expect(extractCodeSegments("rep.beginSegment('A')\nrep.beginSegment( 'B' )\nrep.beginSegment('A')")).toEqual(['A', 'B'])
  })
})

describe('夹具校验：双向缺失/字段缺失/超预算各判红', () => {
  it('合法清单+同步源码 → 判绿零错误', () => {
    const r = validateManifest({ manifest: legalManifest(), sources: { fx: legalSource } })
    expect(r).toEqual({ ok: true, errors: [] })
  })

  it('代码有、清单无（新段未登记）→ 判红', () => {
    const r = validateManifest({ manifest: legalManifest(), sources: { fx: legalSource + "rep.beginSegment('F3')\n" } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('F3') && e.includes('未入清单'))).toBe(true)
  })

  it('清单有、代码无（删段不清账）→ 判红', () => {
    const r = validateManifest({ manifest: legalManifest(), sources: { fx: "rep.beginSegment('F1')\n" } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('F2') && e.includes('删段不清账'))).toBe(true)
  })

  it('源码缺席（登记处指向的电池不可扫描）→ 判红', () => {
    const r = validateManifest({ manifest: legalManifest(), sources: {} })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('源码未提供'))).toBe(true)
  })

  it('字段缺失：缺工单号/失效面/估计时长 → 逐项判红', () => {
    const m = legalManifest()
    m.batteries[0].segments[1] = { seg: 'F2', title: '缺字段' } as never
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    const joined = r.errors.join('\n')
    expect(joined).toContain('缺工单号')
    expect(joined).toContain('缺失效面')
    expect(joined).toContain('缺正数估计时长')
  })

  it('失效面不在五枚举 → 判红', () => {
    const m = legalManifest()
    m.batteries[0].segments[0].surfaces = ['smell']
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.errors.some((e) => e.includes('不在五枚举内'))).toBe(true)
  })

  it('估计总和超预算 → 判红', () => {
    const m = legalManifest()
    m.batteries[0].segments[1].estSeconds = 80 // 30+80=110 > 100
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.errors.some((e) => e.includes('超预算'))).toBe(true)
  })

  it('段号电池内撞号 → 判红', () => {
    const m = legalManifest()
    m.batteries[0].segments[1].seg = 'F1'
    const r = validateManifest({ manifest: m, sources: { fx: "rep.beginSegment('F1')\n" } })
    expect(r.errors.some((e) => e.includes('撞号'))).toBe(true)
  })

  it('预算缺位/清单缺 batteries → 判红不抛', () => {
    const m = legalManifest()
    delete (m.batteries[0] as { budgetSeconds?: number }).budgetSeconds
    expect(validateManifest({ manifest: m, sources: { fx: legalSource } }).ok).toBe(false)
    expect(validateManifest({ manifest: null, sources: {} }).ok).toBe(false)
  })
})

describe('--accept-scope 硬交叉校验', () => {
  it('声明段号全在清单 → ok；任一未知 → unknown 指认', () => {
    const m = legalManifest()
    expect(validateScopeSegments(['F1', 'F2'], m, 'fx')).toEqual({ ok: true, unknown: [] })
    expect(validateScopeSegments(['F1', 'F9'], m, 'fx')).toEqual({ ok: false, unknown: ['F9'] })
  })
  it('电池缺位/清单缺位 → 视同全未知（无从核对）', () => {
    expect(validateScopeSegments(['F1'], legalManifest(), 'nope')).toEqual({ ok: false, unknown: ['F1'] })
    expect(validateScopeSegments(['F1'], null, 'fx').ok).toBe(false)
  })
  it('未声明 scope → 恒 ok（不声明不校验）', () => {
    expect(validateScopeSegments([], legalManifest(), 'nope')).toEqual({ ok: true, unknown: [] })
  })
})

describe('Report 构造期 scope 硬校验（工单110 告警不阻断的升级）', () => {
  const { Report } = require('../../accept/lib/report') as { Report: new (n: string, o: object) => unknown }
  it('清单在位+声明未知段号 → 启动即抛（不烧真机轮）', () => {
    expect(() => new Report('fx', { file: null, scope: ['F9'], manifest: legalManifest() }))
      .toThrow(/未在清单登记/)
  })
  it('声明已知段号 → 正常构造；清单缺位（null）→ 保持告警不阻断旧形态', () => {
    expect(() => new Report('fx', { file: null, scope: ['F1'], manifest: legalManifest() })).not.toThrow()
    expect(() => new Report('fx', { file: null, scope: ['F9'], manifest: null })).not.toThrow()
  })
  it('真主电池清单在位：声明真实段号不抛，声明乱号即抛', () => {
    const manifest = loadManifest() as { batteries: { id: string; segments: { seg: string }[] }[] }
    expect(() => new Report('03-battery', { file: null, scope: ['P1'], manifest })).not.toThrow()
    expect(() => new Report('03-battery', { file: null, scope: ['NOPE-1'], manifest })).toThrow(/NOPE-1/)
  })
})

describe('真仓库现状全绿（CI 执行力所在，工单115）', () => {
  // manifest.batteries[].entry 是仓库根相对路径（app/accept/...），从 app/ 上一级解析
  const APP_ROOT = resolve(__dirname, '../../..')
  it('六电池真实清单 ↔ 六电池真实源码：双向同步、字段完备、预算合规', () => {
    const manifest = loadManifest()
    expect(manifest).not.toBeNull()
    const sources: Record<string, string> = {}
    for (const b of (manifest as { batteries: { id: string; entry: string }[] }).batteries) {
      sources[b.id] = readFileSync(resolve(APP_ROOT, b.entry), 'utf8')
    }
    const r = validateManifest({ manifest, sources })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })
})
