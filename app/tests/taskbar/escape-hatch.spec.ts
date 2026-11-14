// 逃生口触发判据（工单480，ADR-0032 韧性基线）：冻结失能档与崩溃两入口的状态机矩阵。
// 纯函数缝——哨兵存证与接管账面由宿主接线喂入，这里只裁决「开不开逃生口、还不还接管」。
// 先例同构：渲染层哨兵的 silenceVerdict（外部采数、纯函数只裁决级别）与 appbar 托管的
// planAppBarStateRestore（外部喂读回事实、纯函数只裁决退避）。真机行为面由
// 50-taskbar-carry 电池（逃生口段）覆盖。
import { describe, expect, it } from 'vitest'
import { escapeHatchDecide } from '../../src/main/taskbar/escape-hatch'
import type { EscapeHatchEntry, EscapeHatchFacts, EscapeHatchPhase } from '../../src/main/taskbar/escape-hatch'

/** 常态事实：接管在场（条带窗活着、原生栏由我托管）、用户偏好仍要接管 */
const engaged: EscapeHatchFacts = { takeoverEngaged: true, takeoverWanted: true }

/** 从 standby 出发的单步裁决（状态机的一拍） */
function decideFromStandby(entry: EscapeHatchEntry, facts: EscapeHatchFacts = engaged) {
  return escapeHatchDecide('standby', entry, facts)
}

describe('escapeHatchDecide 失能档入口（冻结）', () => {
  it('接管在场遇失能档 → 开逃生口（原生栏还原给系统）', () => {
    expect(decideFromStandby({ kind: 'frozen' })).toEqual({ next: 'escaped', action: 'restore-native' })
  })

  it('接管不在场（原生栏本就归用户/条带未建）遇失能档 → 不动作（无债可还）', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: true }
    expect(decideFromStandby({ kind: 'frozen' }, facts)).toEqual({ next: 'standby', action: 'none' })
  })

  it('已在逃生口再遇失能档 → 不动作（一轮冻结只开一次口，不重复还原）', () => {
    expect(escapeHatchDecide('escaped', { kind: 'frozen' }, engaged)).toEqual({ next: 'escaped', action: 'none' })
  })
})

describe('escapeHatchDecide 崩溃入口（渲染进程退出）', () => {
  it('非正常退出（crashed/killed/oom 等）→ 开逃生口', () => {
    expect(decideFromStandby({ kind: 'crash', cleanExit: false, windowDestroyed: false }))
      .toEqual({ next: 'escaped', action: 'restore-native' })
  })

  it('clean-exit（退出序列伴生事件）→ 不动作——正常退出走既有三路径，不是崩溃', () => {
    expect(decideFromStandby({ kind: 'crash', cleanExit: true, windowDestroyed: false }))
      .toEqual({ next: 'standby', action: 'none' })
  })

  it('面板窗已销毁 → 不动作（退出序列，既有路径已还）', () => {
    expect(decideFromStandby({ kind: 'crash', cleanExit: false, windowDestroyed: true }))
      .toEqual({ next: 'standby', action: 'none' })
  })

  it('接管不在场 → 不动作（渲染崩了自己的窗，原生栏本就归用户）', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: true }
    expect(decideFromStandby({ kind: 'crash', cleanExit: false, windowDestroyed: false }, facts))
      .toEqual({ next: 'standby', action: 'none' })
  })

  it('已在逃生口再遇崩溃 → 不动作（崩溃后不会再有心跳，债已在逃逸时立账）', () => {
    expect(escapeHatchDecide('escaped', { kind: 'crash', cleanExit: false, windowDestroyed: false }, engaged))
      .toEqual({ next: 'escaped', action: 'none' })
  })
})

describe('escapeHatchDecide 恢复入口（心跳回归，重新接管）', () => {
  it('逃生口在场遇恢复 → 还债（重新接管，面板恢复后原生栏交回我托管）', () => {
    expect(escapeHatchDecide('escaped', { kind: 'recovered' }, engaged))
      .toEqual({ next: 'standby', action: 'retake' })
  })

  it('无逃逸账（standby）遇恢复 → 不动作（没有欠债就不重接管——manual 逃逸前的健康心跳等）', () => {
    expect(escapeHatchDecide('standby', { kind: 'recovered' }, engaged))
      .toEqual({ next: 'standby', action: 'none' })
  })
})

