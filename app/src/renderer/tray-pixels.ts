// 托盘像素 → 可贴图 URL（工单162 抽取）：条带页（工单56）与托盘溢出菜单浮层页
// （工单162）同一套转换——BGRA 换序与 canvas 编码只此一份，两页不许各抄一次。
// 编码在渲染层：主进程只搬字节（tray-spike 验收页同款职责分工）。本模块归 DOM
// （canvas/atob 是浏览器 API），离线测试不 import 本文件（像素链路真机电池收口）。
import type { TaskbarTrayPixels } from '../shared/contract'

/** BGRA → RGBA（canvas putImageData 像素序；与 trayhost/pixels 的 alpha 修复同算法，这里只换序） */
export function bgraToRgba(bgra: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(new ArrayBuffer(bgra.length))
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]; out[i + 1] = bgra[i + 1]; out[i + 2] = bgra[i]; out[i + 3] = bgra[i + 3]
  }
  return out
}

/** 托盘像素 → dataURL */
export function trayDataUrl(pixels: TaskbarTrayPixels): string {
  const bgra = Uint8Array.from(atob(pixels.bgraBase64), (c) => c.charCodeAt(0))
  const canvas = document.createElement('canvas')
  canvas.width = pixels.width
  canvas.height = pixels.height
  canvas.getContext('2d')?.putImageData(new ImageData(bgraToRgba(bgra), pixels.width, pixels.height), 0, 0)
  return canvas.toDataURL()
}
