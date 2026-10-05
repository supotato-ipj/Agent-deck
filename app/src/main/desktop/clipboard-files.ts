// 系统文件剪贴板写（工单29 复制/剪切）：DROPFILES（CF_HDROP 载荷）与 Preferred
// DropEffect 的纯打包函数 + 主进程写真源。为什么存在：Electron 44 的 clipboard 只剩
// clear/has/read/readText/writeText/write——writeBuffer（按名写原始格式，含 CF_HDROP）
// 已随上游移除；koffi 直调 user32 是唯一路线（adapter.fileAttributes / icon-ffi.ts
// 先例，纯 native 在数据面子进程同样可用，无需主进程代理）。
// 真机探针差分实证（2026-10-06）：DROPFILES 四段布局 pFiles(0-3)/pt(4-11)/fNC(12-15)/
// fWide(16-19)，fWide 落 16 偏移后 DragQueryFile 与 Get-Clipboard -Format FileDropList
// 双读通过；Preferred DropEffect 为 4 字节 DWORD（DROPEFFECT_COPY=1 / DROPEFFECT_MOVE=2）。

/** 剪贴板写语义（工单29）：copy = 粘贴为副本；move = 剪切（粘贴为搬移） */
export type ClipboardEffect = 'copy' | 'move'

/** DROPFILES 结构大小（pFiles 指向文件表的偏移 = 紧随结构的 20 字节处） */
const DROPFILES_SIZE = 20

/** CF_HDROP 载荷打包：DROPFILES 头 + 双 NUL 结尾 UTF-16 路径表（名单序保持） */
export function buildDropFilesBuffer(paths: readonly string[]): Buffer {
  const header = Buffer.alloc(DROPFILES_SIZE)
  header.writeUInt32LE(DROPFILES_SIZE, 0) // pFiles
  header.writeInt32LE(1, 16) // fWide = 1（宽字符路径表）
  const list = paths.map((p) => Buffer.from(p + '\0', 'utf16le'))
  return Buffer.concat([header, ...list, Buffer.from([0, 0])])
}

/** Preferred DropEffect 打包：4 字节 DWORD LE（DROPEFFECT_COPY=1 / DROPEFFECT_MOVE=2） */
export function buildDropEffectBuffer(effect: ClipboardEffect): Buffer {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(effect === 'move' ? 2 : 1, 0)
  return buf
}

interface ClipboardFfi {
  /** 单事务写两种格式（Open→Empty→CF_HDROP→Preferred DropEffect→Close）；返回错误串，'' 即成功 */
  write(paths: readonly string[], effect: ClipboardEffect): string
}

let ffi: ClipboardFfi | null = null

/** koffi 惰性绑定（沿 adapter.fileAttributes / icon-ffi.ts 先例）：注入假源的离线测试
 * 不触达本路径；非 Windows 或 koffi 缺席时 require/load 抛错，由调用方兜成错误串。 */
function bind(): ClipboardFfi {
  if (ffi) return ffi
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const openClipboard = user32.func('int __stdcall OpenClipboard(void *hWndNewOwner)')
  const closeClipboard = user32.func('int __stdcall CloseClipboard()')
  const emptyClipboard = user32.func('int __stdcall EmptyClipboard()')
  const setClipboardData = user32.func('void *__stdcall SetClipboardData(uint32_t uFormat, void *hMem)')
  const registerClipboardFormatW = user32.func('uint32_t __stdcall RegisterClipboardFormatW(const char16_t *lpszFormat)')
  const globalAlloc = kernel32.func('void *__stdcall GlobalAlloc(uint32_t uFlags, size_t dwBytes)')
  const globalLock = kernel32.func('void *__stdcall GlobalLock(void *hMem)')
  const globalUnlock = kernel32.func('int __stdcall GlobalUnlock(void *hMem)')
  const globalFree = kernel32.func('void *__stdcall GlobalFree(void *hMem)')
  const CF_HDROP = 15
  const GMEM_MOVEABLE = 2

  ffi = {
    write(paths, effect) {
      // GlobalAlloc + GlobalLock + koffi.encode 落字节；SetClipboardData 成功后系统接管内存，
      // 失败才回 GlobalFree（泄漏防线）。写入裁决（池护栏）在 DesktopService，这里只出这一只手。
      const putGlobal = (buf: Buffer): unknown => {
        const h = globalAlloc(GMEM_MOVEABLE, buf.length)
        if (!h) throw new Error('GlobalAlloc 失败')
        const ptr = globalLock(h)
        if (!ptr) {
          globalFree(h)
          throw new Error('GlobalLock 失败')
        }
        try {
          koffi.encode(ptr, `uint8_t[${buf.length}]`, buf)
        } finally {
          globalUnlock(h)
        }
        return h
      }
      if (!openClipboard(null)) return '剪贴板打开失败（可能被其他程序占用）'
      try {
        emptyClipboard()
        const hDrop = putGlobal(buildDropFilesBuffer(paths))
        if (!setClipboardData(CF_HDROP, hDrop)) {
          globalFree(hDrop)
          return '剪贴板写入失败（CF_HDROP）'
        }
        const fmt = registerClipboardFormatW('Preferred DropEffect')
        const hEffect = putGlobal(buildDropEffectBuffer(effect))
        if (!setClipboardData(fmt, hEffect)) {
          globalFree(hEffect)
          emptyClipboard() // 回滚半份状态：只落 HDROP 缺 effect 会让剪切语义悄悄变复制
          return '剪贴板写入失败（Preferred DropEffect）'
        }
        return ''
      } finally {
        closeClipboard()
      }
    },
  }
  return ffi
}

/** 文件剪贴板写真源（DesktopDeps.writeClipboardFiles 缺省装配）：CF_HDROP + Preferred
 * DropEffect 单事务写入（Explorer 及任意应用可直接粘贴/搬移）。'' 即成功，否则错误串
 * （open/trash 同语）。纯 native 调用在数据面子进程同样可用（fileAttributes 同法），
 * 无需 trash 那样的主进程反向代理；OpenClipboard 被占（读剪贴板类工具常驻轮询）时
 * 小退避重试——写路径低频，等待代价可忽略。 */
export async function koffiClipboardFilesWrite(paths: readonly string[], effect: ClipboardEffect): Promise<string> {
  let error = ''
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      error = bind().write(paths, effect)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
    if (!error) return ''
    if (!error.startsWith('剪贴板打开失败')) return error // 仅打开失败值得重试（内容性失败重试无意义）
    await new Promise((resolve) => setTimeout(resolve, 30))
  }
  return error
}
