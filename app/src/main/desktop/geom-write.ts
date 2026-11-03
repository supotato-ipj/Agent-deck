// 窗口几何写入适配层（工单376，spec #369 决策 8 的 FFI 半边）：外部窗口几何写
// （SetWindowPos）与 LOCATIONCHANGE 事件观察（SetWinEventHook）。t372 探针 go 裁决的
// 生产路径（app/accept/experiments/t372-window-geom-probe.js 实证：物理 px 口径、
// SWP_NOZORDER|SWP_NOACTIVATE、回声抑制参数与「koffi 回调注册须具名 proto」坑位）。
//
// 边界（win-facts.ts 只读接缝的对称面）：本模块**只做效果**（写窗 + 事件观察起停），
// 不做裁决——回声归类/重排决策在 geom-control.ts（离线可测），编排串行落位在
// services/agent-tiling.ts。本模块不激活窗口、不改 z 序、不投递键盘鼠标。
//
// lazy-bind（win-facts/yield 同款）：模块加载不触 FFI，首调才 require koffi——离线
// 纯函数测试零 FFI 实害。koffi 具名注册进程级唯一（#153 教训）：proto 名带本票前缀。
//
// 事件回调纪律（t372 实证坑）：WinEvent 回调依赖本线程消息循环派发（Electron 主进程
// 常驻泵——与探针的 pumpSleep 单纯是探针没泵；生产 Electron 主线程持续泵消息），
// 回调体内只做零 FFI 的轻活（读矩形收进队列），归类与重排全部回到编排层 tick。

import type { TileRect } from './tiling-plan'
import type { ScopeRect } from './tile-scope'

const EVENT_OBJECT_LOCATIONCHANGE = 0x800b
const WINEVENT_OUTOFCONTEXT = 0
const OBJID_WINDOW = 0
const SWP_NOZORDER = 0x4
const SWP_NOACTIVATE = 0x10
const GA_ROOT = 2
const WM_SYSCOMMAND = 0x0112
const SC_RESTORE = 0xf120
const SW_MAXIMIZE = 3
const SW_RESTORE = 9
const EVENT_SYSTEM_FOREGROUND = 0x0003

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface GeomBound {
  setWindowPos: KoffiFunc
  getWindowRect: KoffiFunc
  setWinEventHook: KoffiFunc
  unhookWinEvent: KoffiFunc
  getForegroundWindow: KoffiFunc
  setForegroundWindow: KoffiFunc
  showWindow: KoffiFunc
  getAncestor: KoffiFunc
  isZoomed: KoffiFunc
  postMessage: KoffiFunc
}

let bound: GeomBound | null = null
/** 事件回调单登（koffi 具名注册进程级唯一——二次 startWatch 复用同一注册体，#153 教训） */
let registeredCb: ((hwnd: number) => void) | null = null
let registeredProc: unknown = null
let hookHandle: unknown = null
/** 前台观察（工单379）：独立注册体（同名二次 register 是 #153 坑——各自单登） */
let fgRegisteredCb: ((hwnd: number) => void) | null = null
let fgRegisteredProc: unknown = null
let fgHookHandle: unknown = null

function bind(): GeomBound {
  if (bound) return bound
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  koffi.struct('GEOM_WRITE_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  koffi.proto(
    '__stdcall',
    'GEOM_WRITE_WINEVENT_PROC',
    'void',
    ['void *', 'uint32', 'uintptr_t', 'int32', 'int32', 'uint32', 'uint32'],
  )
  koffi.proto(
    '__stdcall',
    'GEOM_WRITE_FOREGROUND_PROC',
    'void',
    ['void *', 'uint32', 'uintptr_t', 'int32', 'int32', 'uint32', 'uint32'],
  )
  bound = {
    setWindowPos: user32.func(
      'bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t after, int x, int y, int cx, int cy, uint32 flags)',
    ),
    getWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ GEOM_WRITE_RECT *r)'),
    setWinEventHook: user32.func(
      'void * __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)',
    ),
    unhookWinEvent: user32.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)'),
    getForegroundWindow: user32.func('uintptr_t __stdcall GetForegroundWindow()'),
    setForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(uintptr_t hWnd)'),
    showWindow: user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)'),
    getAncestor: user32.func('uintptr_t __stdcall GetAncestor(uintptr_t hWnd, uint32 gaFlags)'),
    isZoomed: user32.func('bool __stdcall IsZoomed(uintptr_t hWnd)'),
    postMessage: user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wParam, intptr_t lParam)'),
  }
  return bound
}

