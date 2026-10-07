// 会话行直达的真源（工单09）：顶层窗口枚举 + 置前 + 启动。
// koffi 延迟绑定（desktop/adapter.ts / usage/native.ts 先例）：契约测试注入假源时
// 不触碰 FFI。窗口枚举走 GetTopWindow/GetWindow 链而非 EnumWindows 回调
// （accept/lib/win32.js 实证形态，避免 FFI 回调生命周期问题）。
// 隐私：只取窗口所属进程的可执行路径，不读窗口标题（ADR-0002 边界同 usage/native）。
import type { WindowCandidate } from './plan'
import { panelLabels } from '../lag-sentinel'

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const GW_HWNDNEXT = 2
const SW_RESTORE = 9
const MAX_WINDOWS = 2048

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getTopWindow: KoffiFunc
  getWindow: KoffiFunc
  isWindowVisible: KoffiFunc
  getWindowThreadProcessId: KoffiFunc
  isIconic: KoffiFunc
  showWindow: KoffiFunc
  bringWindowToTop: KoffiFunc
  setForegroundWindow: KoffiFunc
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
    isIconic: user32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    showWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    bringWindowToTop: user32.func('bool __stdcall BringWindowToTop(uintptr_t hWnd)'),
    setForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    queryImageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
  }
  return bound
}

function pidOf(hwnd: number): number {
  const b = bind()
  const buf = Buffer.alloc(4)
  b.getWindowThreadProcessId(hwnd, buf)
  return buf.readUInt32LE(0)
}

function exeOfPid(pid: number): string {
  const b = bind()
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

/**
 * 当前顶层窗口快照：自顶向下链式枚举（与 accept/lib/win32.js 的 topLevelWindows 同形），
 * 逐窗取所属进程 exe 路径。取不到 exe 的窗口（权限/已退出）跳过——
 * 匹配只需 exe，跳过不影响决策。
 */
export function nativeWindowCandidates(): WindowCandidate[] {
  const b = bind()
  const out: WindowCandidate[] = []
  let h = b.getTopWindow(0) as number
  let guard = 0
  while (h && guard++ < MAX_WINDOWS) {
    const pid = pidOf(h)
    if (pid) {
      const exe = exeOfPid(pid)
      if (exe) {
        out.push({
          hwnd: h,
          pid,
          exe: exe.replace(/^.*[\\/]/, ''),
          visible: Boolean(b.isWindowVisible(h)),
          minimized: Boolean(b.isIconic(h)),
        })
      }
    }
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return out
}

/**
 * 把窗口带到前台：最小化先 SW_RESTORE，再 BringWindowToTop + SetForegroundWindow。
 * SetForegroundWindow 受前台锁限制可能失败（返回 false）——调用方按「尽力」处理，
 * 降级不冒泡（面板不因拉不起别人的窗而崩）。
 * 滞后哨兵（工单117）：跨线程 ShowWindow/SetForegroundWindow 对挂死目标可无限期等
 * （#107 电池侧 ShowWindow 阻塞 12 分钟同机理，审计 B8）——整段挂 `focus-tool` 标签。
 */
export function nativeFocusWindow(hwnd: number): boolean {
  return panelLabels.run('focus-tool', () => {
    const b = bind()
    try {
      if (b.isIconic(hwnd)) b.showWindow(hwnd, SW_RESTORE)
      b.bringWindowToTop(hwnd)
      return Boolean(b.setForegroundWindow(hwnd))
    } catch {
      return false
    }
  })
}

/** 启动工具真源：shell.openPath（ShellExecute 语义，单实例应用即唤起） */
export function shellLaunch(exe: string): Promise<string> {
  const { shell } = require('electron')
  return shell.openPath(exe)
}
