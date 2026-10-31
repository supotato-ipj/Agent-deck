// 清单校验器（工单115，spec #109 seam③）：夹具源码+夹具清单断言双向缺失/字段缺失/
// 超预算各判红、合法清单判绿；另以真仓库清单+六电池真实源码跑「现状全绿」——
// CI（test.yml 的 npm test）由此静态把关测试集的每次增删改。
// 工单204（spec #201 A1）扩：段级 areas 域标签（封闭词表）+ path→area 映射表完备性，
// 与既有「失效面五枚举」治理同执行力。
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extractCodeSegments, validateManifest, validateScopeSegments } from '../../accept/lib/manifest-check'
import { loadManifest } from '../../accept/lib/report'

/** 夹具清单：单电池两段，全字段合法（工单204 起含域标签与 path→area 映射表） */
function legalManifest() {
  return {
    version: 1,
    surfaces: { 'panel-alive': '面板存活', pixel: '像素', 'event-evidence': '事件存证', 'input-injection': '输入注入', 'system-state': '系统状态' },
    areas: { 'panel.core': '面板内核', desktop: '桌面域', accept: '验收域' },
    wideAreas: ['panel.core'],
    sourceRoots: ['app/src'],
    pathAreas: [
      { path: 'app/src', area: 'panel.core' },
      { path: 'app/src/main', area: 'panel.core' },
      { path: 'app/src/desktop', area: 'desktop' },
    ],
    batteries: [{
      id: 'fx', title: '夹具电池', entry: 'accept/fx.js', script: 'accept:fx', budgetSeconds: 100,
      areas: ['accept'],
      segments: [
        { seg: 'F1', ticket: 1, title: '首段', surfaces: ['panel-alive'], areas: ['panel.core'], estSeconds: 30 },
        { seg: 'F2', ticket: 2, title: '次段', surfaces: ['pixel', 'system-state'], areas: ['desktop'], estSeconds: 40 },
      ],
    }],
  }
}
const legalSource = "function go() {\n  const rep = new Report('fx', {})\n  rep.beginSegment('F1')\nrep.pass('a')\nrep.beginSegment('F2')\nrep.fail('b')\n}\n"

/** 递归枚举源码树（工单204：path→area 完备性校验的输入）——目录与文件，仓库根相对路径、/ 分隔 */
function collectSourceTree(root: string, roots: string[]): { dirs: string[]; files: string[] } {
  const dirs: string[] = []
  const files: string[] = []
  const walk = (abs: string, rel: string) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        dirs.push(childRel)
        walk(resolve(abs, entry.name), childRel)
      } else if (entry.isFile()) {
        files.push(childRel)
      }
    }
  }
  for (const r of roots) {
    dirs.push(r)
    walk(resolve(root, r), r)
  }
  return { dirs, files }
}

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

  it('tripwire：非单引号字面量形态的起笔（双引号/模板串）→ 判红（评审 P2）', () => {
    const tricky = legalSource + 'rep.beginSegment("F9")\nrep.beginSegment(`F8`)\n'
    const r = validateManifest({ manifest: legalManifest(), sources: { fx: tricky } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('非单引号字面量形态'))).toBe(true)
  })

  it('注释里的 beginSegment 字样不触发 tripwire', () => {
    const commented = legalSource + '// rep.beginSegment("X") 未来再说\n/* rep.beginSegment(\n */\n'
    expect(validateManifest({ manifest: legalManifest(), sources: { fx: commented } }).ok).toBe(true)
  })

  it('Report 名与清单 id 不对应 → 判红（元数据与 scope 硬校验会静默失效，评审 P2）', () => {
    const m = legalManifest()
    const r = validateManifest({ manifest: m, sources: { fx: legalSource.replace("new Report('fx'", "new Report('other'") } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes("new Report('fx')"))).toBe(true)
  })

  it('在场电池脚本未入清单 → 判红（整块逃逸治理，评审 P2）', () => {
    const r = validateManifest({ manifest: legalManifest(), sources: { fx: legalSource }, presentEntries: ['app/accept/fx.js', 'app/accept/rogue.js'] })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('rogue.js') && e.includes('未入清单'))).toBe(true)
  })
})

