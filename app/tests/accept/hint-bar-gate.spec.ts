// 验收提示条挂条条件守卫——「四模式漏挂」（工单213）先行补丁的回归防护，
// 工单214（spec #203 决策 4/6）起按**电池接入表派生后的形态**校验（守卫语义不许放松）。
//
// 提示条由控制器进程自绘（ADR-0008），挂条条件曾是 src/main/index.ts 里一行手维护布尔式。
// 工单213 补齐了四块漏挂电池（任务栏右组/AppBar/应用组枚举过滤/桌面文档组卡），但条件行
// 仍是手维护的——下一块新电池若忘了加进条件，提示条就静默缺席，用户在场时的键鼠干扰风险
// 直接回来，而真机轮次不会因此报红（提示条是增益，不是断言前提）。故在此静态守卫。
//
// 工单214 起挂条条件改由电池接入表（段级清单的电池级条目 hintBar 字段）派生：手维护的
// 九连条件行与 ACCEPT_*_MODE 常量随之退役。本守卫改为按派生后的形态校验，两条语义原样保留：
//   ① 控制器身份的全部验收模式都进挂条条件（新增电池漏挂即判红）；
//   ② 被测物子进程（--panel-accept/--tray-spike）不进挂条条件。
// 另加一条形态守卫：挂条条件必须真由表派生（不得回退成手维护布尔式），且守卫自身不空转。
//
// 被测缝（seam）：控制器身份「挂不挂条」的判定——本仓唯一的挂条点在 src/main/index.ts 的
// 挂条调用处（accept/lib/hint-bar.js 的 showAcceptHintBar 只由它调用），判定依据是
// 电池接入表的 hintBar 字段。期望值取自两处独立来源：① 工单213 验收标准逐字记下的四个
// 模式与旗标；② 工单213/#216 落地的九项挂条覆盖面（八块电池 ＋ stall-duel 对照实验）。
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadRegistry, matchByFlag, hintBarRequired } from '../../accept/lib/registry'

const INDEX_TS = resolve(__dirname, '../../src/main/index.ts')
const source = readFileSync(INDEX_TS, 'utf8')
/** 仓库根（app/ 的上一级）——表内 entry 是仓库根相对路径 */
const REPO_ROOT = resolve(__dirname, '../../..')

/** 电池接入表（段级清单的电池级条目）——挂条条件的唯一依据 */
const registry = loadRegistry()
/** 控制器身份旗标（表内全部条目都是控制器身份；面板侧被测物模式不表化） */
const controllerFlags = registry.map((e) => e.flag)
/** 派生结果：表内 hintBar 为真的条目旗标 */
const derivedHintBarFlags = registry.filter((e) => e.hintBar).map((e) => e.flag)

/** 被测物子进程旗标：面板子进程与托盘 spike 子进程不得挂条（它们是被测物，不是控制器） */
const subjectFlags = ['--panel', '--panel-accept', '--tray-spike']

/** 挂条条件：包住 showAcceptHintBar() 调用的那个 if 的条件表达式 */
function hintBarCondition(): string {
  const call = source.indexOf('showAcceptHintBar()')
  expect(call, 'src/main/index.ts 里找不到 showAcceptHintBar 挂条调用点').toBeGreaterThan(-1)
  const open = source.slice(0, call).lastIndexOf('if (')
  expect(open, '挂条调用点前找不到 if 条件').toBeGreaterThan(-1)
  let depth = 0
  for (let i = open + 3; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return source.slice(open + 4, i)
    }
  }
  throw new Error('挂条条件括号不配平')
}

const condition = hintBarCondition()

