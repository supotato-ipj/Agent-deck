// 事件突发合并调度（工单475）：trailing 防抖 + 最小间隔封顶的纯调度缝。
// 断言面：静默零成本（无悬挂不触发不排程）、突发尾沿触发、风暴封顶频率、账本清结。
// 悬垂面：定时器驱动循环与 Win32 钩子投递（效果层，真机验收盖）。
import { describe, expect, it } from 'vitest'
import {
  EMPTY_PUMP_STATE,
  markEventPending,
  planEventFlush,
} from '../src/main/win-event-route'

const CFG = { quietMs: 60, minIntervalMs: 250 }

describe('planEventFlush 突发合并调度（工单475 纯调度）', () => {
  it('无悬挂事件：不触发、无排程（常驻静默期驱动循环可停表——零成本稳态）', () => {
    const plan = planEventFlush(EMPTY_PUMP_STATE, 5000, CFG)
    expect(plan.fire).toBe(false)
    expect(plan.recheckInMs).toBeNull()
    expect(plan.state.pendingSinceMs).toBeNull()
  })

  it('悬挂未满静默窗：不触发，排程到静默满时刻', () => {
    const marked = markEventPending(EMPTY_PUMP_STATE, 1000)
    const plan = planEventFlush(marked, 1030, CFG) // 到达后 30ms < quietMs 60
    expect(plan.fire).toBe(false)
    expect(plan.recheckInMs).toBe(30) // 1060 - 1030
  })

  it('静默满且无既往冲刷：触发并清悬挂、记冲刷时刻（尾沿单发——一批突发只再评估一次）', () => {
    let state = markEventPending(EMPTY_PUMP_STATE, 1000)
    state = markEventPending(state, 1020) // 同批后续事件不覆盖最老时刻
    state = markEventPending(state, 1040)
    const plan = planEventFlush(state, 1060, CFG)
    expect(plan.fire).toBe(true)
    expect(plan.state.pendingSinceMs).toBeNull()
    expect(plan.state.lastFireMs).toBe(1060)
    expect(plan.recheckInMs).toBeNull()
  })

  it('距上次冲刷不足最小间隔：静默已满也不触发，排程到间隔满（风暴封顶——最坏频率有界）', () => {
    const afterFire = { pendingSinceMs: null, lastFireMs: 5000 }
    const marked = markEventPending(afterFire, 5050) // 上一拍刚冲过（5000），50ms 后又来事件
    const plan = planEventFlush(marked, 5110, CFG) // 静默已满（60ms）但距冲刷仅 110ms < 250
    expect(plan.fire).toBe(false)
    expect(plan.recheckInMs).toBe(140) // 5000+250-5110
    expect(plan.state.pendingSinceMs).toBe(5050) // 悬挂保留
  })

  it('间隔满后补冲：悬挂事件在封顶窗内不丢（下一尝试触发并清账）', () => {
    const afterFire = { pendingSinceMs: null, lastFireMs: 5000 }
    const marked = markEventPending(afterFire, 5050)
    const plan = planEventFlush(marked, 5250, CFG) // 间隔已满（250ms）
    expect(plan.fire).toBe(true)
    expect(plan.state.pendingSinceMs).toBeNull()
    expect(plan.state.lastFireMs).toBe(5250)
  })

  it('重复询问同一账本不漂移（驱动循环可安全重入）', () => {
    const marked = markEventPending(EMPTY_PUMP_STATE, 1000)
    const a = planEventFlush(marked, 1030, CFG)
    const b = planEventFlush(a.state, 1040, CFG)
    expect(b.fire).toBe(false)
    expect(b.recheckInMs).toBe(20)
    expect(b.state).toEqual(a.state)
  })
})
