// 多窗选窗列表浮层宿主（工单196）：五面迁移之五。菜单面 = 应用组多窗应用左键点出的
// 选窗列表（工单53；app-click 裁决 window-list 时开层）。通用载体（popup.ts）承载，域
// 语义只三样：存证事件名（taskbar-wins-menu-* 家族）、寻址键（?menu=wins&exe=<enc>——
// 行集由载页按 exe 即席经 taskbar/app-windows 拉取，不进开层请求）、开层/收层请求
// （taskbar-wins-menu-open/-close，条带页转发）。
// 装配 = 五面同形工厂（menu-host.ts，spec188 评审收口）：本文件只持域参数。
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { startMenuHost } from './menu-host'
import type { MenuHost } from './menu-host'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（各面独立标题，窗常驻防寻窗歧义） */
export const WINS_MENU_TITLE = 'DECK-TASKBAR-WINS-MENU'

export type WinsMenuHost = MenuHost

/** 多窗选窗列表浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startWinsMenuHost(options: { ctx: Context; log: EventLog | null }): WinsMenuHost {
  return startMenuHost({
    ...options,
    title: WINS_MENU_TITLE,
    family: 'taskbar-wins-menu',
    menu: 'wins',
    // 左键手势恒开：URL 未变（同应用再点）= show 即刻重锚定；换应用 = reload 行集
    buildUrl: (base, maxH, payload) => {
      const exe = String((payload as { exe?: unknown } | undefined)?.exe ?? '')
      if (!exe) return '' // 空身份是噪声：不开层
      return `${base}&exe=${encodeURIComponent(exe)}&title=${encodeURIComponent(WINS_MENU_TITLE)}&maxH=${maxH}`
    },
  })
}
