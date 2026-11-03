/**
 * 逐窗几何授权状态机矩阵（工单378，spec #369 决策 9/10/11）：首次用户操作复原并询问、
 * 默认/Esc 保持平铺、确认不写几何、确认后重新操作才浮动、后台自改不弹框、浮动窗再次
 * 操作需重新授权、切出撤销授权但保留浮动几何、恢复平铺收回浮动并清授权。
 * 纯函数直测（零 FFI/Electron），事件判据的机制面（前台/回声）由编排层与真机电池钉。
 */
import { describe, expect, it } from 'vitest'
import {
  acceptFloating,
  authCounts,
  beginPrompt,
  cancelAuth,
  clearFloating,
  consumeAuth,
  confirmAuth,
  createGeomAuthLedger,
  decideGeomEvent,
  enterFloating,
  floatingIds,
  floatingRectOf,
  forget,
  isFloating,
  phaseOf,
  rememberFloating,
  revokeAuth,
} from '../../src/main/desktop/geom-auth'
import type { GeomAuthLedger } from '../../src/main/desktop/geom-auth'

const R1 = { left: 0, top: 0, right: 1280, bottom: 1392 }
const R2 = { left: 300, top: 200, right: 1100, bottom: 900 }

describe('授权账基础（缺省锁定、状态迁移）', () => {
  it('空账：全部窗口 locked、非浮动', () => {
    const l = createGeomAuthLedger()
    expect(phaseOf(l, 7)).toBe('locked')
    expect(isFloating(l, 7)).toBe(false)
    expect(authCounts(l)).toEqual({ floating: 0, prompting: 0, authorized: 0 })
  })

  it('beginPrompt → 确认 → armed；确认不产生任何几何动作（纯状态迁移）', () => {
    const l = createGeomAuthLedger()
    beginPrompt(l, 7)
    expect(phaseOf(l, 7)).toBe('prompt')
    expect(authCounts(l).prompting).toBe(1)
    expect(confirmAuth(l, 7)).toBe(true)
    expect(phaseOf(l, 7)).toBe('armed')
    expect(authCounts(l)).toEqual({ floating: 0, prompting: 0, authorized: 1 })
  })

  it('非 prompt 阶段确认/取消一律 false（不越级授权）', () => {
    const l = createGeomAuthLedger()
    expect(confirmAuth(l, 7)).toBe(false)
    beginPrompt(l, 7)
    expect(cancelAuth(l, 7)).toBe(true)
    expect(phaseOf(l, 7)).toBe('locked')
    expect(confirmAuth(l, 7)).toBe(false)
  })
})

describe('事件决策：首次操作 / 后台自改 / 提示期 / 已授权（决策 10）', () => {
  it('tiled locked + 用户改 → 复原并询问；后台改 → 静默复原（不弹框）', () => {
    expect(decideGeomEvent({ phase: 'locked', floating: false, echo: false, changed: true, userGesture: true }))
      .toBe('restore-prompt')
    expect(decideGeomEvent({ phase: 'locked', floating: false, echo: false, changed: true, userGesture: false }))
      .toBe('restore-silent')
  })

  it('自身写窗回声 / 几何无变化 → 零动作（不是用户操作）', () => {
    expect(decideGeomEvent({ phase: 'locked', floating: false, echo: true, changed: true, userGesture: true }))
      .toBe('none')
    expect(decideGeomEvent({ phase: 'armed', floating: false, echo: false, changed: false, userGesture: true }))
      .toBe('none')
  })

  it('提示期（prompt）任何几何变化都复原——窗口锁在格上（确认前不得拖走一半）', () => {
    expect(decideGeomEvent({ phase: 'prompt', floating: false, echo: false, changed: true, userGesture: true }))
      .toBe('restore')
    expect(decideGeomEvent({ phase: 'prompt', floating: false, echo: false, changed: true, userGesture: false }))
      .toBe('restore')
  })

  it('tiled armed + 用户改 → 浮动；后台改 → 静默复原且授权不丢（决策 10/11）', () => {
    expect(decideGeomEvent({ phase: 'armed', floating: false, echo: false, changed: true, userGesture: true }))
      .toBe('float')
    expect(decideGeomEvent({ phase: 'armed', floating: false, echo: false, changed: true, userGesture: false }))
      .toBe('restore-silent')
  })
})

