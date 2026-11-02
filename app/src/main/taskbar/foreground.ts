// 托盘回调的前台放行（工单363）：应用收到托盘回调后要弹**自己的**菜单 ⇒ 它必须能取前台。
// Windows 的前台锁下，只有「持前台权或末次输入」的过程能替别的进程放行
//（AllowSetForegroundWindow，形参是属主进程 id——不是 hwnd，工单163/164 教训）。
// 外壳同款：投递托盘回调之前先替应用放行，应用随后 SetForegroundWindow + 弹菜单。
//
// 我们的投递真源在数据面子进程（托盘宿主与负载合成同处），但那儿既非前台也非末次
// 输入接收者——真机实证放行恒失败（tray-replay 存证 asfw=false）⇒ 应用弹不出菜单
//（OneDrive 自绘面板、Electron 托盘菜单皆零菜单），或弹出的菜单不持前台
//（PowerToys 的 #32768 标准菜单在场但前台未转移 ⇒ 点外/Esc 收不掉，条带让位
// 只能等超时上限恢复）。放行因此落在面板主进程：条带窗属主进程、也是真实右键的
// 末次输入接收者——与外壳放行时机一致。
//
// 本模块只做「放行」这一件事：解析属主 pid + 调 AllowSetForegroundWindow。
// 不取前台、不注入输入、不碰菜单生命周期（工单363 硬约束：不加定时强制关菜单、
// 全局 Esc 注入、全局输入钩子、不为任何应用建特判）。

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  allowSetForegroundWindow: KoffiFunc
}

let bound: Bound | null = null

/** 延迟绑定（模块加载不触 FFI——离线单测注假源不引 koffi，yield.ts 先例） */
function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  bound = {
    // 形参是 DWORD dwProcessId（属主进程 id）——传 hwnd 恒失败
    allowSetForegroundWindow: user32.func('bool __stdcall AllowSetForegroundWindow(uintptr_t dwProcessId)'),
  }
  return bound
}

/** 放行真源：允许指定进程取前台；API 不可用时抛（由上层收口为失败回报） */
function defaultAllow(pid: number): boolean {
  return Boolean(bind().allowSetForegroundWindow(pid))
}

/** 放行裁决的存证口径 */
export type TrayForegroundReason = 'ok' | 'no-hwnd' | 'no-pid' | 'allow-failed'

export interface TrayForegroundOutcome {
  /** 放行目标 pid（0 = 无目标，未放行） */
  pid: number
  /** 是否放行成功 */
  granted: boolean
  /** 理由（存证用） */
  reason: TrayForegroundReason
}

export interface TrayForegroundDeps {
  /** AllowSetForegroundWindow 真源（缺省延迟绑定 user32；离线单测注假源不触 FFI） */
  allow?: (pid: number) => boolean
}

/**
 * 放行裁决：属主 hwnd 与 pid 都缺位即不放行（不猜、不代持第三方进程）——
 * 放行是「把这一个图标属主进程的取前台权还给它」，不是全局放行。
 */
export function grantTrayForeground(
  input: { hwnd: number; pid: number },
  deps: TrayForegroundDeps = {},
): TrayForegroundOutcome {
  if (!input.hwnd) return { pid: 0, granted: false, reason: 'no-hwnd' }
  if (!input.pid) return { pid: 0, granted: false, reason: 'no-pid' }
  const allow = deps.allow ?? defaultAllow
  try {
    return { pid: input.pid, granted: Boolean(allow(input.pid)), reason: 'ok' }
  } catch {
    // 放行失败不是致命错：应用仍可弹自己的菜单（只是不持前台）——如实回报不抛穿
    return { pid: input.pid, granted: false, reason: 'allow-failed' }
  }
}
