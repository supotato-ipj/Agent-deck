// 工单411 层2：accept lib 成员对齐。
//
// 接缝 = 真实 CommonJS 模块导出、真实工厂、真实类实例（外部依赖一律注入假实现，
// 不启动 Electron）；声明侧成员来自 TypeScript checker 对真实符号/返回类型的解析。
// 本 spec 证明五件事：
// ① 比较器双向语义（持久夹具负例）：等集判绿、可选缺席判绿、声明多成员判红、
//    实现多成员判红、未知可选名出现判红；
// ② 真实八组模块：顶层值导出名双向、需样本根导出（工厂/类/封闭结果）缺根判红、
//    已登记根以真实样本深对齐、own 封闭常量对象深对齐——现状全绿；
// ③ 防漏：自动发现声明文件全集，新声明文件/未登记样本根必须显式判红（负例以夹具证明）；
// ④ 私有句柄状态：TS AST 读 panel-control.js 工厂内 const state 字面量，与 checker 解析的
//    PanelHandleState 七项双向对齐；声明多一项/实现多一项两个方向都有持久负例；
// ⑤ 现存缺陷回归：Report 公开 writeLedger 方法必须真实在位（漏声明在此判红）。
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import {
  acceptLibCompilerOptions,
  alignModule,
  bidirectionalKeyIssues,
  createAlignmentContext,
  declaredClassMemberNames,
  declaredInterfaceMemberNames,
  discoverDeclFiles,
  extractFactoryStateKeys,
  type AlignmentContext,
  type AlignmentIssue,
} from './accept-lib-alignment.helper'

const appRoot = path.resolve(__dirname, '..', '..')
const fixturesDir = path.join(appRoot, 'tests', 'accept', 'fixtures', 'accept-lib')
const requireFromApp = createRequire(path.join(appRoot, 'package.json'))
const requireLib = (name: string): Record<string, unknown> => requireFromApp(path.join(appRoot, 'accept', 'lib', name)) as Record<string, unknown>

function fixtureCtx(files: string[]): AlignmentContext {
  return createAlignmentContext(files, acceptLibCompilerOptions(appRoot))
}

/** 夹具对齐：decl 侧 make() 返回类型 ↔ js 侧真实样本 */
function alignFixturePair(base: string): AlignmentIssue[] {
  const dts = path.join(fixturesDir, 'align', `${base}.d.ts`)
  const js = path.join(fixturesDir, 'align', `${base}.js`)
  const ctx = fixtureCtx([dts])
  const mod = requireFromApp(js) as Record<string, () => unknown>
  return alignModule(ctx, base, dts, mod, { make: () => mod.make() })
}

function issuesAt(issues: AlignmentIssue[], suffix: string): AlignmentIssue[] {
  return issues.filter((i) => i.at === suffix || i.at.endsWith(suffix))
}

// —— 工厂/类的注入假实现（外部依赖全假，离线零真机，决策10） ——

const panelControlFakeDeps = () => ({
  isAlive: () => true,
  gracefulKill: () => {},
  forceKillTree: () => {},
  sleep: async () => {},
  now: () => 0,
})

const panelHandleFakeDeps = () => ({
  ...panelControlFakeDeps(),
  spawn: () => ({}),
  execPath: 'fake-exec-path',
  appRoot: appRoot,
  baseEnv: {},
  eventLogPath: 'fake-events.jsonl',
  readEvents: () => [],
  topLevelWindows: () => [],
  windowPid: () => 0,
  windowTitle: () => '',
  windowClass: () => '',
  isWindowVisible: () => false,
  responsiveProbe: () => false,
  openArchive: () => 0,
  archivePath: 'fake-archive.log',
  log: () => {},
})

/** 真实八组的样本根登记（决策11「少量根」）：工厂、类与封闭结果——全部走真实实现路径 */
function realSampleRoots(): Record<string, Record<string, () => unknown>> {
  const areaSelector = requireLib('area-selector')
  const batteryConfig = requireLib('battery-config')
  const eventTape = requireLib('event-tape')
  const manifestCheck = requireLib('manifest-check')
  const panelControl = requireLib('panel-control')
  const report = requireLib('report')
  const registry = requireLib('registry')
  const trayMachineState = requireLib('tray-machine-state')
  const probeResidue = requireLib('probe-residue')
  return {
    'area-selector': {
      selectPlan: () => (areaSelector.selectPlan as (req: unknown) => unknown)({ changedFiles: [], manifest: null }),
    },
    'battery-config': {
      createBatteryConfig: () => (batteryConfig.createBatteryConfig as (f: string) => unknown)('fake-config-path.json'),
    },
    'event-tape': {
      createEventTape: () => (eventTape.createEventTape as (f: string) => unknown)('fake-events.jsonl'),
    },
    'manifest-check': {
      validateManifest: () => (manifestCheck.validateManifest as (req: unknown) => unknown)({ manifest: { batteries: [] }, sources: {} }),
      validateRegistry: () => (manifestCheck.validateRegistry as (req: unknown) => unknown)({ manifest: { batteries: [] } }),
      validateScopeSegments: () => (manifestCheck.validateScopeSegments as (s: string[], m: unknown, b: string) => unknown)(['1'], { batteries: [] }, 'fixture'),
      matchPathArea: () => (manifestCheck.matchPathArea as (p: string, r: unknown) => unknown)('app/accept/battery.js', [{ path: 'app/accept', area: 'core' }]),
    },
    'panel-control': {
      createPanelControl: () => (panelControl.createPanelControl as (d?: unknown) => unknown)(panelControlFakeDeps()),
      createPanelHandle: () => (panelControl.createPanelHandle as (d?: unknown) => unknown)(panelHandleFakeDeps()),
    },
    report: {
      Report: () => new (report.Report as new (n: string, o?: unknown) => object)('spec411-alignment-probe', { file: null, manifest: null }),
      loadManifest: () => (report.loadManifest as () => unknown)(),
    },
    registry: {
      matchByFlag: () => (registry.matchByFlag as (argv: string[]) => unknown)(['--accept']),
    },
    'tray-machine-state': {
      judgeTrayMachineState: () => (trayMachineState.judgeTrayMachineState as (input?: unknown) => unknown)({}),
    },
    'probe-residue': {
      stripBatteryResidue: () => (probeResidue.stripBatteryResidue as (s: unknown) => unknown)({ pinned: [], recommended: [], excluded: [] }),
    },
  }
}

