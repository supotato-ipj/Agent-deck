// 托盘右键自控弹出的裁决器（工单401 A 线）：纯逻辑零 Electron——喂前台探针快照出决策。
// 背景：Chromium 对 setContextMenu 的自动 TrackPopupMenu 间歇不弹（真机取证：弹出窗
// 全程零前台、#32768 恒 0）⇒ 改 'right-click' 事件自控 popup + 有界验证 + 一拍重试。
import { describe, expect, it } from 'vitest'
import { TRAY_POPUP_POLL_MS, TRAY_POPUP_VERIFY_MS, trayPopupVerdict } from '../../src/main/tray-popup'

const OWN = 100
const PRE = 9001 // popup 起拍时的前台窗（自家常驻宿主窗）
const MENU = 9002 // 菜单窗（自家 Chromium 菜单，popup 后诞生）
const OTHER = 300

describe('trayPopupVerdict（托盘自控弹出裁决）', () => {
  it('菜单窗夺前台（自家 pid、异于基线）→ settled', () => {
    expect(trayPopupVerdict(PRE, { hwnd: MENU, pid: OWN }, OWN, 200, false)).toBe('settled')
  })

  it('前台被第三方夺走（异于基线且非自家）→ abandon（用户已去别处，不重试骚扰）', () => {
    expect(trayPopupVerdict(PRE, { hwnd: 7777, pid: OTHER }, OWN, 200, false)).toBe('abandon')
  })

  it('基线窗仍持前台、未超验证窗 → pending（菜单可能正在路上）', () => {
    expect(trayPopupVerdict(PRE, { hwnd: PRE, pid: OWN }, OWN, 200, false)).toBe('pending')
    expect(trayPopupVerdict(PRE, { hwnd: PRE, pid: OWN }, OWN, TRAY_POPUP_VERIFY_MS - 1, false)).toBe('pending')
  })

  it('验证窗耗尽仍未夺前台 → retry（一拍重试）；重试后仍耗尽 → abandon', () => {
    expect(trayPopupVerdict(PRE, { hwnd: PRE, pid: OWN }, OWN, TRAY_POPUP_VERIFY_MS, false)).toBe('retry')
    expect(trayPopupVerdict(PRE, { hwnd: PRE, pid: OWN }, OWN, TRAY_POPUP_VERIFY_MS * 2, true)).toBe('abandon')
  })

  it('前台读数缺位（null）视同基线在场——重试是安全方向，不误判 settled', () => {
    expect(trayPopupVerdict(PRE, null, OWN, 200, false)).toBe('pending')
    expect(trayPopupVerdict(PRE, null, OWN, TRAY_POPUP_VERIFY_MS, false)).toBe('retry')
  })

  it('常量口径：验证窗 600ms、轮询 100ms（有界、恢复跟手）', () => {
    expect(TRAY_POPUP_VERIFY_MS).toBe(600)
    expect(TRAY_POPUP_POLL_MS).toBe(100)
  })
})
