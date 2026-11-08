/**
 * Agent 平铺窗口范围投影矩阵（工单376，spec #369 决策 6 + 用户故事 44/45）：合格窗口
 * 判据与排除面（副屏/面板自身/系统弹窗/其他桌面）逐项断言；胶囊计数口径 = 全部合格窗
 * （含最小化）。先例：tests/taskbar/apps-plan.spec.ts（构造输入直断输出）。
 */
import { describe, expect, it } from 'vitest'
import { classifyTileWindow, intersectsMainScreen, normalizeExe, projectTileScope, rectMatches } from '../../src/main/desktop/tile-scope'
import type { TileWindowFacts } from '../../src/main/desktop/tile-scope'

const PRIMARY = { left: 0, top: 0, right: 2560, bottom: 1440 }
const OWN = ['C:\\Apps\\agent-deck\\AgentDeck.exe']

const facts = (over: Partial<TileWindowFacts> = {}): TileWindowFacts => ({
  hwnd: 101,
  exe: 'C:\\Windows\\System32\\notepad.exe',
  title: '无标题 - 记事本',
  visible: true,
  cloaked: false,
  cloakedShell: false,
  toolWindow: false,
  owned: false,
  appWindow: false,
  iconic: false,
  resizable: true,
  rect: { left: 100, top: 100, right: 800, bottom: 600 },
  onCurrentDesktop: true,
  ...over,
})

describe('最小化窗豁免主屏相交判（工单377，用户故事 19/44）', () => {
  it('最小化窗矩形为屏外哨兵位（-32000）仍判 tile（保留窗格与计数）', () => {
    const r = classifyTileWindow(facts({ iconic: true, rect: { left: -32000, top: -32000, right: -31800, bottom: -31800 } }), OWN, PRIMARY)
    expect(r).toEqual({ kind: 'tile' })
  })

  it('非最小化窗落在屏外仍按副屏排除（移出主屏 = 退出平铺，story 21）', () => {
    const r = classifyTileWindow(facts({ rect: { left: 3000, top: 0, right: 3800, bottom: 600 } }), OWN, PRIMARY)
    expect(r).toEqual({ kind: 'excluded', reason: 'off-main-screen' })
  })
})

