// 任务栏运行中窗口枚举真源（工单52，效果层薄壳）：顶层可见窗口链式枚举 →
// exe 绝对路径 + 窗口标题。枚举形态同 focus/adapter.ts（GetTopWindow/GetWindow 链，
// 避免 FFI 回调生命周期问题）；差异是 exe 取全路径（应用组身份）且读窗口标题。
// 工单156：枚举只负责采集窗口特征（可见样式位/cloaked/工具窗/属主/APPWINDOW），
// 收/拒裁决全在 apps-plan 的 shouldShowOnTaskbar 纯函数，本层不载裁决。
// 隐私（ADR-0007 对 ADR-0002 的书面口子，仅限任务栏链路）：标题仅内存即时读取，
// 供栏上 tooltip 与多窗口列表即时显示——永不写使用日志、永不落任何持久化。
// 离线测试不加载本模块（服务依赖缝注入假源后从不 require）。
import { normalizeExe } from './apps-plan'
import type { TaskbarWindowInput, TaskbarWindowTraits } from './apps-plan'

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const GW_HWNDNEXT = 2
const GW_OWNER = 4
const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_APPWINDOW = 0x00040000
const DWMWA_CLOAKED = 14
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
  isIconic: KoffiFunc
  showWindow: KoffiFunc
  bringWindowToTop: KoffiFunc
  setForegroundWindow: KoffiFunc
  openProcess: KoffiFunc
  queryImageName: KoffiFunc
  closeHandle: KoffiFunc
  getForegroundWindow: KoffiFunc
  postMessage: KoffiFunc
  attachThreadInput: KoffiFunc
  getCurrentThreadId: KoffiFunc
  getWindowLong: KoffiFunc
  dwmGetWindowAttribute: KoffiFunc
}

const SW_RESTORE = 9
const SW_MINIMIZE = 6
const WM_CLOSE = 0x0010

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  bound = {
    getTopWindow: user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)'),
    getWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)'),
    isWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)'),
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)'),
    getWindowTextLength: user32.func('int __stdcall GetWindowTextLengthW(uintptr_t hWnd)'),
    getWindowText: user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, char16_t *lpString, int nMaxCount)'),
    isIconic: user32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    showWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    bringWindowToTop: user32.func('bool __stdcall BringWindowToTop(uintptr_t hWnd)'),
    setForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    queryImageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    postMessage: user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
    attachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
    getCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
    getWindowLong: user32.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)'),
    dwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)'),
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

/**
 * 窗口标题即时读取的公开缝（工单269）：分屏会话成员资格复用现有合格过滤
 * （shouldShowOnTaskbar 需空标题判据），但**标题读取的隐私口子仍收在本模块**
 * （ADR-0007 唯一例外——tests/usage/log.spec.ts 的 TITLE_READ_ALLOWLIST 钉此边界），
 * 调用方（taskbar/snap.ts）不直读标题。仅内存即时使用、永不持久化，同款纪律。
 */
export function nativeWindowTitle(hwnd: number): string | null {
  return titleOf(bind(), hwnd)
}

/**
 * 窗口特征采集（工单156 薄壳职责）：EXSTYLE 的工具窗/APPWINDOW 位、GW_OWNER 属主、
 * DWMWA_CLOAKED（挂起/其他桌面）。单点取失败按「未采集到该拒绝位」回报（判据缺省
 * 通过的兼容口径），不抛不重试。
 */
function traitsOf(b: Bound, hwnd: number): TaskbarWindowTraits {
  let toolWindow = false
  let appWindow = false
  try {
    const ex = Number(b.getWindowLong(hwnd, GWL_EXSTYLE)) | 0
    toolWindow = (ex & WS_EX_TOOLWINDOW) !== 0
    appWindow = (ex & WS_EX_APPWINDOW) !== 0
  } catch { /* 样式取不到（窗口竞态销毁）按无位 */ }
  let owned = false
  try {
    owned = Number(b.getWindow(hwnd, GW_OWNER)) !== 0
  } catch { /* 属主取不到按无属主 */ }
  let cloaked = false
  try {
    const buf = Buffer.alloc(4)
    if (b.dwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0) cloaked = buf.readInt32LE(0) !== 0
  } catch { /* DWM 态取不到按未 cloak */ }
  return { visible: true, cloaked, toolWindow, owned, appWindow }
}

