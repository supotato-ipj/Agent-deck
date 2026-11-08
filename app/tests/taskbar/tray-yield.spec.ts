// 托盘右键回放的条带让位闸门状态机（工单194，ADR-0013「托盘自带菜单让位」方向）：
// 回放右键期间条带退出置顶带，「菜单已关闭」三路侦测（目标 pid 的 #32768 菜单窗消失 /
// 前台窗变化 / 超时上限）任一命中即恢复。纯状态机单测——FFI 枚举与置顶切换是效果层，
// 由真机人工验收覆盖（native 菜单 z 序难以稳定自动断言，事件时序存证为主），
// 不进单测（工单46 Testing Decisions、yield.spec.ts 同款口径）。
import { describe, expect, it } from 'vitest'
import { TrayYieldMachine, TRAY_YIELD_POLL_MS, TRAY_YIELD_TIMEOUT_MS } from '../../src/main/taskbar/tray-yield'

const OWN_PID = 100
const TARGET_PID = 200 // 回放目标（托盘图标属主应用）
const OTHER_PID = 300 // 无关第三方
const T0 = 50_000 // 起拍墙钟（任意基准）

/** begin 助手：目标右键回放起拍，返回就绪的机器 */
function began(opts: { pid?: number; fgPid?: number } = {}): TrayYieldMachine {
  const m = new TrayYieldMachine()
  m.begin(opts.pid ?? TARGET_PID, opts.fgPid ?? OTHER_PID, OWN_PID, T0)
  return m
}

function hold(m: TrayYieldMachine, at: number, menuCount = 0, fgPid = OTHER_PID) {
  return m.poll({ menuCount, fgPid, now: at })
}

/** 断言助手：本拍必须是恢复，窄化出 reason/elapsedMs（联合类型的 restore 变体） */
function restored(m: TrayYieldMachine, at: number, menuCount = 0, fgPid = OTHER_PID) {
  const d = m.poll({ menuCount, fgPid, now: at })
  if (d.action !== 'restore') throw new Error(`expected restore, got ${JSON.stringify(d)}`)
  return d
}