/**
 * 目标窗此刻是否前台（工单378「用户主动操作」判据）：拖动/边框/最大化/键盘/Snap 都作用于
 * 前台窗；后台自改不满足——复原但不弹框（决策 10、story 30）。取根窗比较（GA_ROOT），
 * 被属主/子窗包装的目标也能判对。读失败按非前台（安全方向：静默复原，不误弹框）。
 */
export function isForegroundWindow(hwnd: number): boolean {
  try {
    const b = bind()
    const fg = Number(b.getForegroundWindow())
    if (!fg) return false
    const root = Number(b.getAncestor(fg, GA_ROOT)) || fg
    return root === Number(hwnd) || fg === Number(hwnd)
  } catch {
    return false
  }
}

/**
 * 复原窗到目标矩形（工单378 首次操作复原）：最大化态先发 WM_SYSCOMMAND SC_RESTORE
 * （t372 S5B 实证的跨进程还原入口，逐像素回到原矩形），再 SetWindowPos 写目标——
 * 避免直接对最大化窗写几何被系统夹取。返回写窗受理与否。
 */
export function restoreWindowRect(hwnd: number, target: TileRect): boolean {
  try {
    const b = bind()
    if (b.isZoomed(hwnd)) b.postMessage(hwnd, WM_SYSCOMMAND, SC_RESTORE, 0)
  } catch {
    /* 还原消息失败不阻写：SetWindowPos 仍可能生效，核验在编排层 */
  }
  return writeWindowRect(hwnd, target)
}

/** 写窗（物理 px；不激活不改 z 序）。返回系统受理与否——受理 ≠ 最终达标（核验在编排层） */
export function writeWindowRect(hwnd: number, target: TileRect): boolean {
  const b = bind()
  try {
    return Boolean(
      b.setWindowPos(
        hwnd,
        0,
        target.left,
        target.top,
        target.right - target.left,
        target.bottom - target.top,
        SWP_NOZORDER | SWP_NOACTIVATE,
      ),
    )
  } catch {
    return false // 窗口竞态销毁：按写失败回报（编排层按失败账处理）
  }
}

/** 读窗矩形（物理 px；竞态销毁按零矩形——tile-scope 的安全方向） */
export function readWindowRect(hwnd: number): ScopeRect {
  const b = bind()
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  try {
    if (!b.getWindowRect(hwnd, r)) return r
  } catch {
    return r
  }
  return r
}

/**
 * 起 LOCATIONCHANGE 观察（全局 hook——目标窗集在编排层过滤）：回调只收 hwnd（轻活），
 * 矩形读取与回声归类都在调用方。返回停表函数（Unhook + 解注册）；重复起表先停旧表
 * （单观察源——多 hook 是重复事件源，回声账会被双读）。
 */
export function startLocationChangeWatch(onEvent: (hwnd: number) => void): () => void {
  const b = bind()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  stopLocationChangeWatch()
  // 注册体进程级单登（首起才 register；重起只换 registeredCb 指向——同名二次 register
  // 是 #153 坑，且 hook 生灭频次高于进程寿命）
  if (!registeredProc) {
    registeredProc = koffi.register(
      (_hHook: unknown, event: number, hwnd: number, idObject: number) => {
        if (event !== EVENT_OBJECT_LOCATIONCHANGE || idObject !== OBJID_WINDOW) return
        try {
          registeredCb?.(Number(hwnd))
        } catch {
          /* 回调异常不入事件流（观察面不产生改窗副作用） */
        }
      },
      'GEOM_WRITE_WINEVENT_PROC *',
    )
  }
  registeredCb = onEvent
  hookHandle = b.setWinEventHook(
    EVENT_OBJECT_LOCATIONCHANGE,
    EVENT_OBJECT_LOCATIONCHANGE,
    null,
    registeredProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT,
  )
  return stopLocationChangeWatch
}

