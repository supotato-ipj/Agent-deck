// 系统文件剪贴板读与写（工单29 复制/剪切 + 工单30 粘贴读向）：DROPFILES（CF_HDROP 载荷）
// 与 Preferred DropEffect 的纯打包函数 + 写真源 + 读写共用的 koffi 单一装配（评审结构项：
// 原写向 ClipboardFfi 与读向 ClipboardReadFfi 两套各自惰性绑定的装配块、两处 CF_HDROP/
// DROPEFFECT 魔数、两圈 3×30ms 退避循环，收敛到本模块单一出处）。
// 为什么存在：Electron 44 的 clipboard 只剩 clear/has/read/readText/writeText/write——
// writeBuffer/readBuffer（按名读写原始格式，含 CF_HDROP）已随上游移除；koffi 直调 user32
// 是唯一路线（adapter.fileAttributes / icon-ffi.ts 先例，纯 native 在数据面子进程同样可用；
// 读向在数据面子进程经 clipboard-read-req/-res 反向代理调用，见 ProxyClipboardRead）。
// 真机探针差分实证（2026-10-06）：DROPFILES 四段布局 pFiles(0-3)/pt(4-11)/fNC(12-15)/
// fWide(16-19)，fWide 落 16 偏移后 DragQueryFile 与 Get-Clipboard -Format FileDropList
// 双读通过；Preferred DropEffect 为 4 字节 DWORD（DROPEFFECT_COPY=1 / DROPEFFECT_MOVE=2）。

/** 剪贴板语义（工单29）：copy = 粘贴为副本；move = 剪切（粘贴为搬移）。读写两向共用
 * （写向 buildDropEffectBuffer 打包、读向 dropEffectOf 归约），单一出处防两处内联联合漂移。 */
export type ClipboardEffect = 'copy' | 'move'

/** CF_HDROP 标准格式号（Win32）：读写两向同一出处 */
export const CF_HDROP = 15
/** Preferred DropEffect DWORD 语义值（1=copy 2=move） */
export const DROPEFFECT_COPY = 1
export const DROPEFFECT_MOVE = 2

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
  buf.writeUInt32LE(effect === 'move' ? DROPEFFECT_MOVE : DROPEFFECT_COPY, 0)
  return buf
}

// ---- koffi 单一装配（读写共用）----
// 句柄约定：全局内存/剪贴板句柄统一按 uintptr_t 数值往返（Win32 语义 OpenClipboard(0) ≡
// NULL、BOOL 与 int 真值同判；本机 koffi 探针实证 uintptr_t 以 number 承载、零值 falsy
// 同判，读写两侧签名逐条对齐后合一）。GlobalLock 的返回是 koffi 不透明指针对象（非数值），
// 只供 encodeBytes/decodeBytes 用后即弃。装配惰性且进程内缓存一份：注入假源的离线测试不
// 触达本路径；非 Windows 或 koffi 缺席时 require/load 抛错，由调用方兜住。

export interface ClipboardFfi {
  isAvailable(format: number): boolean
  open(hWndNewOwner: number): boolean
  close(): boolean
  empty(): void
  get(format: number): number
  set(format: number, hMem: number): number
  registerFormat(name: string): number
  alloc(flags: number, bytes: number): number
  lock(hMem: number): unknown
  unlock(hMem: number): boolean
  free(hMem: number): number
  sizeOf(hMem: number): number
  encodeBytes(ptr: unknown, bytes: Buffer): void
  decodeBytes(ptr: unknown, size: number): Buffer
}

let ffi: ClipboardFfi | null = null

/** 读写共用的 koffi 惰性装配（唯一出处）：改任何 Win32 签名即动真机读写两条路径，
 * 动前先在真机探针核对（写向 29 / 读向 30 各自实证过的形态都保持原样合流）。 */
export function clipboardFfi(): ClipboardFfi {
  if (ffi) return ffi
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  ffi = {
    isAvailable: user32.func('bool __stdcall IsClipboardFormatAvailable(uint32_t format)'),
    open: user32.func('bool __stdcall OpenClipboard(uintptr_t hWndNewOwner)'),
    close: user32.func('bool __stdcall CloseClipboard()'),
    empty: user32.func('void __stdcall EmptyClipboard()'),
    get: user32.func('uintptr_t __stdcall GetClipboardData(uint32_t uFormat)'),
    set: user32.func('uintptr_t __stdcall SetClipboardData(uint32_t uFormat, uintptr_t hMem)'),
    registerFormat: user32.func('uint32_t __stdcall RegisterClipboardFormatW(const char16_t *lpszFormat)'),
    alloc: kernel32.func('uintptr_t __stdcall GlobalAlloc(uint32_t uFlags, size_t dwBytes)'),
    lock: kernel32.func('void *__stdcall GlobalLock(uintptr_t hMem)'),
    unlock: kernel32.func('bool __stdcall GlobalUnlock(uintptr_t hMem)'),
    free: kernel32.func('uintptr_t __stdcall GlobalFree(uintptr_t hMem)'),
    sizeOf: kernel32.func('size_t __stdcall GlobalSize(uintptr_t hMem)'),
    encodeBytes: (ptr, bytes) => { koffi.encode(ptr, `uint8_t[${bytes.length}]`, bytes) },
    decodeBytes: (ptr, size) => Buffer.from(koffi.decode(ptr, 'uint8_t', size)),
  }
  return ffi
}

