// 分屏会话探针边界（工单269，spec #267 Testing Decision 5）：成员资格纯裁决在
// main/taskbar/snap.ts（isSnapSessionMember / resolveSnapSession——离线可测的公开缝），
// FFI 采集（probeSnapWindows）离线不加载（lazy-bind 纪律，yield.ts / windows.ts 先例）。
// 断言面：arranged / minimized / cloaked / 普通手拉几何窗 / 自家与桌面宿主排除 /
// 按显示器隔离 / 识别不可用严格降级（不猜矩形）。
import { describe, expect, it } from 'vitest'
import { isSnapSessionMember, resolveSnapSession } from '../../src/main/taskbar/snap'
import type { SnapWindowFact } from '../../src/main/taskbar/snap'
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
