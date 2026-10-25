// 最大化收栏主进程编排（工单241，spec #236）：三态机接线 + 真最大化探针 + AppBar
// 注销/重注册配对 + 浮层收拢 + 存证命名族。
//
// 接缝（本票离线可测的两处公开边界）：
//   ① 纯函数缝：shared/retract.ts 的 planBarTransition（旧态 → 新态 → 动作计划）。
//      三态迁移的动作集合是纯裁决，可穷举；效果层（Electron 控制器）离线不可测，
//      其接线要点以源码级守卫钉住（见「控制器接线」组）。
//   ② 契约缝：shared/contract.ts 的 taskbar/bar-mode 桥接事件（下发三态给条带渲染层）。
//
// 术语（GLOSSARY #246 入册）：最大化收栏 / 唤出条 / 最大化让位 / 托盘右键让位。
// 「最大化让位」= 窗给栏让位（51 电池 P2 段语境）；「最大化收栏」= 栏给窗让位——方向相反，勿混。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { planBarTransition, retractAutoHideState, normalBarAutoHideState, ABS_AUTOHIDE, ABS_ALWAYSONTOP } from '../../src/shared/retract'
import type { BarMode } from '../../src/shared/retract'

const MODES: BarMode[] = ['visible', 'maximize-retract', 'fullscreen-yield']

/** 仓库根（app/ 的上一级） */
const REPO_ROOT = path.resolve(__dirname, '../../..')
/** 递归枚举仓库内 .ts 文件（仓库根相对路径，/ 分隔） */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts')) out.push(path.relative(REPO_ROOT, full).replace(/\\/g, '/'))
  }
  return out
}
const SRC_FILES = tsFiles(path.resolve(REPO_ROOT, 'app/src'))
function srcOf(rel: string): string {
  return readFileSync(path.resolve(REPO_ROOT, rel), 'utf8')
}
/** 去注释的源码（散文提及不算用法） */
function codeOf(rel: string): string {
  return srcOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('三态迁移的动作计划（工单241 纯函数缝）', () => {
  it('常驻 → 收栏：释放工作区占位（注销 AppBar）+ 收拢浮层；条带窗不隐藏（承载形态 = 栏窗复用）', () => {
    const plan = planBarTransition('visible', 'maximize-retract')
    expect(plan.releaseAppBar).toBe(true)
    expect(plan.claimAppBar).toBe(false)
    expect(plan.closePopups).toBe(true)
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract'])
  })

  it('收栏 → 常驻：重注册 AppBar（占位恢复）+ 重协商；不重复隐藏窗；存证 taskbar-retract-lifted', () => {
    const plan = planBarTransition('maximize-retract', 'visible')
    expect(plan.claimAppBar).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted'])
  })

  it('常驻 → 全屏让位：整窗退场（隐藏）+ 收拢浮层；存证沿用既有 taskbar-yield 名', () => {
    const plan = planBarTransition('visible', 'fullscreen-yield')
    expect(plan.hideWindow).toBe(true)
    expect(plan.showWindow).toBe(false)
    expect(plan.closePopups).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.claimAppBar).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield'])
  })

  it('全屏让位 → 常驻：整窗复现；存证沿用既有 taskbar-yield-lifted 名', () => {
    const plan = planBarTransition('fullscreen-yield', 'visible')
    expect(plan.showWindow).toBe(true)
    expect(plan.hideWindow).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted'])
  })

  it('全屏让位 → 收栏：窗复现 + 释放占位；两族存证各一条（先退出旧态、再进入新态）', () => {
    const plan = planBarTransition('fullscreen-yield', 'maximize-retract')
    expect(plan.showWindow).toBe(true)
    expect(plan.releaseAppBar).toBe(true)
    expect(plan.closePopups).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted', 'taskbar-retract'])
  })

  it('收栏 → 全屏让位：整窗退场 + 占位恢复（让位态占位生效，既有语义不变）', () => {
    const plan = planBarTransition('maximize-retract', 'fullscreen-yield')
    expect(plan.hideWindow).toBe(true)
    expect(plan.claimAppBar).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted', 'taskbar-yield'])
  })

  it('同态 → 同态：零动作、零存证（幂等——每拍轮询不重复落账）', () => {
    for (const mode of MODES) {
      const plan = planBarTransition(mode, mode)
      expect(plan).toEqual({
        releaseAppBar: false,
        engageAutoHide: false,
        clearAutoHide: false,
        claimAppBar: false,
        hideWindow: false,
        showWindow: false,
        closePopups: false,
        evidence: [],
        // 账面目标 = 迁移前账面（缺省从档位推断：收栏档在账，其余未收）
        targetWorkspaceRetracted: mode === 'maximize-retract',
      })
    }
  })

  it('E4 粘性：收栏态不因「占位已释放→最大化窗覆盖整屏」的副作用而翻成让位（真最大化优先，归 resolveBarMode）', () => {
    // 迁移计划自身不重判档位：收栏 → 收栏恒零动作（不重复注销/重注册 AppBar）
    const plan = planBarTransition('maximize-retract', 'maximize-retract')
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.claimAppBar).toBe(false)
    expect(plan.evidence).toEqual([])
  })

  it('不变量：工作区占位只在收栏态释放（其余两态占位必须生效），任一迁移恰有一侧为真', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        const plan = planBarTransition(prev, next)
        if (prev === next) continue
        expect(plan.releaseAppBar, `${prev} → ${next}`).toBe(next === 'maximize-retract')
        expect(plan.claimAppBar, `${prev} → ${next}`).toBe(next !== 'maximize-retract')
        expect(plan.releaseAppBar !== plan.claimAppBar, `${prev} → ${next}`).toBe(true)
      }
    }
  })
})

