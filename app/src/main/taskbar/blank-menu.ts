// 空白右键菜单浮层宿主（工单196）：五面迁移之三。菜单面 = 开始组/推荐组空白右键
// （系统按钮显隐（工单54）+ 恢复段（工单161）——横排时代两组宿主同一份行集，共用
// menu=blank 适配器，开层 URL 不带域参数即「同一菜单面」）。通用载体（popup.ts）承载，
// 域语义只三样：存证事件名（taskbar-blank-menu-* 家族）、寻址键（?menu=blank）、
// 开层/收层请求（taskbar-blank-menu-open/-close，条带页转发）。
// 装配 = 五面同形工厂（menu-host.ts，spec188 评审收口）：本文件只持域参数。
import type { Context } from 'cordis'
import type { EventLog } from '../panel-ipc'
import { startMenuHost } from './menu-host'
import type { MenuHost } from './menu-host'

/** 浮层窗标题：验收控制器按 pid + 标题寻窗（各面独立标题，窗常驻防寻窗歧义） */
export const BLANK_MENU_TITLE = 'DECK-TASKBAR-BLANK-MENU'

export type BlankMenuHost = MenuHost

/** 空白右键菜单浮层宿主（应用组菜单宿主同款形态，域参数各自持有） */
export function startBlankMenuHost(options: { ctx: Context; log: EventLog | null }): BlankMenuHost {
  return startMenuHost({
    ...options,
    title: BLANK_MENU_TITLE,
    family: 'taskbar-blank-menu',
    menu: 'blank',
    // 右键手势恒开：同 URL = show 即刻重锚定（开始组↔推荐组换宿主也同面——恒重开）
    buildUrl: (base, maxH) => `${base}&title=${encodeURIComponent(BLANK_MENU_TITLE)}&maxH=${maxH}`,
  })
}
