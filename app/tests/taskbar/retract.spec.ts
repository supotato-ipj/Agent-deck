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
  planSummonStrips,
  reduceSummon,
  reduceSummonSequence,
  resolveBarMode,
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
