// Win32 FFI（koffi/NAPI）——生产所需的最小绑定：底部钉扎、z 序侦察、TOPMOST 切换。
// 绑定与调用形态经工单01 探针实证（.scratch/standalone-app/probe01，探针C 6/6）。
import { BrowserWindow } from 'electron'
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t hWnd, intptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32 uFlags)')
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)')
const FindWindowW = user32.func('uintptr_t __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)')
const GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(uintptr_t hWnd, int32 nIndex)')

const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const SWP_NOOWNERZORDER = 0x0200
const HWND_BOTTOM = 1
const HWND_TOPMOST = -1
const HWND_NOTOPMOST = -2
const GWL_EXSTYLE = -20
const WS_EX_TOPMOST = 0x8
const GW_HWNDNEXT = 2

export function hwndOf(win: BrowserWindow): number {
  const v = koffi.decode(win.getNativeWindowHandle(), 'uintptr_t')
  return typeof v === 'bigint' ? Number(v) : v
}

// 钉扎闸门（工单07）：桌面遮罩守望把面板提入 TOPMOST 带期间，任何既有的底部钉扎
// 调用点（热区离开、focus 兜底、键盘模式、唤回）都不得把它压回 Progman 之下——
// 那等于亲手把面板塞回被壁纸盖住的境地。守望器在交还（release）时自行清除闸门后重钉。
let pinBlocked: (() => boolean) | null = null

export function setPinGate(gate: (() => boolean) | null): void {
  pinBlocked = gate
}

/** 底部钉扎：压到所有普通窗口之下、壁纸/桌面层之上。Electron 无原生档位，FFI 直调。
 * 闸门置位（桌面遮罩守望的 TOPMOST 期）时跳过并返回 false（调用方只记成功钉扎）。 */
export function pinToBottom(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  if (pinBlocked && pinBlocked()) return false
  return SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}

/** 按类名找顶层窗口（如桌面宿主 Progman）；找不到返回 null。 */
export function findTopWindowByClass(className: string): number | null {
  const h = FindWindowW(className, null)
  return h ? Number(h) : null
}

/** 窗口是否带 WS_EX_TOPMOST 位。 */
export function isTopmost(hwnd: number): boolean {
  return (GetWindowLongW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST) !== 0
}

/** TOPMOST 带进出（工单07 桌面遮罩守望专用）：SWP_NOACTIVATE，不动几何。 */
export function setTopmost(hwnd: number, on: boolean): boolean {
  return SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}

/** a 是否排在 b 之上（可见窗口 z 序，自顶向下先遇到者在上）。任一不可见/不存在时
 * 不可判 → false（调用方以 null/其他条件兜底）。 */
export function zPrecedes(a: number, b: number): boolean {
  let h = GetTopWindow(0)
  for (let i = 0; h && i < 512; i++) {
    const cur = Number(h)
    if (IsWindowVisible(cur)) {
      if (cur === a) return true
      if (cur === b) return false
    }
    h = GetWindow(cur, GW_HWNDNEXT)
  }
  return false
}

/** 窗口之下（z 序更低处）是否还有可见顶层窗口。桌面宿主 Progman 常态即最底；
 * show desktop 态它被抬顶、下方留下最小化窗——以此判别「Progman 已回底」。 */
export function hasVisibleBelow(hwnd: number): boolean {
  let h = GetWindow(hwnd, GW_HWNDNEXT)
  for (let i = 0; h && i < 512; i++) {
    const cur = Number(h)
    if (IsWindowVisible(cur)) return true
    h = GetWindow(cur, GW_HWNDNEXT)
  }
  return false
}