describe('全屏让位与分屏会话解耦（工单271，spec #267）：工作区收栏理由 × 栏面呈现', () => {
  /** 迁移上下文的简写（工单271 第三参：工作区账面 + 理由仍持有） */
  const ctx271 = (workspaceRetracted: boolean, retractHeld: boolean) => ({ workspaceRetracted, retractHeld })

  it('收栏 → 全屏让位（分屏会话仍持有理由）：只改栏面——占位保持释放、托管不中断（零 claim/restore），存证仅 yield 族（无 retract-lifted）', () => {
    const plan = planBarTransition('maximize-retract', 'fullscreen-yield', ctx271(true, true))
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.claimAppBar).toBe(false)
    expect(plan.engageAutoHide).toBe(false)
    expect(plan.clearAutoHide).toBe(false)
    expect(plan.hideWindow).toBe(true)
    expect(plan.closePopups).toBe(true)
    // 「栏面被全屏覆盖」与「分屏会话结束」在存证流上可分：覆盖只落 yield、不落 retract-lifted
    expect(plan.evidence).toEqual(['taskbar-yield'])
  })

  it('全屏让位 → 收栏（工作区仍在收栏账上，退出覆盖会话仍存续）：只改栏面——不重复释放/置位（幂等），存证仅 yield-lifted', () => {
    const plan = planBarTransition('fullscreen-yield', 'maximize-retract', ctx271(true, true))
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.claimAppBar).toBe(false)
    expect(plan.engageAutoHide).toBe(false)
    expect(plan.clearAutoHide).toBe(false)
    expect(plan.showWindow).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted'])
  })

  it('全屏让位 → 常驻（覆盖期间会话已结束、无其他理由）：按既有路径复原——重注册占位 + 复原置位 + retract-lifted 存证', () => {
    const plan = planBarTransition('fullscreen-yield', 'visible', ctx271(true, false))
    expect(plan.claimAppBar).toBe(true)
    expect(plan.clearAutoHide).toBe(true)
    expect(plan.showWindow).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted', 'taskbar-retract-lifted'])
  })

  it('常驻 → 收栏（会话理由建立，账面未收）：照常释放 + 置位——与最大化理由同效果层（理由维度不改变进收栏的动作）', () => {
    const plan = planBarTransition('visible', 'maximize-retract', ctx271(false, true))
    expect(plan.releaseAppBar).toBe(true)
    expect(plan.engageAutoHide).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-retract'])
  })

  it('全屏让位（占位生效中，无会话进入的覆盖）→ 收栏（覆盖期间会话建立后退出全屏）：此刻才释放占位 + 置位（工作区账面驱动，非档位推断）', () => {
    const plan = planBarTransition('fullscreen-yield', 'maximize-retract', ctx271(false, true))
    expect(plan.releaseAppBar).toBe(true)
    expect(plan.engageAutoHide).toBe(true)
    expect(plan.showWindow).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-yield-lifted', 'taskbar-retract'])
  })

  it('同态冻结：覆盖期间理由消失或重建（yield→yield）零动作——工作区复原只发生在退出覆盖的既有路径（不反复复原）', () => {
    for (const retractHeld of [false, true]) {
      const plan = planBarTransition('fullscreen-yield', 'fullscreen-yield', ctx271(true, retractHeld))
      expect(plan).toEqual({
        releaseAppBar: false, engageAutoHide: false, clearAutoHide: false, claimAppBar: false,
        hideWindow: false, showWindow: false, closePopups: false, evidence: [],
        // 冻结 = 账面原样保持（闸门失格的交割例外见下一组——本组理由自然消失不交割）
        targetWorkspaceRetracted: true,
      })
    }
  })

  it('无会话旧口径逐字不变：缺省输入与显式一致上下文在全部 3×3 迁移上等价（既有 P6/P7 语义不回归）', () => {
    // 一致上下文：收栏档态账面必在收（不变量①——占位只在收栏态释放，效果层产不出
    // 「mode=收栏 而账面=未收」的组合）；其余档账面未收、理由不持有。
    for (const prev of MODES) {
      for (const next of MODES) {
        const consistent = ctx271(prev === 'maximize-retract', false)
        expect(planBarTransition(prev, next, consistent), `${prev}→${next}`)
          .toEqual(planBarTransition(prev, next))
      }
    }
  })

  it('组合矩阵不变量（mode × 工作区账面 × 理由持有）：置位与释放严格成对；retract 族存证随工作区面、yield 族随栏面；覆盖不触发工作区复原', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        for (const workspaceRetracted of [false, true]) {
          for (const retractHeld of [false, true]) {
            // 矛盾上下文跳过（收栏档态账面必在收——不变量①，效果层产不出该组合）
            if (prev === 'maximize-retract' && !workspaceRetracted) continue
            const plan = planBarTransition(prev, next, ctx271(workspaceRetracted, retractHeld))
            const tag = `${prev}→${next} 账=${workspaceRetracted} 理由=${retractHeld}`
            // 账面目标单一公式（工单271 评审收口①）：迁移拍 target = wantRetracted
            // （收栏档，或让位档上收栏→让位的理由接续）——效果层原样落账的唯一来源
            if (prev !== next) {
              expect(plan.targetWorkspaceRetracted, tag).toBe(
                next === 'maximize-retract'
                  || (next === 'fullscreen-yield' && prev === 'maximize-retract' && retractHeld),
              )
            }
            // 置位/释放成对（同一次工作区交割，不留半套动作）
            expect(plan.engageAutoHide, tag).toBe(plan.releaseAppBar)
            // retract 族存证 = 工作区面交割；yield 族 = 栏面交割（与会话无关）
            const wsReleased = plan.evidence.includes('taskbar-retract')
            const wsRestored = plan.evidence.includes('taskbar-retract-lifted')
            expect(plan.releaseAppBar, tag).toBe(wsReleased)
            expect(plan.clearAutoHide, tag).toBe(wsRestored)
            expect(plan.evidence.includes('taskbar-yield'), tag).toBe(next === 'fullscreen-yield' && prev !== next)
            expect(plan.evidence.includes('taskbar-yield-lifted'), tag).toBe(prev === 'fullscreen-yield' && prev !== next)
            // 全屏覆盖只改栏面：收栏进覆盖且理由仍持有 ⇒ 绝不 claim/restore（P6 的反面钉死）
            if (prev === 'maximize-retract' && next === 'fullscreen-yield' && retractHeld) {
              expect(plan.claimAppBar, tag).toBe(false)
              expect(plan.clearAutoHide, tag).toBe(false)
            }
            // 复原只发自工作区账面在收的情况（账面未收时零复原）；占位重注册只在
            // 真实迁移到非收栏态时提（同态零动作是既有不变量）
            if (!workspaceRetracted) {
              expect(plan.clearAutoHide, tag).toBe(false)
              expect(plan.claimAppBar, tag).toBe(prev !== next && next !== 'maximize-retract')
            }
          }
        }
      }
    }
  })
})

