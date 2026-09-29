// Win32 FFI（koffi/NAPI）——生产所需的最小绑定：底部钉扎。
// 绑定与调用形态经工单01 探针实证（.scratch/standalone-app/probe01，探针C 6/6）。
import { BrowserWindow } from 'electron'
import koffi from 'koffi'

const user32 = koffi.load('user32.dll')
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t hWnd, uintptr_t hWndInsertAfter, int x, int y, int cx, int cy, uint32 uFlags)')

const SWP_NOSIZE = 0x0001
const SWP_NOMOVE = 0x0002
const SWP_NOACTIVATE = 0x0010
const SWP_NOOWNERZORDER = 0x0200
const HWND_BOTTOM = 1

export function hwndOf(win: BrowserWindow): number {
  const v = koffi.decode(win.getNativeWindowHandle(), 'uintptr_t')
  return typeof v === 'bigint' ? Number(v) : v
}

/** 底部钉扎：压到所有普通窗口之下、壁纸/桌面层之上。Electron 无原生档位，FFI 直调。 */
export function pinToBottom(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false
  return SetWindowPos(hwndOf(win), HWND_BOTTOM, 0, 0, 0, 0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}
