// 任务栏弹窗菜单通路纯函数（工单193）：落位算式与开层裁决。从托盘溢出浮层
// （工单162 overflow.ts）泛化而来——窗口载体（BrowserWindow 效果层）在 popup.ts，
// 本模块零 Electron 依赖，离线单测钉住（tests/taskbar/popup-plan.spec.ts）。
// #196 其余菜单面迁入同一通路时，落位与开层语义在此单点复用。

/** 锚点（屏幕 DIP 坐标；缺省 = 开层拍光标位） */
export interface PopupAnchor { x: number; y: number }

/** 载页实测内容尺寸（ready 回报的 w/h，DIP） */
export interface PopupSize { w: number; h: number }

/** 工作区（screen.getPrimaryDisplay().workArea，DIP） */
export interface PopupWorkArea { x: number; y: number; width: number; height: number }

/** 工作区四缘夹取内衬（DIP；overflow 先例同值） */
export const POPUP_MARGIN = 4

/** 锚点到弹出窗的纵向间距（DIP；先例同值——锚点上方 8px 出层，底部任务栏语境即向上弹） */
export const POPUP_GAP = 8

/**
 * 落位算式（overflow placeAndShow 同式）：水平居中于锚点、整窗悬在锚点上方
 * POPUP_GAP，再对工作区四缘各留 POPUP_MARGIN 夹取——贴边不裁内容。取整在夹取
 * 之前（与先例逐式一致：Math.round(anchor.x - w/2) → max 下界 → min 上界）。
 */
export function clampPopupBounds(
  anchor: PopupAnchor,
  size: PopupSize,
  wa: PopupWorkArea,
): { x: number; y: number } {
  const x = Math.min(Math.max(Math.round(anchor.x - size.w / 2), wa.x + POPUP_MARGIN), wa.x + wa.width - size.w - POPUP_MARGIN)
  const y = Math.min(Math.max(Math.round(anchor.y - size.h - POPUP_GAP), wa.y + POPUP_MARGIN), wa.y + wa.height - size.h - POPUP_MARGIN)
  return { x, y }
}

/**
 * 开层请求裁决（通路开层契约，#196 复用面）：
 * - create：无窗首开——建常驻浮层窗 + 载页，ready 回报即定位弹出（新渲染进程
 *   spin-up 有秒级 jank，先例红轮实证首点吞点击，故窗常驻、首开惰性建）；
 * - reload：窗在场但载页 URL 已变（换菜单目标/换条目集）——重载行集再弹出；
 * - show：窗在场且 URL 未变——行集由载页随 changed 常活自渲（隐藏拍也在收帧），
 *   即刻按现存内容重锚定定位。
 */
export type PopupOpenPlan = 'create' | 'reload' | 'show'

export function planPopupOpen(
  state: { exists: boolean; url: string | null },
  req: { url: string },
): PopupOpenPlan {
  if (!state.exists) return 'create'
  if (state.url !== req.url) return 'reload'
  return 'show'
}
