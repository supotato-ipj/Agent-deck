// 任务栏运行中窗口枚举真源（工单52，效果层薄壳）：顶层可见窗口链式枚举 →
// exe 绝对路径 + 窗口标题。枚举形态同 focus/adapter.ts（GetTopWindow/GetWindow 链，
// 避免 FFI 回调生命周期问题）；差异是 exe 取全路径（左组身份）且读窗口标题。
// 隐私（ADR-0007 对 ADR-0002 的书面口子，仅限任务栏链路）：标题仅内存即时读取，
// 供栏上 tooltip 与多窗口列表即时显示——永不写使用日志、永不落任何持久化。
// 离线测试不加载本模块（服务依赖缝注入假源后从不 require）。
import type { TaskbarWindowInput } from './left-plan'

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const GW_HWNDNEXT = 2
const MAX_WINDOWS = 2048

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getTopWindow: KoffiFunc
  getWindow: KoffiFunc
  isWindowVisible: KoffiFunc
  getWindowThreadProcessId: KoffiFunc
  getWindowTextLength: KoffiFunc
  getWindowText: KoffiFunc
  openProcess: KoffiFunc
  queryImageName: KoffiFunc
  closeHandle: KoffiFunc
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  bound = {
    getTopWindow: user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)'),
    getWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)'),
    isWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)'),
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)'),
    getWindowTextLength: user32.func('int __stdcall GetWindowTextLengthW(uintptr_t hWnd)'),
    getWindowText: user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, char16_t *lpString, int nMaxCount)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    queryImageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
  }
  return bound
}

function pidOf(b: Bound, hwnd: number): number {
  const buf = Buffer.alloc(4)
  b.getWindowThreadProcessId(hwnd, buf)
  return buf.readUInt32LE(0)
}

function exeOfPid(b: Bound, pid: number): string {
  const handle = b.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    const name = Buffer.alloc(1024) // 512 wchar
    const size = Buffer.alloc(4)
    size.writeUInt32LE(510, 0)
    if (!b.queryImageName(handle, 0, name, size)) return ''
    return name.toString('utf16le', 0, size.readUInt32LE(0) * 2)
  } finally {
    b.closeHandle(handle)
  }
}

/** 窗口标题即时读取（仅内存；空标题归 null）。取不到/已销毁归 null，不抛。 */
function titleOf(b: Bound, hwnd: number): string | null {
  try {
    const len = b.getWindowTextLength(hwnd) as number
    if (len <= 0) return null
    const buf = Buffer.alloc((len + 2) * 2)
    const got = b.getWindowText(hwnd, buf, len + 2) as number
    if (got <= 0) return null
    return buf.toString('utf16le', 0, got * 2) || null
  } catch {
    return null
  }
}

/** 任务栏窗口快照条目：exe 为绝对路径（左组身份），hwnd/pid 预留给工单53 的激活语义 */
export interface TaskbarWindowInfo extends TaskbarWindowInput {
  hwnd: number
  pid: number
}

/**
 * 当前可见顶层窗口快照（最小化窗口仍带 WS_VISIBLE，在列——任务栏运行态含最小化）。
 * 取不到 exe 的窗口（权限/已退出）跳过；标题空归 null。纯枚举薄壳，无分支裁决
 * （合并/去重/排序全在 left-plan 纯函数），真机行为由验收电池覆盖。
 */
export function nativeTaskbarWindows(): TaskbarWindowInfo[] {
  const b = bind()
  const out: TaskbarWindowInfo[] = []
  let h = b.getTopWindow(0) as number
  let guard = 0
  while (h && guard++ < MAX_WINDOWS) {
    if (b.isWindowVisible(h)) {
      const pid = pidOf(b, h)
      if (pid) {
        const exe = exeOfPid(b, pid)
        if (exe) out.push({ hwnd: h, pid, exe, title: titleOf(b, h) })
      }
    }
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return out
}