describe('同态让位拍的闸门失格交割（工单271 评审收口②，spec #267 用户故事 27）', () => {
  /** 上下文简写：账面 + 理由持有 + 闸门失格（gateDisqualified 由调用方经 retractGateDisqualified 采出） */
  const ctxGate = (workspaceRetracted: boolean, retractHeld: boolean, gateDisqualified: boolean) =>
    ({ workspaceRetracted, retractHeld, gateDisqualified })

  it('覆盖期间关共用开关（账在收、闸门失格）：工作区面当场交割——claim+restore+retract-lifted、账面清、零栏面动作', () => {
    // 让位档不受开关闸（既有口径）⇒ 档位同态冻结在让位；但用户故事 27 要求关开关后
    // 工作区立即恢复——交割只发生在工作区面（占位重注册 + 托管复原），栏面显隐/浮层零动作
    const plan = planBarTransition('fullscreen-yield', 'fullscreen-yield', ctxGate(true, false, true))
    expect(plan.claimAppBar).toBe(true)
    expect(plan.clearAutoHide).toBe(true)
    expect(plan.releaseAppBar).toBe(false)
    expect(plan.engageAutoHide).toBe(false)
    expect(plan.hideWindow).toBe(false)
    expect(plan.showWindow).toBe(false)
    expect(plan.closePopups).toBe(false)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted'])
    expect(plan.targetWorkspaceRetracted).toBe(false)
  })

  it('降级档失格同待遇（两道闸门任一即交割；理由持有位不参与本裁决）', () => {
    const plan = planBarTransition('fullscreen-yield', 'fullscreen-yield', ctxGate(true, true, true))
    expect(plan.claimAppBar).toBe(true)
    expect(plan.clearAutoHide).toBe(true)
    expect(plan.evidence).toEqual(['taskbar-retract-lifted'])
    expect(plan.targetWorkspaceRetracted).toBe(false)
  })

  it('账面未收的同态失格拍零动作（无账可交——不重复交割）', () => {
    const plan = planBarTransition('fullscreen-yield', 'fullscreen-yield', ctxGate(false, false, true))
    expect(plan).toEqual({
      releaseAppBar: false, engageAutoHide: false, clearAutoHide: false, claimAppBar: false,
      hideWindow: false, showWindow: false, closePopups: false, evidence: [],
      targetWorkspaceRetracted: false,
    })
  })

  it('收栏档同态撞闸门失格不交割（resolveBarMode 两道闸门后产不出收栏档——范围钉在 fullscreen-yield）', () => {
    const plan = planBarTransition('maximize-retract', 'maximize-retract', ctxGate(true, true, true))
    expect(plan.claimAppBar).toBe(false)
    expect(plan.clearAutoHide).toBe(false)
    expect(plan.evidence).toEqual([])
    expect(plan.targetWorkspaceRetracted).toBe(true)
  })

  it('交割后的退出覆盖拍幂等：账已清（target=false）→ 再遇闸门失格同态拍零动作；退出覆盖走既有路径单次复原', () => {
    // 同态失格拍（账已清）→ 零动作
    const again = planBarTransition('fullscreen-yield', 'fullscreen-yield', ctxGate(false, false, true))
    expect(again.evidence).toEqual([])
    // 退出覆盖（会话已结束、账已清）：既有复原路径——claim 空转（已注册）、restore 不重复
    const exit = planBarTransition('fullscreen-yield', 'visible', ctxGate(false, false, false))
    expect(exit.clearAutoHide).toBe(false)
    expect(exit.showWindow).toBe(true)
    expect(exit.evidence).toEqual(['taskbar-yield-lifted'])
  })
})

describe('原生栏托管（工单260，spec #258）：收栏置位 ABS_AUTOHIDE 的迁移计划', () => {
  it('进入收栏：置位原生栏自动隐藏（engageAutoHide）——与注销占位同拍、与唤出条同生命周期', () => {
    for (const prev of ['visible', 'fullscreen-yield'] as BarMode[]) {
      const plan = planBarTransition(prev, 'maximize-retract')
      expect(plan.engageAutoHide, `${prev} → maximize-retract`).toBe(true)
      expect(plan.clearAutoHide, `${prev} → maximize-retract`).toBe(false)
    }
  })

  it('退出收栏：复原原生栏自动隐藏（clearAutoHide）——解除最大化和被全屏压过两路都算退', () => {
    for (const next of ['visible', 'fullscreen-yield'] as BarMode[]) {
      const plan = planBarTransition('maximize-retract', next)
      expect(plan.clearAutoHide, `maximize-retract → ${next}`).toBe(true)
      expect(plan.engageAutoHide, `maximize-retract → ${next}`).toBe(false)
    }
  })

  it('非收栏迁移不碰自动隐藏（仅收栏态置位，非收栏时段系统行为与现状一致）', () => {
    const a = planBarTransition('visible', 'fullscreen-yield')
    const b = planBarTransition('fullscreen-yield', 'visible')
    expect(a.engageAutoHide || a.clearAutoHide).toBe(false)
    expect(b.engageAutoHide || b.clearAutoHide).toBe(false)
  })

  it('同态零动作含自动隐藏（250ms 每拍轮询不重复置位/复原）', () => {
    for (const mode of MODES) {
      const plan = planBarTransition(mode, mode)
      expect(plan.engageAutoHide).toBe(false)
      expect(plan.clearAutoHide).toBe(false)
    }
  })

  it('不变量：置位恰在进入收栏、复原恰在退出收栏——与占位注销严格同拍（释放占位不释放保留带＝白做）', () => {
    for (const prev of MODES) {
      for (const next of MODES) {
        if (prev === next) continue
        const plan = planBarTransition(prev, next)
        expect(plan.engageAutoHide, `${prev} → ${next}`).toBe(next === 'maximize-retract')
        expect(plan.clearAutoHide, `${prev} → ${next}`).toBe(prev === 'maximize-retract')
        expect(plan.engageAutoHide, `${prev} → ${next}`).toBe(plan.releaseAppBar)
      }
    }
  })
})