describe('段级 areas 域标签（工单204：域标签封闭词表）', () => {
  it('段级域标签越出封闭词表 → 判红（负例）', () => {
    const m = legalManifest()
    m.batteries[0].segments[0].areas = ['smell']
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('smell') && e.includes('不在域标签封闭词表内'))).toBe(true)
  })

  it('电池级域标签越出封闭词表 → 判红（负例）', () => {
    const m = legalManifest()
    m.batteries[0].areas = ['smell']
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('smell') && e.includes('不在域标签封闭词表内'))).toBe(true)
  })

  it('段级与电池级都无域标签 → 判红（每段必须登记归属域）', () => {
    const m = legalManifest()
    delete (m.batteries[0].segments[0] as { areas?: string[] }).areas
    delete (m.batteries[0] as { areas?: string[] }).areas
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('F1') && e.includes('缺域标签 areas'))).toBe(true)
  })

  it('电池级标签覆盖：段无域标签时取电池级（副电池单域覆盖口径）', () => {
    const m = legalManifest()
    delete (m.batteries[0].segments[1] as { areas?: string[] }).areas
    m.batteries[0].areas = ['desktop']
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('清单缺 areas 封闭词表 → 判红（词表缺位＝治理缺位）', () => {
    const m = legalManifest()
    delete (m as { areas?: Record<string, string> }).areas
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('缺 areas 域标签封闭词表'))).toBe(true)
  })
})

