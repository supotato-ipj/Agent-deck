// 图标直取 FFI 真源（工单06）：SHDefExtractIconW 显式提取图标资源，HICON → BGRA → PNG。
// 为什么存在：Electron app.getFileIcon（SHGetFileInfo 路径）对本机巨型 exe（Kimi /
// DeepSeek Harness / MiniMax Code，~235MB）确定性返回字节级相同的通用应用图标——
// 新路径副本仍复现，排除 shell 图标缓存，属 SHGetFileInfo 对该类 PE 的资源解析失败；
// 而 SHDefExtractIconW / ExtractAssociatedIcon 对同一批 exe 能取出真图标（探针实证）。
// koffi 惰性绑定（沿 adapter.fileAttributes 先例）：本模块只在主进程提取链内被调用，
// 注入假源的离线测试不触达；任一步失败返回 null，调用方回落 getFileIcon 链
// （目录、非 PE、异常形态的既定通道）。
import type { NativeImage } from 'electron'

interface Ffi {
  extract(file: string, index: number, size: number): { ok: boolean; hicon: unknown }
  iconInfo(hicon: unknown, out: { fIcon: number; hbmMask: unknown; hbmColor: unknown }): boolean
  bitmapOf(hbm: unknown): { bmWidth: number; bmHeight: number } | null
  dibBits(hdc: unknown, hbm: unknown, bmi: object, bits: Buffer, lines: number): number
  createDC(): unknown
  deleteObject(h: unknown): void
  deleteDC(h: unknown): void
  destroyIcon(h: unknown): void
  nativeImage: { createFromBuffer(buf: Buffer, opts: { width: number; height: number }): NativeImage }
}

let ffi: Ffi | null = null

function bind(): Ffi {
  if (ffi) return ffi
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')
  const shell32 = koffi.load('shell32.dll')

  // HICON 出参容器：koffi 结构体出参惯用法（传空对象，调用后被填充）
  koffi.struct('HICON_REF', { h: 'void *' })
  koffi.struct('ICONINFO', {
    fIcon: 'int32',
    xHotspot: 'uint32',
    yHotspot: 'uint32',
    hbmMask: 'void *',
    hbmColor: 'void *',
  })
  koffi.struct('BITMAP', {
    bmType: 'int32',
    bmWidth: 'int32',
    bmHeight: 'int32',
    bmWidthBytes: 'int32',
    bmPlanes: 'uint16',
    bmBitsPixel: 'uint16',
    bmBits: 'void *',
  })
  koffi.struct('BITMAPINFOHEADER', {
    biSize: 'uint32',
    biWidth: 'int32',
    biHeight: 'int32',
    biPlanes: 'uint16',
    biBitCount: 'uint16',
    biCompression: 'uint32',
    biSizeImage: 'uint32',
    biXPelsPerMeter: 'int32',
    biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32',
    biClrImportant: 'uint32',
  })
  koffi.struct('BITMAPINFO', {
    bmiHeader: 'BITMAPINFOHEADER',
    bmiColors: 'uint32[3]', // BI_BITFIELDS 掩码容身之处
  })

  // SHDefExtractIconW：nIconSize 低字=大图尺寸（MAKELONG(48,48)）；返回 S_OK(0)/S_FALSE(1)
  // 均可能有图标（S_FALSE = 请求尺寸不完全匹配但已给最接近者），E_FAIL/负值无图标
  const shDefExtract = shell32.func(
    'int __stdcall SHDefExtractIconW(const char16_t *pszIconFile, int iIndex, uint32_t uFlags, _Out_ HICON_REF *phiconLarge, void *phiconSmall, uint32_t nIconSize)',
  )
  const getIconInfo = user32.func('int __stdcall GetIconInfo(void *hIcon, _Out_ ICONINFO *piconinfo)')
  const destroyIcon = user32.func('int __stdcall DestroyIcon(void *hIcon)')
  const getObjectW = gdi32.func('int __stdcall GetObjectW(void *h, int c, _Out_ BITMAP *pv)')
  const getDibBits = gdi32.func(
    'int __stdcall GetDIBits(void *hdc, void *hbm, uint32_t start, uint32_t lines, void *bits, _Inout_ BITMAPINFO *bmi, uint32_t usage)',
  )
  const createCompatibleDC = gdi32.func('void *__stdcall CreateCompatibleDC(void *hdc)')
  const deleteObject = gdi32.func('int __stdcall DeleteObject(void *h)')
  const deleteDC = gdi32.func('int __stdcall DeleteDC(void *hdc)')

  ffi = {
    extract: (file, index, size) => {
      const out = {}
      const ret = shDefExtract(file, index, 0, out, null, (size | (size << 16)) >>> 0)
      const hicon = (out as { h?: unknown }).h
      return { ok: (ret === 0 || ret === 1) && hicon != null, hicon }
    },
    iconInfo: (hicon, out) => getIconInfo(hicon, out) !== 0,
    bitmapOf: (hbm) => {
      const bm = {}
      return getObjectW(hbm, koffi.sizeof('BITMAP'), bm) !== 0 ? (bm as { bmWidth: number; bmHeight: number }) : null
    },
    dibBits: (hdc, hbm, bmi, bits, lines) => getDibBits(hdc, hbm, 0, lines, bits, bmi, 0),
    createDC: () => createCompatibleDC(null),
    deleteObject: (h) => { deleteObject(h) },
    deleteDC: (h) => { deleteDC(h) },
    destroyIcon: (h) => { destroyIcon(h) },
    nativeImage: require('electron').nativeImage,
  }
  return ffi
}

