// 拉回裁决纯函数缝（工单479，ADR-0032 韧性基线）：外层守卫对面板异常退出的
// 「该不该重拉、第几次、隔多久」单点裁决。先例同构：render-sentinel.ts 的
// silenceVerdict（采样在外、裁决单点）、resident-event-log.ts 的 planRotation
// （操作表由纯函数出，执行在写入器）。守卫编排是宿主薄壳，不在此测。
import { describe, expect, it } from 'vitest'
import { adjudicatePullback, backoffDelayMs, isCleanPanelExit, PANEL_BOOT_FAILED_EXIT_CODE } from '../src/main/pullback'

/** 生产表的独立事实源（期望值写死字面量，不从模块常量反推——防同源反复） */
const TABLE = [1000, 2000, 5000]

/** 基态输入：崩溃链第 1 次、面板刚起就死、窗口参数取生产默认口径 */
const base = {
  crashesSoFar: 0,
  maxRespawns: 3,
  stableMs: 500,
  stableResetMs: 60_000,
  delaysMs: TABLE,
}

describe('backoffDelayMs 退避表查表', () => {
  it('第 1/2/3 次重拉分别取表内前三档', () => {
    expect(backoffDelayMs(TABLE, 1)).toBe(1000)
    expect(backoffDelayMs(TABLE, 2)).toBe(2000)
    expect(backoffDelayMs(TABLE, 3)).toBe(5000)
  })

  it('超出表长夹取到最后一档（有界外推，不越表）', () => {
    expect(backoffDelayMs(TABLE, 4)).toBe(5000)
    expect(backoffDelayMs(TABLE, 99)).toBe(5000)
  })

  it('空表属配置错误，拒绝而非静默 0 延迟', () => {
    expect(() => backoffDelayMs([], 1)).toThrow()
  })
})

describe('adjudicatePullback 重拉上限裁决', () => {
  it('首次异常退出 → 重拉（attempt=1，退避取首档）', () => {
    expect(adjudicatePullback(base)).toEqual({ action: 'respawn', attempt: 1, delayMs: 1000 })
  })

  it('连续第 2/3 次异常退出 → 继续重拉，退避逐档升级', () => {
    expect(adjudicatePullback({ ...base, crashesSoFar: 1 })).toEqual({ action: 'respawn', attempt: 2, delayMs: 2000 })
    expect(adjudicatePullback({ ...base, crashesSoFar: 2 })).toEqual({ action: 'respawn', attempt: 3, delayMs: 5000 })
  })

  it('连崩达上限（第 4 次）→ 放弃重拉、延迟 0——重拉次数有界，不做无限循环', () => {
    expect(adjudicatePullback({ ...base, crashesSoFar: 3 })).toEqual({ action: 'give-up', attempt: 4, delayMs: 0 })
  })

  it('稳定运行越过重置窗 → 连崩账清零，再崩从第 1 次重新起算', () => {
    expect(adjudicatePullback({ ...base, crashesSoFar: 3, stableMs: 61_000 }))
      .toEqual({ action: 'respawn', attempt: 1, delayMs: 1000 })
  })

  it('稳定窗边界值恰等 resetMs 即算稳定（≥ 口径）', () => {
    expect(adjudicatePullback({ ...base, crashesSoFar: 3, stableMs: 60_000 }).action).toBe('respawn')
    expect(adjudicatePullback({ ...base, crashesSoFar: 3, stableMs: 59_999 }).action).toBe('give-up')
  })

  it('maxRespawns=0 → 首崩即放弃（配置可收紧到完全不重拉）', () => {
    expect(adjudicatePullback({ ...base, maxRespawns: 0 })).toEqual({ action: 'give-up', attempt: 1, delayMs: 0 })
  })

  it('自定义表逐档生效：两档表第 2 次取第 2 档、第 3 次夹取末档', () => {
    const two = [300, 900]
    expect(adjudicatePullback({ ...base, delaysMs: two })).toEqual({ action: 'respawn', attempt: 1, delayMs: 300 })
    expect(adjudicatePullback({ ...base, crashesSoFar: 1, delaysMs: two })).toEqual({ action: 'respawn', attempt: 2, delayMs: 900 })
    expect(adjudicatePullback({ ...base, crashesSoFar: 2, delaysMs: two, maxRespawns: 99 })).toEqual({ action: 'respawn', attempt: 3, delayMs: 900 })
  })
})

// —— 干净退出判定与启动期失败退出码（2026-11-14 双轴评审 H1/L1 钉外部行为）——
// 宿主薄壳 handlePanelExit（index.ts）与 bootPanel 失败径的裁决缝收口到纯函数单点：
// 这里钉的是守卫看到的外部行为契约，不是实现细节。
describe('isCleanPanelExit 干净退出判定（守卫裁决缝）', () => {
  it('code=0 是唯一的干净退出（托盘退出/退出信使完整退出链）——不触发拉回', () => {
    expect(isCleanPanelExit(0)).toBe(true)
  })

  it('null（信号终止/宿主强杀，无退出码）判异常退出——触发拉回（评审 L1）', () => {
    expect(isCleanPanelExit(null)).toBe(false)
  })

  it('非零码判异常退出——触发拉回（崩溃/强杀/启动期失败）', () => {
    expect(isCleanPanelExit(1)).toBe(false)
    expect(isCleanPanelExit(3)).toBe(false)
  })
})

describe('PANEL_BOOT_FAILED_EXIT_CODE 启动期失败专用退出码（评审 H1）', () => {
  it('是非零专用码——bootPanel 失败径以异常退出身份过守卫拉回裁决，不落回 exit 0', () => {
    expect(PANEL_BOOT_FAILED_EXIT_CODE).not.toBe(0)
    expect(Number.isInteger(PANEL_BOOT_FAILED_EXIT_CODE)).toBe(true)
    expect(isCleanPanelExit(PANEL_BOOT_FAILED_EXIT_CODE)).toBe(false)
  })

  it('与既有退出径三线分立：不与 spawn 失败的 exit(1)、干净退出的 exit(0) 撞码', () => {
    expect(PANEL_BOOT_FAILED_EXIT_CODE).not.toBe(1)
  })
})