describe('浮动与授权消费（决策 11）', () => {
  it('enterFloating：记录几何、仍算浮动；授权留到本次操作静止后才消费（持续拖动不反复弹框）', () => {
    const l = createGeomAuthLedger()
    beginPrompt(l, 7)
    confirmAuth(l, 7)
    enterFloating(l, 7, R2)
    expect(isFloating(l, 7)).toBe(true)
    expect(phaseOf(l, 7)).toBe('armed') // 一次持续授权覆盖整个拖动
    expect(floatingRectOf(l, 7)).toEqual(R2)
    expect(authCounts(l)).toEqual({ floating: 1, prompting: 0, authorized: 1 })
    // 操作静止：编排层消费授权 → 下次操作需重新确认
    expect(consumeAuth(l, 7)).toBe(true)
    expect(phaseOf(l, 7)).toBe('locked')
    expect(consumeAuth(l, 7)).toBe(false)
  })

  it('浮动窗未授权用户操作 → 复原到保留的浮动几何并重新询问（不是拉回平铺）', () => {
    expect(decideGeomEvent({ phase: 'locked', floating: true, echo: false, changed: true, userGesture: true }))
      .toBe('restore-prompt')
  })

  it('浮动窗已授权用户操作 → 接受新几何（仍浮动、授权消费）；后台改 → 零动作（浮动不受平铺约束）', () => {
    expect(decideGeomEvent({ phase: 'armed', floating: true, echo: false, changed: true, userGesture: true }))
      .toBe('accept')
    expect(decideGeomEvent({ phase: 'locked', floating: true, echo: false, changed: true, userGesture: false }))
      .toBe('none')
    const l = createGeomAuthLedger()
    enterFloating(l, 7, R2)
    beginPrompt(l, 7)
    confirmAuth(l, 7)
    acceptFloating(l, 7, R1)
    expect(floatingRectOf(l, 7)).toEqual(R1)
    expect(phaseOf(l, 7)).toBe('armed') // 操作尚未结束：授权仍在
    consumeAuth(l, 7)
    expect(phaseOf(l, 7)).toBe('locked') // 静止后再次操作要重新确认
  })

  it('rememberFloating 只更新浮动窗（非浮动窗不因观察而变浮动）', () => {
    const l = createGeomAuthLedger()
    rememberFloating(l, 7, R2)
    expect(isFloating(l, 7)).toBe(false)
    l.floating.set(7, { ...R1 })
    rememberFloating(l, 7, R2)
    expect(floatingRectOf(l, 7)).toEqual(R2)
  })
})

describe('切出撤销授权、恢复平铺清账', () => {
  it('revokeAuth：prompt/armed → locked，浮动几何保留（切出保留浮动、撤销授权）', () => {
    const l = createGeomAuthLedger()
    enterFloating(l, 9, R2)
    beginPrompt(l, 7)
    confirmAuth(l, 8) // 未 prompt：false，不建账
    beginPrompt(l, 8)
    expect(revokeAuth(l).sort()).toEqual([7, 8])
    expect(phaseOf(l, 7)).toBe('locked')
    expect(phaseOf(l, 8)).toBe('locked')
    expect(isFloating(l, 9)).toBe(true)
    expect(floatingRectOf(l, 9)).toEqual(R2) // 几何不丢
  })

  it('clearFloating：按进入浮动序收回全部浮动（恢复平铺的补入顺序依据）', () => {
    const l = createGeomAuthLedger()
    enterFloating(l, 9, R2)
    enterFloating(l, 5, R1)
    expect(floatingIds(l)).toEqual([9, 5])
    expect(clearFloating(l)).toEqual([9, 5])
    expect(isFloating(l, 9)).toBe(false)
    expect(authCounts(l).floating).toBe(0)
  })

  it('forget：窗口消失时授权与浮动账一并清（同 hwnd 复用不继承旧状态）', () => {
    const l = createGeomAuthLedger()
    beginPrompt(l, 7)
    enterFloating(l, 8, R2)
    expect(forget(l, 7)).toBe(true)
    expect(forget(l, 8)).toBe(true)
    expect(forget(l, 9)).toBe(false)
    expect(l.phase.size).toBe(0)
    expect(l.floating.size).toBe(0)
  })

  it('账为空时 revoke/clear 幂等（无授权、无浮动的普通桌面语义）', () => {
    const l: GeomAuthLedger = createGeomAuthLedger()
    expect(revokeAuth(l)).toEqual([])
    expect(clearFloating(l)).toEqual([])
  })
})