const GMEM_MOVEABLE = 2

/** OpenClipboard 被占（读剪贴板类工具常驻轮询）的退避重试档：读/写两向同一出处 */
export const CLIPBOARD_BUSY_ATTEMPTS = 3
export const CLIPBOARD_BUSY_BACKOFF_MS = 30

/** 被占退避重试骨架（读写共用）：每拍一次尝试，busy(结果) 说这一拍值不值得再试
 * （仅「剪贴板被占」值得——内容性失败重试无意义、环境缺席直接落败），值得则退避一档
 * 再来，共 CLIPBOARD_BUSY_ATTEMPTS 拍；否则立刻返回当拍结果。 */
export async function retryClipboardBusy<T>(attempt: () => Promise<T>, busy: (result: T) => boolean): Promise<T> {
  let result = await attempt()
  for (let n = 1; n < CLIPBOARD_BUSY_ATTEMPTS && busy(result); n++) {
    await new Promise((resolve) => setTimeout(resolve, CLIPBOARD_BUSY_BACKOFF_MS))
    result = await attempt()
  }
  return result
}

/** 写事务单拍（koffiClipboardFilesWrite 的尝试体）：GlobalAlloc + GlobalLock + koffi.encode
 * 落字节；SetClipboardData 成功后系统接管内存，失败才回 GlobalFree（泄漏防线）。写入裁决
 * （池护栏）在 DesktopService，这里只出这一只手。返回错误串，'' 即成功；装配/内存异常
 * 以 rejection 上抛由调用方折成错误串。 */
function writeClipboardFilesOnce(ffi: ClipboardFfi, paths: readonly string[], effect: ClipboardEffect): string {
  const putGlobal = (buf: Buffer): number => {
    const h = ffi.alloc(GMEM_MOVEABLE, buf.length)
    if (!h) throw new Error('GlobalAlloc 失败')
    const ptr = ffi.lock(h)
    if (!ptr) {
      ffi.free(h)
      throw new Error('GlobalLock 失败')
    }
    try {
      ffi.encodeBytes(ptr, buf)
    } finally {
      ffi.unlock(h)
    }
    return h
  }
  if (!ffi.open(0)) return '剪贴板打开失败（可能被其他程序占用）'
  try {
    ffi.empty()
    const hDrop = putGlobal(buildDropFilesBuffer(paths))
    if (!ffi.set(CF_HDROP, hDrop)) {
      ffi.free(hDrop)
      return '剪贴板写入失败（CF_HDROP）'
    }
    const fmt = ffi.registerFormat('Preferred DropEffect')
    const hEffect = putGlobal(buildDropEffectBuffer(effect))
    if (!ffi.set(fmt, hEffect)) {
      ffi.free(hEffect)
      ffi.empty() // 回滚半份状态：只落 HDROP 缺 effect 会让剪切语义悄悄变复制
      return '剪贴板写入失败（Preferred DropEffect）'
    }
    return ''
  } finally {
    ffi.close()
  }
}

/** 文件剪贴板写真源（DesktopDeps.writeClipboardFiles 缺省装配）：CF_HDROP + Preferred
 * DropEffect 单事务写入（Explorer 及任意应用可直接粘贴/搬移）。'' 即成功，否则错误串
 * （open/trash 同语）。纯 native 调用在数据面子进程同样可用（fileAttributes 同法），
 * 无需 trash 那样的主进程反向代理；OpenClipboard 被占时按共用骨架小退避重试——
 * 写路径低频，等待代价可忽略。 */
export async function koffiClipboardFilesWrite(paths: readonly string[], effect: ClipboardEffect): Promise<string> {
  return retryClipboardBusy(async () => {
    try {
      return writeClipboardFilesOnce(clipboardFfi(), paths, effect)
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    }
  }, (error) => error.startsWith('剪贴板打开失败')) // 仅打开失败值得重试（内容性失败重试无意义）
}
