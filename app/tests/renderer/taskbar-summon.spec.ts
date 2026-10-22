// 唤出条渲染与交互（工单242，spec #236 用户故事 12–22、24、31–33）：渲染层纯逻辑的离线测试。
//
// 接缝 = app/src/renderer/taskbar-summon.ts 的公开面：几何规划（planSummonGeometry）、
// 指针对账（reconcilePointer / tickSummon）、热区声明（summonHotZones）、浮层钉组映射
// （overlayOwnerGroup / applyOverlayState）、点击与浮层事件入口（clickStrip）。
// 决策逻辑本体在 shared/retract.ts（工单237 单一来源），本模块只做渲染层的接线与对账。
//
// 振荡防御（原型教训）：悬停判定**不采信浏览器 enter/leave 事件序列**，一律按光标坐标
// hit-test 校正——对账拍喂进来的 zoneId 是唯一事实来源。下面的振荡回归用例即钉这条。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { initialSummonState, SUMMON_GRACE_MS, SUMMON_HOVER_DELAY_MS, SUMMON_STRIP_HIT_HEIGHT, SUMMON_STRIP_VISUAL_HEIGHT } from '../../src/shared/retract'
import type { SummonPillRect, SummonState } from '../../src/shared/retract'
import {
  OVERLAY_OWNER_GROUP,
  applyOverlayState,
  clickStrip,
  overlayOwnerGroup,
  parseSummonZone,
  pillZoneId,
  planSummonGeometry,
  reconcilePointer,
  stripZoneId,
  summonHotZones,
  summonRiseKeyframes,
  SUMMON_RISE_DY,
  SUMMON_RISE_MS,
  tickSummon,
} from '../../src/renderer/taskbar-summon'

const APP_ROOT = path.resolve(__dirname, '../..')
const GROUPS = ['start', 'recs', 'apps', 'right', 'showdesk']
const T0 = 50_000
/** 条带窗客户区高（工单238 栏高 48 DIP）——屏幕底边即客户区底边 */
const BAND = 48

/** 常态栏布局：五组 pill + 组间空隙 8px + 最右端显示桌面细条 */
const BAR_PILLS: SummonPillRect[] = [
  { group: 'start', x: 8, width: 120 },
  { group: 'recs', x: 136, width: 200 },
  { group: 'apps', x: 344, width: 300 },
  { group: 'right', x: 1600, width: 280 },
  { group: 'showdesk', x: 1912, width: 8 },
]

function state(): SummonState {
  return initialSummonState(GROUPS)
}

/* ================================================================
 * 一、唤出条几何：镜像 pill 横向区间，视觉 3px / 命中 9px 两个口径
 * ================================================================ */