// 本文件凡构建 TS 检查程序的用例（fixtureCtx / ctxForRealRepo → createAlignmentContext）
// 一律显式 15s 预算：单跑各 ~1.0–1.8s，但全量门禁并行时 CPU 竞争会把程序构建推过 vitest
// 5s 默认预算（工单228 自检门实测 3 例假红，单跑全绿）——128/163 行先例同机制同处置，
// 只放宽时间预算、断言零改动。
describe('工单411 层2：成员对齐比较器双向语义（持久夹具负例）', () => {
  it('等集形状判绿', () => {
    expect(alignFixturePair('ok-pair')).toEqual([])
  }, 30_000) // 本文件首个程序构建付全价（skipLibCheck=false 全量 lib/node 类型，单独实测 ~2.1s），后续经 oldProgram 复用降载
  it('可选成员合法缺席判绿', () => {
    expect(alignFixturePair('optional-absent-pair')).toEqual([])
  }, 15_000)
  it('声明多成员（必需成员运行时缺失）判红', () => {
    const issues = alignFixturePair('decl-extra-pair')
    expect(issuesAt(issues, '.required').map((i) => i.problem)).toEqual(['声明必需成员在运行时缺失'])
  }, 15_000)
  it('实现多成员（运行时多出声明外成员）判红', () => {
    const issues = alignFixturePair('impl-extra-pair')
    expect(issuesAt(issues, '.extra').map((i) => i.problem)).toEqual(['实现多出声明外成员'])
  }, 15_000)
  it('未知可选名出现判红（可选性不是未知成员逃生口）', () => {
    const issues = alignFixturePair('unknown-optional-pair')
    expect(issuesAt(issues, '.opt2').map((i) => i.problem)).toEqual(['实现多出声明外成员'])
  }, 15_000)
})

describe('工单411 层2：真实八组模块成员对齐', () => {
  it('自动发现的声明文件全集全部登记样本根并对齐通过（现状全绿 + 新增面防漏）', () => {
    const declFiles = discoverDeclFiles(appRoot)
    expect(declFiles.length).toBeGreaterThanOrEqual(8) // 票面八组；夹具不在 accept/lib 下，不会混入
    const roots = realSampleRoots()
    const allIssues: AlignmentIssue[] = []
    for (const declFile of declFiles) {
      const moduleName = path.basename(declFile, '.d.ts')
      const sampleRoots = roots[moduleName]
      if (!sampleRoots) {
        allIssues.push({ at: moduleName, problem: '新声明文件未登记样本根——覆盖面不得静默扩张' })
        continue
      }
      const mod = requireLib(moduleName)
      allIssues.push(...alignModule(ctxForRealRepo(), moduleName, declFile, mod, sampleRoots))
    }
    expect(allIssues).toEqual([])
  }, 30_000) // 真实仓库检查程序首次构建付全价（八组声明 + 全量 lib/node 类型，单独实测 ~3s）

  it('现存缺陷回归：Report 公开 writeLedger 必须真实在位且已声明', () => {
    const report = requireLib('report')
    const inst = new (report.Report as new (n: string, o?: unknown) => Record<string, unknown>)('spec411-writeledger-probe', { file: null, manifest: null })
    expect(typeof inst.writeLedger).toBe('function')
    // 声明侧回归：专用检查程序内 Report 类型必须含 writeLedger 成员
    const ctx = ctxForRealRepo()
    const declFile = path.join(appRoot, 'accept', 'lib', 'report.d.ts')
    const members = declaredClassMemberNames(ctx, declFile, 'Report')
    expect(members).toContain('writeLedger')
    expect(bidirectionalKeyIssues('Report', members, Object.keys(inst).concat(prototypePublicKeys(inst)))).toEqual([])
  }, 15_000)
})

