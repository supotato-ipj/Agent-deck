// 分区热区几何（工单89）：分区交互面 = 容器可见矩形外扩 ZONE_HOTZONE_PAD_PX（裁到
// 窗内）；空分区不占热区。纯函数零 DOM——热区声明（declareHotZones）与 body 级分区
// 语义路由（zoneAtPoint）共用同一几何，两处一旦走样，环带就成了「接住点击却无事发生」
// 的黑洞，故单点出处 + 离线测试钉死。

/** 分区容器矩形四周外扩量（DIP px）：框选起笔带宽度，也是穿透让渡带宽 */
export const ZONE_HOTZONE_PAD_PX = 24

export interface ZoneBox {
  x: number
  y: number
  w: number
  h: number
}

/** 容器可见矩形 → 分区热区矩形：四周外扩 PAD、裁进 bounds。空分区（hasItems=false）
 * 或裁剪后退化（宽/高≤0）返回 null——不占热区、不产生点击死区（空分区外穿透照旧）。 */
export function zoneHotzoneRect(box: ZoneBox, bounds: ZoneBox, hasItems: boolean): ZoneBox | null {
  if (!hasItems) return null
  const x = Math.max(box.x - ZONE_HOTZONE_PAD_PX, bounds.x)
  const y = Math.max(box.y - ZONE_HOTZONE_PAD_PX, bounds.y)
  const right = Math.min(box.x + box.w + ZONE_HOTZONE_PAD_PX, bounds.x + bounds.w)
  const bottom = Math.min(box.y + box.h + ZONE_HOTZONE_PAD_PX, bounds.y + bounds.h)
  if (right <= x || bottom <= y) return null
  return { x, y, w: right - x, h: bottom - y }
}

/** 点是否在热区矩形内（左/上沿闭、右/下沿开，与 DOM 命中习惯一致） */
export function zoneHotzoneContains(rect: ZoneBox | null, px: number, py: number): boolean {
  return rect !== null
    && px >= rect.x && px < rect.x + rect.w
    && py >= rect.y && py < rect.y + rect.h
}