describe('唤出条几何（planSummonGeometry）', () => {
  it('镜像映射：逐组 1:1 镜像所属 pill 的横向区间与宽度', () => {
    const geo = planSummonGeometry(BAR_PILLS, BAND)
    expect(geo.map((g) => [g.group, g.x, g.width])).toEqual([
      ['start', 8, 120],
      ['recs', 136, 200],
      ['apps', 344, 300],
      ['right', 1600, 280],
      ['showdesk', 1912, 8],
    ])
  })

  it('两个口径分离：视觉条 3px 贴屏底、命中区 9px（命中区比视觉高，好摸不碍眼）', () => {
    const geo = planSummonGeometry(BAR_PILLS, BAND)
    for (const g of geo) {
      expect(g.visualHeight).toBe(SUMMON_STRIP_VISUAL_HEIGHT)
      expect(g.visualHeight).toBe(3)
      expect(g.hitHeight).toBe(SUMMON_STRIP_HIT_HEIGHT)
      expect(g.hitHeight).toBe(9)
      // 两者都贴屏幕底边（客户区底 = 屏底）
      expect(g.visualTop + g.visualHeight).toBe(BAND)
      expect(g.hitTop + g.hitHeight).toBe(BAND)
      // 命中区比视觉高 → 命中区上缘在视觉条之上
      expect(g.hitTop).toBeLessThan(g.visualTop)
    }
  })

  it('组间空隙不出条：只有有 pill 的组才出一条（空隙不被任何条覆盖）', () => {
    const geo = planSummonGeometry(BAR_PILLS, BAND)
    expect(geo.map((g) => [g.x, g.x + g.width])).toEqual([
      [8, 128], [136, 336], [344, 644], [1600, 1880], [1912, 1920],
    ])
  })

  it('显示桌面细条在最右端独立一条（自己的窄条，不并进右组）', () => {
    const geo = planSummonGeometry(BAR_PILLS, BAND)
    const sliver = geo.filter((g) => g.group === 'showdesk')
    expect(sliver).toHaveLength(1)
    expect(sliver[0].x).toBe(1912)
    expect(sliver[0].width).toBe(8)
  })

  it('pill 相叠 → 条夹取到互不重叠（每条仍可独立命中）', () => {
    const geo = planSummonGeometry([
      { group: 'a', x: 0, width: 100 },
      { group: 'b', x: 50, width: 100 },
    ], BAND)
    expect(geo.map((g) => [g.group, g.x, g.width])).toEqual([['a', 0, 100], ['b', 100, 50]])
    expect(geo[0].x + geo[0].width).toBeLessThanOrEqual(geo[1].x)
    for (const g of geo) expect(g.width).toBeGreaterThan(0)
  })

  it('组增删 1:1 跟随：按输入矩形集重算，不留历史态', () => {
    const withoutRecs = planSummonGeometry(BAR_PILLS.filter((p) => p.group !== 'recs'), BAND)
    expect(withoutRecs.map((g) => g.group)).toEqual(['start', 'apps', 'right', 'showdesk'])
    const withExtra = planSummonGeometry([...BAR_PILLS, { group: 'extra', x: 700, width: 60 }], BAND)
    expect(withExtra.map((g) => g.group)).toEqual(['start', 'recs', 'apps', 'right', 'showdesk', 'extra'])
  })

  it('空组（零宽 pill）不出条', () => {
    const geo = planSummonGeometry([
      { group: 'start', x: 8, width: 120 },
      { group: 'empty', x: 200, width: 0 },
    ], BAND)
    expect(geo.map((g) => g.group)).toEqual(['start'])
  })

  it('输入不被改动（纯函数不写回调用方的矩形集）', () => {
    const pills = BAR_PILLS.map((p) => ({ ...p }))
    const snapshot = pills.map((p) => ({ ...p }))
    planSummonGeometry(pills, BAND)
    expect(pills).toEqual(snapshot)
  })
})

/* ================================================================
 * 二、热区 id 编码：对账靠它还原「指针此刻在哪」
 * ================================================================ */

describe('唤出热区 id 编码', () => {
  it('条命中区与弹出 pill 命中区分开编码，可原样往返解析', () => {
    expect(parseSummonZone(stripZoneId('apps'))).toEqual({ group: 'apps', kind: 'strip' })
    expect(parseSummonZone(pillZoneId('apps'))).toEqual({ group: 'apps', kind: 'pill' })
  })

  it('非唤出热区 id（常态栏面 pill 矩形等）解析为 null——不误认成唤出命中区', () => {
    expect(parseSummonZone('pill-start')).toBeNull()
    expect(parseSummonZone('right-pill')).toBeNull()
    expect(parseSummonZone(null)).toBeNull()
    expect(parseSummonZone(undefined)).toBeNull()
  })

  it('条与 pill 的 id 不互相误解析（前缀不同）', () => {
    expect(parseSummonZone('summon:strip:showdesk')?.kind).toBe('strip')
    expect(parseSummonZone('summon:pill:showdesk')?.kind).toBe('pill')
  })
})

/* ================================================================
 * 三、指针对账：悬停 150ms 弹出 / 点击立即 / 400ms 宽限 / 按组独立
 * ================================================================ */

