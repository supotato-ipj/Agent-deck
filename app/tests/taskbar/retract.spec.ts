// 收栏决策纯函数域模块（工单237，spec #236 用户故事 34）：最大化收栏的全部决策逻辑
// 集中在这一份模块——三态裁决（resolveBarMode）、唤出条几何规划（planSummonStrips）、
// 唤出交互归约（reduceSummon）。纯函数缝：探针快照/几何/事件序列由调用方采好，
// 本模块只裁决，零 FFI、零全局时钟、零 DOM。
// 先例同构：shared/overflow 的 planAppsOverflow（几何裁决）、main/taskbar/yield 的
// shouldYieldToFullscreen（覆盖判定谓词）、main/taskbar/tray-yield 的 TrayYieldMachine
// （now 显式传参的注入式状态机）、main/render-sentinel 的 silenceVerdict（组合穷举真值表）。
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import {
  COVER_TOLERANCE,
  DESKTOP_HOST_CLASSES,
  SUMMON_GRACE_MS,
  SUMMON_HOVER_DELAY_MS,
  SUMMON_STRIP_HIT_HEIGHT,
  SUMMON_STRIP_MIN_WIDTH,
  SUMMON_STRIP_VISUAL_HEIGHT,
  initialSummonState,
  planBarTransition,
  planSummonStrips,
  recheckStripHostRect,
  reduceSummon,
  reduceSummonSequence,
  resolveBarMode,
  retractGateDisqualified,
  retractHeldByZoomed,
  retractReasonHeld,
  summonedGroups,
} from '../../src/shared/retract'
import type {
  BarMode,
  BarModeInput,
  ForegroundProbe,
  PhysRect,
  SummonEvent,
  SummonEventType,
  SummonState,
} from '../../src/shared/retract'

/** 主屏物理矩形（1920×1080 @ 原点 0,0） */
const SCREEN: PhysRect = { left: 0, top: 0, right: 1920, bottom: 1080 }
const OWN_PID = 1000
const OTHER_PID = 2000

/** 收栏态的探针契约：zoomed = 是否真最大化（IsZoomed 族），非矩形覆盖法的推断 */
function probe(over: Partial<ForegroundProbe> = {}): ForegroundProbe {
  return { hwnd: 42, pid: OTHER_PID, className: 'AppWindow', rect: { ...SCREEN }, zoomed: false, ...over }
}

/** 三态裁决的基线输入（组合穷举时按 spread 覆写） */
const baseInput: BarModeInput = {
  probe: probe(),
  screen: SCREEN,
  ownPid: OWN_PID,
  retractEnabled: true,
  appBarDegraded: false,
}

/* ================================================================
 * resolveBarMode：三态裁决
 * ================================================================ */

/**
 * 探针形态 →（开关 × 降级档）→ 期望档位。**表是数据**，不重述实现的分支次序——
 * 写成与实现同形的 if 链，穷举只能查出「实现与自身不符」，查不出「实现与矩阵不符」。
 * 列序：[开关开·未降级, 开关开·降级, 开关关·未降级, 开关关·降级]
 */
type ProbeKind = 'missing' | 'own' | 'desktop-host' | 'normal' | 'maximized' | 'maximized-covering' | 'fullscreen'

const MODE_TABLE: Record<ProbeKind, readonly [BarMode, BarMode, BarMode, BarMode]> = {
  // 探针缺位 / 自家进程 / 桌面宿主类 / 普通窗 → 一律 visible
  missing: ['visible', 'visible', 'visible', 'visible'],
  own: ['visible', 'visible', 'visible', 'visible'],
  'desktop-host': ['visible', 'visible', 'visible', 'visible'],
  normal: ['visible', 'visible', 'visible', 'visible'],
  // 真最大化窗 → 开关开且未降级才收栏；真最大化窗**永不**判全屏让位（工单237 修正 A1）
  maximized: ['maximize-retract', 'visible', 'visible', 'visible'],
  'maximized-covering': ['maximize-retract', 'visible', 'visible', 'visible'],
  // 真全屏窗（覆盖主屏且不上 IsZoomed）→ 全屏让位压收栏，与开关/降级档无关
  fullscreen: ['fullscreen-yield', 'fullscreen-yield', 'fullscreen-yield', 'fullscreen-yield'],
}

/** 各探针形态的快照（'maximized' = AppBar 占位生效、底边停在栏上方；'maximized-covering' = 收栏后铺满整屏） */
function probeOf(kind: ProbeKind): ForegroundProbe | null {
  switch (kind) {
    case 'missing':
      return null
    case 'own':
      return probe({ pid: OWN_PID, zoomed: true })
    case 'desktop-host':
      return probe({ className: 'Progman', zoomed: true })
    case 'normal':
      return probe({ rect: { left: 300, top: 200, right: 1100, bottom: 800 } })
    case 'maximized':
      return probe({ zoomed: true, rect: { left: 0, top: 0, right: 1920, bottom: 1080 - 96 } })
    case 'maximized-covering':
      return probe({ zoomed: true })
    case 'fullscreen':
      return probe()
  }
}

