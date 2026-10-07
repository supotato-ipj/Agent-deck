// 渲染层静默分级裁决（工单93，#92 spec 的纯函数缝）：静默 → 失能的状态机矩阵。
// 纯函数缝——心跳与时间戳由哨兵采数，这里只裁决「该不该报、报哪一级」。先例同构：
// 桌面遮罩守望的 coverDecision（外部完成 z 序侦察、纯函数只裁决 engage/release）、
// 键盘模式门控的 nextKeyboardGate（外部喂事件、纯函数归约出通道变化沿）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { silenceVerdict } from '../src/main/render-sentinel'
import type { SilenceAction, SilenceSnapshot } from '../src/main/render-sentinel'

/** 静默判据阈值（由调用方传入，测试只负责喂进去，不假设模块内部持这个数） */
const T = 5000

/** 常态：面板活着、有上行、同一形态未上报过 */
const normal: SilenceSnapshot = {
  quietMs: 0,
  thresholdMs: T,
  reportedQuiet: false,
  recovered: false,
  windowDestroyed: false,
  rendererDestroyed: false,
}

describe('silenceVerdict 静默分级裁决', () => {
  it('常态无静默 → 不动作', () => {
    expect(silenceVerdict(normal)).toEqual({ action: 'none', recovered: false })
  })

  it('静默时长未达阈值 → 不动作', () => {
    expect(silenceVerdict({ ...normal, quietMs: 0 })).toEqual({ action: 'none', recovered: false })
    expect(silenceVerdict({ ...normal, quietMs: T - 1 })).toEqual({ action: 'none', recovered: false })
  })

  it('达阈值且当前形态未上报过 → 报静默（阈值含等号，5213ms 那条即在此档）', () => {
    expect(silenceVerdict({ ...normal, quietMs: T })).toEqual({ action: 'report-quiet', recovered: false })
    expect(silenceVerdict({ ...normal, quietMs: 5213 })).toEqual({ action: 'report-quiet', recovered: false })
  })

  it('静默期间收到过心跳 → 报静默且标记已恢复，而不是失能（15:19:15 自愈假阳性的直接编码）', () => {
    expect(silenceVerdict({ ...normal, quietMs: 5213, recovered: true })).toEqual({
      action: 'report-quiet',
      recovered: true,
    })
  })

  it('达阈值但同一形态已上报过、期间收到过心跳 → 不动作（不重复报）', () => {
    expect(silenceVerdict({ ...normal, quietMs: T, reportedQuiet: true, recovered: true })).toEqual({
      action: 'none',
      recovered: false,
    })
    expect(silenceVerdict({ ...normal, quietMs: 6313, reportedQuiet: true, recovered: true })).toEqual({
      action: 'none',
      recovered: false,
    })
  })

  it('已报静默后再次静默（未收到心跳）→ 升级失能', () => {
    expect(silenceVerdict({ ...normal, quietMs: 6313, reportedQuiet: true, recovered: false })).toEqual({
      action: 'escalate-unresponsive',
      recovered: false,
    })
  })

  it('窗口销毁或渲染进程已销毁 → 不动作（各上报/恢复组合一律不动作）', () => {
    for (const reportedQuiet of [false, true]) {
      for (const recovered of [false, true]) {
        expect(silenceVerdict({ ...normal, quietMs: 6313, reportedQuiet, recovered, windowDestroyed: true }))
          .toEqual({ action: 'none', recovered: false })
        expect(silenceVerdict({ ...normal, quietMs: 6313, reportedQuiet, recovered, rendererDestroyed: true }))
          .toEqual({ action: 'none', recovered: false })
        expect(silenceVerdict({ ...normal, quietMs: 6313, reportedQuiet, recovered, windowDestroyed: true, rendererDestroyed: true }))
          .toEqual({ action: 'none', recovered: false })
      }
    }
  })

  it('阈值由外部传入：换一个阈值，同一份采数落另一档', () => {
    const snap = { ...normal, quietMs: 1200 }
    expect(silenceVerdict({ ...snap, thresholdMs: 5000 })).toEqual({ action: 'none', recovered: false })
    expect(silenceVerdict({ ...snap, thresholdMs: 1000 })).toEqual({ action: 'report-quiet', recovered: false })
    // 阈值调到 0 也不改变「未达阈值」分支的语义：quietMs 恒 ≥ 0 即恒达阈值
    expect(silenceVerdict({ ...normal, quietMs: 0, thresholdMs: 0 })).toEqual({ action: 'report-quiet', recovered: false })
  })

  it('已恢复的静默永不升级为失能（分级语义不变量：失能 = 静默且不自愈）', () => {
    for (const quietMs of [0, T - 1, T, 5213, 6313, 60000]) {
      for (const reportedQuiet of [false, true]) {
        expect(silenceVerdict({ ...normal, quietMs, reportedQuiet, recovered: true }).action)
          .not.toBe('escalate-unresponsive')
      }
    }
  })
})