describe('唤出指针对账（reconcilePointer + tickSummon）', () => {
  it('指针停在条上 → 150ms 后弹出该组（149 不弹 / 150 弹）', () => {
    let s = reconcilePointer(state(), stripZoneId('apps'), T0)
    expect(s.groups.apps.popped).toBe(false)
    s = tickSummon(s, T0 + SUMMON_HOVER_DELAY_MS - 1)
    expect(s.groups.apps.popped).toBe(false)
    s = tickSummon(s, T0 + SUMMON_HOVER_DELAY_MS)
    expect(s.groups.apps.popped).toBe(true)
  })

  it('快速扫过不误触发：指针离开条 → 悬停作废，不弹出', () => {
    let s = reconcilePointer(state(), stripZoneId('apps'), T0)
    s = reconcilePointer(s, null, T0 + 50)
    s = tickSummon(s, T0 + 5_000)
    expect(s.groups.apps.popped).toBe(false)
  })

  it('点击立即弹出（不吃 150ms 延迟）', () => {
    const s = clickStrip(state(), 'apps', T0)
    expect(s.groups.apps.popped).toBe(true)
  })

  it('指针离开已弹出的组 → 400ms 宽限才收起（399 仍弹 / 400 收）', () => {
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, null, T0 + 10)
    expect(s.groups.apps.popped).toBe(true)
    s = tickSummon(s, T0 + 10 + SUMMON_GRACE_MS - 1)
    expect(s.groups.apps.popped).toBe(true)
    s = tickSummon(s, T0 + 10 + SUMMON_GRACE_MS)
    expect(s.groups.apps.popped).toBe(false)
  })

  it('各组互相独立：点击 apps + 悬停 right → 两组可同时在场', () => {
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, stripZoneId('right'), T0 + 10)
    s = tickSummon(s, T0 + 10 + SUMMON_HOVER_DELAY_MS)
    expect(s.groups.apps.popped).toBe(true)
    expect(s.groups.right.popped).toBe(true)
  })

  it('各组收起也独立：apps 的宽限到点即收，指针仍在条上的 right 不受影响', () => {
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, stripZoneId('right'), T0 + 10) // 指针移到 right 的条 → apps 起宽限
    s = tickSummon(s, T0 + 10 + SUMMON_HOVER_DELAY_MS)
    expect(s.groups.apps.popped).toBe(true)
    expect(s.groups.right.popped).toBe(true)
    s = tickSummon(s, T0 + 10 + SUMMON_GRACE_MS + 10) // apps 的 400ms 宽限到点
    expect(s.groups.apps.popped).toBe(false)
    expect(s.groups.right.popped).toBe(true) // 指针仍压在 right 的条上 → 不收
  })

  it('静止指针对账：指针压在已弹出的 pill 上 → 该组保持弹出（长期不收）', () => {
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, pillZoneId('apps'), T0 + 10)
    s = tickSummon(s, T0 + 30_000)
    expect(s.groups.apps.popped).toBe(true)
  })

  it('振荡回归：弹出→收→弹 的振荡被钉住（对账纠正悬停态后该组不再塌）', () => {
    // 原型教训：组 pill 弹出/收起改变指针下的元素，浏览器补发的 enter/leave 不可靠，
    // 静止指针会「弹出→收→弹」振荡。防线 = 按光标坐标 hit-test 对账（zoneId 为唯一事实），
    // 指针落在 pill 上则宽限作废。本例复现噪声离开 + 对账纠正，断言该组不再收起。
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, stripZoneId('apps'), T0 + 5)
    // 噪声①：对账拍报「指针不在任何命中区」
    s = reconcilePointer(s, null, T0 + 20)
    // 对账纠正：指针其实压在 pill 上
    s = reconcilePointer(s, pillZoneId('apps'), T0 + 45)
    // 噪声②：又报一次离开，再次纠正
    s = reconcilePointer(s, null, T0 + 70)
    s = reconcilePointer(s, pillZoneId('apps'), T0 + 95)
    // 此后无论过多久都不该再收（收过一次即构成「弹出→收→弹」振荡）
    for (const at of [T0 + 400, T0 + 1_000, T0 + 5_000, T0 + 30_000]) {
      s = tickSummon(s, at)
      expect(s.groups.apps.popped).toBe(true)
    }
  })

  it('真正离开（无对账纠正）时仍按 400ms 宽限收起——防线不吞掉正常收起', () => {
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, null, T0 + 10)
    s = tickSummon(s, T0 + 10 + SUMMON_GRACE_MS)
    expect(s.groups.apps.popped).toBe(false)
  })

  it('指针从条移到同组的 pill：组不塌（宽限不起算——先落进入再落离开）', () => {
    let s = reconcilePointer(state(), stripZoneId('apps'), T0)
    s = tickSummon(s, T0 + SUMMON_HOVER_DELAY_MS)
    expect(s.groups.apps.popped).toBe(true)
    s = reconcilePointer(s, pillZoneId('apps'), T0 + 160)
    s = tickSummon(s, T0 + 160 + SUMMON_GRACE_MS + 1)
    expect(s.groups.apps.popped).toBe(true)
  })

  it('指针从 pill 移回同组的条：组不塌（条上仍在命中区内）', () => {
    let s = clickStrip(state(), 'apps', T0)
    s = reconcilePointer(s, pillZoneId('apps'), T0 + 10)
    s = reconcilePointer(s, stripZoneId('apps'), T0 + 20)
    s = tickSummon(s, T0 + 20 + SUMMON_GRACE_MS + 1)
    expect(s.groups.apps.popped).toBe(true)
  })

  it('未知组的热区 id 不新建状态（不凭空长出一个组）', () => {
    const s = reconcilePointer(state(), stripZoneId('ghost'), T0)
    expect(Object.keys(s.groups).sort()).toEqual([...GROUPS].sort())
  })

  it('空组状态推进时钟不炸（无组可推进即原样返回）', () => {
    const empty = initialSummonState([])
    expect(tickSummon(empty, T0)).toEqual(empty)
  })
})

