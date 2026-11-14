// 启动反馈状态机单测（工单483，spec #472）：只断外部行为——begin 即刻可投影出 launching、
// 收敛/失败/超时三路都回到「无反馈」常态、连点不刷新起拍时刻。不测内部数据结构形状。
import { describe, expect, it } from 'vitest'
import {
  LAUNCH_FEEDBACK_TIMEOUT_MS,
  beginLaunchFeedback,
  convergeLaunchFeedback,
  expireLaunchFeedback,
  launchFeedbackOf,
  settleLaunchFeedback,
} from '../../src/renderer/launch-feedback.js'

const T0 = 1_000_000
const EXE = 'C:\\Apps\\MiniMax.exe'
const OTHER = 'C:\\Apps\\Qoder.exe'

describe('启动反馈状态机（工单483 点击 ≤1s 反馈）', () => {
  it('begin 后同一拍即可投影出 launching（点击反馈不跨 await）', () => {
    let state = beginLaunchFeedback(new Map(), EXE, T0)
    expect(launchFeedbackOf(state, EXE, T0)).toBe('launching')
    expect(launchFeedbackOf(state, EXE, T0 + 999)).toBe('launching')
  })

  it('连点不刷新起拍时刻：第二次 begin 后仍按首次点击起算超时', () => {
    let state = beginLaunchFeedback(new Map(), EXE, T0)
    state = beginLaunchFeedback(state, EXE, T0 + 40_000)
    // 距首次点击 59s 仍在反馈窗内；第二次点击若刷新起拍则此处仍 launching——判负
    expect(launchFeedbackOf(state, EXE, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS - 1)).toBe('launching')
    const expired = expireLaunchFeedback(state, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)
    expect(expired.expired).toEqual([EXE.toLowerCase()]) // 键归一（小写形，见键归一用例）
    expect(launchFeedbackOf(expired.state, EXE, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)).toBeNull()
  })

  it('未在册条目投影为 null（常态图标不携带启动中态）', () => {
    const state = beginLaunchFeedback(new Map(), EXE, T0)
    expect(launchFeedbackOf(state, OTHER, T0 + 1)).toBeNull()
    expect(launchFeedbackOf(new Map(), EXE, T0)).toBeNull()
  })

  it('目标应用窗口上栏（running）→ 收敛回常态，未就绪条目不受牵连', () => {
    let state = beginLaunchFeedback(new Map(), EXE, T0)
    state = beginLaunchFeedback(state, OTHER, T0 + 1)
    state = convergeLaunchFeedback(state, [EXE])
    expect(launchFeedbackOf(state, EXE, T0 + 2)).toBeNull()
    expect(launchFeedbackOf(state, OTHER, T0 + 2)).toBe('launching')
  })

  it('失败回执 settle 即收（图标回常态，失败文案由条带 toast 承担）', () => {
    let state = beginLaunchFeedback(new Map(), EXE, T0)
    state = settleLaunchFeedback(state, EXE)
    expect(launchFeedbackOf(state, EXE, T0 + 1)).toBeNull()
  })

  it('settle 未在册条目是无痕空操作（不凭空造出反馈态）', () => {
    const state = settleLaunchFeedback(new Map(), EXE)
    expect(launchFeedbackOf(state, EXE, T0)).toBeNull()
  })

  it('超时有界：达到上限即静默收敛（重型工具自身冷启不记账，图标不无限转）', () => {
    const state = beginLaunchFeedback(new Map(), EXE, T0)
    const before = expireLaunchFeedback(state, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS - 1)
    expect(before.expired).toEqual([])
    expect(launchFeedbackOf(before.state, EXE, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS - 1)).toBe('launching')
    const at = expireLaunchFeedback(state, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)
    expect(at.expired).toEqual([EXE.toLowerCase()])
    const after = expireLaunchFeedback(state, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS + 5_000)
    expect(after.expired).toEqual([EXE.toLowerCase()])
    expect(launchFeedbackOf(after.state, EXE, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS + 5_000)).toBeNull()
  })

  it('超时收敛只带走到期的键，未到期条目原位保留', () => {
    let state = beginLaunchFeedback(new Map(), EXE, T0)
    state = beginLaunchFeedback(state, OTHER, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS - 10)
    const { state: pruned } = expireLaunchFeedback(state, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)
    expect(launchFeedbackOf(pruned, EXE, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)).toBeNull()
    expect(launchFeedbackOf(pruned, OTHER, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)).toBe('launching')
  })

  it('默认超时预算有界且为正（常量本身是外部可依赖的收敛上界）', () => {
    expect(LAUNCH_FEEDBACK_TIMEOUT_MS).toBeGreaterThan(0)
    expect(LAUNCH_FEEDBACK_TIMEOUT_MS).toBeLessThanOrEqual(120_000)
  })

  it('exe 键归一：同一路径的大小写/斜杠形差收敛到同一键（运行条目 exe 与推荐条目 exe 来源不同——内核 normalizeExe 同款口径）', () => {
    let state = beginLaunchFeedback(new Map(), 'C:\\Apps\\MiniMax.exe', T0)
    // 运行名单给斜杠+小写形（窗口枚举与推荐富化的来源形差），收敛照常命中
    state = convergeLaunchFeedback(state, ['c:/apps/minimax.exe'])
    expect(launchFeedbackOf(state, 'C:\\Apps\\MiniMax.exe', T0 + 1)).toBeNull()
    // begin/settle/expire 全通道同键归一：小写 begin、原文 settle 也能命中
    state = beginLaunchFeedback(new Map(), 'c:/apps/qoder.exe', T0)
    state = settleLaunchFeedback(state, 'C:\\APPS\\QODER.EXE')
    expect(launchFeedbackOf(state, 'c:/apps/qoder.exe', T0 + 1)).toBeNull()
    state = beginLaunchFeedback(new Map(), 'C:\\Apps\\X.exe', T0)
    const at = expireLaunchFeedback(state, T0 + LAUNCH_FEEDBACK_TIMEOUT_MS)
    expect(at.expired).toEqual(['c:\\apps\\x.exe'])
  })
})