describe('escapeHatchDecide 手动入口（热键保险丝）', () => {
  it('接管在场健康时按热键 → 开逃生口（保险丝语义：防自动检测本身失灵）', () => {
    expect(decideFromStandby({ kind: 'manual' })).toEqual({ next: 'escaped', action: 'restore-native' })
  })

  it('用户偏好已禁用接管时按热键 → 不动作（原生栏本就归用户，无债可还也不欠接管）', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: false }
    expect(decideFromStandby({ kind: 'manual' }, facts)).toEqual({ next: 'standby', action: 'none' })
  })

  it('接管不在场但偏好仍要接管时按热键 → 不动作（评审 L2 闸，与 frozen/crash 同款：条带未建无债可立）', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: true }
    expect(decideFromStandby({ kind: 'manual' }, facts)).toEqual({ next: 'standby', action: 'none' })
  })

  it('逃逸后条带已销（engaged=false）再按热键 → 仍还债（逃逸债是历史事实，还债不以条带在场为前提）', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: true }
    expect(escapeHatchDecide('escaped', { kind: 'manual' }, facts))
      .toEqual({ next: 'standby', action: 'retake' })
  })

  it('逃生口在场按热键 → 还债（再按可恢复接管——toggle 语义）', () => {
    expect(escapeHatchDecide('escaped', { kind: 'manual' }, engaged))
      .toEqual({ next: 'standby', action: 'retake' })
  })

  it('逃生口在场但偏好已翻禁用 → 只清账不重接管（用户偏好优先于热键 toggle）', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: false }
    expect(escapeHatchDecide('escaped', { kind: 'manual' }, facts))
      .toEqual({ next: 'standby', action: 'none' })
  })
})

describe('escapeHatchDecide 生命周期链（多拍往返）', () => {
  /** 把一串入口按状态机走完，收集每拍动作（宿主接线逐拍调用的形态） */
  function run(entries: EscapeHatchEntry[], facts: EscapeHatchFacts = engaged) {
    let phase: EscapeHatchPhase = 'standby'
    const actions: string[] = []
    for (const e of entries) {
      const d = escapeHatchDecide(phase, e, facts)
      phase = d.next
      actions.push(d.action)
    }
    return { phase, actions }
  }

  it('冻结→恢复→冻结→恢复：两轮失能各开一次口、各还一次债（可反复）', () => {
    const { phase, actions } = run([{ kind: 'frozen' }, { kind: 'recovered' }, { kind: 'frozen' }, { kind: 'recovered' }])
    expect(actions).toEqual(['restore-native', 'retake', 'restore-native', 'retake'])
    expect(phase).toBe('standby')
  })

  it('崩溃入口后（无心跳闭合）热键再按可恢复接管（崩溃径的还债通道）', () => {
    const { phase, actions } = run([{ kind: 'crash', cleanExit: false, windowDestroyed: false }, { kind: 'manual' }])
    expect(actions).toEqual(['restore-native', 'retake'])
    expect(phase).toBe('standby')
  })

  it('崩溃后紧接失能档：逃逸已立账，不重复还原', () => {
    const { phase, actions } = run([{ kind: 'crash', cleanExit: false, windowDestroyed: false }, { kind: 'frozen' }])
    expect(actions).toEqual(['restore-native', 'none'])
    expect(phase).toBe('escaped')
  })

  it('manual 逃逸期间面板真冻结：逃逸账吸收失能档，恢复拍仍还债', () => {
    const { phase, actions } = run([{ kind: 'manual' }, { kind: 'frozen' }, { kind: 'recovered' }])
    expect(actions).toEqual(['restore-native', 'none', 'retake'])
    expect(phase).toBe('standby')
  })

  it('接管不在场（用户偏好禁用）全入口静默：逃生口不越偏好半步', () => {
    const facts: EscapeHatchFacts = { takeoverEngaged: false, takeoverWanted: false }
    const { phase, actions } = run(
      [{ kind: 'frozen' }, { kind: 'crash', cleanExit: false, windowDestroyed: false }, { kind: 'manual' }, { kind: 'recovered' }],
      facts,
    )
    expect(actions).toEqual(['none', 'none', 'none', 'none'])
    expect(phase).toBe('standby')
  })
})

// —— 接线守卫（效果层离线不可执行，源码级钉住：restore-ledger-wiring「控制器接线」
// 同款手法——断言的顺序即行为。真机行为由 50-taskbar-carry 电池逃生口段覆盖）——
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => readFileSync(path.resolve(__dirname, '../..', rel), 'utf8')