/* ================================================================
 * 四、浮层钉组：自绘浮层在场只钉住所属组
 * ================================================================ */

describe('浮层钉组映射（overlayOwnerGroup / applyOverlayState）', () => {
  it('托盘溢出菜单钉右组；档位菜单同属右组', () => {
    expect(overlayOwnerGroup('taskbar-tray-overflow')).toBe('right')
    expect(overlayOwnerGroup('taskbar-tier-menu')).toBe('right')
  })

  it('应用组右键菜单与多窗选窗列表钉应用组；推荐条目菜单钉推荐组；空白菜单钉开始组', () => {
    expect(overlayOwnerGroup('taskbar-app-menu')).toBe('apps')
    expect(overlayOwnerGroup('taskbar-wins-menu')).toBe('apps')
    expect(overlayOwnerGroup('taskbar-rec-menu')).toBe('recs')
    expect(overlayOwnerGroup('taskbar-blank-menu')).toBe('start')
  })

  it('域外浮层家族不钉任何组（噪声不生事）', () => {
    expect(overlayOwnerGroup('taskbar-unknown')).toBeNull()
    expect(applyOverlayState(state(), 'taskbar-unknown', true, T0)).toEqual(state())
  })

  it('浮层在场 → 所属组钉住不收；其余组照常收', () => {
    let s = applyOverlayState(state(), 'taskbar-tray-overflow', true, T0)
    expect(s.groups.right.pinned).toBe(true)
    expect(s.groups.right.popped).toBe(true)

    s = reconcilePointer(s, null, T0 + 10)
    s = tickSummon(s, T0 + 10 + 5_000)
    expect(s.groups.right.popped).toBe(true) // 被钉住不收

    // 其余组不受浮层影响，照常收
    let t = clickStrip(state(), 'apps', T0)
    t = applyOverlayState(t, 'taskbar-tray-overflow', true, T0)
    t = reconcilePointer(t, null, T0 + 10)
    t = tickSummon(t, T0 + 10 + SUMMON_GRACE_MS)
    expect(t.groups.apps.popped).toBe(false)
    expect(t.groups.right.popped).toBe(true)
  })

  it('浮层关闭 → 解除钉住，指针不在该组则 400ms 后收起', () => {
    let s = applyOverlayState(state(), 'taskbar-tray-overflow', true, T0)
    s = applyOverlayState(s, 'taskbar-tray-overflow', false, T0 + 100)
    expect(s.groups.right.pinned).toBe(false)
    s = tickSummon(s, T0 + 100 + SUMMON_GRACE_MS - 1)
    expect(s.groups.right.popped).toBe(true)
    s = tickSummon(s, T0 + 100 + SUMMON_GRACE_MS)
    expect(s.groups.right.popped).toBe(false)
  })

  it('六面浮层都有归属组（映射表覆盖主进程 popupHosts 登记的六面）', () => {
    expect(Object.keys(OVERLAY_OWNER_GROUP).sort()).toEqual([
      'taskbar-app-menu',
      'taskbar-blank-menu',
      'taskbar-rec-menu',
      'taskbar-tier-menu',
      'taskbar-tray-overflow',
      'taskbar-wins-menu',
    ])
  })
})

