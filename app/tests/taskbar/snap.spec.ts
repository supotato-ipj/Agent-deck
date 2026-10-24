// 分屏会话探针边界（工单269，spec #267 Testing Decision 5）：成员资格纯裁决在
// main/taskbar/snap.ts（isSnapSessionMember / resolveSnapSession——离线可测的公开缝），
// FFI 采集（probeSnapWindows）离线不加载（lazy-bind 纪律，yield.ts / windows.ts 先例）。
// 断言面：arranged / minimized / cloaked / 普通手拉几何窗 / 自家与桌面宿主排除 /
// 按显示器隔离 / 识别不可用严格降级（不猜矩形）。
// 工单270 追加：成员集合（snapSessionMembers——代表性布局统一判定）/ 结束因果分类
// （classifySnapSessionEnd——会话结束可区分存证的纯裁决面）。
import { describe, expect, it } from 'vitest'
import {
  classifySnapSessionEnd,
  isSnapSessionMember,
  resolveSnapSession,
  snapSessionMembers,
} from '../../src/main/taskbar/snap'
import type { SnapSessionEndCause, SnapWindowFact } from '../../src/main/taskbar/snap'
import type { PhysRect } from '../../src/shared/retract'

/** 主屏物理矩形（2560×1440 @ 原点 0,0，与探针同坐标系） */
const PRIMARY: PhysRect = { left: 0, top: 0, right: 2560, bottom: 1440 }
/** 副屏物理矩形（主屏右侧） */
const SECONDARY: PhysRect = { left: 2560, top: 0, right: 5120, bottom: 1440 }
const OWN_EXE = 'C:\\Users\\dev\\deck\\agent-deck.exe'
const OTHER_EXE = 'C:\\Program Files\\Notepad\\notepad.exe'

/** 合格真 Snap 窗的事实快照（左半屏 Snap 几何——含 DWM 7px 不可见边，#268 实测形态） */
function snapWin(over: Partial<SnapWindowFact> = {}): SnapWindowFact {
  return {
    hwnd: 101,
    pid: 2001,
    className: 'Chrome_WidgetWin_1',
    exe: OTHER_EXE,
    title: '记事本',
    rect: { left: -7, top: -7, right: 1287, bottom: 1447 },
    iconic: false,
    arranged: true,
    visible: true,
    cloaked: false,
    cloakedShell: false,
    toolWindow: false,
    owned: false,
    appWindow: false,
    ...over,
  }
}

