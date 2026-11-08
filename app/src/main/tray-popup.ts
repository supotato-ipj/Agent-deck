// 托盘右键回放的菜单开层验证裁决器（工单401）：纯逻辑零 Electron，喂前台探针快照出决策。
//
// 背景（2026-11-07 真机取证定谳）：自家图标右键回放的 PostMessage 即便成功，Chromium
// 托盘管线仍间歇丢消息——菜单从未开成（弹出窗全程零前台变迁、#32768 恒 0，10s 让位
// 超时兜底收场）。有界验证窗内看菜单窗（自家 Chromium 菜单，异于基线前台窗）是否夺
// 前台，没夺到就重注一拍；重注仍未开即弃（防循环弹骚扰）。
//
// 纪律同 tray-yield.ts：本模块只做裁决，FFI 采集是效果层（services/taskbar.ts 接线）；
// 裁决器纯逻辑离线单测钉住（tests/taskbar/tray-popup.spec.ts）。

/** 验证窗：回放后等菜单窗夺前台的时长（绿轮实证 ~300ms 夺前台，600ms 有余量） */
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
  | 'retry' // 验证窗耗尽仍无菜单：重注一拍
  | 'abandon' // 用户已去别处 / 重注仍失败：放弃（下次右键重来）

/**
 * 一拍裁决。preFgHwnd = 回放起拍时的前台窗句柄（自家常驻宿主窗基线）；probe = 当拍
 * 前台读数（缺位视同基线在场——重注是安全方向，不把 FFI 抖动当「已去别处」）；
 * retried = 是否已重注过（重注机会只有一拍，防循环弹骚扰）。
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