/* ================================================================
 * 五、收栏态热区声明：条命中区 + 已弹出 pill 的命中区
 * ================================================================ */

describe('收栏态热区声明（summonHotZones）', () => {
  const geo = planSummonGeometry(BAR_PILLS, BAND)
  const pillRects = {
    start: { x: 8, y: 0, w: 120, h: 48 },
    recs: { x: 136, y: 0, w: 200, h: 48 },
    apps: { x: 344, y: 0, w: 300, h: 48 },
    right: { x: 1600, y: 0, w: 280, h: 48 },
    showdesk: { x: 1912, y: 0, w: 8, h: 48 },
  }

  it('逐组一条条命中区：id 带组标号、几何取命中区口径（9px 贴底）', () => {
    const zones = summonHotZones(state(), geo, pillRects)
    expect(zones.map((z) => z.id)).toEqual([
      'summon:strip:start',
      'summon:strip:recs',
      'summon:strip:apps',
      'summon:strip:right',
      'summon:strip:showdesk',
    ])
    const apps = zones.find((z) => z.id === 'summon:strip:apps')!
    expect(apps).toMatchObject({ x: 344, y: BAND - 9, w: 300, h: 9 })
  })

  it('已弹出组的条隐藏 → 该组不再出条命中区，改出弹出 pill 的命中区', () => {
    const s = clickStrip(state(), 'apps', T0)
    const zones = summonHotZones(s, geo, pillRects)
    expect(zones.map((z) => z.id)).not.toContain('summon:strip:apps')
    const pill = zones.find((z) => z.id === 'summon:pill:apps')!
    expect(pill).toMatchObject({ x: 344, y: 0, w: 300, h: 48 })
  })

  it('零尺寸的弹出 pill 矩形不出命中区（未渲染的元素不占位）', () => {
    const s = clickStrip(state(), 'apps', T0)
    const zones = summonHotZones(s, geo, { ...pillRects, apps: { x: 0, y: 0, w: 0, h: 0 } })
    expect(zones.map((z) => z.id)).not.toContain('summon:pill:apps')
  })

  it('弹出 pill 的命中区排在条命中区之前（浮起的组在视觉之上，命中优先）', () => {
    const s = clickStrip(state(), 'right', T0)
    const zones = summonHotZones(s, geo, pillRects)
    expect(zones[0].id).toBe('summon:pill:right')
  })
})

/* ================================================================
 * 六、渲染层接线守卫（源码级）：对账通路 / 动画口径
 * ================================================================ */