describe('resolveBarMode 三态裁决', () => {
  it('探针缺位（前台窗读不到）→ visible（还原是安全方向）', () => {
    expect(resolveBarMode({ ...baseInput, probe: null })).toBe('visible')
  })

  it('自家进程成前台（面板本体被点击）→ visible（不收自己的栏）', () => {
    expect(resolveBarMode({ ...baseInput, probe: probe({ pid: OWN_PID, zoomed: true }) })).toBe('visible')
  })

  it('自家浮层夺前台 ⇒ 当前档位保持（工单253：收栏档不被翻掉）', () => {
    // 自绘浮层开层即取前台 ⇒ 前台探针看到的是**自家进程**。若按「自家进程 → visible」
    // 翻档，收栏档当场解除：栏面复现、唤出态被工单249 的 F1 同拍清空 ⇒「浮层在场只钉住所属组」
    // 在真机上不可观测（浮层一开档位就走了）。浮层在场 ⇒ 沿用当前档位，不做迁移。
    expect(resolveBarMode({
      ...baseInput,
      probe: probe({ pid: OWN_PID }),
      prevMode: 'maximize-retract',
      ownOverlayPresent: true,
    })).toBe('maximize-retract')
  })

  it('自家浮层夺前台 ⇒ 常驻档也保持（不是凭空收栏；工单253）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probe({ pid: OWN_PID }),
      prevMode: 'visible',
      ownOverlayPresent: true,
    })).toBe('visible')
  })

  it('面板本体被点成前台（自家浮层不在场）⇒ 仍 visible（既有语义不变，工单253）', () => {
    // 与上一条的分清点：自家进程成前台**且**自家浮层不在场 ⇒ 面板本体被点了 ⇒ visible
    expect(resolveBarMode({
      ...baseInput,
      probe: probe({ pid: OWN_PID, zoomed: true }),
      prevMode: 'maximize-retract',
      ownOverlayPresent: false,
    })).toBe('visible')
  })

  it('自家浮层不在场时，缺省输入的裁决与既有语义逐字一致（工单253：新增输入位不改变旧口径）', () => {
    // 既有调用方（不传 prevMode / ownOverlayPresent）⇒ 自家进程仍判 visible
    expect(resolveBarMode({ ...baseInput, probe: probe({ pid: OWN_PID }) })).toBe('visible')
    expect(resolveBarMode({ ...baseInput, probe: probeOf('maximized') })).toBe('maximize-retract')
    expect(resolveBarMode({ ...baseInput, probe: probeOf('fullscreen') })).toBe('fullscreen-yield')
  })

  it.each(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'])(
    '桌面宿主类 %s（矩形常态即通栏）→ visible', (className) => {
      expect(resolveBarMode({ ...baseInput, probe: probe({ className, zoomed: true }) })).toBe('visible')
    },
  )

  it('真最大化窗（IsZoomed 族）→ 收栏', () => {
    expect(resolveBarMode({ ...baseInput, probe: probeOf('maximized') })).toBe('maximize-retract')
  })

  it('收栏开关关 → 永不为 maximize-retract', () => {
    expect(resolveBarMode({ ...baseInput, retractEnabled: false, probe: probeOf('maximized') })).toBe('visible')
  })

  it('降级档（AppBar 注册失败）→ 永不为 maximize-retract', () => {
    expect(resolveBarMode({ ...baseInput, appBarDegraded: true, probe: probeOf('maximized') })).toBe('visible')
  })

  it('全屏让位压收栏：覆盖主屏的真全屏窗 → fullscreen-yield（收栏不得翻它）', () => {
    expect(resolveBarMode({ ...baseInput, probe: probeOf('fullscreen') })).toBe('fullscreen-yield')
  })

  it('全屏让位与开关/降级档无关：开关开着、降级档下仍是 fullscreen-yield', () => {
    expect(resolveBarMode({ ...baseInput, retractEnabled: true, appBarDegraded: true, probe: probeOf('fullscreen') }))
      .toBe('fullscreen-yield')
  })

  it('两态不互咬（工单237 修正 A1）：收栏后最大化窗铺满整屏（覆盖主屏）仍判收栏，不被翻成全屏让位', () => {
    // 收栏注销 AppBar → 最大化窗底边落到屏底 → 矩形覆盖成立。若按覆盖判全屏，
    // 收栏刚生效就被翻成让位、唤出条再也回不来（spec #236 取证补记 B.2 同一论断）。
    expect(resolveBarMode({ ...baseInput, probe: probeOf('maximized-covering') })).toBe('maximize-retract')
  })

  it('真最大化窗永不判全屏让位（zoomed 优先于覆盖判定——全屏让位分支排除真最大化窗）', () => {
    // 无论开关/降级档怎么配，zoomed 窗都不落 fullscreen-yield
    for (const retractEnabled of [true, false]) {
      for (const appBarDegraded of [true, false]) {
        expect(resolveBarMode({
          ...baseInput, retractEnabled, appBarDegraded, probe: probe({ zoomed: true }),
        })).not.toBe('fullscreen-yield')
      }
    }
  })

  it('普通窗（既不真最大化也不覆盖主屏）→ visible', () => {
    expect(resolveBarMode({ ...baseInput, probe: probeOf('normal') })).toBe('visible')
  })

  it('覆盖主屏但不上 IsZoomed 的窗（手拉铺满）→ fullscreen-yield（按覆盖判全屏，不误触发收栏）', () => {
    expect(resolveBarMode({ ...baseInput, probe: probe({ zoomed: false }) })).toBe('fullscreen-yield')
  })
})

describe('resolveBarMode 全组合穷举（探针形态 × 开关 × 降级档 = 7 × 2 × 2）', () => {
  it('逐格命中真值表', () => {
    const kinds: ProbeKind[] = ['missing', 'own', 'desktop-host', 'normal', 'maximized', 'maximized-covering', 'fullscreen']
    const mismatches: string[] = []
    let checked = 0

    for (const kind of kinds) {
      for (const retractEnabled of [true, false]) {
        for (const appBarDegraded of [true, false]) {
          // 列序：开关开·未降级 / 开关开·降级 / 开关关·未降级 / 开关关·降级
          const col = (retractEnabled ? 0 : 2) + (appBarDegraded ? 1 : 0)
          const want = MODE_TABLE[kind][col]
          const got = resolveBarMode({ ...baseInput, probe: probeOf(kind), retractEnabled, appBarDegraded })
          checked += 1
          if (got !== want) {
            mismatches.push(
              `${kind} 开关=${retractEnabled} 降级=${appBarDegraded} → ${got}（期望 ${want}）`,
            )
          }
        }
      }
    }

    expect(checked).toBe(28)
    expect(mismatches).toEqual([])
  })

  it('真值表覆盖齐七种探针形态（守卫表自身不漏格）', () => {
    expect(Object.keys(MODE_TABLE).sort()).toEqual([
      'desktop-host', 'fullscreen', 'maximized', 'maximized-covering', 'missing', 'normal', 'own',
    ])
  })
})

/* ================================================================
 * resolveBarMode：分屏会话输入（工单269，spec #267）
 * ================================================================ */

describe('resolveBarMode 分屏会话裁决（工单269）', () => {
  it('单个合格 Snap 窗建立的会话（后台事实）→ 收栏：前台是普通窗也收（普通前台切换不打断，用户故事 8/9）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('normal'),
      snapSessionActive: true,
    })).toBe('maximize-retract')
  })

  it('前台探针缺位 + 会话存续 → 仍收栏（会话独立于前台，不随探针缺位翻脸）', () => {
    expect(resolveBarMode({ ...baseInput, probe: null, snapSessionActive: true })).toBe('maximize-retract')
  })

  it('桌面宿主成前台 + 会话存续 → 仍收栏（点桌面不结束会话）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probe({ className: 'Progman' }),
      snapSessionActive: true,
    })).toBe('maximize-retract')
  })

  it('自家进程成前台（浮层不在场）+ 会话存续 → 仍收栏（面板本体被点不翻会话的栏）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probe({ pid: OWN_PID }),
      prevMode: 'maximize-retract',
      ownOverlayPresent: false,
      snapSessionActive: true,
    })).toBe('maximize-retract')
  })

  it('自家浮层夺前台 + 会话存续 → 档位保持（工单253 既有语义不因会话输入改变）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probe({ pid: OWN_PID }),
      prevMode: 'visible',
      ownOverlayPresent: true,
      snapSessionActive: true,
    })).toBe('visible')
  })

  it('全屏让位压过会话收栏的栏面呈现：覆盖主屏的全屏前台 → fullscreen-yield（最小闭环语义；#271 再精化工作区归属）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('fullscreen'),
      snapSessionActive: true,
    })).toBe('fullscreen-yield')
  })

  it('全屏 + 会话 + 开关关 → 仍 fullscreen-yield（让位不受闸门，既有口径不因会话输入改变）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('fullscreen'),
      retractEnabled: false,
      snapSessionActive: true,
    })).toBe('fullscreen-yield')
  })

  it('真最大化 + 会话并存 → 收栏（两理由同档，不叠加动作）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('maximized'),
      snapSessionActive: true,
    })).toBe('maximize-retract')
  })

  it('共用开关关 → 分屏收栏禁用（沿用 taskbar.maximizeRetract，不新增配置）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('normal'),
      retractEnabled: false,
      snapSessionActive: true,
    })).toBe('visible')
  })

  it('AppBar 降级档 → 分屏收栏禁用（降级档不建立分屏收栏）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('normal'),
      appBarDegraded: true,
      snapSessionActive: true,
    })).toBe('visible')
  })

  it('会话结束 + 普通前台 → 及时恢复 visible（最后一个 Snap 窗解除即回栏）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('normal'),
      snapSessionActive: false,
    })).toBe('visible')
  })

  it('收栏理由接续：会话结束但前台仍真最大化 → 保持收栏（不先恢复再收栏，用户故事 21）', () => {
    expect(resolveBarMode({
      ...baseInput,
      probe: probeOf('maximized'),
      snapSessionActive: false,
    })).toBe('maximize-retract')
  })

  it('缺省输入（不传 snapSessionActive）与旧口径逐字一致（新增输入位不改变旧行为）', () => {
    expect(resolveBarMode({ ...baseInput, probe: probeOf('normal') })).toBe('visible')
    expect(resolveBarMode({ ...baseInput, probe: probeOf('maximized') })).toBe('maximize-retract')
    expect(resolveBarMode({ ...baseInput, probe: null })).toBe('visible')
  })
})

