// 应用组菜单域适配器（工单193）：任务栏弹窗菜单通路的首个菜单面。行集 =
// taskbarAppMenuPopupRows（与条带视图同一份推导——条目集现状不变：手钉/解除手钉、
// 关闭窗口、打开文件位置）；行动作 = 存证先行（taskbar-app-menu-action 族，事件存证
// 名不变）+ 既有分发殿后（dispatchAppMenuAction——pin/unpin/close/reveal 各归其道，
// 手钉变更经回推的 taskbar/changed 反映在应用组）。exe 身份随开层 query 进页。
import { dispatchAppMenuAction, taskbarAppMenuPopupRows, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarAppMenuAction } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

/** 开层目标（条带页右键的 exe 身份）：页身份常量，changed 重推导按它寻址 */
const exe = new URLSearchParams(location.search).get('exe') ?? ''

export const appMenuAdapter = {
  readyEvent: 'taskbar-app-menu-ready',
  closeEvent: 'taskbar-app-menu-close',
  rows(state: TaskbarState) {
    const rows = taskbarAppMenuPopupRows(taskbarViewModel(state).apps, exe)
    return rows ? rows.map((row) => ({ id: row.action, label: row.label })) : null
  },
  onRow(row: { id: string; label: string }) {
    // 存证名不变（49 电池事件面断言存活）；分发与迁移前条带内行点击同一道（内核裁决）
    window.deck.host.notify('taskbar-app-menu-action', { exe, action: row.id })
    void dispatchAppMenuAction(window.deck.bridge, exe, row.id as TaskbarAppMenuAction)
  },
}