describe('逃生口接线（工单480）：任务栏控制器（window.ts）', () => {
  const src = read('src/main/taskbar/window.ts')

  it('控制器暴露 escapeHatch 入口，裁决用接管事实自账面取（session 在场 + 用户偏好）', () => {
    expect(src).toContain("from './escape-hatch'")
    expect(src).toContain('escapeHatchDecide(')
    expect(src).toContain('takeoverEngaged: session !== null')
    expect(src).toContain('takeoverWanted: ctx.taskbar.state().enabled')
    expect(src).toMatch(/escapeHatch\(\s*entry/)
  })

  it('开逃生口 = 交还环同款次序：托盘宿主先停（setTray(false)）再 destroy（reason=escape-hatch）', () => {
    const def = src.slice(src.indexOf('const escapeHatch'))
    expect(def).toContain("destroy('escape-hatch')")
    const iTray = def.indexOf('setTray(false)')
    const iDestroy = def.indexOf("destroy('escape-hatch')")
    expect(iTray).toBeGreaterThan(0)
    expect(iTray).toBeLessThan(iDestroy)
  })

  it('重接管走既有 create 路径（不新造接管机制）', () => {
    const def = src.slice(src.indexOf('const escapeHatch'))
    expect(def).toContain('create()')
  })

  it('逃生口在场时 taskbar/changed 不自动重建条带（changed 事件常来——推荐位刷新/收编回推）', () => {
    const changed = src.slice(src.indexOf("ctx.on('taskbar/changed'"))
    const gate = changed.slice(0, changed.indexOf('enabledLatch = state.enabled'))
    expect(gate).toMatch(/escapePhase/)
  })

  it('用户显式禁用清逃生口账（偏好优先：禁用后再启用走正常接管恢复）', () => {
    const changed = src.slice(src.indexOf("ctx.on('taskbar/changed'"))
    const disableBranch = changed.slice(changed.indexOf('else if (enabledLatch)'), changed.indexOf('enabledLatch = state.enabled'))
    expect(disableBranch).toContain("destroy('disabled')")
    expect(disableBranch).toMatch(/escapePhase\s*=\s*'standby'/)
  })
})

describe('逃生口接线（工单480）：哨兵入口（panel-ipc.ts）与热键（index.ts）', () => {
  const ipc = read('src/main/panel-ipc.ts')
  const index = read('src/main/index.ts')

  it('失能档发射接逃生口入口（onFrozen 同拍喂入，武装态才会发生）', () => {
    const frozen = ipc.slice(ipc.indexOf('onFrozen:'))
    expect(frozen).toMatch(/onEscapeEntry/)
    expect(frozen).toContain("{ kind: 'frozen' }")
  })

  it('心跳闭合接恢复入口（onUnfrozen 同拍喂入）', () => {
    const unfrozen = ipc.slice(ipc.indexOf('onUnfrozen:'))
    expect(unfrozen).toMatch(/onEscapeEntry/)
    expect(unfrozen).toContain("{ kind: 'recovered' }")
  })

  it('render-process-gone 接崩溃入口：clean-exit 与窗销两桩事实宿主侧补证（判据在纯函数）', () => {
    const gone = ipc.slice(ipc.indexOf("wc.on('render-process-gone'"))
    expect(gone).toMatch(/onEscapeEntry/)
    expect(gone).toContain('cleanExit')
    expect(gone).toContain('windowDestroyed')
  })

  it('崩溃入口不受日志缺席影响（render-process-gone 处理器在 log 闸门外接线）', () => {
    const gone = ipc.indexOf("wc.on('render-process-gone'")
    const logGate = ipc.indexOf('if (!log) return')
    expect(gone).toBeGreaterThanOrEqual(0)
    expect(logGate).toBeGreaterThan(gone)
  })

  it('面板窗接线把逃生口入口交给任务栏控制器（wireHostIpc hooks.onEscapeEntry）', () => {
    const call = index.slice(index.indexOf('wireHostIpc(win, tracker, log'))
    expect(call).toContain('onEscapeEntry')
    expect(call).toContain('taskbarCtl.escapeHatch')
  })

  it('全局热键注册到任务栏控制器手动入口，退出注销（保险丝随时可达）', () => {
    expect(index).toContain('globalShortcut.register(')
    expect(index).toContain("{ kind: 'manual' }")
    expect(index).toContain('globalShortcut.unregister(')
    const iReg = index.indexOf('globalShortcut.register(')
    const iUnreg = index.indexOf('globalShortcut.unregister(')
    expect(iUnreg).toBeGreaterThan(iReg)
  })

  it('热键注册成败落存证（冲突不可达时取证有账）', () => {
    expect(index).toContain('escape-hatch-hotkey-armed')
    expect(index).toContain('escape-hatch-hotkey-denied')
  })
})
