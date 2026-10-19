// 工单213（spec #203 实施决策 4）：验收提示条挂条条件守卫——「四模式漏挂」先行补丁的回归防护。
//
// 提示条由控制器进程自绘（ADR-0008），挂条条件是 src/main/index.ts 里一行手维护布尔式。
// 工单213 补齐了四块漏挂电池（任务栏右组/AppBar/应用组枚举过滤/桌面文档组卡），但条件行
// 仍是手维护的——下一块新电池若忘了加进条件，提示条就静默缺席，用户在场时的键鼠干扰风险
// 直接回来，而真机轮次不会因此报红（提示条是增益，不是断言前提）。故在此静态守卫。
//
// 被测缝（seam）：控制器身份「挂不挂条」的判定——本仓唯一的挂条点在 src/main/index.ts 的
// --accept* 分发处（accept/lib/hint-bar.js 的 showAcceptHintBar 只由它调用）。期望值取自两处
// 独立来源：① 模式常量与其 CLI 旗标的声明处（index.ts 顶部常量区）；② 工单213 验收标准逐字
// 记下的四个模式与旗标。不是把实现的表达式原样抄一遍（故不构成同义反复）。
//
// 口径与 tests/accept/manifest-check.spec.ts 同款（静态交叉校验源码自身）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const INDEX_TS = resolve(__dirname, '../../src/main/index.ts')
const source = readFileSync(INDEX_TS, 'utf8')

/** 模式常量声明：const XXX_MODE = process.argv.includes('--flag') */
const MODE_DECL_RE = /const\s+([A-Z][A-Z0-9_]*_MODE)\s*=\s*process\.argv\.includes\('(--[a-z-]+)'\)/g

interface ModeDecl {
  mode: string
  flag: string
}

function modeDecls(): ModeDecl[] {
  const out: ModeDecl[] = []
  for (const m of source.matchAll(MODE_DECL_RE)) out.push({ mode: m[1], flag: m[2] })
  return out
}

/** 控制器身份的验收模式：旗标以 --accept 开头（被测物子进程的旗标是 --panel-accept/--tray-spike，不落此集） */
const controllerModes = modeDecls().filter((d) => d.flag.startsWith('--accept'))
/** 被测物子进程：面板子进程与托盘 spike 子进程不得挂条（它们是被测物，不是控制器） */
const subjectModes = modeDecls().filter((d) => d.flag === '--panel-accept' || d.flag === '--tray-spike')

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
const conditionModes: string[] = condition.match(/[A-Z][A-Z0-9_]*/g) ?? []

describe('验收提示条挂条条件（工单213）', () => {
  it('控制器身份的全部验收模式都进挂条条件（新增电池漏挂即判红）', () => {
    const missing = controllerModes
      .filter((d) => !conditionModes.includes(d.mode))
      .map((d) => `${d.mode}（${d.flag}）`)
    expect(missing).toEqual([])
  })

  it('工单213 的四块漏挂电池：模式常量绑定的旗标与工单记的一致', () => {
    const want: Record<string, string> = {
      ACCEPT_TASKBAR_RIGHT_GROUP_MODE: '--accept-taskbar-right-group',
      ACCEPT_TASKBAR_APPBAR_MODE: '--accept-taskbar-appbar',
      ACCEPT_TASKBAR_APPS_FILTER_MODE: '--accept-taskbar-apps-filter',
      ACCEPT_DOC_GROUP_CARDS_MODE: '--accept-doc-group-cards',
    }
    const decls = new Map(modeDecls().map((d) => [d.mode, d.flag]))
    for (const [mode, flag] of Object.entries(want)) expect(decls.get(mode)).toBe(flag)
  })

  it('工单213 的四块漏挂电池：控制器模式都进挂条条件', () => {
    const want = [
      'ACCEPT_TASKBAR_RIGHT_GROUP_MODE',
      'ACCEPT_TASKBAR_APPBAR_MODE',
      'ACCEPT_TASKBAR_APPS_FILTER_MODE',
      'ACCEPT_DOC_GROUP_CARDS_MODE',
    ]
    expect(want.filter((m) => !conditionModes.includes(m))).toEqual([])
  })

  it('被测物子进程（--panel-accept/--tray-spike）不进挂条条件', () => {
    expect(subjectModes.length).toBeGreaterThan(0)
    expect(subjectModes.filter((d) => conditionModes.includes(d.mode)).map((d) => d.mode)).toEqual([])
  })

  it('守卫自身不空转：控制器模式集非空且条件非空', () => {
    expect(controllerModes.length).toBeGreaterThanOrEqual(8)
    expect(condition.trim().length).toBeGreaterThan(0)
  })
})
