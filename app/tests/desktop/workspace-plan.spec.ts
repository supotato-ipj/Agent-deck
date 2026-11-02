/**
 * 桌面工作区纯逻辑矩阵（工单375，spec #369 决策 2/4/13）：配对解析、当前模式三值
 * 映射、切换决策（单飞/同态）、系统 ID 回读确认判据。先例：tests/taskbar/apps-plan.spec.ts
 * （直接喂构造输入断言输出）。桌面身份一律系统桌面 ID（GUID 原文），不落任何窗口身份。
 */
import { describe, expect, it } from 'vitest'
import {
  canPairNow,
  decideSwitch,
  firstPairing,
  modeOfCurrent,
  resolvePairing,
  switchConfirmed,
} from '../../src/main/desktop/workspace-plan'
import type { DesktopSetFacts, StoredPairing } from '../../src/main/desktop/workspace-plan'

const NORMAL = '11111111-2222-3333-4444-555555555555'
const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const THIRD = '99999999-8888-7777-6666-555555555555'

const pairing: StoredPairing = { normalId: NORMAL, agentId: AGENT }
const facts = (over: Partial<DesktopSetFacts> = {}): DesktopSetFacts => {
  const merged: DesktopSetFacts = { ids: [NORMAL, AGENT, THIRD], current: NORMAL, internalCurrent: NORMAL, ...over }
  // current 改写而 internalCurrent 未显式给 → 双源同拍（真实系统两源一致是常态）
  if (over.current !== undefined && over.internalCurrent === undefined) merged.internalCurrent = over.current
  return merged
}

describe('配对解析 resolvePairing（工单375）', () => {
  it('双侧在册 = ok，配对原样保留', () => {
    expect(resolvePairing(pairing, facts())).toEqual({ kind: 'ok', pairing })
  })

  it('未存储配对 = unpaired（等待首次启用配对）', () => {
    expect(resolvePairing(null, facts())).toEqual({ kind: 'unpaired' })
    expect(resolvePairing({ normalId: '', agentId: '' }, facts())).toEqual({ kind: 'unpaired' })
  })

  it('双侧失效 = unpaired（不吞并残留桌面的安全态）', () => {
    expect(resolvePairing(pairing, facts({ ids: [THIRD], current: THIRD }))).toEqual({ kind: 'unpaired' })
  })

  it('单侧失效 = partial：在册侧保留、失效侧清空（Agent 被删 / 普通被删两向）', () => {
    expect(resolvePairing(pairing, facts({ ids: [NORMAL, THIRD], current: NORMAL })))
      .toEqual({ kind: 'partial', pairing: { normalId: NORMAL, agentId: '' } })
    expect(resolvePairing(pairing, facts({ ids: [AGENT, THIRD], current: AGENT })))
      .toEqual({ kind: 'partial', pairing: { normalId: '', agentId: AGENT } })
  })
})

describe('当前模式映射 modeOfCurrent（三值口径，unmanaged 不是第三种模式）', () => {
  it('命中配对两侧 → normal / agent', () => {
    expect(modeOfCurrent(facts({ current: NORMAL }), pairing)).toBe('normal')
    expect(modeOfCurrent(facts({ current: AGENT }), pairing)).toBe('agent')
  })

  it('第三桌面 → unmanaged（两枚入口均不高亮的口径）', () => {
    expect(modeOfCurrent(facts({ current: THIRD, internalCurrent: THIRD }), pairing)).toBe('unmanaged')
  })

  it('未配对 → 一律 unmanaged（不冒领任何一侧）', () => {
    expect(modeOfCurrent(facts({ current: NORMAL }), null)).toBe('unmanaged')
  })

  it('双源打架（注册表与内部 COM 不一致）→ unmanaged 不提交任何一侧，下一拍重对账', () => {
    expect(modeOfCurrent(facts({ current: NORMAL, internalCurrent: AGENT }), pairing)).toBe('unmanaged')
  })

  it('单源缺席不作打架判定：内部 COM 不可读时按注册表映射', () => {
    expect(modeOfCurrent(facts({ current: AGENT, internalCurrent: null }), pairing)).toBe('agent')
  })

  it('当前不可读 → unmanaged（不猜）', () => {
    expect(modeOfCurrent(facts({ current: null }), pairing)).toBe('unmanaged')
  })
})

describe('切换决策 decideSwitch（spec 决策 4 单飞串行）', () => {
  it('在途 → in-flight（连点忽略的裁决本体）', () => {
    expect(decideSwitch({ switching: true, pairing, current: 'normal' }, 'agent')).toEqual({ action: 'in-flight' })
  })

  it('已处目标模式 → no-op（同态空转，不重发切换）', () => {
    expect(decideSwitch({ switching: false, pairing, current: 'agent' }, 'agent')).toEqual({ action: 'no-op' })
  })

  it('未配对 → switch（编排层先配对再切；targetId 空 = 配对原料待建）', () => {
    expect(decideSwitch({ switching: false, pairing: null, current: 'unmanaged' }, 'agent'))
      .toEqual({ action: 'switch', targetId: '' })
  })

  it('已配对 → switch 且携带目标桌面系统 ID', () => {
    expect(decideSwitch({ switching: false, pairing, current: 'normal' }, 'agent'))
      .toEqual({ action: 'switch', targetId: AGENT })
    expect(decideSwitch({ switching: false, pairing, current: 'unmanaged' }, 'normal'))
      .toEqual({ action: 'switch', targetId: NORMAL })
  })
})

describe('切换确认判据 switchConfirmed（只有系统桌面 ID 匹配才提交 UI）', () => {
  it('双源都命中目标 = 确认', () => {
    expect(switchConfirmed(facts({ current: AGENT, internalCurrent: AGENT }), AGENT)).toBe(true)
  })

  it('注册表未命中 = 未确认（乐观调用不认账）', () => {
    expect(switchConfirmed(facts({ current: NORMAL, internalCurrent: AGENT }), AGENT)).toBe(false)
  })

  it('内部 COM 命中但注册表未命中 = 未确认（单源不提交）', () => {
    expect(switchConfirmed(facts({ current: NORMAL, internalCurrent: AGENT }), AGENT)).toBe(false)
  })

  it('内部 COM 在场且不匹配 = 未确认；内部缺席（null）时按注册表单源确认（能力降级不卡死）', () => {
    expect(switchConfirmed(facts({ current: AGENT, internalCurrent: NORMAL }), AGENT)).toBe(false)
    expect(switchConfirmed(facts({ current: AGENT, internalCurrent: null }), AGENT)).toBe(true)
  })

  it('空目标 ID 恒不确认', () => {
    expect(switchConfirmed(facts(), '')).toBe(false)
  })
})

describe('配对原料核验与首次配对（验收①口径）', () => {
  it('canPairNow：当前 ID 可读且集合非空才可配对', () => {
    expect(canPairNow(facts())).toBe(true)
    expect(canPairNow(facts({ current: null }))).toBe(false)
    expect(canPairNow(facts({ ids: [] }))).toBe(false)
  })

  it('firstPairing：普通 = 当下所在桌面，Agent = 新建（首次为空由系统保证）', () => {
    expect(firstPairing(NORMAL, AGENT)).toEqual({ normalId: NORMAL, agentId: AGENT })
  })
})