const RENDERER_SRC = readFileSync(path.join(APP_ROOT, 'src/renderer/taskbar.ts'), 'utf8')
const HTML_SRC = readFileSync(path.join(APP_ROOT, 'src/renderer/taskbar.html'), 'utf8')
const SUMMON_SRC = readFileSync(path.join(APP_ROOT, 'src/renderer/taskbar-summon.ts'), 'utf8')

describe('渲染层接线守卫（工单242）', () => {
  it('悬停判定不采信浏览器 enter/leave 事件序列（原型振荡教训）', () => {
    expect(RENDERER_SRC).not.toMatch(/mouseenter|mouseleave|mouseover|mouseout/)
  })

  it('对账走主进程光标轮询通路：渲染层订阅光标区事件，不用渲染层自造坐标源', () => {
    expect(RENDERER_SRC).toContain("'taskbar/cursor-zone'")
  })

  it('浮层钉组订阅浮层在场事件', () => {
    expect(RENDERER_SRC).toContain("'taskbar/popup-state'")
  })

  it('唤出条几何落同族存证（taskbar-<名> 族，与 taskbar-retract / taskbar-yield 同源）', () => {
    expect(RENDERER_SRC).toContain("notify('taskbar-summon-strips'")
  })

  it('唤出条命中区沿用既有热区通路（declareHotZones → setHotZones）', () => {
    expect(RENDERER_SRC).toMatch(/declareHotZones[\s\S]*setHotZones/)
  })

  it('140ms 上滑淡入：关键帧含位移与 140ms 时长', () => {
    expect(SUMMON_RISE_MS).toBe(140)
    expect(SUMMON_RISE_DY).toBe(8)
    const shifted = summonRiseKeyframes(true)
    expect(shifted).toEqual([
      { opacity: 0, transform: 'translateY(calc(-50% + 8px))' },
      { opacity: 1, transform: 'translateY(-50%)' },
    ])
    // 满高竖条（显示桌面细条）无处可滑——只淡入
    expect(summonRiseKeyframes(false)).toEqual([{ opacity: 0 }, { opacity: 1 }])
    // 渲染层按这组参数施加（Web Animations API——条带页样式表不容 @keyframes 嵌套块）
    expect(RENDERER_SRC).toContain('summonRiseKeyframes(')
    expect(RENDERER_SRC).toMatch(/duration:\s*SUMMON_RISE_MS/)
  })

  it('条的高度归样式表（渲染层只写横向几何——挤撞守卫同款纪律，工单238）', () => {
    expect(RENDERER_SRC).not.toMatch(/\.style\.height\s*=/)
    const hit = /\.tb-summon-strip\s*\{[^}]*height:\s*(\d+)px/.exec(HTML_SRC)?.[1]
    const visual = /\.tb-summon-bar\s*\{[^}]*height:\s*(\d+)px/.exec(HTML_SRC)?.[1]
    expect(Number(hit)).toBe(SUMMON_STRIP_HIT_HEIGHT)
    expect(Number(visual)).toBe(SUMMON_STRIP_VISUAL_HEIGHT)
  })

  it('组收起瞬时：条带页 CSS 不挂任何过渡声明（收起无淡出/位移过渡——display 切换即瞬时）', () => {
    expect(HTML_SRC).not.toMatch(/transition\s*:/)
    // 被唤出的组复现规则在位（display 覆盖退场态）
    expect(HTML_SRC).toMatch(/maximize-retract"\]\s+#pill-start\.summon-popped/)
  })

  it('渲染层不得运行时 import 共享契约面 shared/contract（值模块 shared/retract 不在此列）', () => {
    const runtime = SUMMON_SRC.split('\n')
      .filter((l) => /^import\s+\{/.test(l) && l.includes('shared/contract'))
    expect(runtime).toEqual([])
  })

  it('决策逻辑单一来源：渲染层不另写一份 planSummonStrips / reduceSummon 实现', () => {
    expect(SUMMON_SRC).not.toMatch(/export\s+function\s+(planSummonStrips|reduceSummon)\b/)
    expect(SUMMON_SRC).toMatch(/from\s+'\.\.\/shared\/retract\.js'/)
  })
})