describe('工单411 层2：防漏——新声明文件 / 缺失样本根显式判红', () => {
  it('未登记样本根的声明模块判红（夹具证明机制承重，非只走绿路径）', () => {
    const dts = path.join(fixturesDir, 'align', 'ok-pair.d.ts')
    const ctx = fixtureCtx([dts])
    const mod = requireFromApp(path.join(fixturesDir, 'align', 'ok-pair.js')) as Record<string, () => unknown>
    // createPanelControl 形状的函数有封闭返回类型——不给样本根必须判红
    const issues = alignModule(ctx, 'ok-pair', dts, mod, {})
    expect(issues).toContainEqual({ at: 'ok-pair.make', problem: '需样本根的导出（工厂/类/封闭结果）未登记样本根' })
  }, 15_000)

  it('登记了不存在导出的样本根判红（登记表防朽）', () => {
    const dts = path.join(fixturesDir, 'align', 'ok-pair.d.ts')
    const ctx = fixtureCtx([dts])
    const mod = requireFromApp(path.join(fixturesDir, 'align', 'ok-pair.js')) as Record<string, () => unknown>
    const issues = alignModule(ctx, 'ok-pair', dts, mod, { make: () => mod.make(), ghost: () => ({}) })
    expect(issues).toContainEqual({ at: 'ok-pair.ghost', problem: '样本根登记了声明中不存在的导出' })
  }, 15_000)

  it('真实声明文件自动发现不含夹具目录（坏声明夹具不进正常编译目标）', () => {
    const declFiles = discoverDeclFiles(appRoot)
    for (const f of declFiles) {
      expect(f.startsWith(fixturesDir)).toBe(false)
    }
    // 主 typecheck 不吃夹具：tsconfig.typecheck.json 显式排除 tests/accept/fixtures/**
    const tc = JSON.parse(fs.readFileSync(path.join(appRoot, 'tsconfig.typecheck.json'), 'utf8')) as { exclude?: string[] }
    expect(tc.exclude).toContain('tests/accept/fixtures/**')
  })
})

describe('工单411 层2：私有句柄状态双向对齐（决策12，AST × checker）', () => {
  const panelControlJs = path.join(appRoot, 'accept', 'lib', 'panel-control.js')
  const panelControlDts = path.join(appRoot, 'accept', 'lib', 'panel-control.d.ts')

  it('真实七项状态字面量 ↔ PanelHandleState 声明双向对齐（现状全绿）', () => {
    const ctx = ctxForRealRepo()
    const runtimeKeys = extractFactoryStateKeys(fs.readFileSync(panelControlJs, 'utf8'), 'createPanelHandle')
    const declaredNames = declaredInterfaceMemberNames(ctx, panelControlDts, 'PanelHandleState')
    expect(runtimeKeys.length).toBe(7) // 票面点名「七项句柄状态」
    expect(bidirectionalKeyIssues('PanelHandleState', declaredNames, runtimeKeys)).toEqual([])
  }, 15_000)

  it('负例：声明多一项（持久夹具 8 项接口）→ 判红', () => {
    const fixtureDts = path.join(fixturesDir, 'panel-state-fixture-extra.d.ts')
    const ctx = fixtureCtx([fixtureDts])
    const declaredNames = declaredInterfaceMemberNames(ctx, fixtureDts, 'FixturePanelStateExtra')
    const runtimeKeys = extractFactoryStateKeys(fs.readFileSync(panelControlJs, 'utf8'), 'createPanelHandle')
    const issues = bidirectionalKeyIssues('FixturePanelStateExtra', declaredNames, runtimeKeys)
    expect(issues).toContainEqual({ at: 'FixturePanelStateExtra.fakeExtra', problem: '声明成员在实现侧缺失' })
  }, 15_000)

  it('负例：实现多一项（合成状态字面量多出键）→ 判红', () => {
    const ctx = ctxForRealRepo()
    const declaredNames = declaredInterfaceMemberNames(ctx, panelControlDts, 'PanelHandleState')
    const implExtra = fs.readFileSync(panelControlJs, 'utf8').replace(
      '    stderrTail: \'\',',
      "    stderrTail: '',\n    driftKey: null,",
    )
    expect(extractFactoryStateKeys(implExtra, 'createPanelHandle')).toContain('driftKey')
    const issues = bidirectionalKeyIssues('PanelHandleState', declaredNames, extractFactoryStateKeys(implExtra, 'createPanelHandle'))
    expect(issues).toContainEqual({ at: 'PanelHandleState.driftKey', problem: '实现多出声明外成员' })
  }, 15_000)
})

// —— 真实仓库检查程序（懒建一次，八组声明 + 专用配置口径） ——

let realCtx: AlignmentContext | null = null
function ctxForRealRepo(): AlignmentContext {
  if (!realCtx) {
    realCtx = createAlignmentContext(discoverDeclFiles(appRoot), acceptLibCompilerOptions(appRoot))
  }
  return realCtx
}

function prototypePublicKeys(inst: object): string[] {
  const proto = Object.getPrototypeOf(inst) as object | null
  if (!proto || proto === Object.prototype) return []
  return Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor' && !k.startsWith('_'))
}