/** 对文件本体直取图标资源，返回 PNG dataURL；任一步失败返回 null（调用方回落 getFileIcon）。
 * sizePx 请求图标边长（48 对齐既有 large 档）；实际尺寸以位图为准。 */
export function extractIconDataUrl(filePath: string, iconIndex: number, sizePx = 48): string | null {
  let f: Ffi
  try {
    f = bind()
  } catch {
    return null
  }
  let hdc: unknown = null
  let hicon: unknown = null
  let hbmMask: unknown = null
  let hbmColor: unknown = null
  try {
    const hit = f.extract(filePath, iconIndex, sizePx)
    if (!hit.ok) return null
    hicon = hit.hicon
    const info = { fIcon: 0, xHotspot: 0, yHotspot: 0, hbmMask: null, hbmColor: null }
    if (!f.iconInfo(hicon, info)) return null
    hbmMask = info.hbmMask
    hbmColor = info.hbmColor
    if (!hbmColor) return null // 单色掩码图标：无色彩位图，交回落
    const bm = f.bitmapOf(hbmColor)
    if (!bm || bm.bmWidth <= 0 || bm.bmHeight <= 0) return null
    const w = bm.bmWidth
    const h = Math.abs(bm.bmHeight)
    const bytes = w * h * 4
    const bits = Buffer.alloc(bytes)
    const bmi = {
      bmiHeader: {
        biSize: 40, biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
        biCompression: 0, biSizeImage: bytes, biXPelsPerMeter: 0, biYPelsPerMeter: 0,
        biClrUsed: 0, biClrImportant: 0,
      },
      bmiColors: [0, 0, 0],
    }
    hdc = f.createDC()
    if (!hdc) return null
    if (f.dibBits(hdc, hbmColor, bmi, bits, h) === 0) return null
    // 图标资源 alpha 为直通（非预乘）；nativeImage 位图按预乘语义解释——逐像素预乘后交入
    for (let i = 0; i < bytes; i += 4) {
      const a = bits[i + 3]
      if (a !== 255) {
        bits[i] = (bits[i] * a + 127) / 255 | 0
        bits[i + 1] = (bits[i + 1] * a + 127) / 255 | 0
        bits[i + 2] = (bits[i + 2] * a + 127) / 255 | 0
      }
    }
    const img = f.nativeImage.createFromBuffer(bits, { width: w, height: h })
    return img.isEmpty() ? null : img.toDataURL()
  } catch {
    return null
  } finally {
    if (hbmColor) f.deleteObject(hbmColor)
    if (hbmMask) f.deleteObject(hbmMask)
    if (hicon) f.destroyIcon(hicon)
    if (hdc) f.deleteDC(hdc)
  }
}
