// 空白右键菜单域适配器（工单196）：五面迁移之三——开始组/推荐组空白右键菜单（系统按钮
// 显隐（工单54）+ 恢复段（工单161「恢复 <显示名>」行））从「pill 内横排」迁入弹窗通路。
// 横排时代两组宿主渲染同一份行集（menuOpen 态挂开层宿主 pill），工单196 起共用 menu=blank
// 适配器——开层语义走通路面（右键恒重开，8s 兜底定时器退役：blur/点空白/条目退场/条带
// 转达收层全 Family 由通用层承载）。行集 = taskbarBlankMenuPopupRows（系统行 id=按钮 id、
// 恢复行 id=restore:<exe>）。行动作 = 存证先行（taskbar-menu-action / taskbar-rec-restore，
// 事件存证名不变）+ 既有分发殿后（dispatchTaskbarVisibility / dispatchRecRestore），回执
// 事件（-result）在浮层隐藏后照落（窗常驻：hide 不销渲染进程，红轮教训「存证先行」仍守）。
import { dispatchRecRestore, dispatchTaskbarVisibility, taskbarBlankMenuPopupRows, taskbarViewModel } from './taskbar-view.js'
import type { TaskbarButtonId } from '../shared/contract'
import type { TaskbarState } from '../shared/contract'

/** 最近一拍视图状态（changed 常活重推导时更新——onRow 据它取显隐翻转目标态） */
let latest: TaskbarState | null = null

export const blankMenuAdapter = {
  readyEvent: 'taskbar-blank-menu-ready',
  closeEvent: 'taskbar-blank-menu-close',
  rows(state: TaskbarState) {
    latest = state
    return taskbarBlankMenuPopupRows(taskbarViewModel(state))
  },
  onRow(row: { id: string; label: string }) {
    if (row.id.startsWith('restore:')) {
      const exe = row.id.slice('restore:'.length)
      // 恢复段动作（工单161 事件存证名不变）：存证先行 + 分发殿后
      const label = (latest ? taskbarViewModel(latest).excluded.find((ex) => ex.exe === exe)?.label : null) ?? row.label.slice('恢复 '.length)
      window.deck.host.notify('taskbar-rec-restore', { exe, label })
      void dispatchRecRestore(window.deck.bridge, exe)
        .then((s) => window.deck.host.notify('taskbar-rec-restore-result', { exe, excluded: s?.excluded?.length ?? null }))
      return
    }
    const buttonId = row.id as TaskbarButtonId
    const hidden = !(latest ? taskbarViewModel(latest).menu.find((m) => m.id === buttonId)?.hidden : false)
    // 显隐切换动作（工单54 事件存证名不变）：hidden = 翻转后的目标态
    window.deck.host.notify('taskbar-menu-action', { id: buttonId, hidden })
    void dispatchTaskbarVisibility(window.deck.bridge, buttonId, hidden)
      .then((s) => window.deck.host.notify('taskbar-menu-result', { id: buttonId, hiddenButtons: s?.hiddenButtons ?? null }))
  },
}