describe('resolveBarMode 全组合穷举（探针形态 × 开关 × 降级档 × 分屏会话 = 7 × 2 × 2 × 2）', () => {
  // 会话在场列：除全屏覆盖形态外一律「开且未降级才收栏」；全屏覆盖仍压收栏（栏面呈现）
  const SNAP_MODE_TABLE: Record<ProbeKind, readonly [BarMode, BarMode, BarMode, BarMode]> = {
    missing: ['maximize-retract', 'visible', 'visible', 'visible'],
    own: ['maximize-retract', 'visible', 'visible', 'visible'],
    'desktop-host': ['maximize-retract', 'visible', 'visible', 'visible'],
    normal: ['maximize-retract', 'visible', 'visible', 'visible'],
    maximized: ['maximize-retract', 'visible', 'visible', 'visible'],
    'maximized-covering': ['maximize-retract', 'visible', 'visible', 'visible'],
    fullscreen: ['fullscreen-yield', 'fullscreen-yield', 'fullscreen-yield', 'fullscreen-yield'],
  }

  it('逐格命中真值表（含会话缺席列 = 旧表逐字不变）', () => {
    const kinds: ProbeKind[] = ['missing', 'own', 'desktop-host', 'normal', 'maximized', 'maximized-covering', 'fullscreen']
    const mismatches: string[] = []
    let checked = 0

    for (const kind of kinds) {
      for (const retractEnabled of [true, false]) {
        for (const appBarDegraded of [true, false]) {
          for (const snapSessionActive of [false, true]) {
            // 列序：开关开·未降级 / 开关开·降级 / 开关关·未降级 / 开关关·降级
            const col = (retractEnabled ? 0 : 2) + (appBarDegraded ? 1 : 0)
            const table = snapSessionActive ? SNAP_MODE_TABLE : MODE_TABLE
            const want = table[kind][col]
            const got = resolveBarMode({
              ...baseInput, probe: probeOf(kind), retractEnabled, appBarDegraded, snapSessionActive,
            })
            checked += 1
            if (got !== want) {
              mismatches.push(
                `${kind} 开关=${retractEnabled} 降级=${appBarDegraded} 会话=${snapSessionActive} → ${got}（期望 ${want}）`,
              )
            }
          }
        }
      }
    }

    expect(checked).toBe(56)
    expect(mismatches).toEqual([])
  })

  it('会话真值表覆盖齐七种探针形态（守卫表自身不漏格）', () => {
    expect(Object.keys(SNAP_MODE_TABLE).sort()).toEqual([
      'desktop-host', 'fullscreen', 'maximized', 'maximized-covering', 'missing', 'normal', 'own',
    ])
  })
})

/* ================================================================
 * 收栏理由接续（工单270，spec #267 决策 5/用户故事 21）：zoomed × 分屏会话
 * 两类收栏理由的组合时序——只在最后一个理由消失后复原，效果动作幂等。
 * 一拍 = { zoomed, session }；逐拍过 resolveBarMode（prevMode=上一拍档位）→
 * 档位变化时过 planBarTransition——与 window.ts 三态轮询的生产链路同构。
 * ================================================================ */

describe('收栏理由接续（工单270：最大化 × 分屏会话组合时序）', () => {
  interface Tick { zoomed: boolean; session: boolean }

  /** 逐拍推进（与生产同构），收全部档位迁移与其动作计划 */
  const runTicks = (ticks: readonly Tick[]) => {
    let mode: BarMode = 'visible'
    const transitions: { from: BarMode; to: BarMode; plan: ReturnType<typeof planBarTransition> }[] = []
    for (const t of ticks) {
      const next = resolveBarMode({
        ...baseInput,
        probe: t.zoomed ? probeOf('maximized') : probeOf('normal'),
        prevMode: mode,
        snapSessionActive: t.session,
      })
      if (next !== mode) {
        transitions.push({ from: mode, to: next, plan: planBarTransition(mode, next) })
        mode = next
      }
    }
    return { finalMode: mode, transitions }
  }

  it('先后建立：会话先建收栏，最大化理由加入 → 档位不动、零多余动作（两理由同档不叠加）', () => {
    const r = runTicks([
      { zoomed: false, session: true },
      { zoomed: true, session: true },
    ])
    expect(r.finalMode).toBe('maximize-retract')
    expect(r.transitions).toHaveLength(1)
    expect(r.transitions[0]).toMatchObject({ from: 'visible', to: 'maximize-retract' })
  })

  it('先后结束（最大化先消失）：会话接续持有收栏，会话再消失才复原——复原仅一次', () => {
    const r = runTicks([
      { zoomed: true, session: true },
      { zoomed: false, session: true },
      { zoomed: false, session: false },
    ])
    expect(r.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'visible->maximize-retract',
      'maximize-retract->visible',
    ])
    // 中间拍（zoomed 消失、会话在场）零迁移——工作区不先恢复再收栏
    expect(r.transitions[1].plan.claimAppBar).toBe(true)
    expect(r.transitions[1].plan.clearAutoHide).toBe(true)
    expect(r.transitions[1].plan.evidence).toEqual(['taskbar-retract-lifted'])
  })

  it('先后结束（会话先消失）：真最大化接续持有收栏（不先恢复再收栏），最大化再消失才复原', () => {
    const r = runTicks([
      { zoomed: true, session: true },
      { zoomed: true, session: false },
      { zoomed: false, session: false },
    ])
    expect(r.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'visible->maximize-retract',
      'maximize-retract->visible',
    ])
  })

  it('同时结束：两理由同拍消失 → 单次复原（无中间可见态、无双重复原动作）', () => {
    const r = runTicks([
      { zoomed: true, session: true },
      { zoomed: false, session: false },
    ])
    expect(r.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'visible->maximize-retract',
      'maximize-retract->visible',
    ])
    expect(r.transitions).toHaveLength(2)
  })

  it('理由交叉起落（最大化收栏上建会话、最大化消失、会话消失）：全程收栏、起止各一次动作', () => {
    const r = runTicks([
      { zoomed: true, session: false },
      { zoomed: true, session: true },
      { zoomed: false, session: true },
      { zoomed: false, session: false },
    ])
    expect(r.transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      'visible->maximize-retract',
      'maximize-retract->visible',
    ])
    // 存证账：全程一次 taskbar-retract + 一次 taskbar-retract-lifted（无反复）
    const evidence = r.transitions.flatMap((t) => t.plan.evidence)
    expect(evidence).toEqual(['taskbar-retract', 'taskbar-retract-lifted'])
  })

  it('幂等：同理由组合连续多拍 → 迁移仅首次，后续拍零动作（planBarTransition 同态空计划）', () => {
    expect(planBarTransition('maximize-retract', 'maximize-retract')).toEqual({
      releaseAppBar: false, engageAutoHide: false, clearAutoHide: false,
      claimAppBar: false, hideWindow: false, showWindow: false, closePopups: false, evidence: [],
      targetWorkspaceRetracted: true, // 同态 = 账面原样保持（收栏档在账）
    })
    const r = runTicks([
      { zoomed: true, session: true },
      { zoomed: true, session: true },
      { zoomed: true, session: true },
      { zoomed: true, session: true },
    ])
    expect(r.transitions).toHaveLength(1)
  })

  it('接续期间零多余注销/重注册：中间拍不产生任何 AppBar 或托管动作（无状态反复）', () => {
    const r = runTicks([
      { zoomed: true, session: true },
      { zoomed: true, session: false }, // 会话结束、zoomed 接续——中间拍
      { zoomed: false, session: false }, // 最后理由消失——复原拍
    ])
    expect(r.transitions).toHaveLength(2)
    expect(r.transitions[0].plan.releaseAppBar).toBe(true) // 进入收栏：注销一次
    expect(r.transitions[1].plan.claimAppBar).toBe(true) // 退出收栏：重注册一次
    // 中间没有第二条迁移——不存在「先注销再重注册再注销」的反复
  })
})

