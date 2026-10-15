// 推荐组条目菜单浮层宿主（工单196）：五面迁移之二。菜单面 = 推荐位图标右键三行
// （手钉到任务栏/从推荐栏移除/打开文件位置，条目集现状不变）。通用载体（popup.ts）
// 承载，域语义只三样：存证事件名（taskbar-rec-menu-* 家族，勿与别域混用）、寻址键
// （?menu=rec&exe=<enc>&name=<enc>——行集由载页按 exe 自足推导，name 只随动作事件
// 原样回传）、开层/收层请求（taskbar-rec-menu-open/-close，条带页转发）。
// 装配 = 五面同形工厂（menu-host.ts，spec188 评审收口）：本文件只持域参数。
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { startMenuHost } from './menu-host'
import type { MenuHost } from './menu-host'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（DECK-TASKBAR-MENU 先例；各面独立标题——
 * 窗常驻同 title 多扇会让电池寻窗歧义） */
export const REC_MENU_TITLE = 'DECK-TASKBAR-REC-MENU'

export type RecMenuHost = MenuHost

/** 推荐组条目菜单浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startRecMenuHost(options: { ctx: Context; log: EventLog | null }): RecMenuHost {
  return startMenuHost({
    ...options,
    title: REC_MENU_TITLE,
    family: 'taskbar-rec-menu',
    menu: 'rec',
    buildUrl: (base, maxH, payload) => {
      const p = (payload ?? {}) as { exe?: unknown; name?: unknown }
      const exe = String(p.exe ?? '')
      if (!exe) return '' // 空身份是噪声：不开层
      return `${base}&exe=${encodeURIComponent(exe)}&name=${encodeURIComponent(String(p.name ?? ''))}&title=${encodeURIComponent(REC_MENU_TITLE)}&maxH=${maxH}`
    },
  })
}