describe('合格窗口判据 classifyTileWindow（工单376）', () => {
  it('普通应用窗（在主屏、当前桌面）= tile', () => {
    expect(classifyTileWindow(facts(), OWN, PRIMARY)).toEqual({ kind: 'tile' })
  })

  it('面板自身进程 = own-process（own exe 归一比较）', () => {
    expect(classifyTileWindow(facts({ exe: 'c:/apps/agent-deck/agentdeck.exe' }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'own-process' })
    expect(normalizeExe('C:/Apps/X/app.EXE')).toBe('c:\\apps\\x\\app.exe')
  })

  it('副屏窗口 = off-main-screen（与主屏无正面积相交）', () => {
    expect(classifyTileWindow(facts({ rect: { left: 2560, top: 0, right: 3840, bottom: 1080 } }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'off-main-screen' })
    // 跨屏但主体在主屏 → 仍算主屏（正面积相交即合格；平铺目标在本屏内由规划保证）
    expect(classifyTileWindow(facts({ rect: { left: 2500, top: 0, right: 3840, bottom: 1080 } }), OWN, PRIMARY))
      .toEqual({ kind: 'tile' })
  })

  it('零矩形（取不到/竞态销毁）= off-main-screen（安全方向）', () => {
    expect(classifyTileWindow(facts({ rect: { left: 0, top: 0, right: 0, bottom: 0 } }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'off-main-screen' })
  })

  it('其他桌面：shell cloak 或 VDM 判非当前（用户故事 45 排除面）', () => {
    expect(classifyTileWindow(facts({ cloakedShell: true }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'other-desktop' })
    expect(classifyTileWindow(facts({ onCurrentDesktop: false }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'other-desktop' })
  })

  it('IsOnCurrent 不可判（null）不因它拒绝（判据缺省通过口径；cloak 判据仍在场）', () => {
    expect(classifyTileWindow(facts({ onCurrentDesktop: null }), OWN, PRIMARY)).toEqual({ kind: 'tile' })
  })

  it('系统弹窗：工具窗 / 有属主无 APPWINDOW = tool-or-popup', () => {
    expect(classifyTileWindow(facts({ toolWindow: true }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'tool-or-popup' })
    expect(classifyTileWindow(facts({ owned: true }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'tool-or-popup' })
    expect(classifyTileWindow(facts({ owned: true, appWindow: true }), OWN, PRIMARY))
      .toEqual({ kind: 'tile' }) // 显式 APPWINDOW 的属主窗是合格应用窗（taskbar 同口径）
  })

  it('应用自 cloak（挂起）= cloaked', () => {
    expect(classifyTileWindow(facts({ cloaked: true }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'cloaked' })
  })

  it('无身份（空 exe / 空标题）= no-identity（改窗与计数都无从寻址）', () => {
    expect(classifyTileWindow(facts({ exe: '' }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'no-identity' })
    expect(classifyTileWindow(facts({ title: '' }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'no-identity' })
  })

  it('Shell 浮层宿主 = shell-host（startmenuexperiencehost/searchhost）', () => {
    expect(classifyTileWindow(facts({ exe: 'C:\\Windows\\SystemApps\\Shell\\SearchHost.exe' }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'shell-host' })
  })

  it('通知 toast 横幅（ShellExperienceHost CoreWindow）= shell-host（工单420）', () => {
    // 签名 = PR #412 真机取证事实：exe=shellexperiencehost、class=CoreWindow、
    // 虚拟屏右下横幅区、无 THICKFRAME、owned/toolWindow/appWindow 全否（否则早被
    // tool-or-popup 拦下）——真机三轮同签名计为 fixed-size 异常成员的资格面口子
    expect(classifyTileWindow(facts({
      exe: 'C:\\Windows\\SystemApps\\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\\ShellExperienceHost.exe',
      title: 'accept-guard',
      resizable: false,
      rect: { left: 2164, top: 1269, right: 2560, bottom: 1440 },
    }), OWN, PRIMARY)).toEqual({ kind: 'excluded', reason: 'shell-host' })
  })

  it('不可见样式位 = not-visible', () => {
    expect(classifyTileWindow(facts({ visible: false }), OWN, PRIMARY))
      .toEqual({ kind: 'excluded', reason: 'not-visible' })
  })

  it('最小化窗仍合格（计数含最小化——GLOSSARY「顶部窗口胶囊」口径）', () => {
    expect(classifyTileWindow(facts({ iconic: true }), OWN, PRIMARY)).toEqual({ kind: 'tile' })
  })
})

describe('批量投影 projectTileScope（工单376）', () => {
  it('成员保持 z 序、排除窗带理由入账', () => {
    const panel = facts({ hwnd: 1, exe: OWN[0]!, title: 'AGENT DECK' })
    const np1 = facts({ hwnd: 2, rect: { left: 0, top: 0, right: 1280, bottom: 1392 } })
    const np2 = facts({ hwnd: 3, rect: { left: 1280, top: 0, right: 2560, bottom: 1392 } })
    const popup = facts({ hwnd: 4, toolWindow: true, title: '提示' })
    const other = facts({ hwnd: 5, cloakedShell: true, title: '别桌的窗' })
    const proj = projectTileScope([panel, np1, np2, popup, other], OWN, PRIMARY)
    expect(proj.members.map((m) => m.hwnd)).toEqual([2, 3])
    expect(proj.excluded).toEqual([
      { hwnd: 1, reason: 'own-process' },
      { hwnd: 4, reason: 'tool-or-popup' },
      { hwnd: 5, reason: 'other-desktop' },
    ])
  })
})

describe('几何判据（工单376 共用）', () => {
  it('intersectsMainScreen 正面积判据', () => {
    expect(intersectsMainScreen({ left: 0, top: 0, right: 2560, bottom: 1440 }, PRIMARY)).toBe(true)
    expect(intersectsMainScreen({ left: -10, top: 0, right: 0, bottom: 100 }, PRIMARY)).toBe(false) // 零宽
  })

  it('rectMatches 容差等值', () => {
    const t = { left: 10, top: 20, right: 130, bottom: 240 }
    expect(rectMatches({ left: 10, top: 20, right: 130, bottom: 240 }, t)).toBe(true)
    expect(rectMatches({ left: 11, top: 20, right: 131, bottom: 240 }, t)).toBe(true) // tol 1
    expect(rectMatches({ left: 12, top: 20, right: 130, bottom: 240 }, t)).toBe(false)
  })
})

describe('受管窗豁免 off-main-screen 排除（工单405，屏外滚动带成员账）', () => {
  // 屏外带成员被布局写到主屏右缘之外的列上——它们的「屏外」是受管布局自身的产物，
  // 不是副屏迁移。豁免判据沿用最小化豁免同款诚实口径（tile-scope.ts 头注）：窗口停在
  // 布局实际落定的矩形上（编排层以 lastPlaced 匹配给出豁免集），按矩形判会把自家
  // 带成员误判成副屏窗踢出成员账。其余拒绝面（其他桌面/cloaked 等）不受豁免。
  it('豁免集内的屏外窗判 tile；不在豁免集仍排除（story 21 移出主屏语义保持）', () => {
    const off = facts({ hwnd: 9, rect: { left: 2600, top: 0, right: 3880, bottom: 1392 } })
    expect(classifyTileWindow(off, OWN, PRIMARY)).toEqual({ kind: 'excluded', reason: 'off-main-screen' })
    expect(classifyTileWindow(off, OWN, PRIMARY, [9])).toEqual({ kind: 'tile' })
  })
  it('豁免只作用于 off-main-screen：其他桌面/cloaked 照常拒绝', () => {
    const other = facts({ hwnd: 9, rect: { left: 2600, top: 0, right: 3880, bottom: 1392 }, cloakedShell: true })
    expect(classifyTileWindow(other, OWN, PRIMARY, [9])).toEqual({ kind: 'excluded', reason: 'other-desktop' })
  })
  it('projectTileScope 透传豁免集', () => {
    const fs = [
      facts({ hwnd: 1 }),
      facts({ hwnd: 9, rect: { left: 2600, top: 0, right: 3880, bottom: 1392 } }),
    ]
    expect(projectTileScope(fs, OWN, PRIMARY).members.map((m) => m.hwnd)).toEqual([1])
    expect(projectTileScope(fs, OWN, PRIMARY, [9]).members.map((m) => m.hwnd)).toEqual([1, 9])
  })
})
