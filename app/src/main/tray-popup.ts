// 托盘右键自控弹出的裁决器（工单401 A 线）：纯逻辑零 Electron，喂前台探针快照出决策。
//
// 背景（2026-11-07 真机取证定谳）：Electron Tray 的 setContextMenu 让 Chromium 在原生
// 消息处理里自动 TrackPopupMenu，该通路间歇性静默不弹——弹出窗全程零前台变迁、
// #32768 计数恒 0（10s 让位窗超时兜底收场，电池臂4 红轮实证）。弃 setContextMenu、
// 改 'right-click' 事件自控 menu.popup() 后，弹出结果不再黑盒：有界验证窗内看菜单窗
// （自家 Chromium 菜单，异于基线前台窗）是否夺前台，没夺到就重试一拍。
//
// 纪律同 tray-yield.ts：本模块只做裁决，FFI 采集是效果层（tray.ts 接线）；
// 真机人工验收覆盖弹出现场，不进单测。

/** 验证窗：menu.popup() 后等菜单窗夺前台的时长（绿轮实证 ~300ms 夺前台，600ms 有余量） */
export const TRAY_POPUP_VERIFY_MS = 600

/** 验证轮询间隔 */
export const TRAY_POPUP_POLL_MS = 100

/** 当拍前台读数（效果层采集；缺位 = null） */
export interface TrayPopupProbe {
  hwnd: number
  pid: number
}

export type TrayPopupVerdict =
  | 'pending' // 菜单可能正在路上：继续等
  | 'settled' // 菜单窗已夺前台：弹出成功
  | 'retry' // 验证窗耗尽仍无菜单：重试一拍
  | 'abandon' // 用户已去别处 / 重试仍失败：放弃（下次右键重来）

/**
 * 一拍裁决。preFgHwnd = popup 起拍时的前台窗句柄（自家常驻宿主窗基线）；probe = 当拍
 * 前台读数（缺位视同基线在场——重试是安全方向，不把 FFI 抖动当「已去别处」）；
 * retried = 是否已重试过（重试机会只有一拍，防循环弹骚扰）。
 */
export function trayPopupVerdict(
  preFgHwnd: number,
  probe: TrayPopupProbe | null,
  ownPid: number,
  elapsedMs: number,
  retried: boolean,
): TrayPopupVerdict {
  if (probe && probe.hwnd && probe.hwnd !== preFgHwnd) {
    // 前台离开了基线窗：落到自家 pid = 菜单窗诞生并夺前台；落到别处 = 用户已去别处
    return probe.pid === ownPid ? 'settled' : 'abandon'
  }
  if (elapsedMs >= TRAY_POPUP_VERIFY_MS) return retried ? 'abandon' : 'retry'
  return 'pending'
}