/**
 * 达阈值后的分档字面表（#92 spec 的裁决矩阵写成数据，不重述实现的分支次序）：
 * 键 = 「是否已上报过_期间是否收到过心跳」，值 = 该格应有的裁决与恢复标记。
 * 这里刻意不写成 if 链——若写成与实现同形的分支，穷举只能查出「实现与自身不符」，
 * 查不出「实现与矩阵不符」；落成数据表才能钉住规则本身。
 */
const AFTER_THRESHOLD: Record<string, { action: SilenceAction; recovered: boolean }> = {
  'no_no': { action: 'report-quiet', recovered: false },
  'no_yes': { action: 'report-quiet', recovered: true },
  'yes_yes': { action: 'none', recovered: false },
  'yes_no': { action: 'escalate-unresponsive', recovered: false },
}

describe('silenceVerdict 全组合穷举', () => {
  it('上报态 × 恢复态 × 销毁态 × 时长档（16 × 4）逐格命中字面表', () => {
    const quietLevels = [0, T - 1, T, 6313]
    const yesNo = (b: boolean) => (b ? 'yes' : 'no')
    const mismatches: string[] = []
    let checked = 0

    for (const reportedQuiet of [false, true]) {
      for (const recovered of [false, true]) {
        for (const windowDestroyed of [false, true]) {
          for (const rendererDestroyed of [false, true]) {
            for (const quietMs of quietLevels) {
              const got = silenceVerdict({
                quietMs,
                thresholdMs: T,
                reportedQuiet,
                recovered,
                windowDestroyed,
                rendererDestroyed,
              })
              // 销毁闸门与阈值闸门各自一行，均落在「不动作」
              const want = windowDestroyed || rendererDestroyed || quietMs < T
                ? { action: 'none' as SilenceAction, recovered: false }
                : AFTER_THRESHOLD[`${yesNo(reportedQuiet)}_${yesNo(recovered)}`]
              checked += 1
              if (got.action !== want.action || got.recovered !== want.recovered) {
                mismatches.push(
                  `quietMs=${quietMs} reported=${reportedQuiet} recovered=${recovered} ` +
                  `winDead=${windowDestroyed} procDead=${rendererDestroyed} → ` +
                  `${got.action}/${got.recovered}（期望 ${want.action}/${want.recovered}）`,
                )
              }
            }
          }
        }
      }
    }

    expect(checked).toBe(64)
    expect(mismatches).toEqual([])
  })

  it('字面表覆盖齐四种上报/恢复组合（守卫表自身不漏格）', () => {
    expect(Object.keys(AFTER_THRESHOLD).sort()).toEqual(['no_no', 'no_yes', 'yes_no', 'yes_yes'])
  })
})

/** 静态 import 语句（含 type-only）与 CommonJS / 动态 require() */
const IMPORT_STMT_RE = /^\s*import\s+(?:type\s+)?[\s{*]/gm
const REQUIRE_RE = /\b(?:import|require)\s*\(/

describe('静默裁决纯函数的依赖边界', () => {
  const SRC = path.resolve(__dirname, '../src/main/render-sentinel.ts')
  const src = readFileSync(SRC, 'utf8')

  it('守卫自身不空转：同一条正则能在确含 import / require 的先例模块上命中', () => {
    const precedent = readFileSync(path.resolve(__dirname, '../src/main/desktop-cover.ts'), 'utf8')
    expect(precedent.match(IMPORT_STMT_RE)?.length ?? 0).toBeGreaterThan(0)
    expect(precedent.match(REQUIRE_RE)?.length ?? 0).toBeGreaterThan(0)
    // 哨兵模块自身也被真的读到了（源非空），否则下面的 not.toMatch 是白过
    expect(src.length).toBeGreaterThan(0)
  })

  it('模块不含任何 import / require（零 Electron、零 IO：裁决只吃调用方喂进来的快照）', () => {
    expect(src.match(IMPORT_STMT_RE)).toBeNull()
    expect(src.match(REQUIRE_RE)).toBeNull()
  })

  it('模块不出现阈值魔数（5000 由调用方传入）', () => {
    expect(src).not.toMatch(/\b5000\b/)
  })
})
