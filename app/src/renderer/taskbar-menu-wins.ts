// 多窗选窗列表域适配器（工单196）：五面迁移之五——应用组多窗应用的选窗列表（工单53）
// 从「pill 内横排」迁入弹窗通路。行源不在 state 快照内（窗口清单是当拍枚举），走
// rowsAsync 即席经 taskbar/app-windows 拉取（app-click window-list 的 windowsOf 同一
// 当拍枚举——行集与条带视图永不各判一次；exe 护栏不在场 = null 页自收）。行身份 =
// hwnd（点行经 dispatchActivateWindow 精确到达），label = 窗口标题（无标题回退
// 「（无标题窗口）」，横排退役前 pill 内列表同文案；标题仅内存即时呈现，ADR-0007 口子）。
// 行动作 = 存证先行（taskbar-window-pick，事件存证名不变）+ 既有分发殿后。
import { dispatchActivateWindow, taskbarWinsMenuPopupRows, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

/** 开层目标（条带页左键 app-click 回执 window-list 的 exe 身份）：页身份常量 */
const exe = new URLSearchParams(location.search).get('exe') ?? ''

export const winsMenuAdapter = {
  readyEvent: 'taskbar-wins-menu-ready',
  closeEvent: 'taskbar-wins-menu-close',
  rows() {
    // 行源即席（rowsAsync）：窗口清单不在 state 快照内，同步口径不产行（页在有
    // rowsAsync 时只走异步道；此成员为适配器契约的同步位，恒 null 不作判据）
    return null
  },
  async rowsAsync(state: TaskbarState) {
    if (!taskbarViewModel(state).apps.some((a) => a.exe === exe)) return null
    const r = await window.deck.bridge.invoke('taskbar/app-windows', { exe })
    return r.ok ? taskbarWinsMenuPopupRows(r.windows) : null
  },
  onRow(row: { id: string; label: string }) {
    const hwnd = Number(row.id)
    if (!Number.isFinite(hwnd) || hwnd <= 0) return // 非法 hwnd 是噪声（分发层同款护栏）
    window.deck.host.notify('taskbar-window-pick', { exe, hwnd })
    void dispatchActivateWindow(window.deck.bridge, hwnd)
  },
}