describe('收栏置位的目标 appbar 状态（工单260 值函数，thide RAII 蓝本）', () => {
  it('保留用户的 ALWAYSONTOP 位、加 ABS_AUTOHIDE（spike 基线 state 0 → 置 1：1392→1440 的实测序列）', () => {
    expect(retractAutoHideState(0)).toBe(ABS_AUTOHIDE)
    expect(retractAutoHideState(ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
  })

  it('用户本已开启自动隐藏：置位为无操作（结果不变——记账照走、复原照走，逻辑不特判）', () => {
    expect(retractAutoHideState(ABS_AUTOHIDE)).toBe(ABS_AUTOHIDE)
    expect(retractAutoHideState(ABS_AUTOHIDE | ABS_ALWAYSONTOP)).toBe(ABS_AUTOHIDE | ABS_ALWAYSONTOP)
  })

  it('ABS_* 常量与 Win32 shellapi 对齐（探针同款：AUTOHIDE=0x1 ALWAYSONTOP=0x2）', () => {
    expect(ABS_AUTOHIDE).toBe(0x1)
    expect(ABS_ALWAYSONTOP).toBe(0x2)
  })
})

describe('普通栏态的清位目标（ADR-0016 双缺陷复审 Q1=A 值函数）', () => {
  it('清 AUTOHIDE、保留 ALWAYSONTOP——与收栏置位同一份用户原状态派生的另一目标', () => {
    expect(normalBarAutoHideState(0)).toBe(0)
    expect(normalBarAutoHideState(ABS_ALWAYSONTOP)).toBe(ABS_ALWAYSONTOP)
    expect(normalBarAutoHideState(ABS_AUTOHIDE)).toBe(0)
    expect(normalBarAutoHideState(ABS_AUTOHIDE | ABS_ALWAYSONTOP)).toBe(ABS_ALWAYSONTOP)
  })

  it('与收栏置位互逆：两目标只差 AUTOHIDE 一位（切换不产生第三种状态）', () => {
    for (const user of [0, ABS_AUTOHIDE, ABS_ALWAYSONTOP, ABS_AUTOHIDE | ABS_ALWAYSONTOP]) {
      expect(retractAutoHideState(user) ^ normalBarAutoHideState(user)).toBe(ABS_AUTOHIDE)
    }
  })

  it('用户本已开着自动隐藏：清位是**有动作**的（与收栏置位的「无操作」相反，不特判）', () => {
    expect(normalBarAutoHideState(ABS_AUTOHIDE)).toBe(0)
    expect(normalBarAutoHideState(ABS_AUTOHIDE | ABS_ALWAYSONTOP)).toBe(ABS_ALWAYSONTOP)
  })
})

describe('迁移计划只有一份实现（单一纯模块口径，同工单237：主进程侧只做转发导出）', () => {
  it('实现本体在 shared/retract.ts，别处零出现', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export\s+function\s+planBarTransition\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
  })
})

describe('真最大化探针（工单241：IsZoomed 族真最大化样式）', () => {
  const YIELD_SRC = 'app/src/main/taskbar/yield.ts'

  it('探针绑定 user32 的 IsZoomed，真值直接喂进 zoomed 位（不是矩形覆盖法的推断）', () => {
    const text = srcOf(YIELD_SRC)
    expect(text).toMatch(/IsZoomed/)
    expect(text).toMatch(/zoomed:\s*Boolean\(/)
  })

  it('探针不引新具名 struct（koffi 具名类型进程级单登，#153 教训：撞名即崩）', () => {
    const structs = srcOf(YIELD_SRC).match(/koffi\.struct\('[^']+'/g) ?? []
    expect(structs).toEqual(["koffi.struct('TASKBAR_YIELD_RECT'"])
  })

  it('不用 GetWindowPlacement（更重，要 struct）/ WS_MAXIMIZE 样式位（与贴靠语义不一致）', () => {
    for (const rel of SRC_FILES) {
      // 注释不参与判定（散文提及「为什么不用」不算用法）
      const code = srcOf(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      expect(code.includes('GetWindowPlacement'), rel).toBe(false)
      expect(code.includes('WS_MAXIMIZE'), rel).toBe(false)
      expect(code.includes('GWL_STYLE'), rel).toBe(false)
    }
  })

  it('判定仍归 resolveBarMode 单一裁决（探针只供事实，不自判两态关系）', () => {
    const text = srcOf(YIELD_SRC)
    // 探针只负责取事实：矩形/类名/进程/真最大化四件，不出现档位裁决
    expect(text).not.toMatch(/maximize-retract|fullscreen-yield/)
  })
})

describe('控制器接线（工单241 三态机；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const ctrl = srcOf(CTRL)
  const code = codeOf(CTRL)

  it('档位裁决单一来源：控制器调 resolveBarMode，不自判两态关系', () => {
    expect(code).toMatch(/resolveBarMode\(/)
    expect(code).not.toMatch(/coversScreenRect/)
    // 不自己拿真最大化位做判断（只允许进存证载荷）
    expect(code).not.toMatch(/if\s*\(\s*probe\.zoomed/)
    expect(code).not.toMatch(/probe\.zoomed\s*===/)
  })

  it('收栏动作成对：释放占位注销 AppBar + 恢复时重注册并重协商', () => {
    expect(code).toMatch(/removeAppBar\(/)
    expect(code).toMatch(/registerAppBar\(/)
    expect(code).toMatch(/renegotiate\(/)
  })

  it('浮层收拢走单一清单（popupHosts 单遍历——不另起一份浮层名单）', () => {
    // 收层一处（h.close）；dispose 一处是销毁清算（另一语义，不算收层）
    expect(code.match(/for \(const h of popupHosts\) h\.close\(/g)?.length ?? 0).toBe(1)
  })

  it('存证命名族：收栏/恢复落 taskbar-retract / taskbar-retract-lifted（名在纯模块，控制器照单落盘）', () => {
    const plan = srcOf('app/src/shared/retract.ts')
    expect(plan).toMatch(/'taskbar-retract'/)
    expect(plan).toMatch(/'taskbar-retract-lifted'/)
    expect(code).toMatch(/for \(const type of plan\.evidence\)/)
  })

  it('轮询与全屏让位共用 250ms 节奏（单一 YIELD_POLL_MS，只有一处轮询用它）', () => {
    expect(code).toMatch(/const YIELD_POLL_MS = 250/)
    expect(code.match(/\bYIELD_POLL_MS\b/g)?.length ?? 0).toBe(2) // 定义 + 轮询一处（TRAY_YIELD_POLL_MS 是另一档）
  })

  it('降级档禁用收栏：注册失败置降级位，裁决输入取该位', () => {
    expect(code).toMatch(/appBarDegraded = true/)
    expect(code).toMatch(/appBarDegraded: s\.appBarDegraded/)
  })

  it('收栏态不动条带几何（唤出条要贴屏底；条带矩形与协商矩形保持同位，回正守卫不打架）', () => {
    // 档位迁移只做「占位 / 显隐 / 浮层 / 下发」四类动作，不碰窗口位置
    const machine = code.slice(code.indexOf('applyBarMode'), code.indexOf('applyBarMode') + 3000)
    expect(machine).not.toMatch(/setBounds|setPosition/)
  })

  it('自家浮层夺前台不翻收栏档（工单253）：在场事实喂进裁决，且带上当前档位', () => {
    // 在场事实取六面浮层的开合事件（同一通道 taskbar/popup-state——载体是唯一收口）
    expect(code).toMatch(/ctx\.on\('taskbar\/popup-state'/)
    // 裁决输入带「自家浮层在场」与「当前档位」两个位（纯函数侧据此判「保持」）
    expect(code).toMatch(/ownOverlayPresent:\s*openOverlayFamilies\.size > 0/)
    expect(code).toMatch(/prevMode:\s*s\.mode/)
  })

  it('浮层在场集合随浮层收层/销窗清账（工单253：不在场的浮层不得钉住档位）', () => {
    // 载体收层与销窗都发「浮层不在场」事实（popup.ts 是六面唯一收口）
    const popup = srcOf('app/src/main/taskbar/popup.ts')
    expect(popup).toMatch(/taskbar\/popup-state'[^)]*open: false/)
    // 控制器退场时退订该订阅（不留悬挂监听）
    expect(code).toMatch(/offPopupState\(\)/)
  })
})

describe('三态下发契约（工单241：主进程 → 条带渲染层）', () => {
  it('taskbar/bar-mode 在内核桥接事件表登记（载荷含档位与迁移原因）', () => {
    const contract = srcOf('app/src/shared/contract.ts')
    expect(contract).toMatch(/export interface TaskbarBarModeState/)
    expect(contract).toMatch(/'taskbar\/bar-mode':\s*TaskbarBarModeState/)
  })

  it('ctx 事件声明齐备（cordis.d.ts——ctx.emit 的类型口）', () => {
    const d = srcOf('app/src/main/cordis.d.ts')
    expect(d).toMatch(/'taskbar\/bar-mode':\s*\(payload: TaskbarBarModeState\) => void/)
  })

  it('条带窗订阅该事件并据此让栏面退场（收栏态栏面隐去、热区清空）', () => {
    const renderer = srcOf('app/src/renderer/taskbar.ts')
    expect(renderer).toMatch(/'taskbar\/bar-mode'/)
    expect(renderer).toMatch(/data-bar-mode/)
    const html = srcOf('app/src/renderer/taskbar.html')
    expect(html).toMatch(/data-bar-mode="maximize-retract"/)
  })

  it('收栏前缓存各组 pill 矩形（唤出条几何来源——裁决 (b)：渲染层自算，主进程不回读几何帧）', () => {
    const renderer = srcOf('app/src/renderer/taskbar.ts')
    expect(renderer).toMatch(/summonPillCache/)
    // 五组齐（开始/推荐/应用/右组/显示桌面细条——显示桌面细条在最右端各出一条）
    for (const group of ['start', 'recs', 'apps', 'right', 'showdesk']) {
      expect(renderer, `缺组 ${group}`).toMatch(new RegExp(`group:\\s*'${group}'`))
    }
    // 收栏态不得覆写缓存（栏面退场量不到矩形——缓存要留收栏前最后一帧）
    expect(renderer).toMatch(/if \(barMode === 'maximize-retract'\) return/)
  })
})

describe('原生栏托管接线（工单260；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const AUTOHIDE = 'app/src/main/taskbar/appbar-autohide.ts'
  const APPBAR = 'app/src/main/taskbar/appbar.ts'
  const code = codeOf(CTRL)

  it('置位/复原随迁移计划执行：applyBarMode 认 plan.engageAutoHide / plan.clearAutoHide，不自判收栏', () => {
    expect(code).toMatch(/if \(plan\.engageAutoHide\)/)
    expect(code).toMatch(/if \(plan\.clearAutoHide\)/)
    // 置位与注销占位同段（releaseAppBar 的同拍纪律——engage/restore 两钩子都在占位段内）
    const m = code.match(/if \(plan\.releaseAppBar[\s\S]{0,1200}?if \(plan\.clearAutoHide\)/)
    expect(m).toBeTruthy()
  })

  it('进出收栏两过渡都带宿主矩形复核（工单293，spec #292 用户故事 9：恢复后自绘栏不漂移）——enter 与 exit 同判据（stripPhysRect 底边 vs 屏底），exit 复核钉在 clearAutoHide 之后（先清位还原带、再核矩形）', () => {
    expect(code).toMatch(/if \(plan\.engageAutoHide\) verifyStripBottom\(s, 'retract-enter'\)/)
    expect(code).toMatch(/if \(plan\.clearAutoHide\) verifyStripBottom\(s, 'retract-exit'\)/)
    // exit 复核在 clearRetractAutoHide 之后（band 已还原才核得住「贴屏底」）
    const m = code.match(/if \(plan\.clearAutoHide\) clearRetractAutoHide\(log, reason\)[\s\S]{0,600}?if \(plan\.clearAutoHide\) verifyStripBottom\(s, 'retract-exit'\)/)
    expect(m).toBeTruthy()
  })

  it('销窗路径（destroy）也复原：面板退出/禁用在收栏态时账不悬空（还原路径①扩展）', () => {
    expect(code).toMatch(/restoreTakeoverAutoHide\(log, reason\)/)
    // destroy 内的复原先于会话判空（与 hidNative 还原同一位置纪律——账不随窗生灭）
    const m = code.match(/const destroy = \(reason: string\) => \{[\s\S]{0,600}?restoreTakeoverAutoHide\(log, reason\)/)
    expect(m).toBeTruthy()
    // appbar 复原**先于可见性复原**（顺序即行为，与守卫/守护径同源——restore-ledger-wiring
    // 的钉序理由）：置位态下 WS_VISIBLE 位可被 explorer 翻开，可见性判据会被「已可见」
    // 骗成静默；先卸置位，可见性复原才做真工作（51 电池 P9 的面板侧径）
    const d = code.slice(code.indexOf('const destroy'))
    const iAppbar = d.indexOf('restoreTakeoverAutoHide(log, reason)')
    const iShow = d.indexOf('showNativeTaskbar(log, reason)')
    expect(iAppbar).toBeGreaterThanOrEqual(0)
    expect(iShow).toBeGreaterThanOrEqual(0)
    expect(iAppbar).toBeLessThan(iShow)
  })

  it('置位/复原的 RAII 实现单一实现住在 appbar-autohide.ts（记账 + 读回验证 + 退避复原）', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/export function engageTakeoverAutoHide\(/)
    expect(src).toMatch(/export function restoreTakeoverAutoHide\(/)
    expect(src).toMatch(/retractAutoHideState\(/) // 目标值来自纯函数（不自算位运算）
    expect(src).toMatch(/planAppBarStateRestore\(/) // 退避裁决走 native-restore 纯函数
    expect(src).toMatch(/getAppBarState\(\)/) // 读回验证以视图事实为准
    // setAppBarState 调用点闭集（工单261 扩）：路径① RAII（appbar-autohide）+ 路径②③
    // 落盘账复原（appbar-ledger——守卫/守护从账读复原目标，票面「还原账全路径扩展」）。
    // 闭集之外零调用：SETSTATE 是系统级状态写，不许第三处自行动笔。
    const callers: string[] = []
    for (const rel of SRC_FILES) {
      const c = codeOf(rel).replace(/export function setAppBarState\([^)]*\): void \{/, '')
      if (/setAppBarState\(/.test(c)) callers.push(rel)
    }
    expect(callers.sort()).toEqual([AUTOHIDE, 'app/src/main/taskbar/appbar-ledger.ts'].sort())
  })

  it('koffi 绑定：ABM_GETSTATE/ABM_SETSTATE 常量与封装在 appbar.ts（shellapi 官方值 4/10）', () => {
    const src = codeOf(APPBAR)
    expect(src).toMatch(/ABM_GETSTATE = 4/)
    expect(src).toMatch(/ABM_SETSTATE = 10/)
    expect(src).toMatch(/export function getAppBarState\(\)/)
    expect(src).toMatch(/export function setAppBarState\(/)
  })

  it('置位值函数经主进程侧转发导出（单一实现纪律，同工单237）', () => {
    const fwd = srcOf('app/src/main/taskbar/retract.ts')
    expect(fwd).toMatch(/\bretractAutoHideState\b/)
    expect(fwd).toMatch(/\bABS_AUTOHIDE\b/)
    expect(fwd).toMatch(/\bABS_ALWAYSONTOP\b/)
  })
})

describe('原生栏重申轮询接线（工单262，spec #258；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const AUTOHIDE = 'app/src/main/taskbar/appbar-autohide.ts'
  const WATCH = 'app/src/main/taskbar/native-watch.ts'
  const NATIVE = 'app/src/main/taskbar/native.ts'
  const code = codeOf(CTRL)

  it('值守起止随接管生灭（双缺陷复审 Q1/Q2 改段）：create 即建接管并起表、destroy 停表；档位迁移不再起停轮询（普通态的清位同样会被 explorer 重启冲掉）', () => {
    // 起表与建立接管同处（create），先建接管再起表：重申机器以「刚清位过的当拍事实」立基线
    const m = code.match(/engageTakeoverAutoHide\(log\)\s*startNativeWatch\(s\)/)
    expect(m).toBeTruthy()
    // 档位迁移里不得再起停轮询（旧「随工作区收栏账起停」语义作废）
    expect(code).not.toMatch(/if \(s\.workspaceRetracted\) startNativeWatch\(s\)/)
    expect(code).not.toMatch(/else stopNativeWatch\(s\)/)
  })

  it('销窗路径（destroy）停表：收栏态下禁用/退役/退出不悬空轮询（同 hidNative 复原的位置纪律）', () => {
    const m = code.match(/const destroy = \(reason: string\) => \{[\s\S]{0,600}?stopNativeWatch/)
    expect(m).toBeTruthy()
  })

  it('外部先销窗路径（closed）同样停表（迟到的 interval 不许悬空——同 stopYieldPoll 位置纪律）', () => {
    const m = code.match(/stopYieldPoll\(s\)[\s\S]{0,300}?stopNativeWatch\(s\)/)
    expect(m).toBeTruthy()
  })

  it('一拍裁决照单执行：hide → hideNativeTaskbar、autoHide 非空 → reassertTakeoverAutoHide、归因落 taskbar-native-reassert 存证', () => {
    expect(code).toMatch(/if \(decision\.hide\) hideNativeTaskbar\(log\)/)
    expect(code).toMatch(/if \(decision\.autoHide !== null\) reassertTakeoverAutoHide\(log\)/)
    // 目标档位随工作区收栏账（在账 = 置位、账清 = 清位）
    expect(code).toMatch(/s\.workspaceRetracted \? 'autohide-on' : 'autohide-off'/)
    expect(code).toMatch(/'taskbar-native-reassert'/)
  })

  it('轮询节奏单一常量（NATIVE_WATCH_POLL_MS，票面 1–2s 低频档；纯值在 native-watch.ts）', () => {
    expect(code).toMatch(/setInterval\(pollNativeWatch, NATIVE_WATCH_POLL_MS\)/)
    expect(srcOf(WATCH)).toMatch(/export const NATIVE_WATCH_POLL_MS = 1000/)
  })

  it('重申住在 appbar-autohide.ts：账不动（不新记 userState），两档目标都从账面派生，无账按完整接管走', () => {
    const src = codeOf(AUTOHIDE)
    expect(src).toMatch(/export function reassertTakeoverAutoHide\(/)
    // 目标值仍从账面 userState 派生（置位档 / 清位档两条都由纯函数给出）
    expect(src).toMatch(/retractAutoHideState\(e\.userState\)/)
    expect(src).toMatch(/normalBarAutoHideState\(e\.userState\)/)
    expect(src).toMatch(/engageTakeoverAutoHide\(log\)/) // 无账的恢复路径
  })

  it('观察面一次采齐：句柄+可见性走 native.ts 单一来源（nativeTaskbarView），置位读回走 getAppBarState', () => {
    expect(codeOf(NATIVE)).toMatch(/export function nativeTaskbarView\(/)
    expect(code).toMatch(/nativeTaskbarView\(\)/)
    expect(code).toMatch(/getAppBarState\(\)/)
  })

  it('裁决归 NativeReassertMachine 单一实现（控制器不自判重建/翻转——观察喂机器、照单执行）', () => {
    expect(code).toMatch(/new NativeReassertMachine\(\)/)
    expect(code).toMatch(/\.machine\.poll\(/)
    expect(code).not.toMatch(/IsWindowVisible/) // FFI 不进控制器（观察收口 native.ts）
  })
})

describe('分屏会话接线（工单269，spec #267；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const SNAP = 'app/src/main/taskbar/snap.ts'
  const code = codeOf(CTRL)
  const snapCode = codeOf(SNAP)

  it('会话事实喂进三态裁决：控制器在收栏轮询接缝上调分屏探针并传 snapSessionActive（spec 决策 3）', () => {
    expect(code).toMatch(/snapSessionActive:\s*snap\.active/)
    // 探针调用与轮询同缝（barInput 装配段内——工单271 起档位与理由持有同源消费），主屏会话按显示器参数裁决
    const m = code.match(/const snap = [^\n]*\n[\s\S]{0,800}?resolveBarMode\(barInput\)/)
    expect(m).toBeTruthy()
    // 工单270：控制器收成员集合（snapSessionMembers，会话=成员非空），不再只折布尔
    expect(code).toMatch(/snapSessionMembers\(/)
    expect(code).toMatch(/primaryPhysRect\(\)/)
  })

  it('会话事实翻转落存证（可观测分屏会话建立/结束，spec 用户故事 42）：名 taskbar-snap-session', () => {
    expect(code).toMatch(/'taskbar-snap-session'/)
    // 只在事实变化时落（每 250ms 拍不刷屏——同 plan.evidence 的幂等纪律）：账本比对后写
    expect(code).toMatch(/snapSessionLedger/)
  })

  it('探针失败按「无会话」处理（还原是安全方向）：分屏探针包 try/catch，异常不拦轮询', () => {
    const m = snapCode.match(/try\s*\{[\s\S]{0,400}?catch/)
    expect(m).toBeTruthy()
    expect(code).toMatch(/pollSnapSession/)
  })

  it('真 Snap 探针绑定 user32 的 IsWindowArranged（公共 API），模块加载不触 FFI（lazy-bind 先例）', () => {
    expect(snapCode).toMatch(/IsWindowArranged/)
    // lazy-bind：koffi 只在 bind() 内 require（yield.ts / windows.ts 同款），顶层零 FFI
    const top = snapCode.slice(0, snapCode.indexOf('function bind('))
    expect(top).not.toMatch(/koffi\.load|require\('koffi'\)/)
    expect(snapCode).toMatch(/require\('koffi'\)/)
  })

  it('识别不可用严格降级（spec 决策 11）：IsWindowArranged 声明期抛错被 try/catch 收编为不可用事实', () => {
    // 声明包 try/catch——缺失符号同步抛错（域笔记实机实证），失败置空走「无会话」
    const m = snapCode.match(/try\s*\{[^}]*IsWindowArranged[^}]*\}\s*catch/)
    expect(m).toBeTruthy()
  })

  it('无补齐路径（工单268 定谳：Windows 自动重排）——分屏模块与控制器不调任何窗口移动/改窗接口', () => {
    for (const banned of [/SetWindowPos/, /MoveWindow/, /ShowWindow\(/]) {
      expect(snapCode.match(banned), `snap.ts 含 ${banned}`).toBeNull()
    }
    // 控制器新增的分屏段（pollSnapSession 定义）不含改窗调用
    const seg = code.slice(code.indexOf('pollSnapSession'), code.indexOf('pollSnapSession') + 900)
    expect(seg).not.toMatch(/SetWindowPos|MoveWindow|setBounds/)
  })

  it('成员资格裁决单一实现住在 snap.ts（对齐 planBarTransition 的单一实现纪律）', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export function (isSnapSessionMember|resolveSnapSession)\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual([SNAP])
  })
})

describe('分屏会话集合生命周期接线（工单270，spec #267；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const SNAP = 'app/src/main/taskbar/snap.ts'
  const code = codeOf(CTRL)
  const snapCode = codeOf(SNAP)

  it('探针带成员追踪集：上一拍合格成员句柄喂回探针（最小化/解除的前成员照采事实，去向可分类）', () => {
    // 追踪集账本随拍更新——集合生命周期的「成员」而非「一次判定」是账面口径
    expect(code).toMatch(/probeSnapWindows\(snapMemberHwnds\)/)
    expect(code).toMatch(/snapMemberHwnds\s*=/)
  })

  it('会话结束因果分类单一实现住在 snap.ts，控制器只调用不另判', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export function classifySnapSessionEnd\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual([SNAP])
    expect(code).toMatch(/classifySnapSessionEnd\(/)
  })

  it('会话翻转存证带结束因果与理由接续（spec 决策 14 可观测）：cause / retractHeldByZoomed 字段落进 taskbar-snap-session', () => {
    expect(code).toMatch(/cause:\s*snap\.flip\.cause/)
    // retractHeldByZoomed 取 retractReasonHeld 的 zoomed 分量（工单271 评审收口⑤）——
    // 不再取 mode === 'maximize-retract'（浮层 prevMode 保持拍会把「无理由持有」误记成 zoomed 接续）
    expect(code).toMatch(/retractHeldByZoomed:\s*retractHeldByZoomed\(barInput\)/)
    expect(code).not.toMatch(/retractHeldByZoomed:\s*mode\s*===/)
    // 存证落在档位裁决之后（理由接续读得到当拍档位）
    const iSnapProbe = code.indexOf('const snap = pollSnapSession()')
    const iResolve = code.indexOf('const mode = resolveBarMode(')
    const iSnapLog = code.indexOf("'taskbar-snap-session'")
    expect(iSnapProbe).toBeGreaterThanOrEqual(0)
    expect(iResolve).toBeGreaterThan(iSnapProbe)
    expect(iSnapLog).toBeGreaterThan(iResolve)
  })

  it('探针采集面扩展：追踪集参数 + cloak 分位（SHELL 位 = 其他虚拟桌面）', () => {
    expect(snapCode).toMatch(/track:\s*readonly number\[\]/)
    expect(snapCode).toMatch(/DWM_CLOAKED_SHELL/)
    expect(snapCode).toMatch(/cloakedShell/)
  })
})

describe('枚举/FFI 面双写防漂移守卫（工单271 评审收口④：单一来源收敛前的在案钉）', () => {
  // 现状：snap.ts 与 windows.ts 各持一份 Win32 枚举/绑定面（Bound 表、MAX_WINDOWS、
  // pidOf/exeOfPid 逐字双写）。收敛为单一来源（snap.ts 复用 windows.ts 的 Bound）前，
  // 本守卫钉住双写不漂移——改一份必须同步另一份（或顺势收敛）。traitsOf 刻意不在
  // 逐字守卫内：两份口径分叉是工单270 的裁决（windows.ts 布尔折叠 vs snap.ts cloak
  // 分位采集），不是漂移。
  const WIN = 'app/src/main/taskbar/windows.ts'
  const SNAP = 'app/src/main/taskbar/snap.ts'

  /** 抓取顶层函数全文（闭括号落在行首——两个文件的函数体收尾同形） */
  const grab = (src: string, fn: string): string | undefined =>
    src.match(new RegExp(`function ${fn}\\([^)]*\\):[^\\n]*\\{[\\s\\S]*?\\n\\}`))?.[0]

  it('pidOf / exeOfPid 双写逐字一致（exeOfPid 单一语义：OpenProcess+QueryFullProcessImageNameW+CloseHandle 配对）', () => {
    const win = srcOf(WIN)
    const snap = srcOf(SNAP)
    for (const fn of ['pidOf', 'exeOfPid']) {
      expect(grab(win, fn), `windows.ts 缺 ${fn}`).toBeTruthy()
      expect(grab(snap, fn), `snap.ts 缺 ${fn}`).toBeTruthy()
      expect(grab(snap, fn), `${fn} 双写漂移——两份必须逐字同步，或收敛为单一实现`).toBe(grab(win, fn))
    }
  })

  it('MAX_WINDOWS 枚举上限双写同值（2048——链式枚举的终止护栏不得两处分叉）', () => {
    expect(srcOf(WIN).match(/const MAX_WINDOWS = (\d+)/)?.[1]).toBe('2048')
    expect(srcOf(SNAP).match(/const MAX_WINDOWS = (\d+)/)?.[1]).toBe('2048')
  })
})

describe('全屏让位与分屏会话解耦接线（工单271，spec #267；效果层离线不可测，以源码级守卫钉住）', () => {
  const CTRL = 'app/src/main/taskbar/window.ts'
  const FWD = 'app/src/main/taskbar/retract.ts'
  const code = codeOf(CTRL)

  it('理由持有裁决单一实现住在 shared/retract.ts（retractReasonHeld / retractGateDisqualified / retractHeldByZoomed），主进程侧经转发导出（同工单237 纪律）', () => {
    const hits: string[] = []
    for (const rel of SRC_FILES) {
      if (/export\s+function\s+(retractReasonHeld|retractGateDisqualified|retractHeldByZoomed)\b/.test(srcOf(rel))) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
    expect(srcOf(FWD)).toMatch(/\bretractReasonHeld\b/)
    expect(srcOf(FWD)).toMatch(/\bretractGateDisqualified\b/)
    expect(srcOf(FWD)).toMatch(/\bretractHeldByZoomed\b/)
    // 控制器不自算理由（pid/类名/zoomed 组合裁决不进效果层）
    expect(code).toMatch(/retractReasonHeld\(/)
    // 不自己拿真最大化位做裁决（只允许进存证载荷——同工单241 组的判据形态）
    expect(code).not.toMatch(/if\s*\(\s*probe\.zoomed/)
    expect(code).not.toMatch(/probe\.zoomed\s*===/)
  })

  it('同缝装配：裁决输入对象装配一次，resolveBarMode 与 retractReasonHeld 同源消费（不另采一套事实）', () => {
    const m = code.match(/const barInput = \{[\s\S]{0,700}?resolveBarMode\(barInput\)[\s\S]{0,200}?retractReasonHeld\(barInput\)/)
    expect(m).toBeTruthy()
    // 工单269/253 既有输入位逐字保留（改装配不丢位）
    expect(code).toMatch(/snapSessionActive:\s*snap\.active/)
    expect(code).toMatch(/prevMode:\s*s\.mode/)
    expect(code).toMatch(/ownOverlayPresent:\s*openOverlayFamilies\.size > 0/)
  })

  it('迁移计划带解耦上下文：applyBarMode 以账面 + 理由持有 + 闸门失格调 planBarTransition（两参旧调用不得残留）', () => {
    expect(code).toMatch(/planBarTransition\(\s*prev,\s*next,\s*\{[\s\S]{0,200}?\}\s*\)/)
    expect(code).not.toMatch(/planBarTransition\(\s*prev,\s*next\s*\)/)
    expect(code).toMatch(/workspaceRetracted:\s*s\.workspaceRetracted/)
    expect(code).toMatch(/retractHeld/)
    // 闸门失格位进计划上下文（同态让位拍交割的裁决输入——工单271 评审收口②）
    expect(code).toMatch(/gateDisqualified/)
    expect(code).toMatch(/retractGateDisqualified\(barInput\)/)
  })

  it('工作区账面是会话字段：建账 false、随迁移以计划产出原样落账、轮询停摆即清账（单一所有权）', () => {
    expect(code).toMatch(/workspaceRetracted: false/)
    // 账面推进的唯一落账式：plan.targetWorkspaceRetracted 原样落账（工单271 评审收口①）
    expect(code).toMatch(/s\.workspaceRetracted = plan\.targetWorkspaceRetracted/)
    // 效果层无第二份推进公式（旧写法「= next === 'maximize-retract' || …」不得残留——
    // 该公式与纯函数 wantRetracted 的 fullscreen-yield 子句不同形，漂移可静默通过全部离线测试）
    expect(code).not.toMatch(/s\.workspaceRetracted\s*=\s*next\b/)
    // 单一公式钉在纯函数本体（wantRetracted 的两支全在守卫射程内）
    const planSrc = srcOf('app/src/shared/retract.ts')
    expect(planSrc).toMatch(/const wantRetracted = next === 'maximize-retract'/)
    expect(planSrc).toMatch(/\|\| \(next === 'fullscreen-yield' && prev === 'maximize-retract' && retractHeld\)/)
    // 同态早退认计划（零存证零交割才退——闸门失格的同态交割拍带 retract-lifted 不得早退）
    expect(code).toMatch(/if \(prev === next && plan\.evidence\.length === 0\) return/)
    // stopYieldPoll（destroy/closed 共用）清账——账随轮询生灭，不悬空
    const m = code.match(/const stopYieldPoll = \(s: TaskbarSession\) => \{[\s\S]{0,400}?\}/)
    expect(m?.[0]).toMatch(/workspaceRetracted = false/)
  })

  it('重申轮询守门：拆场即返回（档位不再作为守门——普通档同样值守，目标由工作区收栏账派生）', () => {
    expect(code).toMatch(/const pollNativeWatch = \(\): void => \{[\s\S]{0,400}?if \(!s \|\| s\.win\.isDestroyed\(\)\) return/)
    // 旧「非收栏账不值守」的守门必须已撤（否则普通态清位被 explorer 冲掉后无人压回）
    expect(code).not.toMatch(/!s\.workspaceRetracted\) return/)
  })
})