/* ================================================================
 * planSummonStrips：唤出条几何规划
 * ================================================================ */

const SCREEN_BOTTOM = 1080

/** 常态栏布局：五组 pill + 组间空隙 8px + 最右端显示桌面细条 */
const BAR_PILLS = [
  { group: 'start', x: 8, width: 120 },
  { group: 'recs', x: 136, width: 200 },
  { group: 'apps', x: 344, width: 300 },
  { group: 'right', x: 1600, width: 280 },
  { group: 'showdesk', x: 1912, width: 8 },
]

describe('planSummonStrips 唤出条几何规划', () => {
  it('几何口径：视觉 3px / 命中 9px（本函数只出命中区矩形）', () => {
    expect(SUMMON_STRIP_VISUAL_HEIGHT).toBe(3)
    expect(SUMMON_STRIP_HIT_HEIGHT).toBe(9)
  })

  it('镜像映射：逐组 1:1 镜像所属 pill 的横向区间与宽度', () => {
    const strips = planSummonStrips({ pills: BAR_PILLS, screenBottom: SCREEN_BOTTOM })
    expect(strips.map((s) => [s.group, s.x, s.width])).toEqual([
      ['start', 8, 120],
      ['recs', 136, 200],
      ['apps', 344, 300],
      ['right', 1600, 280],
      ['showdesk', 1912, 8],
    ])
  })

  it('命中区贴屏幕底边：top = 底边 − 9px、高度恒 9px', () => {
    const strips = planSummonStrips({ pills: BAR_PILLS, screenBottom: SCREEN_BOTTOM })
    for (const s of strips) {
      expect(s.top).toBe(SCREEN_BOTTOM - 9)
      expect(s.height).toBe(9)
      expect(s.top + s.height).toBe(SCREEN_BOTTOM)
    }
  })

  it('组间空隙不出条：只有有 pill 的组才出一条（空隙不被任何条覆盖）', () => {
    const strips = planSummonStrips({ pills: BAR_PILLS, screenBottom: SCREEN_BOTTOM })
    // 组间空隙：[128,136) / [336,344) / [644,1600) / [1880,1912)
    expect(strips.map((s) => [s.x, s.x + s.width])).toEqual([
      [8, 128], [136, 336], [344, 644], [1600, 1880], [1912, 1920],
    ])
  })

  it('显示桌面细条在最右端独立一条（自己的窄条，不并进右组）', () => {
    const strips = planSummonStrips({ pills: BAR_PILLS, screenBottom: SCREEN_BOTTOM })
    const sliver = strips.find((s) => s.group === 'showdesk')
    expect(sliver).toBeTruthy()
    expect(sliver!.x).toBe(1912)
    expect(sliver!.width).toBe(8)
    expect(strips.filter((s) => s.group === 'showdesk')).toHaveLength(1)
  })

  it('pill 相叠 → 唤出条夹取到互不重叠（每条仍可独立命中）', () => {
    const strips = planSummonStrips({
      pills: [
        { group: 'a', x: 0, width: 100 },
        { group: 'b', x: 50, width: 100 },
      ],
      screenBottom: SCREEN_BOTTOM,
    })
    expect(strips.map((s) => [s.group, s.x, s.width])).toEqual([
      ['a', 0, 100],
      ['b', 100, 50],
    ])
    // 互不重叠 + 各自可命中（宽度非零）
    expect(strips[0].x + strips[0].width).toBeLessThanOrEqual(strips[1].x)
    for (const s of strips) expect(s.width).toBeGreaterThan(0)
  })

  it('pill 相叠且后者被完全压住 → 后者保底宽度且仍不重叠（宁窄不重叠）', () => {
    const strips = planSummonStrips({
      pills: [
        { group: 'a', x: 0, width: 100 },
        { group: 'b', x: 0, width: 20 },
      ],
      screenBottom: SCREEN_BOTTOM,
    })
    expect(strips[0].x + strips[0].width).toBeLessThanOrEqual(strips[1].x)
    expect(strips[1].width).toBeGreaterThanOrEqual(SUMMON_STRIP_MIN_WIDTH)
    expect(strips[1].width).toBeGreaterThan(0)
  })

  it('三连相叠 → 逐条夹取，两两不重叠', () => {
    const strips = planSummonStrips({
      pills: [
        { group: 'a', x: 0, width: 100 },
        { group: 'b', x: 80, width: 100 },
        { group: 'c', x: 90, width: 100 },
      ],
      screenBottom: SCREEN_BOTTOM,
    })
    for (let i = 1; i < strips.length; i++) {
      expect(strips[i - 1].x + strips[i - 1].width).toBeLessThanOrEqual(strips[i].x)
      expect(strips[i].width).toBeGreaterThan(0)
    }
  })

  it('组增删 1:1 跟随：纯函数按输入矩形集重算，不留历史态', () => {
    const before = planSummonStrips({ pills: BAR_PILLS, screenBottom: SCREEN_BOTTOM })
    expect(before.map((s) => s.group)).toEqual(['start', 'recs', 'apps', 'right', 'showdesk'])

    const withoutRecs = planSummonStrips({
      pills: BAR_PILLS.filter((p) => p.group !== 'recs'),
      screenBottom: SCREEN_BOTTOM,
    })
    expect(withoutRecs.map((s) => s.group)).toEqual(['start', 'apps', 'right', 'showdesk'])

    const withExtra = planSummonStrips({
      pills: [...BAR_PILLS, { group: 'extra', x: 700, width: 60 }],
      screenBottom: SCREEN_BOTTOM,
    })
    // 输出序 = 入列序（与输入 1:1）；夹取按几何左→右做，输出序不受其影响
    expect(withExtra.map((s) => s.group)).toEqual(['start', 'recs', 'apps', 'right', 'showdesk', 'extra'])
    // 夹取后仍互不重叠：extra 落在 apps 与 right 之间的空档里，宽度未被吃掉
    expect(withExtra.find((s) => s.group === 'extra')).toMatchObject({ x: 700, width: 60 })
  })

  it('空组（零宽 pill）不出条（与组间空隙同一口径）', () => {
    const strips = planSummonStrips({
      pills: [{ group: 'start', x: 8, width: 120 }, { group: 'empty', x: 200, width: 0 }],
      screenBottom: SCREEN_BOTTOM,
    })
    expect(strips.map((s) => s.group)).toEqual(['start'])
  })

  it('空输入 → 空输出', () => {
    expect(planSummonStrips({ pills: [], screenBottom: SCREEN_BOTTOM })).toEqual([])
  })

  it('输入不被改动（纯函数不写回调用方的矩形集）', () => {
    const pills = BAR_PILLS.map((p) => ({ ...p }))
    const snapshot = pills.map((p) => ({ ...p }))
    planSummonStrips({ pills, screenBottom: SCREEN_BOTTOM })
    expect(pills).toEqual(snapshot)
  })
})