describe('isSnapSessionMember 成员资格（工单269 纯裁决）', () => {
  it('合格、非最小化、真 Snap、落在目标显示器 → 成员（单个即建立会话，不要求成对）', () => {
    expect(isSnapSessionMember(snapWin(), PRIMARY, OWN_EXE)).toBe(true)
  })

  it('手动拖成相同半屏几何但不具备真 Snap 状态 → 非成员（矩形不得成为身份兜底）', () => {
    // 几何与 snapWin 逐字相同（左半屏铺满），只把 arranged 置假——身份只认 IsWindowArranged
    expect(isSnapSessionMember(snapWin({ arranged: false }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('识别不可用（arranged 缺位 null）→ 非成员（不猜、不兜底）', () => {
    expect(isSnapSessionMember(snapWin({ arranged: null }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('最小化 Snap 窗 → 非成员（最后一个 Snap 最小化即会话结束）', () => {
    expect(isSnapSessionMember(snapWin({ iconic: true }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('其他虚拟桌面（cloaked）→ 非成员（当前虚拟桌面会话不含其他桌面布局）', () => {
    expect(isSnapSessionMember(snapWin({ cloaked: true }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('SHELL 位 cloak（其他虚拟桌面的分位事实，工单270）→ 非成员（当前桌面隔离口径不因分位采集放宽）', () => {
    // cloakedShell=true 蕴含 cloaked=true（SHELL 位是 cloak 值的一分位）；分位采集只为
    // 结束因果分类服务，成员资格仍按「任何 cloak 即拒」的既有口径
    expect(isSnapSessionMember(snapWin({ cloaked: true, cloakedShell: true }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('工具窗 / 有属主无 APPWINDOW / 空标题 → 非成员（沿用现有合格顶层窗口过滤）', () => {
    expect(isSnapSessionMember(snapWin({ toolWindow: true }), PRIMARY, OWN_EXE)).toBe(false)
    expect(isSnapSessionMember(snapWin({ owned: true, appWindow: false }), PRIMARY, OWN_EXE)).toBe(false)
    expect(isSnapSessionMember(snapWin({ title: null }), PRIMARY, OWN_EXE)).toBe(false)
    expect(isSnapSessionMember(snapWin({ title: '' }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('自家进程的 Snap 形态窗 → 非成员（自家排除，exe 归一口径）', () => {
    expect(isSnapSessionMember(snapWin({ exe: OWN_EXE }), PRIMARY, OWN_EXE)).toBe(false)
    // 大小写/斜杠归一（NTFS 语义）同样排除
    expect(isSnapSessionMember(snapWin({ exe: 'c:/users/dev/DECK/AGENT-DECK.EXE' }), PRIMARY, OWN_EXE)).toBe(false)
  })

  it('桌面宿主类 → 非成员（Progman/WorkerW/Shell_TrayWnd/Shell_SecondaryTrayWnd）', () => {
    for (const className of ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']) {
      expect(isSnapSessionMember(snapWin({ className }), PRIMARY, OWN_EXE)).toBe(false)
    }
  })

  it('按显示器隔离：矩形不与目标显示器相交 → 非成员（副屏 Snap 不算主屏会话）', () => {
    // 窗在副屏（x ≥ 2560），对主屏会话判非成员；同一窗对副屏会话是成员
    const onSecondary = snapWin({ rect: { left: 2560, top: -7, right: 3847, bottom: 1447 } })
    expect(isSnapSessionMember(onSecondary, PRIMARY, OWN_EXE)).toBe(false)
    expect(isSnapSessionMember(onSecondary, SECONDARY, OWN_EXE)).toBe(true)
  })

  it('矩形只与目标显示器擦边相交（零面积接触）→ 非成员（相交须有正面积）', () => {
    const touching = snapWin({ rect: { left: 2560, top: 0, right: 3840, bottom: 1440 } })
    expect(isSnapSessionMember(touching, PRIMARY, OWN_EXE)).toBe(false)
  })
})

describe('resolveSnapSession 会话裁决（工单269 纯裁决）', () => {
  it('空集 → 无会话', () => {
    expect(resolveSnapSession([], PRIMARY, OWN_EXE)).toBe(false)
  })

  it('单个合格 Snap 窗即建立会话（不要求成对或互补，不依赖布局 ID）', () => {
    expect(resolveSnapSession([snapWin()], PRIMARY, OWN_EXE)).toBe(true)
  })

  it('多窗混合：任一合格非最小化 Snap 窗在场 → 会话存续', () => {
    const windows = [
      snapWin({ hwnd: 1, arranged: false }), // 手拉半屏几何（伪分屏）
      snapWin({ hwnd: 2, iconic: true }), // 最小化的 Snap 窗
      snapWin({ hwnd: 3 }), // 合格真 Snap
    ]
    expect(resolveSnapSession(windows, PRIMARY, OWN_EXE)).toBe(true)
  })

  it('最后一个 Snap 窗最小化/解除（只剩非成员）→ 会话结束', () => {
    const windows = [
      snapWin({ hwnd: 1, arranged: false }),
      snapWin({ hwnd: 2, iconic: true }),
      snapWin({ hwnd: 3, cloaked: true }),
    ]
    expect(resolveSnapSession(windows, PRIMARY, OWN_EXE)).toBe(false)
  })

  it('识别不可用（全体 arranged 缺位）→ 无会话（严格降级：仅关分屏收栏，不几何猜测）', () => {
    expect(resolveSnapSession([
      snapWin({ hwnd: 1, arranged: null }),
      snapWin({ hwnd: 2, arranged: null }),
    ], PRIMARY, OWN_EXE)).toBe(false)
  })

  it('会话按显示器隔离：副屏 Snap 集合对主屏会话恒无份（不引入全局判定）', () => {
    const secondarySnaps = [
      snapWin({ hwnd: 1, rect: { left: 2560, top: -7, right: 3847, bottom: 1447 } }),
      snapWin({ hwnd: 2, rect: { left: 3833, top: -7, right: 5127, bottom: 1447 } }),
    ]
    expect(resolveSnapSession(secondarySnaps, PRIMARY, OWN_EXE)).toBe(false)
    expect(resolveSnapSession(secondarySnaps, SECONDARY, OWN_EXE)).toBe(true)
  })
})

/* ================================================================
 * 工单270：成员集合（代表性布局统一判定）与结束因果分类（可区分存证）
 * ================================================================ */

/** 主屏 2560×1440 的代表性 Snap 布局事实族（含 DWM 7px 不可见边口径，#268 实测形态） */
function layoutFacts(layout: 'dual' | 'corners' | 'three-col' | 'one-third-two-thirds'): SnapWindowFact[] {
  const W = 2560, H = 1440, E = 7 // E = DWM 不可见边外扩
  switch (layout) {
    case 'dual': // 左右各半
      return [
        snapWin({ hwnd: 11, rect: { left: -E, top: -E, right: W / 2 + E, bottom: H + E } }),
        snapWin({ hwnd: 12, rect: { left: W / 2 - E, top: -E, right: W + E, bottom: H + E } }),
      ]
    case 'corners': // 四角（上下半 × 左右半）
      return [
        snapWin({ hwnd: 21, rect: { left: -E, top: -E, right: W / 2 + E, bottom: H / 2 + E } }),
        snapWin({ hwnd: 22, rect: { left: W / 2 - E, top: -E, right: W + E, bottom: H / 2 + E } }),
        snapWin({ hwnd: 23, rect: { left: -E, top: H / 2 - E, right: W / 2 + E, bottom: H + E } }),
        snapWin({ hwnd: 24, rect: { left: W / 2 - E, top: H / 2 - E, right: W + E, bottom: H + E } }),
      ]
    case 'three-col': // 三栏（各三分之一）
      return [
        snapWin({ hwnd: 31, rect: { left: -E, top: -E, right: W / 3 + E, bottom: H + E } }),
        snapWin({ hwnd: 32, rect: { left: W / 3 - E, top: -E, right: (2 * W) / 3 + E, bottom: H + E } }),
        snapWin({ hwnd: 33, rect: { left: (2 * W) / 3 - E, top: -E, right: W + E, bottom: H + E } }),
      ]
    case 'one-third-two-thirds': // 三分之一 + 三分之二
      return [
        snapWin({ hwnd: 41, rect: { left: -E, top: -E, right: W / 3 + E, bottom: H + E } }),
        snapWin({ hwnd: 42, rect: { left: W / 3 - E, top: -E, right: W + E, bottom: H + E } }),
      ]
  }
}

describe('snapSessionMembers 成员集合（工单270：多窗 Snap 集合生命周期）', () => {
  it.each(['dual', 'corners', 'three-col', 'one-third-two-thirds'] as const)(
    '代表性布局 %s：全部合格真 Snap 窗都是成员、会话活跃（同一判定，无布局专用分支）',
    (layout) => {
      const facts = layoutFacts(layout)
      const members = snapSessionMembers(facts, PRIMARY, OWN_EXE)
      expect(members.map((m) => m.hwnd)).toEqual(facts.map((f) => f.hwnd))
      expect(resolveSnapSession(facts, PRIMARY, OWN_EXE)).toBe(true)
    },
  )

  it('最小化其中一个 Snap 窗 → 该成员出列、其余维持会话（集合生命周期：其一最小化不结束）', () => {
    const facts = layoutFacts('dual')
    const after = facts.map((f) => (f.hwnd === 12 ? { ...f, iconic: true } : f))
    const members = snapSessionMembers(after, PRIMARY, OWN_EXE)
    expect(members.map((m) => m.hwnd)).toEqual([11])
    expect(resolveSnapSession(after, PRIMARY, OWN_EXE)).toBe(true)
  })

  it('其中一个 Snap 窗关闭（从事实集消失）→ 其余维持会话', () => {
    const after = layoutFacts('dual').filter((f) => f.hwnd !== 12)
    expect(snapSessionMembers(after, PRIMARY, OWN_EXE).map((m) => m.hwnd)).toEqual([11])
    expect(resolveSnapSession(after, PRIMARY, OWN_EXE)).toBe(true)
  })

  it('最后一个 Snap 窗最小化 → 空成员集、会话结束（最后一个才结束）', () => {
    const after = layoutFacts('dual').map((f) => ({ ...f, iconic: true }))
    expect(snapSessionMembers(after, PRIMARY, OWN_EXE)).toEqual([])
    expect(resolveSnapSession(after, PRIMARY, OWN_EXE)).toBe(false)
  })

  it('多窗混合其他桌面/手拉几何：只数合格成员，其余各归各位（统一判定不改口径）', () => {
    const facts = [
      ...layoutFacts('one-third-two-thirds'),
      snapWin({ hwnd: 51, cloaked: true, cloakedShell: true, rect: { left: 2560, top: -7, right: 3833, bottom: 1447 } }), // 其他桌面 Snap
      snapWin({ hwnd: 52, arranged: false }), // 手拉半屏几何
      snapWin({ hwnd: 53, iconic: true }), // 最小化 Snap
    ]
    expect(snapSessionMembers(facts, PRIMARY, OWN_EXE).map((m) => m.hwnd)).toEqual([41, 42])
  })

  it('识别不可用（available=false 语义：arranged 全缺位）→ 零成员（严格降级不猜）', () => {
    const facts = layoutFacts('dual').map((f) => ({ ...f, arranged: null }))
    expect(snapSessionMembers(facts, PRIMARY, OWN_EXE)).toEqual([])
    expect(resolveSnapSession(facts, PRIMARY, OWN_EXE)).toBe(false)
  })
})

describe('classifySnapSessionEnd 结束因果分类（工单270：可区分存证的纯裁决）', () => {
  it('前成员仍在列但已最小化（iconic）→ minimized', () => {
    const prev = layoutFacts('dual')
    const cur = prev.map((f) => (f.hwnd === 12 ? { ...f, iconic: true } : f))
    // 11 也最小化（最后一个 Snap 最小化即会话结束——两枚同拍最小化是常态路径）
    const curAll = cur.map((f) => (f.hwnd === 11 ? { ...f, iconic: true } : f))
    expect(classifySnapSessionEnd(prev.map((f) => f.hwnd), curAll, PRIMARY)).toBe('minimized')
  })

  it('前成员从事实集消失（已关闭）→ closed', () => {
    const prev = layoutFacts('dual')
    const cur = prev.filter((f) => f.hwnd !== 12)
    expect(classifySnapSessionEnd([12], cur, PRIMARY)).toBe('closed')
  })

  it('前成员仍在列但 arranged=false（解除 Snap）→ unsnapped', () => {
    const prev = layoutFacts('dual')
    const cur = prev.map((f) => (f.hwnd === 12 ? { ...f, arranged: false } : f))
    expect(classifySnapSessionEnd([12], cur, PRIMARY)).toBe('unsnapped')
  })

  it('前成员 cloakedShell（切到其他虚拟桌面）→ desktop-switched', () => {
    const prev = layoutFacts('dual')
    const cur = prev.map((f) => ({ ...f, cloaked: true, cloakedShell: true }))
    expect(classifySnapSessionEnd(prev.map((f) => f.hwnd), cur, PRIMARY)).toBe('desktop-switched')
  })

  it('前成员 app 位 cloak（应用自 cloak，非虚拟桌面）→ unknown（不误报桌面切换）', () => {
    const prev = layoutFacts('dual')
    const cur = prev.map((f) => (f.hwnd === 12 ? { ...f, cloaked: true, cloakedShell: false } : f))
    expect(classifySnapSessionEnd([12], cur, PRIMARY)).toBe('unknown')
  })

  it('前成员仍 arranged、非最小化、非 cloak，但已落在目标显示器外 → left-display（换屏不误报解除）', () => {
    const cur = [snapWin({ hwnd: 12, rect: { left: 2560, top: -7, right: 3833, bottom: 1447 } })]
    expect(classifySnapSessionEnd([12], cur, PRIMARY)).toBe('left-display')
  })

  it('虚拟桌面切换全家福压过最小化（整组同拍消失时按最能解释集合去向的因归类）', () => {
    const prev = layoutFacts('dual')
    const cur = prev.map((f) => (f.hwnd === 12 ? { ...f, iconic: true, cloaked: true, cloakedShell: true } : { ...f, cloaked: true, cloakedShell: true }))
    expect(classifySnapSessionEnd(prev.map((f) => f.hwnd), cur, PRIMARY)).toBe('desktop-switched')
  })

  it('混合去向优先级：desktop-switched > minimized > unsnapped > left-display > closed', () => {
    // 最小化 + 解除同拍 → minimized
    expect(classifySnapSessionEnd([1, 2], [
      snapWin({ hwnd: 1, iconic: true }),
      snapWin({ hwnd: 2, arranged: false }),
    ], PRIMARY)).toBe('minimized')
    // 解除 + 关闭同拍 → unsnapped
    expect(classifySnapSessionEnd([1, 2], [
      snapWin({ hwnd: 1, arranged: false }),
    ], PRIMARY)).toBe('unsnapped')
    // 解除 + 换屏同拍 → unsnapped（用户动作压过几何去向）
    expect(classifySnapSessionEnd([1, 2], [
      snapWin({ hwnd: 1, arranged: false }),
      snapWin({ hwnd: 2, rect: { left: 2560, top: -7, right: 3833, bottom: 1447 } }),
    ], PRIMARY)).toBe('unsnapped')
    // 换屏 + 关闭同拍 → left-display
    expect(classifySnapSessionEnd([1, 2], [
      snapWin({ hwnd: 1, rect: { left: 2560, top: -7, right: 3833, bottom: 1447 } }),
    ], PRIMARY)).toBe('left-display')
  })

  it('空追踪集 → unknown（无可归因成员——账守卫，不抛）', () => {
    expect(classifySnapSessionEnd([], [], PRIMARY)).toBe('unknown')
  })
})
