// 使用日志采集真源（工单06）：koffi 延迟绑定（沿用 desktop/adapter.ts 先例——
// 离线测试注入假源时不触碰 FFI；out 参数一律走 Buffer，与 accept/lib/win32.js 的
// 实证调用形态一致）。刻意不读窗口标题：前台可执行路径经前台窗口句柄 → pid →
// QueryFullProcessImageNameW 取得，全程不获取任何标题文本（tests 有常驻隐私守卫）。
interface KoffiFunc {
  (...args: unknown[]): unknown
}

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const MAX_PIDS = 4096

interface Bound {
  enumProcesses: KoffiFunc
  openProcess: KoffiFunc
  queryImageName: KoffiFunc
  closeHandle: KoffiFunc
  getForegroundWindow: KoffiFunc
  getWindowThreadProcessId: KoffiFunc
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const psapi = koffi.load('psapi.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const user32 = koffi.load('user32.dll')
  bound = {
    enumProcesses: psapi.func('bool __stdcall EnumProcesses(uint32 *ids, uint32 cb, uint32 *used)') as KoffiFunc,
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)') as KoffiFunc,
    queryImageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)') as KoffiFunc,
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *h)') as KoffiFunc,
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()') as KoffiFunc,
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)') as KoffiFunc,
  }
  return bound
}

function imageNameOf(pid: number): string | null {
  const b = bind()
  const handle = b.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return null
  try {
    const name = Buffer.alloc(1024) // 512 wchar
    const size = Buffer.alloc(4)
    size.writeUInt32LE(510, 0)
    if (!b.queryImageName(handle, 0, name, size)) return null
    return name.toString('utf16le', 0, size.readUInt32LE(0) * 2)
  } finally {
    b.closeHandle(handle)
  }
}

/** pid -> 可执行路径（EnumProcesses + 逐 pid 查询；只取 exe，不取任何其他进程信息） */
export function nativeRunningPidExes(): Map<number, string> {
  const b = bind()
  const out = new Map<number, string>()
  const ids = Buffer.alloc(MAX_PIDS * 4)
  const used = Buffer.alloc(4)
  if (!b.enumProcesses(ids, MAX_PIDS * 4, used)) return out
  const n = used.readUInt32LE(0) / 4
  for (let i = 0; i < n; i++) {
    const pid = ids.readUInt32LE(i * 4)
    const exe = imageNameOf(pid)
    if (exe) out.set(pid, exe)
  }
  return out
}

/** 前台窗口所属进程的可执行路径（刻意不读取窗口标题）；取不到返回 null */
export function nativeForegroundExe(): string | null {
  const b = bind()
  const hwnd = b.getForegroundWindow() as number
  if (!hwnd) return null
  const pid = Buffer.alloc(4)
  b.getWindowThreadProcessId(hwnd, pid)
  if (!pid.readUInt32LE(0)) return null
  return imageNameOf(pid.readUInt32LE(0))
}