/* ================================================================
 * reduceSummon：唤出交互归约（now 显式传参的注入式逻辑时钟）
 * ================================================================ */

const T0 = 50_000
const GROUPS = ['start', 'recs', 'apps', 'right', 'showdesk']

function ev(type: SummonEventType, group: string, now: number): SummonEvent {
  return { type, group, now }
}

function stateOf(s: SummonState, group: string) {
  return s.groups[group]
}

describe('reduceSummon 唤出交互归约', () => {
  it('悬停唤出条 150ms 后弹出该组（149 不弹 / 150 弹 / 151 弹）', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-enter', 'apps', T0))
    expect(stateOf(s, 'apps').popped).toBe(false)

    s = reduceSummon(s, ev('tick', 'apps', T0 + 149))
    expect(stateOf(s, 'apps').popped).toBe(false)

    s = reduceSummon(s, ev('tick', 'apps', T0 + 150))
    expect(stateOf(s, 'apps').popped).toBe(true)

    let s2 = reduceSummon(initialSummonState(GROUPS), ev('strip-enter', 'apps', T0))
    s2 = reduceSummon(s2, ev('tick', 'apps', T0 + 151))
    expect(stateOf(s2, 'apps').popped).toBe(true)
  })

  it('悬停期间离开唤出条 → 不弹出（快速扫过不误触发）', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-enter', 'apps', T0))
    s = reduceSummon(s, ev('strip-leave', 'apps', T0 + 100))
    s = reduceSummon(s, ev('tick', 'apps', T0 + 500))
    expect(stateOf(s, 'apps').popped).toBe(false)
  })

  it('点击唤出条立即弹出（不吃 150ms 延迟）', () => {
    const s = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    expect(stateOf(s, 'apps').popped).toBe(true)
    expect(stateOf(s, 'apps').hoverSince).toBeNull()
  })

  it('离开已弹出的组后 400ms 宽限才收起（399 仍弹 / 400 收 / 401 收）', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    s = reduceSummon(s, ev('strip-leave', 'apps', T0 + 10)) // 指针离开唤出条 → 宽限起算
    expect(stateOf(s, 'apps').popped).toBe(true)

    s = reduceSummon(s, ev('tick', 'apps', T0 + 10 + 399))
    expect(stateOf(s, 'apps').popped).toBe(true)

    s = reduceSummon(s, ev('tick', 'apps', T0 + 10 + 400))
    expect(stateOf(s, 'apps').popped).toBe(false)

    let s2 = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    s2 = reduceSummon(s2, ev('strip-leave', 'apps', T0 + 10))
    s2 = reduceSummon(s2, ev('tick', 'apps', T0 + 10 + 401))
    expect(stateOf(s2, 'apps').popped).toBe(false)
  })

  it('各组唤出与收起互相独立：多组可同时在场', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-enter', 'apps', T0))
    s = reduceSummon(s, ev('strip-enter', 'right', T0 + 10))
    s = reduceSummon(s, ev('tick', 'right', T0 + 160))
    expect(stateOf(s, 'apps').popped).toBe(true)
    expect(stateOf(s, 'right').popped).toBe(true)
    expect(summonedGroups(s).sort()).toEqual(['apps', 'right'])
  })

  it('各组收起也独立：apps 收起不影响 right 在场', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    s = reduceSummon(s, ev('strip-click', 'right', T0))
    s = reduceSummon(s, ev('strip-leave', 'apps', T0 + 10))
    s = reduceSummon(s, ev('tick', 'apps', T0 + 500))
    expect(stateOf(s, 'apps').popped).toBe(false)
    expect(stateOf(s, 'right').popped).toBe(true)
  })

  it('自绘浮层在场只钉住所属组：所属组不收，其余组照常收', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('overlay-open', 'right', T0))
    expect(stateOf(s, 'right').pinned).toBe(true)
    expect(stateOf(s, 'right').popped).toBe(true)

    // 指针离开右组 → 被钉住不收
    s = reduceSummon(s, ev('strip-leave', 'right', T0 + 10))
    s = reduceSummon(s, ev('tick', 'right', T0 + 10 + 5_000))
    expect(stateOf(s, 'right').popped).toBe(true)

    // 其余组不受浮层影响，照常收
    let t = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    t = reduceSummon(t, ev('overlay-open', 'right', T0))
    t = reduceSummon(t, ev('strip-leave', 'apps', T0 + 10))
    t = reduceSummon(t, ev('tick', 'apps', T0 + 10 + 400))
    expect(stateOf(t, 'apps').popped).toBe(false)
    expect(stateOf(t, 'right').popped).toBe(true)
  })

  it('浮层关闭 → 解除钉住，指针不在该组则 400ms 后收起', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('overlay-open', 'right', T0))
    s = reduceSummon(s, ev('overlay-close', 'right', T0 + 100))
    s = reduceSummon(s, ev('tick', 'right', T0 + 100 + 399))
    expect(stateOf(s, 'right').popped).toBe(true)
    s = reduceSummon(s, ev('tick', 'right', T0 + 100 + 400))
    expect(stateOf(s, 'right').popped).toBe(false)
  })

  it('收栏态下已弹出组的唤出条隐藏（条与 pill 同位，露出会闪）', () => {
    const idle = initialSummonState(GROUPS)
    expect(stateOf(idle, 'apps').stripVisible).toBe(true)

    const popped = reduceSummon(idle, ev('strip-click', 'apps', T0))
    expect(stateOf(popped, 'apps').stripVisible).toBe(false)
    expect(stateOf(popped, 'recs').stripVisible).toBe(true)
  })

  it('静止指针对账：指针压在已弹出的 pill 上 → 该组保持弹出（长期不收）', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    s = reduceSummon(s, ev('pill-enter', 'apps', T0 + 10))
    s = reduceSummon(s, ev('tick', 'apps', T0 + 5_000))
    expect(stateOf(s, 'apps').popped).toBe(true)
  })

  it('振荡回归：弹出→收→弹 的振荡被钉住（对账纠正悬停态后该组不再塌）', () => {
    // 真机原型教训：组 pill 弹出/收起改变指针下的元素，浏览器补发的 enter/leave 不可靠，
    // 静止指针会「弹出→收→弹」振荡。防线是按光标坐标 hit-test 对账（25ms 拍）+ 归约里
    // 「指针在 pill 上则宽限作废」——本例复现噪声事件序列，断言该组不再收起。
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-enter', 'apps', T0))
    s = reduceSummon(s, ev('tick', 'apps', T0 + 150))
    expect(stateOf(s, 'apps').popped).toBe(true)

    // 噪声①：浏览器补发的 strip-leave（指针其实没动，还在 pill 上）
    s = reduceSummon(s, ev('strip-leave', 'apps', T0 + 160))
    // 对账拍：hit-test 纠正为「指针在 pill 上」
    s = reduceSummon(s, ev('pill-enter', 'apps', T0 + 185))
    // 噪声②：又补发一次 pill-leave，对账再次纠正
    s = reduceSummon(s, ev('pill-leave', 'apps', T0 + 210))
    s = reduceSummon(s, ev('pill-enter', 'apps', T0 + 235))

    // 此后无论过多久都不该再收（收过一次即构成「弹出→收→弹」振荡）
    for (const at of [T0 + 400, T0 + 1_000, T0 + 5_000, T0 + 30_000]) {
      s = reduceSummon(s, ev('tick', 'apps', at))
      expect(stateOf(s, 'apps').popped).toBe(true)
    }
  })

  it('真正离开（无对账纠正）时仍按 400ms 宽限收起——防线不吞掉正常收起', () => {
    let s = reduceSummon(initialSummonState(GROUPS), ev('strip-click', 'apps', T0))
    s = reduceSummon(s, ev('strip-leave', 'apps', T0 + 10))
    s = reduceSummon(s, ev('tick', 'apps', T0 + 10 + 400))
    expect(stateOf(s, 'apps').popped).toBe(false)
  })

  it('组增删跟随：新组的事件即建状态（不需预先登记）', () => {
    let s = reduceSummon(initialSummonState(['apps']), ev('strip-enter', 'brand-new', T0))
    expect(stateOf(s, 'brand-new')).toBeTruthy()
    s = reduceSummon(s, ev('tick', 'brand-new', T0 + 150))
    expect(stateOf(s, 'brand-new').popped).toBe(true)
  })

  it('事件序列折叠口径：reduceSummonSequence 与逐步归约同解', () => {
    const events = [
      ev('strip-enter', 'apps', T0),
      ev('tick', 'apps', T0 + 150),
      ev('strip-leave', 'apps', T0 + 160),
      ev('tick', 'apps', T0 + 1_000),
    ]
    const folded = reduceSummonSequence(events, initialSummonState(GROUPS))
    let stepped = initialSummonState(GROUPS)
    for (const e of events) stepped = reduceSummon(stepped, e)
    expect(folded).toEqual(stepped)
    expect(stateOf(folded, 'apps').popped).toBe(false)
  })

  it('阈值是明确常量（150ms 悬停延迟 / 400ms 宽限，可断言）', () => {
    expect(SUMMON_HOVER_DELAY_MS).toBe(150)
    expect(SUMMON_GRACE_MS).toBe(400)
  })
})