describe('path→area 映射表完备性（工单204）', () => {
  it('源码目录未在映射表登记 → 判红（负例：新目录必须先定域）', () => {
    const m = legalManifest()
    const r = validateManifest({
      manifest: m,
      sources: { fx: legalSource },
      sourceTree: { dirs: ['app/src', 'app/src/main', 'app/src/undeclared'], files: ['app/src/main/a.ts'] },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/src/undeclared') && e.includes('未在 path→area 映射表登记'))).toBe(true)
  })

  it('源码文件未被任何映射规则覆盖 → 判红（负例：源码根本身未登记）', () => {
    const m = legalManifest()
    const r = validateManifest({
      manifest: m,
      sources: { fx: legalSource },
      sourceTree: { dirs: ['app/other'], files: ['app/other/x.ts'] },
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/other/x.ts') && e.includes('未被 path→area 映射表覆盖'))).toBe(true)
  })

  it('映射规则的域越出封闭词表 → 判红（负例）', () => {
    const m = legalManifest()
    m.pathAreas.push({ path: 'app/src/x', area: 'nope' })
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/src/x') && e.includes('不在域标签封闭词表内'))).toBe(true)
  })

  it('映射规则缺 path / 缺 area → 判红（负例）', () => {
    const m = legalManifest()
    m.pathAreas.push({ area: 'desktop' } as never)
    m.pathAreas.push({ path: 'app/src/y' } as never)
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    const joined = r.errors.join('\n')
    expect(joined).toContain('缺 path')
    expect(joined).toContain('缺 area')
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
  it('六电池真实清单 ↔ 六电池真实源码：双向同步、字段完备、预算合规、Report 名对应', () => {
    const manifest = loadManifest() as { batteries: { id: string; entry: string }[] }
    expect(manifest).not.toBeNull()
    const sources: Record<string, string> = {}
    for (const b of manifest.batteries) {
      sources[b.id] = readFileSync(resolve(APP_ROOT, b.entry), 'utf8')
    }
    // 反向核对：accept 目录（除 lib/ 与非电池脚本）在场脚本必须全部入清单
    const presentEntries = readdirSync(resolve(APP_ROOT, 'app/accept'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => `app/accept/${f}`)
    const r = validateManifest({ manifest, sources, presentEntries })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('八电池真实清单：域标签全回填 + path→area 映射表对源码目录完备（工单204）', () => {
    const manifest = loadManifest()
    expect(manifest).not.toBeNull()
    // 词表落在 14 域上（封闭：清单 areas 键集就是全集，CI 以它为准）
    expect(Object.keys(manifest!.areas).length).toBe(14)
    const sources: Record<string, string> = {}
    // 工单214：experiment 条目（取证工具）段级治理豁免——不参与段级源码扫描
    for (const b of manifest!.batteries.filter((x) => x.kind !== 'experiment')) {
      sources[b.id] = readFileSync(resolve(APP_ROOT, b.entry), 'utf8')
    }
    const sourceTree = collectSourceTree(APP_ROOT, manifest!.sourceRoots || [])
    const r = validateManifest({ manifest, sources, sourceTree })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    // 108 段全部有归属域：段级或电池级至少一处登记
    // （94 → 98：工单244 增段——51 电池 +P6/P7/P8、55 电池 +P8；98 → 102：工单243 增段
    //   ——49 电池 +P22/P23/P24/P25 唤出条交互段；102 → 104：工单260 增段——51 电池 +P9
    //   收栏态退出双复原、50 电池 +C2 maximizeRetract=off 不置位；104 → 105：工单262
    //   增段——51 电池 +P10 收栏态原生栏重申轮询；105 → 106：工单269 增段——51 电池
    //   +P11 分屏收栏单窗最小闭环；106 → 108：工单270 增段——51 电池 +P12 分屏会话
    //   集合生命周期与代表性布局、+P13 虚拟桌面切换隔离与收栏理由接续；108 → 109：
    //   工单271 增段——51 电池 +P14 全屏让位与分屏会话解耦；109 → 110：工单200 增段
    //   ——166 电池 +P200 空临时组卡留屏；110 → 111：工单293 增段——51 电池 +P15
    //   普通态清位与三路径禁现；111 → 114：工单296 增段——50 电池 +A5/A6/A7 普通态
    //   出发的退场复原对应轮（正常退出/崩溃/强杀）；114 → 120：工单310 新电池 +P1..P6
    //   （宿主摆位：长按/吸附/持久化/组卡冻结展开/搜索方向/无空位拒绝）；120 → 121：
    //   工单256 增段——49 电池 +P26 轮末清场自检（参照窗销毁后验＋桌面探针残留窄口径扫描）；
    //   121 → 122：工单332 新电池 332-conversation +C1（真实 DSH 聊天会话全链冒烟）；
    //   122 → 123：工单331 增段——03 电池 +P13 零权限投放包独立上下文（P11 同 PR 特征退役：
    //   旧同上下文投放探针随 ADR-0025 断裂迁移移除，段保留、断言缩至内置五卡自举）；
    //   123 → 124：工单333 增段——332-conversation +C2 管理型会话只读面板与插件契约
    //   （真实 DSH 显式授权/只读工具真链/凭证失效/宿主回收；一段绑定一工单）；
    //   124 → 125：工单340 增段——332-conversation +C3 浮动版本与失败处置（bogus 后端档
    //   失败非破坏 + 全新数据目录手势；C1/C2 est 60→30 同 PR 校准，#333 健康轮 took=13.0/9.7s）
    const total = manifest!.batteries.reduce((n, b) => n + (b.segments || []).length, 0)
    // 125 → 126：工单334 增段——332-conversation +C4 DSH 全链创建零权限插件（执行序 C1→C2→C4→C3；
    // C3 是失败注入段必须最后）；预算 120→240（C4 est 90 实跑佐证随轮入库，#333 预算上调先例）
    // 126 → 127：工单335 增段——332-conversation +C5 DSH 更新已装包与卸载全链（执行序 C4 后
    // C3 前；est 90 起笔健康轮 took=6.5s 同 PR 校准 90→30）；预算 240 保持（120+30=150≤240）
    // 127 → 128：工单336 增段——332-conversation +C6 媒体信息卡与 media.read（执行序 C5 后
    // C3 前；est 90 起笔首轮量后校准）；预算 240→360（理由：媒体全链+真机 SMTC 播放器夹具
    // ——罐头编排 4 轮+批准激活+Edge 起停+缩略图链+撤销即停，随关票评论留痕）
    // 128 → 129：工单337 增段——332-conversation +C7 媒体控制可选权限（双包对照；执行序 C7 后 C3 前）
    // 129 → 130：工单338 增段——332-conversation +C8 联网组件与 origin 权限（执行序 C7 后 C3 前）
    // 130 → 131：工单339 增段——332-conversation +C9 命名凭证与认证联网（执行序 C8 后 C3 前）
    expect(total).toBe(131)
    for (const b of manifest!.batteries.filter((x) => x.kind !== 'experiment')) {
      for (const s of b.segments || []) {
        const eff = (s.areas && s.areas.length) ? s.areas : (b.areas || [])
        expect(eff.length).toBeGreaterThan(0)
      }
    }
  })
})

/**
 * 文件级例外规则白名单（工单220，spec #201 A 链 P1 机制补强）——夹具：
 * 两条目录级规则 + 一条文件级例外规则（tray.ts 归 tray 域，与父目录 panel.core 不同）。
 */
function fileRuleManifest() {
  const m = legalManifest()
  ;(m as { areas: Record<string, string> }).areas = { ...m.areas, tray: '托盘域' }
  m.pathAreas = [
    { path: 'app/src', area: 'panel.core' },
    { path: 'app/src/main', area: 'panel.core' },
    { path: 'app/src/main/tray.ts', area: 'tray' },
  ]
  ;(m as unknown as { requiredFileRules: { path: string; area: string }[] }).requiredFileRules = [
    { path: 'app/src/main/tray.ts', area: 'tray' },
  ]
  return m
}

describe('文件级例外规则白名单（工单220：文件级规则不得被静默删/改域）', () => {
  it('白名单与映射表一致 → 判绿零错误', () => {
    const r = validateManifest({ manifest: fileRuleManifest(), sources: { fx: legalSource } })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  it('文件级规则被删（目录规则兜住它）→ 判红（负例：静默删规则不得过关）', () => {
    const m = fileRuleManifest()
    m.pathAreas = m.pathAreas.filter((r) => r.path !== 'app/src/main/tray.ts')
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/src/main/tray.ts') && e.includes('删除'))).toBe(true)
  })

  it('文件级规则的域被改 → 判红（负例：域归属不得被静默改）', () => {
    const m = fileRuleManifest()
    m.pathAreas.find((r) => r.path === 'app/src/main/tray.ts')!.area = 'desktop'
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/src/main/tray.ts') && e.includes('域被改'))).toBe(true)
  })

  it('映射表有文件级规则但未在白名单登记 → 判红（负例：白名单须是全量台账）', () => {
    const m = fileRuleManifest()
    m.pathAreas.push({ path: 'app/src/main/rogue.ts', area: 'tray' })
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('app/src/main/rogue.ts') && e.includes('未在 requiredFileRules 白名单登记'))).toBe(true)
  })

  it('清单缺 requiredFileRules 白名单（而映射表有文件级规则）→ 判红（负例：白名单不得被整份删掉）', () => {
    const m = fileRuleManifest()
    delete (m as unknown as { requiredFileRules?: unknown }).requiredFileRules
    const r = validateManifest({ manifest: m, sources: { fx: legalSource } })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('缺 requiredFileRules 白名单'))).toBe(true)
  })

  it('真仓库现状：37 条文件级例外规则逐条登记在白名单（删一条／改一域即判红）', () => {
    const manifest = loadManifest()!
    const fileRules = (manifest.pathAreas || []).filter((r) => (r.path.split('/').pop() || '').includes('.'))
    expect(fileRules.length).toBe(37)
    expect(manifest.requiredFileRules!.length).toBe(37)
    for (const req of manifest.requiredFileRules!) {
      const hit = fileRules.find((r) => r.path === req.path)
      expect(hit, `文件级例外规则 ${req.path} 已从映射表消失`).toBeTruthy()
      expect(hit!.area, `文件级例外规则 ${req.path} 的域被改了`).toBe(req.area)
    }
  })
})