/** 停表（幂等）：Unhook + 解注册——卸载/失活路径零残留事件源 */
export function stopLocationChangeWatch(): void {
  if (hookHandle) {
    try {
      bind().unhookWinEvent(hookHandle)
    } catch {
      /* 收尾尽力 */
    }
    hookHandle = null
  }
  // koffi 注册体不显式解挂（进程级单登复用——二次起表 koffi.register 同名会撞 #153 坑，
  // 保留单注册体、只换 registeredCb 指向是最安全的复用形态）
  registeredCb = null
}

/** 当前前台窗 hwnd（读失败/无前台 → null） */
export function foregroundWindow(): number | null {
  try {
    const fg = Number(bind().getForegroundWindow())
    return fg > 0 ? fg : null
  } catch {
    return null
  }
}

/**
 * 真实最大化并激活目标窗（工单379，spec #369 决策 16 / GLOSSARY「Agent 聚焦」）：
 * ShowWindow(SW_MAXIMIZE) 是系统级真最大化——既有的最大化收栏（IsZoomed 族事实）
 * 照常生效；随后 SetForegroundWindow 把焦点交给目标（预览窗刚取焦，本进程是前台，
 * 激活许可成立）。返回系统受理与否（受理 ≠ 最终达标，验收以 IsZoomed/几何为准）。
 */
export function maximizeWindow(hwnd: number): boolean {
  try {
    const b = bind()
    const shown = Boolean(b.showWindow(hwnd, SW_MAXIMIZE))
    // 兼容前台许可被拒的时机：先激活再最大化一次（不改变结果语义，只是提高成功率）
    const fg = Number(b.getForegroundWindow())
    if (fg !== Number(hwnd)) b.setForegroundWindow(hwnd)
    return shown
  } catch {
    return false
  }
}

/** 还原目标窗到最大化前几何（退出聚焦；与 restoreWindowRect 的 SC_RESTORE 同源语义） */
export function restoreWindow(hwnd: number): boolean {
  try {
    return Boolean(bind().showWindow(hwnd, SW_RESTORE))
  } catch {
    return false
  }
}

/**
 * 前台变化观察（工单379，聚焦协调）：EVENT_SYSTEM_FOREGROUND 全局钩子——回调只递
 * 新前台窗 hwnd（轻活；判定与退出聚焦在服务层）。返回停表函数（Unhook + 解注册）。
 * 注册体进程级单登（#153 教训：同名二次 register 崩）——重起只换回调指向。
 */
export function startForegroundWatch(onChange: (hwnd: number) => void): () => void {
  const b = bind()
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  stopForegroundWatch()
  if (!fgRegisteredProc) {
    fgRegisteredProc = koffi.register(
      (_hHook: unknown, _event: number, hwnd: number) => {
        try {
          fgRegisteredCb?.(Number(hwnd))
        } catch {
          /* 回调异常不入事件流 */
        }
      },
      'GEOM_WRITE_FOREGROUND_PROC *',
    )
  }
  fgRegisteredCb = onChange
  fgHookHandle = b.setWinEventHook(
    EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_FOREGROUND,
    null,
    fgRegisteredProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT,
  )
  return stopForegroundWatch
}

/** 停前台观察（幂等） */
export function stopForegroundWatch(): void {
  if (fgHookHandle) {
    try {
      bind().unhookWinEvent(fgHookHandle)
    } catch {
      /* 收尾尽力 */
    }
    fgHookHandle = null
  }
  fgRegisteredCb = null
}