/** 任务栏窗口快照条目：exe 为绝对路径（应用组身份），hwnd/pid 预留给工单53 的激活语义；
 * 特征位（工单156）由本枚举采集，收/拒裁决在 shouldShowOnTaskbar 纯函数 */
export interface TaskbarWindowInfo extends TaskbarWindowInput, TaskbarWindowTraits {
  hwnd: number
  pid: number
}

/**
 * 当前可见顶层窗口快照（最小化窗口仍带 WS_VISIBLE，在列——任务栏运行态含最小化）。
 * 取不到 exe 的窗口（权限/已退出）跳过；标题空归 null。纯枚举薄壳，无分支裁决
 * （过滤判据在 apps-plan 的 shouldShowOnTaskbar，合并/去重/排序在 planAppsGroup），
 * 真机行为由验收电池覆盖。
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
        if (exe) out.push({ hwnd: h, pid, exe, title: titleOf(b, h), ...traitsOf(b, h) })
      }
    }
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return out
}

// —— 工单53 窗口效果薄壳（无分支裁决——裁决全在 interactions.ts 纯函数；真机行为由验收电池覆盖）——

/** 当前前台窗口 hwnd（三态裁决「已前台」判据；无前台窗口归 0） */
export function nativeForegroundHwnd(): number {
  return Number(bind().getForegroundWindow()) || 0
}

/**
 * 置前目标窗口（最小化先还原）。SetForegroundWindow 有前台锁——本进程后台无焦点时
 * 直调会静默失败（任务栏闪烁提示了事）；AttachThreadInput 链到当前前台线程再置前是
 * 验收电池 forceForeground 同款实证形态。调用方按 hwnd 即时操作，句柄失效即 false。
 */
export function nativeActivateWindow(hwnd: number): boolean {
  const b = bind()
  if (b.isIconic(hwnd)) b.showWindow(hwnd, SW_RESTORE)
  const fg = Number(b.getForegroundWindow()) || 0
  const curTid = b.getCurrentThreadId() as number
  const fgTid = fg ? (b.getWindowThreadProcessId(fg, Buffer.alloc(4)) as number) : 0
  const attached = !!(fgTid && fgTid !== curTid && b.attachThreadInput(curTid, fgTid, true))
  try {
    b.bringWindowToTop(hwnd)
    return !!b.setForegroundWindow(hwnd)
  } finally {
    if (attached) b.attachThreadInput(curTid, fgTid, false)
  }
}

/** 最小化目标窗口（已前台再点的切换语义，Win11 同款） */
export function nativeMinimizeWindow(hwnd: number): boolean {
  return !!bind().showWindow(hwnd, SW_MINIMIZE)
}

/** 投递 WM_CLOSE（优雅关闭：多窗口/有未存确认的应用按自身语义处理，不强杀） */
export function nativeCloseWindow(hwnd: number): boolean {
  return !!bind().postMessage(hwnd, WM_CLOSE, 0, 0)
}

/**
 * 按 exe 身份把运行中窗口带到前台（工单58 点击置前真源）：链式枚举找首个该 exe 的
 * 可见顶层窗（工单156：跳过工具窗/cloaked/有属主无 APPWINDOW 的窗——垃圾窗不是
 * 置前目标，点击应落在真实主窗上），最小化先 SW_RESTORE，再 BringWindowToTop +
 * SetForegroundWindow（focus/adapter 同款尽力序列——SetForegroundWindow 受前台锁
 * 限制可能失败，返回 false 由调用方按拒收回报，不抛）。找不到该 exe 的合格窗口
 * （竞态退出）返回 false。
 */
export function nativeFocusExeWindow(exe: string): boolean {
  const b = bind()
  const target = normalizeExe(exe)
  let h = b.getTopWindow(0) as number
  let guard = 0
  while (h && guard++ < MAX_WINDOWS) {
    if (b.isWindowVisible(h)) {
      const pid = pidOf(b, h)
      if (pid) {
        const wexe = exeOfPid(b, pid)
        if (wexe && normalizeExe(wexe) === target) {
          const t = traitsOf(b, h)
          if (t.cloaked || t.toolWindow || (t.owned && !t.appWindow)) {
            h = b.getWindow(h, GW_HWNDNEXT) as number
            continue // 垃圾窗形态：不是置前目标（枚举过滤判据同款口径）
          }
          try {
            if (b.isIconic(h)) b.showWindow(h, SW_RESTORE)
            b.bringWindowToTop(h)
            return Boolean(b.setForegroundWindow(h))
          } catch {
            return false
          }
        }
      }
    }
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return false
}
