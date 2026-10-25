/**
 * 托盘图标像素纯函数测试（工单48）：GetDIBits 取回的 32bpp BGRA 位图 alpha 修复
 * 与 RGBA 互换（验收页 canvas putImageData 用）。
 */
import { describe, expect, it } from 'vitest'
import { bgraToRgba, fixIconAlpha, maskRowStride } from '../src/main/trayhost/pixels'

/** 造一幅 4x2 BGRA 图：逐像素 (b,g,r,a) 由 fn 给 */
function makeBgra(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): Buffer {
  const buf = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [b, g, r, a] = fn(x, y)
      const i = (y * w + x) * 4
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a
    }
  }
  return buf
}

/** 1bpp 顶向下 AND 掩码：bit 置位 = 透明。bit(行内) 从最高位起。 */
function makeMask(w: number, h: number, transparent: Array<[number, number]>): Buffer {
  const stride = maskRowStride(w)
  const buf = Buffer.alloc(stride * h)
  for (const [x, y] of transparent) {
    buf[y * stride + (x >> 3)] |= 0x80 >> (x & 7)
  }
  return buf
}

describe('fixIconAlpha（XOR alpha 全 0 时用 AND 掩码补透明度）', () => {
  it('alpha 已有内容（任一像素非 0）→ 原样保留，不动掩码', () => {
    const bgra = makeBgra(2, 1, (x) => [10, 20, 30, x === 0 ? 128 : 0])
    const mask = makeMask(2, 1, [[1, 0]])
    fixIconAlpha(bgra, 2, 1, mask)
    expect(bgra[3]).toBe(128)
    expect(bgra[7]).toBe(0) // 保留原 0，不被掩码改成 255
  })

  it('alpha 全 0 + 掩码：掩码置位像素透明、未置位像素不透明', () => {
    const bgra = makeBgra(4, 2, () => [1, 2, 3, 0])
    const mask = makeMask(4, 2, [[0, 0], [3, 1]])
    fixIconAlpha(bgra, 4, 2, mask)
    expect(bgra[3]).toBe(0)                    // (0,0) 掩码置位 → 透明
    expect(bgra[(0 * 4 + 1) * 4 + 3]).toBe(255) // (1,0) 未置位 → 不透明
    expect(bgra[(1 * 4 + 3) * 4 + 3]).toBe(0)   // (3,1) 置位 → 透明
    expect(bgra[(1 * 4 + 2) * 4 + 3]).toBe(255) // (2,1) 未置位
  })

  it('alpha 全 0 + 无掩码（hbmMask 为空）：整图置不透明', () => {
    const bgra = makeBgra(3, 1, () => [9, 9, 9, 0])
    fixIconAlpha(bgra, 3, 1, null)
    expect([bgra[3], bgra[7], bgra[11]]).toEqual([255, 255, 255])
  })

  it('掩码行跨字节：宽 16 的掩码 stride=4（32 位对齐），第 9 列落在第二字节', () => {
    expect(maskRowStride(16)).toBe(4)
    expect(maskRowStride(33)).toBe(8)
    const bgra = makeBgra(16, 1, () => [0, 0, 0, 0])
    const mask = makeMask(16, 1, [[9, 0]])
    fixIconAlpha(bgra, 16, 1, mask)
    expect(bgra[9 * 4 + 3]).toBe(0)
    expect(bgra[8 * 4 + 3]).toBe(255)
  })
})

describe('bgraToRgba（验收页 canvas 像素序互换）', () => {
  it('逐像素 B↔R 互换，G/alpha 不动', () => {
    const bgra = makeBgra(1, 1, () => [10, 20, 30, 40])
    const rgba = bgraToRgba(bgra)
    expect(Array.from(rgba)).toEqual([30, 20, 10, 40])
  })
})