/* ================================================================
 * 依赖边界与单一来源守卫
 * ================================================================ */

const APP_ROOT = path.resolve(__dirname, '../../..')
const SRC = path.resolve(APP_ROOT, 'app/src/shared/retract.ts')
const src = readFileSync(SRC, 'utf8')

/** import 语句（含 type-only）与 CommonJS / 动态 require() */
const IMPORT_STMT_RE = /^\s*import\s+(?:type\s+)?[\s{*]/gm
const REQUIRE_RE = /\b(?:import|require)\s*\(/

/** 递归枚举仓库内 .ts 文件（仓库根相对路径，/ 分隔） */
function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...tsFiles(full))
    else if (name.endsWith('.ts')) out.push(path.relative(APP_ROOT, full).replace(/\\/g, '/'))
  }
  return out
}

describe('收栏决策模块的依赖边界', () => {
  it('模块不含任何 import / require（零 FFI、零 IO：只吃调用方喂进来的快照）', () => {
    expect(src.match(IMPORT_STMT_RE)).toBeNull()
    expect(src.match(REQUIRE_RE)).toBeNull()
  })

  it('模块不读全局时钟（now 一律由调用方传参注入）', () => {
    expect(src).not.toMatch(/Date\.now|performance\.now|new Date/)
  })

  it('模块不碰 DOM（渲染层的事留在渲染层）', () => {
    expect(src).not.toMatch(/\bdocument\b|\bwindow\b/)
  })

  it('守卫自身不空转：同一条正则能在确含 import / require 的先例模块上命中', () => {
    const precedent = readFileSync(path.resolve(APP_ROOT, 'app/src/main/taskbar/yield.ts'), 'utf8')
    expect(precedent.match(IMPORT_STMT_RE)?.length ?? 0).toBeGreaterThan(0)
    expect(src.length).toBeGreaterThan(0)
  })
})

