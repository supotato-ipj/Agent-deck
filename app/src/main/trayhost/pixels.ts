// 托盘图标像素纯函数（工单48）：GDI GetDIBits 取回的 32bpp 顶向下 BGRA 位图的后处理。
// 效果层（host.ts）只负责把字节取出来，alpha 修复与像素序互换在这里做，零 Win32。

/** 1bpp AND 掩码的行字节数（32 位对齐） */
export function maskRowStride(width: number): number {
  return ((width + 31) >> 5) * 4
}

/**
 * alpha 修复：很多应用的 32bpp XOR 位图 alpha 通道全 0（图标靠 AND 掩码表达透明），
 * 直接渲染会整图透明。规则与 ManagedShell 同款：任一像素 alpha 非 0 即信任原 alpha；
 * 否则掩码置位像素 → 透明，未置位 → 不透明；无掩码 → 整图不透明。
 */
export function fixIconAlpha(bgra: Buffer, width: number, height: number, mask: Buffer | null): void {
  let anyAlpha = false
  for (let i = 3; i < bgra.length; i += 4) {
    if (bgra[i] !== 0) { anyAlpha = true; break }
  }
  if (anyAlpha) return
  if (mask === null) {
    for (let i = 3; i < bgra.length; i += 4) bgra[i] = 255
    return
  }
  const stride = maskRowStride(width)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const masked = (mask[y * stride + (x >> 3)] & (0x80 >> (x & 7))) !== 0
      bgra[(y * width + x) * 4 + 3] = masked ? 0 : 255
    }
  }
}

/** BGRA → RGBA（canvas putImageData 像素序）。返回新缓冲，不改原图。 */
export function bgraToRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]
    out[i + 1] = bgra[i + 1]
    out[i + 2] = bgra[i]
    out[i + 3] = bgra[i + 3]
  }
  return out
}