describe('验收提示条挂条条件（工单213 语义，工单214 表派生形态）', () => {
  it('① 控制器身份的全部验收模式都进挂条条件（表内每条接线都要挂条）', () => {
    const missing = controllerFlags.filter((f) => !derivedHintBarFlags.includes(f))
    expect(missing).toEqual([])
  })

  it('① 工单213 的四块漏挂电池：表内旗标与工单记的一致', () => {
    const want: Record<string, string> = {
      '55-taskbar-right-group': '--accept-taskbar-right-group',
      '51-taskbar-appbar': '--accept-taskbar-appbar',
      '156-taskbar-apps-filter': '--accept-taskbar-apps-filter',
      '166-doc-group-cards': '--accept-doc-group-cards',
    }
    for (const [id, flag] of Object.entries(want)) {
      const e = registry.find((x) => x.id === id)
      expect(e, `电池接入表缺条目 ${id}`).toBeTruthy()
      expect(e!.flag).toBe(flag)
    }
  })

  it('① 工单213/#216 的九项挂条覆盖面齐备（八块电池 ＋ stall-duel 对照实验）', () => {
    const want = [
      '--accept',
      '--accept-tray',
      '--accept-taskbar',
      '--accept-taskbar-carry',
      '--accept-taskbar-right-group',
      '--accept-taskbar-appbar',
      '--accept-taskbar-apps-filter',
      '--accept-doc-group-cards',
      '--accept-stall-duel',
    ]
    expect(want.filter((f) => !derivedHintBarFlags.includes(f))).toEqual([])
  })

  it('② 被测物子进程（--panel/--panel-accept/--tray-spike）不进挂条条件（不表化）', () => {
    expect(subjectFlags.filter((f) => controllerFlags.includes(f))).toEqual([])
    expect(subjectFlags.filter((f) => derivedHintBarFlags.includes(f))).toEqual([])
  })

  it('形态守卫：挂条条件由表派生，不得回退成手维护布尔式', () => {
    // 条件表达式必须落在表的 hintBar 字段上（派生），而非 ACCEPT_*_MODE 之类手维护常量
    expect(condition).toMatch(/hintBar/i)
    // 手维护的**控制器**旗标常量声明必须已退役（面板侧被测物模式 --panel/--panel-accept/
    // --tray-spike 不表化，保留既在判别；注释里为申报旧口径而提及旧名不算——只判声明形态）
    expect(source).not.toMatch(/const\s+ACCEPT_[A-Z0-9_]*_MODE\s*=\s*process\.argv\.includes/)
  })

  it('派生函数与表一致：hintBar 为真的条目命中 argv 即挂条', () => {
    const e = registry.find((x) => x.flag === '--accept-doc-group-cards')!
    expect(hintBarRequired(matchByFlag(['--accept-doc-group-cards']))).toBe(true)
    expect(hintBarRequired(matchByFlag(['--panel-accept']))).toBe(false)
    expect(hintBarRequired(matchByFlag([]))).toBe(false)
    expect(e.hintBar).toBe(true)
  })

  it('守卫自身不空转：控制器条目集非空且条件非空', () => {
    expect(controllerFlags.length).toBeGreaterThanOrEqual(8)
    expect(derivedHintBarFlags.length).toBeGreaterThanOrEqual(8)
    expect(condition.trim().length).toBeGreaterThan(0)
  })
})

// —— 三方互校（工单214 补强）：表 ↔ package.json 控制器旗标 ↔ accept 目录在场电池脚本 ——
// 旧守卫从 index.ts 的模式常量声明**反查代码**，能抓「代码里新增了控制器模式但没进条件」；
// 表派生后判定基准是表自身，若新电池只在 package.json ＋ accept 目录登记而**未入表**，
// 本守卫会因「表为准」而全绿。此处补三方互校，把「表漏登记」从跨文件依赖升级为表自身完备性。
describe('电池接入表三方互校（表 ↔ package.json ↔ accept 目录）', () => {
  /** package.json 的 scripts 里出现的控制器旗标（--accept*；--accept-scope 是段范围旗标，不算身份） */
  const scriptControllerFlags = (): string[] => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'app/package.json'), 'utf8')) as { scripts: Record<string, string> }
    const out: string[] = []
    for (const cmd of Object.values(pkg.scripts || {})) {
      for (const m of String(cmd).matchAll(/--accept(?:-[a-z0-9-]+)*/g)) {
        const flag = m[0]
        if (flag === '--accept-scope') continue
        if (!out.includes(flag)) out.push(flag)
      }
    }
    return out
  }

  /** accept 目录顶层在场的电池脚本（仓库根相对路径）——子目录（lib/、experiments/）不入此集 */
  const presentBatteryScripts = (): string[] => readdirSync(resolve(REPO_ROOT, 'app/accept'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => `app/accept/${f}`)

  it('package.json 的控制器旗标集合 == 表内旗标集合（表漏登记即判红）', () => {
    const scriptFlags = scriptControllerFlags().sort()
    const tableFlags = [...controllerFlags].sort()
    expect(scriptFlags).toEqual(tableFlags)
  })

  it('accept 目录在场的每块电池脚本都有表项且挂条（新电池漏登记/漏挂条即判红）', () => {
    const byEntry = new Map(registry.map((e) => [e.entry.replace(/\\/g, '/'), e]))
    const missing: string[] = []
    const noHintBar: string[] = []
    for (const p of presentBatteryScripts()) {
      const e = byEntry.get(p)
      if (!e) { missing.push(p); continue }
      if (!e.hintBar) noHintBar.push(`${p}（${e.flag}）`)
    }
    expect(missing, 'accept 目录在场电池脚本未入电池接入表').toEqual([])
    expect(noHintBar, '在册电池未登记挂条条件').toEqual([])
  })
})
