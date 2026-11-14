// 冻结告警一次裁决纯函数缝（工单479，ADR-0032）：渲染层哨兵判出冻结失能时，
// 托盘告警恰好一次——同一冻结 episode 不重复告警（哨兵发射判据已保证 renderer-frozen
// 一轮一条，本裁决再加一道防双源重复的闩），episode 由恢复（renderer-unfrozen）闭合，
// 闭合后再冻是新的一轮、可再告警。自动杀拉不在本票范围（ADR-0032 暂缓项）。
import { describe, expect, it } from 'vitest'
import { nextFreezeAlarm } from '../src/main/freeze-alarm'

describe('nextFreezeAlarm 冻结告警一次裁决', () => {
  it('全新状态收到冻结 → 告警恰好一次，闩落下', () => {
    expect(nextFreezeAlarm({ alarmed: false }, 'frozen')).toEqual({ alarm: true, state: { alarmed: true } })
  })

  it('闩已落下再收到冻结 → 不重复告警（防双源重报）', () => {
    expect(nextFreezeAlarm({ alarmed: true }, 'frozen')).toEqual({ alarm: false, state: { alarmed: true } })
  })

  it('收到恢复 → 闩抬起（本 episode 告警义务已尽），不再告警', () => {
    expect(nextFreezeAlarm({ alarmed: true }, 'unfrozen')).toEqual({ alarm: false, state: { alarmed: false } })
    expect(nextFreezeAlarm({ alarmed: false }, 'unfrozen')).toEqual({ alarm: false, state: { alarmed: false } })
  })

  it('闭合后再冻是新的一轮 → 可再告警', () => {
    const closed = nextFreezeAlarm({ alarmed: true }, 'unfrozen').state
    expect(nextFreezeAlarm(closed, 'frozen').alarm).toBe(true)
  })
})
