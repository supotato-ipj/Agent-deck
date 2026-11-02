// 任务栏运行中窗口快照与置前/最小化/关闭效果层（工单52/53/58，效果层薄壳）。
// 工单370（spec #369 决策 6）：顶层窗口枚举骨架、窗口身份（pid/exe）、特征位与标题读取
// 已收敛到 win-facts.ts 单一接缝（Snap 探针同缝消费）——本层是接缝上的任务栏投影 +
// 窗口效果 FFI（激活/还原/最小化/WM_CLOSE），不再持枚举绑定面；无分支裁决，收/拒裁决
// 全在 apps-plan 的 shouldShowOnTaskbar 纯函数。
// 差异保留（工单52）：任务栏投影的 exe 取全路径（应用组身份）且读窗口标题。
// 隐私（ADR-0007 对 ADR-0002 的书面口子，仅限任务栏链路）：标题仅内存即时读取，供栏上
// tooltip 与多窗口列表即时显示——永不写使用日志、永不落任何持久化。标题读取的公开缝
// nativeWindowTitle 现单文件收口在 win-facts.ts（tests/usage/log.spec.ts
// TITLE_READ_ALLOWLIST 钉此边界）。
// 加载不变式（工单271 评审收口④措辞的工单370 更新版）：taskbar/snap.ts 与本层同缝消费
// win-facts.ts；离线纯函数测试可加载本模块——效果绑定与事实接缝都 bind() 惰性（首调才
// 触 FFI，syskeys.ts/yield.ts 先例），离线测试零 FFI 实害。
import { normalizeExe } from './apps-plan'
import type { TaskbarWindowInput, TaskbarWindowTraits } from './apps-plan'
import {
  exeOfPid,
  isIconic,
  isWindowVisible,
  nativeWindowTitle,
  pidOf,
  scanTopWindows,
  windowTraits,
} from './win-facts'

interface KoffiFunc {
  (...args: unknown[]): unknown
}

/** 效果绑定表（工单370 起：仅窗口效果 FFI——事实采集全部走 win-facts 接缝） */
interface EffectBound {
  getWindowThreadProcessId: KoffiFunc
  showWindow: KoffiFunc
  bringWindowToTop: KoffiFunc
  setForegroundWindow: KoffiFunc
  getForegroundWindow: KoffiFunc
  postMessage: KoffiFunc
  attachThreadInput: KoffiFunc
  getCurrentThreadId: KoffiFunc
}

const SW_RESTORE = 9
const SW_MINIMIZE = 6
const WM_CLOSE = 0x0010

let bound: EffectBound | null = null

function bind(): EffectBound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  bound = {
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)'),
    showWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    bringWindowToTop: user32.func('bool __stdcall BringWindowToTop(uintptr_t hWnd)'),
    setForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)'),
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    postMessage: user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)'),
    attachThreadInput: user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)'),
    getCurrentThreadId: kernel32.func('uint32 __stdcall GetCurrentThreadId()'),
  }
  return bound
}

/** 任务栏窗口快照条目：exe 为绝对路径（应用组身份），hwnd/pid 预留给工单53 的激活语义；
 * 特征位（工单156）由 win-facts 接缝采集，收/拒裁决在 shouldShowOnTaskbar 纯函数 */
export interface TaskbarWindowInfo extends TaskbarWindowInput, TaskbarWindowTraits {
  hwnd: number
  pid: number
}

/**
 * 当前可见顶层窗口快照（最小化窗口仍带 WS_VISIBLE，在列——任务栏运行态含最小化）。
 * 取不到 exe 的窗口（权限/已退出）跳过；标题空归 null。纯枚举薄壳 + 接缝投影，无分支
 * 裁决（过滤判据在 apps-plan 的 shouldShowOnTaskbar，合并/去重/排序在 planAppsGroup），
 * 真机行为由验收电池覆盖。
 */
export function nativeTaskbarWindows(): TaskbarWindowInfo[] {
  const out: TaskbarWindowInfo[] = []
  for (const h of scanTopWindows((hwnd) => isWindowVisible(hwnd))) {
    const pid = pidOf(h)
    if (!pid) continue
    const exe = exeOfPid(pid)
    if (!exe) continue
    out.push({ hwnd: h, pid, exe, title: nativeWindowTitle(h), visible: true, ...windowTraits(h) })
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
  if (isIconic(hwnd)) b.showWindow(hwnd, SW_RESTORE)
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
 * 按 exe 身份把运行中窗口带到前台（工单58 点击置前真源）：接缝枚举找首个该 exe 的
 * 可见顶层窗（工单156：跳过工具窗/cloaked/有属主无 APPWINDOW 的窗——垃圾窗不是
 * 置前目标，点击应落在真实主窗上），最小化先 SW_RESTORE，再 BringWindowToTop +
 * SetForegroundWindow（focus/adapter 同款尽力序列——SetForegroundWindow 受前台锁
 * 限制可能失败，返回 false 由调用方按拒收回报，不抛）。找不到该 exe 的合格窗口
 * （竞态退出）返回 false。
 */
export function nativeFocusExeWindow(exe: string): boolean {
  const target = normalizeExe(exe)
  for (const h of scanTopWindows((hwnd) => isWindowVisible(hwnd))) {
    const pid = pidOf(h)
    if (!pid) continue
    const wexe = exeOfPid(pid)
    if (wexe && normalizeExe(wexe) === target) {
      const t = windowTraits(h)
      if (t.cloaked || t.toolWindow || (t.owned && !t.appWindow)) {
        continue // 垃圾窗形态：不是置前目标（过滤判据同款口径）
      }
      try {
        if (isIconic(h)) bind().showWindow(h, SW_RESTORE)
        bind().bringWindowToTop(h)
        return Boolean(bind().setForegroundWindow(h))
      } catch {
        return false
      }
    }
  }
  return false
}
