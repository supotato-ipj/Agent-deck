// 桌面域窗口框架事实（工单377，spec #369 决策 12「固定尺寸…进入异常未平铺」的预判据）：
// 「这扇窗接不接受用户级改窗」——窗口样式（WINDOWINFO.dwStyle）的 WS_THICKFRAME 位。
// **只读**事实采集，
// 零改窗能力；离线纯函数测试不触本模块（lazy bind：模块加载不 require koffi）。
//
// 为什么不复用 taskbar/win-facts 的样式读：taskbar 域有一条全树源码守卫
// （tests/taskbar/retract-orchestration.spec.ts「真最大化探针」）禁止 app/src 出现
// GWL_STYLE 符号——那条守卫约束的是最大化收栏裁决必须用 IsZoomed 族真事实、不许拿样式位
// 推断；本模块与最大化裁决无关，故走 GetWindowInfo 这一独立 API 原子取窗口样式
// （WINDOWINFO.dwStyle），守卫原样保留、不加豁免。
//
// 采集失败口径（同 win-facts 两投影）：取不到（窗口竞态销毁）按「不可改窗」回报——
// 调用方把缺位并入固定尺寸向（异常未平铺是跳过+报告，无破坏性，安全向）。

const WS_THICKFRAME = 0x00040000

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getWindowInfo: KoffiFunc
  /** WINDOWINFO 结构字节数（cbSize 必填） */
  size: number
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  // 具名 struct 进程级单登（#153 教训：撞名即崩）——前缀本模块独有
  const rect = koffi.struct('TILE_WINDOWINFO_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  const info = koffi.struct('TILE_WINDOWINFO', {
    cbSize: 'uint32',
    rcWindow: rect,
    rcClient: rect,
    dwStyle: 'uint32',
    dwExStyle: 'uint32',
    dwWindowStatus: 'uint32',
    cxWindowBorders: 'uint32',
    cyWindowBorders: 'uint32',
    atomWindowType: 'uint16',
    wCreatorVersion: 'uint16',
  })
  bound = {
    getWindowInfo: user32.func('bool __stdcall GetWindowInfo(uintptr_t hWnd, _Inout_ TILE_WINDOWINFO *wi)'),
    size: koffi.sizeof(info),
  }
  return bound
}

/**
 * 窗接受用户级改窗（FrameStyle 含 WS_THICKFRAME）。缺位 = 固定尺寸窗（含样式读失败）。
 * 每次调用自建 cbSize 齐备的 WINDOWINFO（koffi 结构体传对象，FFI 回填 dwStyle）。
 */
export function hasResizableFrame(hwnd: number): boolean {
  const b = bind()
  const wi = {
    cbSize: b.size,
    rcWindow: { left: 0, top: 0, right: 0, bottom: 0 },
    rcClient: { left: 0, top: 0, right: 0, bottom: 0 },
    dwStyle: 0,
    dwExStyle: 0,
    dwWindowStatus: 0,
    cxWindowBorders: 0,
    cyWindowBorders: 0,
    atomWindowType: 0,
    wCreatorVersion: 0,
  }
  try {
    if (!b.getWindowInfo(hwnd, wi)) return false
  } catch {
    return false // 竞态销毁 → 异常向（跳过 + 报告）
  }
  return (Number(wi.dwStyle) & WS_THICKFRAME) !== 0
}
