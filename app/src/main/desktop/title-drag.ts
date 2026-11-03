// 标题栏原生拖动观察（工单407，spec #403 决策「原生拖动手势先探针后接入」）：
// EVENT_SYSTEM_MOVESIZESTART / MOVESIZEEND 全局钩子（SetWinEventHook，t407 探针 GO
// 实证：真实标题栏拖动起止各恰好一帧、hwnd 即被拖窗根窗、exe 身份可读、真实窗口移动、
// 非标题栏拖拽零事件——accept/experiments/t407-title-drag-probe.js）。
//
// 纪律（geom-write.ts 同款）：本模块只做效果（事件观察起停 + 光标点读取），不做裁决
// ——落点判定/资格核对/迁移事务在 services/agent-drag-in.ts 与 desktop/drag-in-plan.ts。
// **不引入全局低级鼠标钩子**（spec 决策红线）：MOVESIZE 事件源只认标题栏移动手势，
// Chromium 图标拖拽（OLE drop）不发本族事件——拖拽身份永远不会混入本判定路径。
//
// lazy-bind（win-facts/geom-write 同款）：模块加载不触 FFI，首调才 require koffi——
// 离线纯函数测试零 FFI 实害。koffi 具名注册进程级唯一（#153 教训）：proto 名带本票
// 前缀 TITLE_DRAG_。回调只做零侧效轻活（记 hwnd + 读光标点），判定回编排层。

const EVENT_SYSTEM_MOVESIZESTART = 0x000a
const EVENT_SYSTEM_MOVESIZEEND = 0x000b
const WINEVENT_OUTOFCONTEXT = 0
const OBJID_WINDOW = 0

export interface ScreenPoint {
  x: number
  y: number
}

export interface TitleDragHooks {
  /** 拖动会话开始（hwnd = 被移动窗口——源窗口身份的唯一出处） */
  onStart?: (hwnd: number) => void
  /** 拖动会话结束（point = 松手时刻光标屏幕坐标——落点判定的光标事实） */
  onEnd?: (hwnd: number, point: ScreenPoint | null) => void
}

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface DragBound {
  setWinEventHook: KoffiFunc
  unhookWinEvent: KoffiFunc
  getCursorPos: KoffiFunc
}

let bound: DragBound | null = null
let bindFailed = false
/** 事件回调单登（koffi 具名注册进程级唯一——二次 start 复用同一注册体，#153 教训） */
let registeredCb: ((event: number, hwnd: number) => void) | null = null
let registeredProc: unknown = null
let hookHandle: unknown = null

function bind(): DragBound | null {
  if (bindFailed) return null
  if (bound) return bound
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi')
    const user32 = koffi.load('user32.dll')
    koffi.struct('TITLE_DRAG_POINT', { x: 'long', y: 'long' })
    koffi.proto(
      '__stdcall',
      'TITLE_DRAG_WINEVENT_PROC',
      'void',
      ['void *', 'uint32', 'uintptr_t', 'int32', 'int32', 'uint32', 'uint32'],
    )
    bound = {
      setWinEventHook: user32.func(
        'void * __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *hmodWinEventProc, void *pfnWinEventProc, uint32 idProcess, uint32 idThread, uint32 dwFlags)',
      ),
      unhookWinEvent: user32.func('bool __stdcall UnhookWinEvent(void *hWinEventHook)'),
      getCursorPos: user32.func('bool __stdcall GetCursorPos(_Out_ TITLE_DRAG_POINT *pt)'),
    }
    return bound
  } catch {
    bindFailed = true
    return null
  }
}

/** 松手时刻光标屏幕坐标（读失败 = null——调用方按「落点不可判」处理，不猜） */
export function readCursorPoint(): ScreenPoint | null {
  try {
    const b = bind()
    if (!b) return null
    const pt = { x: 0, y: 0 }
    if (!b.getCursorPos(pt)) return null
    return { x: pt.x, y: pt.y }
  } catch {
    return null
  }
}

/**
 * 起标题栏拖动观察（全局 MOVESIZE 钩子——源窗口过滤在编排层）。回调只递 hwnd 与松手
 * 光标点（轻活纪律）。返回停表函数（Unhook + 解注册）；重复起表先停旧表（单观察源）。
 */
export function startTitleDragWatch(hooks: TitleDragHooks): () => void {
  const b = bind()
  if (!b) return () => undefined // 绑定不可用：零观察（失败关闭，编排层零拖入）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const koffi = require('koffi')
  stopTitleDragWatch()
  if (!registeredProc) {
    registeredProc = koffi.register(
      (_hHook: unknown, event: number, hwnd: number, idObject: number) => {
        if (idObject !== OBJID_WINDOW) return
        try {
          registeredCb?.(Number(event), Number(hwnd))
        } catch {
          /* 回调异常不入事件流（观察面不产生改窗副作用） */
        }
      },
      'TITLE_DRAG_WINEVENT_PROC *',
    )
  }
  registeredCb = (event, hwnd) => {
    if (event === EVENT_SYSTEM_MOVESIZESTART) hooks.onStart?.(hwnd)
    else if (event === EVENT_SYSTEM_MOVESIZEEND) hooks.onEnd?.(hwnd, readCursorPoint())
  }
  hookHandle = b.setWinEventHook(
    EVENT_SYSTEM_MOVESIZESTART,
    EVENT_SYSTEM_MOVESIZEEND,
    null,
    registeredProc,
    0,
    0,
    WINEVENT_OUTOFCONTEXT,
  )
  return stopTitleDragWatch
}

/** 停表（幂等）：Unhook + 解注册——失活/卸载路径零残留事件源 */
export function stopTitleDragWatch(): void {
  if (hookHandle) {
    try {
      const b = bind()
      if (b) b.unhookWinEvent(hookHandle)
    } catch {
      /* 收尾尽力 */
    }
    hookHandle = null
  }
  registeredCb = null
}