describe('收栏决策模块的单一来源（工单237 修正 A2/A4）', () => {
  it('三个裁决函数在全仓只有一份实现（主进程侧只做转发导出，不另写实现）', () => {
    const implRe = /export\s+function\s+(resolveBarMode|planSummonStrips|reduceSummon)\b/
    const hits: string[] = []
    for (const rel of tsFiles(path.resolve(APP_ROOT, 'app/src'))) {
      const text = readFileSync(path.resolve(APP_ROOT, rel), 'utf8')
      if (implRe.test(text)) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
  })

  it('主进程侧转发模块存在且只做 re-export（导出名两侧同名）', () => {
    const forward = path.resolve(APP_ROOT, 'app/src/main/taskbar/retract.ts')
    const text = readFileSync(forward, 'utf8')
    for (const name of ['resolveBarMode', 'planSummonStrips', 'reduceSummon']) {
      expect(text).toMatch(new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`))
    }
    expect(text).toMatch(/from\s+'\.\.\/\.\.\/shared\/retract'/)
    expect(text).not.toMatch(/export\s+function/)
  })

  it('前台探针形状只有一份定义（ForegroundProbe 在 shared/retract.ts，yield.ts import 之）', () => {
    const defRe = /export\s+interface\s+(ForegroundProbe|PhysRect)\b/
    const hits: string[] = []
    for (const rel of tsFiles(path.resolve(APP_ROOT, 'app/src'))) {
      const text = readFileSync(path.resolve(APP_ROOT, rel), 'utf8')
      if (defRe.test(text)) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
  })

  it('探针形状含 zoomed 字段（真最大化的输入契约位）', () => {
    expect(src).toMatch(/zoomed\s*:\s*boolean/)
  })

  it('yield.ts 不再自带第二份名单字面量（改为 import 同一份）', () => {
    const yieldSrc = readFileSync(path.resolve(APP_ROOT, 'app/src/main/taskbar/yield.ts'), 'utf8')
    for (const cls of DESKTOP_HOST_CLASSES) {
      expect(yieldSrc).not.toContain(`'${cls}'`)
    }
    expect(yieldSrc).toMatch(/from\s+'\.\.\/\.\.\/shared\/retract'/)
  })

  it('全仓源码里这四个类名只在 shared/retract.ts 作为名单条目出现（无第二份抄写）', () => {
    // 判据取「带引号的名单条目」形态——散落在注释里的散文提及（native.ts 记过
    // Shell_SecondaryTrayWnd 副屏栏不动）不是名单抄写，不算命中。
    const hits: string[] = []
    for (const rel of tsFiles(path.resolve(APP_ROOT, 'app/src'))) {
      if (readFileSync(path.resolve(APP_ROOT, rel), 'utf8').includes("'Shell_SecondaryTrayWnd'")) hits.push(rel)
    }
    expect(hits).toEqual(['app/src/shared/retract.ts'])
  })

  it('覆盖判定容差是单一来源的常量（全屏让位与收栏共用一份）', () => {
    expect(COVER_TOLERANCE).toBe(2)
    const yieldSrc = readFileSync(path.resolve(APP_ROOT, 'app/src/main/taskbar/yield.ts'), 'utf8')
    expect(yieldSrc).not.toMatch(/COVER_TOLERANCE\s*=\s*\d/)
  })

  it('退役谓词 shouldYieldToFullscreen：生产代码不得再 import（工单249 守卫）', () => {
    const hits: string[] = []
    for (const rel of tsFiles(path.resolve(APP_ROOT, 'app/src'))) {
      const text = readFileSync(path.resolve(APP_ROOT, rel), 'utf8')
      // 判据取 import 语句形态——注释里的散文提及（说明它为何退役）不算引用
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      if (/import[^\n]*\bshouldYieldToFullscreen\b/.test(code)) hits.push(rel)
    }
    expect(hits).toEqual([])
  })

  it('退役谓词的头注释显式标注「已退役」并写明档位归属（档位归 resolveBarMode）', () => {
    const yieldSrc = readFileSync(path.resolve(APP_ROOT, 'app/src/main/taskbar/yield.ts'), 'utf8')
    expect(yieldSrc).toMatch(/已退役/)
    expect(yieldSrc).toMatch(/resolveBarMode/)
  })
})

/* ================================================================
 * retractReasonHeld：工作区收栏理由持有（工单271，spec #267）
 * ================================================================ */

describe('retractReasonHeld 工作区收栏理由持有（工单271）', () => {
  it('分屏会话存续 + 过闸 → 持有（会话是后台事实，与前台是谁无关）', () => {
    for (const kind of ['missing', 'own', 'desktop-host', 'normal', 'fullscreen'] as const) {
      expect(retractReasonHeld({ ...baseInput, probe: probeOf(kind), snapSessionActive: true }),
        `${kind} + 会话`).toBe(true)
    }
  })

  it('全屏覆盖 + 会话存续 → 持有——resolveBarMode 同输入落让位档（②支掩蔽），理由维度独立可见（解耦的落点）', () => {
    const input = { ...baseInput, probe: probeOf('fullscreen'), snapSessionActive: true }
    expect(resolveBarMode(input)).toBe('fullscreen-yield')
    expect(retractReasonHeld(input)).toBe(true)
  })

  it('真最大化前台 → 持有（zoomed 理由）；探针缺位 / 自家进程 / 桌面宿主且无会话 → 不持有', () => {
    expect(retractReasonHeld({ ...baseInput, probe: probeOf('maximized') })).toBe(true)
    expect(retractReasonHeld({ ...baseInput, probe: null })).toBe(false)
    expect(retractReasonHeld({ ...baseInput, probe: probe({ pid: OWN_PID }) })).toBe(false)
    expect(retractReasonHeld({ ...baseInput, probe: probe({ className: 'Progman' }) })).toBe(false)
  })

  it('两道闸门：开关关 / 降级档 → 不持有（会话与真最大化同受闸）', () => {
    expect(retractReasonHeld({ ...baseInput, retractEnabled: false, probe: probeOf('maximized'), snapSessionActive: true })).toBe(false)
    expect(retractReasonHeld({ ...baseInput, appBarDegraded: true, probe: probeOf('maximized'), snapSessionActive: true })).toBe(false)
  })

  it('与 resolveBarMode 收栏档一致：非全屏探针下两者同真同假（分歧仅发生在全屏掩蔽拍——held 独立可见的价值）', () => {
    const kinds: ProbeKind[] = ['missing', 'own', 'desktop-host', 'normal', 'maximized', 'maximized-covering']
    for (const kind of kinds) {
      for (const retractEnabled of [true, false]) {
        for (const snapSessionActive of [false, true]) {
          const input = { ...baseInput, probe: probeOf(kind), retractEnabled, snapSessionActive }
          expect(
            retractReasonHeld(input) === (resolveBarMode(input) === 'maximize-retract'),
            `${kind} 开关=${retractEnabled} 会话=${snapSessionActive}`,
          ).toBe(true)
        }
      }
    }
  })
})

/* ================================================================
 * retractGateDisqualified / retractHeldByZoomed（工单271 评审收口②⑤）
 * ================================================================ */

describe('retractGateDisqualified 两道闸门失格谓词（工单271 评审收口②）', () => {
  it('开关关或降级档任一即失格；两道全开不失格（与 retractReasonHeld 闸门支同源）', () => {
    expect(retractGateDisqualified({ retractEnabled: true, appBarDegraded: false })).toBe(false)
    expect(retractGateDisqualified({ retractEnabled: false, appBarDegraded: false })).toBe(true)
    expect(retractGateDisqualified({ retractEnabled: true, appBarDegraded: true })).toBe(true)
    expect(retractGateDisqualified({ retractEnabled: false, appBarDegraded: true })).toBe(true)
  })

  it('与 retractReasonHeld 的分野：闸门失格与理由自然消失在理由维度同为 false——本谓词是把「失格」从「自然消失」里分出来的裁决面', () => {
    // 闸门失格：held=false 且 gate 失格 ⇒ 同态让位拍交割（用户故事 27）
    const gated = { ...baseInput, retractEnabled: false, probe: probeOf('fullscreen'), snapSessionActive: true }
    expect(retractReasonHeld(gated)).toBe(false)
    expect(retractGateDisqualified(gated)).toBe(true)
    // 理由自然消失（会话结束）：held=false 且 gate 未失格 ⇒ 同态让位拍维持冻结（P14③）
    const natural = { ...baseInput, retractEnabled: true, probe: probeOf('fullscreen'), snapSessionActive: false }
    expect(retractReasonHeld(natural)).toBe(false)
    expect(retractGateDisqualified(natural)).toBe(false)
  })
})

describe('retractHeldByZoomed zoomed 分量谓词（工单271 评审收口⑤）', () => {
  it('真最大化前台在场（过闸、非自家、非桌面宿主）→ true——会话结束拍的「zoomed 接续」判据', () => {
    expect(retractHeldByZoomed({ ...baseInput, probe: probeOf('maximized') })).toBe(true)
    expect(retractHeldByZoomed({ ...baseInput, probe: probeOf('maximized'), snapSessionActive: true })).toBe(true)
  })

  it('自家进程前台（浮层夺前台的 prevMode 保持拍）→ false——「无理由持有」不再误记为 zoomed 接续', () => {
    // 工单253 场景：浮层开层取前台，档位按 prevMode 保持收栏；probe 是自家进程 ⇒ 非.zoomed 接续
    expect(retractHeldByZoomed({
      ...baseInput,
      probe: probe({ pid: OWN_PID, zoomed: true }),
      prevMode: 'maximize-retract',
      ownOverlayPresent: true,
    })).toBe(false)
  })

  it('桌面宿主 / 探针缺位 / 普通窗 → false（排除族与 retractReasonHeld 的 zoomed 支同族）', () => {
    expect(retractHeldByZoomed({ ...baseInput, probe: probe({ className: 'Progman', zoomed: true }) })).toBe(false)
    expect(retractHeldByZoomed({ ...baseInput, probe: null })).toBe(false)
    expect(retractHeldByZoomed({ ...baseInput, probe: probeOf('normal') })).toBe(false)
  })

  it('两道闸门失格 → false（没有任何理由在持有时不记接续）', () => {
    expect(retractHeldByZoomed({ ...baseInput, retractEnabled: false, probe: probeOf('maximized') })).toBe(false)
    expect(retractHeldByZoomed({ ...baseInput, appBarDegraded: true, probe: probeOf('maximized') })).toBe(false)
  })

  it('会话理由接续拍（无 zoomed）→ false——zoomed 分量与分屏会话分量可分（不冒充）', () => {
    expect(retractHeldByZoomed({
      ...baseInput,
      probe: probeOf('normal'),
      snapSessionActive: true,
    })).toBe(false)
  })
})

/* ================================================================
 * recheckStripHostRect：收栏过渡后的宿主矩形复核（工单295，spec #292）
 * 判据 = 条带宿主矩形底边 vs 期望矩形底边（±1 DIP）；偏离即回正。
 * 两矩形各取自己的底边/上缘（不假设定高）；偏离以 DIP 计（渲染层落点不入判据）。
 * ================================================================ */
describe('recheckStripHostRect 宿主矩形复核判据（工单295，spec #292）', () => {
  /** 期望矩形：屏底锚定通栏条带（2560×1440 @100%，条带高 48 DIP——stripPhysRect 的 DIP 像） */
  const expected = { x: 0, y: 1392, width: 2560, height: 48 }

  it('重合矩形 → verified，回正目标 = 现矩形（不动作）', () => {
    const v = recheckStripHostRect({ ...expected }, expected)
    expect(v.verdict).toBe('verified')
    expect(v.rect).toEqual({ ...expected })
    expect(v.bottomDeviationDip).toBe(0)
    expect(v.topDeviationDip).toBe(0)
  })

  it('底边偏离恰好 1 DIP → verified（±1 DIP 界内，含边界值本身）', () => {
    const v = recheckStripHostRect({ ...expected, y: expected.y - 1 }, expected)
    expect(v.verdict).toBe('verified')
    expect(v.bottomDeviationDip).toBe(1)
  })

  it('底边偏离 1.5 DIP → corrected，回正目标 = 期望矩形（票面：偏离 >1 DIP 即回正）', () => {
    const cur = { ...expected, y: expected.y - 1.5 }
    const v = recheckStripHostRect(cur, expected)
    expect(v.verdict).toBe('corrected')
    expect(v.rect).toEqual(expected)
    expect(v.from).toEqual(cur)
    expect(v.bottomDeviationDip).toBeCloseTo(1.5)
  })

  it('缺陷形态：宿主被壳侧抬高一个原生栏身高（48 DIP）→ corrected——唤出条整体偏高 48px 的根因态', () => {
    const cur = { ...expected, y: expected.y - 48 } // [屏底−96, 屏底−48]，真机 R7/R8 实证形态
    const v = recheckStripHostRect(cur, expected)
    expect(v.verdict).toBe('corrected')
    expect(v.rect).toEqual(expected)
    expect(v.bottomDeviationDip).toBe(48)
  })

  it('宿主越过屏底（底边超出）→ corrected——负向偏离同判（绝对值）', () => {
    const cur = { ...expected, y: expected.y + 3 }
    const v = recheckStripHostRect(cur, expected)
    expect(v.verdict).toBe('corrected')
    expect(v.bottomDeviationDip).toBe(3)
  })

  it('双矩形各取底边/上缘：底边贴底但上缘偏 3 DIP（现矩形更高）→ corrected', () => {
    const cur = { x: 0, y: expected.y - 3, width: 2560, height: 51 } // 底边重合、上缘高 3
    const v = recheckStripHostRect(cur, expected)
    expect(v.verdict).toBe('corrected')
    expect(v.bottomDeviationDip).toBe(0)
    expect(v.topDeviationDip).toBe(3)
  })

  it('双矩形各取底边/上缘：上缘贴齐但底边偏 2 DIP（现矩形更矮）→ corrected——定高假设判不出这态', () => {
    const cur = { x: 0, y: expected.y, width: 2560, height: 46 }
    const v = recheckStripHostRect(cur, expected)
    expect(v.verdict).toBe('corrected')
    expect(v.topDeviationDip).toBe(0)
    expect(v.bottomDeviationDip).toBe(2)
  })

  it('判据以 DIP 计不以物理像素计（150% scale）：1 物理px=0.667 DIP → verified、2 物理px=1.333 DIP → corrected', () => {
    // 期望矩形取屏底 960 DIP（1440 物理px @1.5）上方的 48 DIP 条带
    const exp15 = { x: 0, y: 912, width: 1707, height: 48 }
    const onePhysPx = recheckStripHostRect({ ...exp15, y: exp15.y - 1 / 1.5 }, exp15)
    expect(onePhysPx.verdict).toBe('verified')
    expect(onePhysPx.bottomDeviationDip).toBeCloseTo(0.667, 2)
    const twoPhysPx = recheckStripHostRect({ ...exp15, y: exp15.y - 2 / 1.5 }, exp15)
    expect(twoPhysPx.verdict).toBe('corrected')
    expect(twoPhysPx.bottomDeviationDip).toBeCloseTo(1.333, 2)
  })

  it('容差可调：toleranceDip=2 时 1.5 DIP 偏离 → verified（宽限档位为上游留口径，判据域不变）', () => {
    const v = recheckStripHostRect({ ...expected, y: expected.y - 1.5 }, expected, 2)
    expect(v.verdict).toBe('verified')
  })
})
