// 推荐组条目菜单域适配器（工单196）：五面迁移之二——推荐位图标右键三行菜单（手钉到
// 任务栏/从推荐栏移除/打开文件位置，工单160/161 条目集现状不变）从「pill 内横排」迁入
// 弹窗通路。行集 = taskbarRecMenuPopupRows（与条带视图同一份推导，exe 不在场 = 页自收）；
// 行动作 = 存证先行（taskbar-rec-menu-action 族，事件存证名不变）+ 既有分发殿后
// （dispatchRecMenuAction——pin/remove/reveal 各归其道，手钉/移除变更经回推的
// taskbar/changed 反映在推荐组）。exe/name 身份随开层 query 进页（动作事件载荷保持
// {name, exe, action} 既有口径——49 电池 P16③/P17① 按 name+action 对账）。
import { dispatchRecMenuAction, taskbarRecMenuPopupRows, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarRecMenuAction } from './taskbar-view.js'
import type { TaskbarState } from '../shared/contract'

/** 开层目标（条带页右键的 exe/name 身份）：页身份常量，changed 重推导按它寻址 */
const exe = new URLSearchParams(location.search).get('exe') ?? ''
const name = new URLSearchParams(location.search).get('name') ?? ''

export const recMenuAdapter = {
  readyEvent: 'taskbar-rec-menu-ready',
  closeEvent: 'taskbar-rec-menu-close',
  rows(state: TaskbarState) {
    const rows = taskbarRecMenuPopupRows(taskbarViewModel(state).recommendations, exe)
    return rows ? rows.map((row) => ({ id: row.action, label: row.label })) : null
  },
  onRow(row: { id: string; label: string }) {
    // 存证名不变（49 电池事件面断言存活）；分发与迁移前条带内行点击同一道（内核裁决）
    window.deck.host.notify('taskbar-rec-menu-action', { name, exe, action: row.id })
    void dispatchRecMenuAction(window.deck.bridge, exe, row.id as TaskbarRecMenuAction)
      .then((r) => {
        if (r) window.deck.host.notify('taskbar-rec-menu-result', { name, exe, action: row.id })
      })
  },
}