describe('TrayYieldMachine（托盘让位闸门状态机）', () => {
  it('超时上限是明确常量（10s，可断言；自绘面板盲区靠它兜底不死锁）', () => {
    expect(TRAY_YIELD_TIMEOUT_MS).toBe(10_000)
    expect(TRAY_YIELD_POLL_MS).toBeGreaterThan(0)
  })

  it('begin 首拍 = yield（条带退出置顶带），机器转active并记下目标 pid', () => {
    const m = new TrayYieldMachine()
    expect(m.active).toBe(false)
    expect(m.begin(TARGET_PID, OTHER_PID, OWN_PID, T0)).toBe('yield')
    expect(m.active).toBe(true)
    expect(m.pid).toBe(TARGET_PID)
  })

  it('让位期间菜单未出现、前台无变化 → hold（keepalive/热区重申点被闸门压制的窗口期）', () => {
    const m = began()
    expect(hold(m, T0 + TRAY_YIELD_POLL_MS).action).toBe('hold')
    expect(hold(m, T0 + 3_000).action).toBe('hold')
  })

  it('三路①：目标 pid 菜单窗出现再消失 → restore menu-closed（含 elapsed）', () => {
    const m = began()
    expect(hold(m, T0 + TRAY_YIELD_POLL_MS, 1).action).toBe('hold') // 菜单在场：menuSeen 置位
    const d = hold(m, T0 + 1_234, 0)
    expect(d).toEqual({ action: 'restore', reason: 'menu-closed', elapsedMs: 1_234 })
    expect(m.active).toBe(false)
  })

  it('三路②a：前台先落到目标应用（菜单进程拿前台）再离开 → restore foreground-changed', () => {
    const m = began()
    expect(hold(m, T0 + TRAY_YIELD_POLL_MS, 0, TARGET_PID).action).toBe('hold') // ASFW 放行后应用成前台
    const d = hold(m, T0 + 2_000, 0, OTHER_PID)
    expect(d).toEqual({ action: 'restore', reason: 'foreground-changed', elapsedMs: 2_000 })
  })

  it('三路②b：前台从未落到目标但直接被第三方夺走 → restore foreground-changed', () => {
    const m = began({ fgPid: OTHER_PID })
    const d = hold(m, T0 + 800, 0, 999)
    expect(d).toEqual({ action: 'restore', reason: 'foreground-changed', elapsedMs: 800 })
  })

  it('三路③：超时上限（菜单一直开着也强制恢复——防死锁让位的硬顶）', () => {
    const m = began()
    expect(hold(m, T0 + TRAY_YIELD_TIMEOUT_MS - 1, 2).action).toBe('hold') // 顶格前一拍仍 hold
    const d = hold(m, T0 + TRAY_YIELD_TIMEOUT_MS, 2)
    expect(d).toEqual({ action: 'restore', reason: 'timeout', elapsedMs: TRAY_YIELD_TIMEOUT_MS })
  })

  it('自家图标菜单（目标=自家进程）收起：菜单窗消失 → 及时恢复（menu-closed），不等 10s 超时', () => {
    // 工单363 S2：自家托盘图标的菜单是自家 Chromium 菜单窗——收起后前台可能仍留在
    // 自家进程（对话窗等自家窗），前台变化路判不出「菜单已关」⇒ 旧口径只能等超时。
    // 通用信号 = 菜单窗消失（效果层判出记下的前台窗已销毁）⇒ 与 #32768 计数同一语义。
    const m = new TrayYieldMachine()
    m.begin(OWN_PID, OTHER_PID, OWN_PID, T0) // 目标=自家托盘图标属主（=自家进程）
    const hold1 = m.poll({ menuCount: 0, fgPid: OWN_PID, fgHwnd: 9001, now: T0 + 150 })
    expect(hold1.action).toBe('hold') // 菜单在场：自家进程持前台
    expect(m.menuWindowHwnd).toBe(9001) // 记下菜单窗身份（供效果层判销毁）
    // 菜单收起：效果层判出菜单窗已销毁（前台仍留在自家进程——自家另一个窗）
    const d = m.poll({ menuCount: 0, fgPid: OWN_PID, fgHwnd: 9002, menuHwndGone: true, now: T0 + 300 })
    expect(d).toEqual({ action: 'restore', reason: 'menu-closed', elapsedMs: 300 })
    expect(m.active).toBe(false)
  })

  it('第三方目标：菜单窗消失信号同样生效（#32768 菜单销毁 → menu-closed），与前台变化路不打架', () => {
    const m = began()
    hold(m, T0 + TRAY_YIELD_POLL_MS, 0, TARGET_PID) // 目标持前台（自绘菜单：#32768 计数恒 0）
    const d = m.poll({ menuCount: 0, fgPid: TARGET_PID, fgHwnd: 9001, menuHwndGone: true, now: T0 + 400 })
    expect(d).toEqual({ action: 'restore', reason: 'menu-closed', elapsedMs: 400 })
  })

  it('工单401：起拍时自家前台窗（溢出宿主/条带）不得被记成菜单窗——基线窗常驻不销毁，误记会让 menuHwndGone 变死信号拖到 10s 超时', () => {
    // 臂4 溢出径的物理时序：点 ⋯ 的左键已把前台交给自家进程 ⇒ 起拍 fgPid=ownPid、
    // fgHwnd=自家常驻窗（Electron_NotifyIconHostWindow 等）。该窗在菜单收起后仍存活
    // ⇒ 若被记成 menuHwnd，「菜单窗已销毁」永远判不出 ⇒ 只能等 10s 超时兜底
    // （2026-11-07 三连跑 r1 timeout elapsed=10107 / r3 foreground-changed elapsed=9914 实证）。
    const HOST_HWND = 9001 // 起拍时的自家前台窗（常驻）
    const MENU_HWND = 9002 // 真菜单窗（后诞生、异于基线）
    const m = new TrayYieldMachine()
    m.begin(OWN_PID, OWN_PID, OWN_PID, T0, HOST_HWND) // 目标=自家图标属主；起拍前台=自家宿主窗
    // 菜单未开的头几拍：fg 仍落在基线宿主窗上——不得误记为菜单窗
    expect(m.poll({ menuCount: 0, fgPid: OWN_PID, fgHwnd: HOST_HWND, now: T0 + 150 }).action).toBe('hold')
    expect(m.menuWindowHwnd).toBe(0)
    // 真菜单窗夺前台：记下的必须是它（异于基线）
    expect(m.poll({ menuCount: 0, fgPid: OWN_PID, fgHwnd: MENU_HWND, now: T0 + 300 }).action).toBe('hold')
    expect(m.menuWindowHwnd).toBe(MENU_HWND)
    // 菜单收起（宿主窗仍在前台/存活）：menuHwndGone 命中 → 及时 menu-closed，不等 10s
    const d = m.poll({ menuCount: 0, fgPid: OWN_PID, fgHwnd: HOST_HWND, menuHwndGone: true, now: T0 + 500 })
    expect(d).toEqual({ action: 'restore', reason: 'menu-closed', elapsedMs: 500 })
  })

  it('前台无窗（0）或自家进程成前台 → 不触发前台变化路径', () => {
    const m = began()
    expect(hold(m, T0 + 1_000, 0, 0).action).toBe('hold')
    expect(hold(m, T0 + 2_000, 0, OWN_PID).action).toBe('hold')
  })

  it('菜单窗从未出现且前台无变化 → 只有超时路径恢复（自绘面板盲区）', () => {
    const m = began()
    expect(hold(m, T0 + 5_000).action).toBe('hold')
    expect(restored(m, T0 + TRAY_YIELD_TIMEOUT_MS)).toEqual({ action: 'restore', reason: 'timeout', elapsedMs: TRAY_YIELD_TIMEOUT_MS })
  })

  it('目标 pid 未知（hwnd 解析缺位 = 0）：菜单/前台两路停用（分不清前台是否落到菜单应用），只超时兜底', () => {
    const m = began({ pid: 0 })
    expect(hold(m, T0 + 1_000, 3).action).toBe('hold') // 菜单计数不归因（pid 未知）
    expect(hold(m, T0 + 2_000, 0, TARGET_PID).action).toBe('hold') // 可能是菜单应用拿前台，不误判
    expect(hold(m, T0 + 2_500, 0, OTHER_PID + 7).action).toBe('hold')

    const m2 = began({ pid: 0 })
    expect(restored(m2, T0 + TRAY_YIELD_TIMEOUT_MS)).toEqual({ action: 'restore', reason: 'timeout', elapsedMs: TRAY_YIELD_TIMEOUT_MS })
  })

  it('让位中再次右键（换目标）→ extend：换监视 pid、重置菜单账、按新起拍续时限', () => {
    const m = began()
    hold(m, T0 + 1_000, 1, TARGET_PID) // 第一个菜单已在场
    expect(m.begin(OTHER_PID, TARGET_PID, OWN_PID, T0 + 1_500)).toBe('extend')
    expect(m.pid).toBe(OTHER_PID)
    // 旧菜单的在场计数不再归因新目标；时限按新起拍重计
    expect(hold(m, T0 + 1_600, 0).action).toBe('hold')
    const d = hold(m, T0 + 1_500 + TRAY_YIELD_TIMEOUT_MS, 0, TARGET_PID)
    expect(d).toEqual({ action: 'restore', reason: 'timeout', elapsedMs: TRAY_YIELD_TIMEOUT_MS })
  })

  it('reset 强制复位（条带销毁/禁用路径）：机器回 idle，后续 poll 空转 hold', () => {
    const m = began()
    expect(m.active).toBe(true)
    m.reset()
    expect(m.active).toBe(false)
    expect(hold(m, T0 + 100).action).toBe('hold')
  })
})
