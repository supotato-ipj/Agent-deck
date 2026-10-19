// AppBar 工作区占位（工单51，ADR-0007「工作区」决策）：任务栏窗口注册为 AppBar
// 占住主屏底边，系统工作区收缩——最大化窗口底边停在栏上方不被遮挡；DPI/分辨率
// 变化经 ABM_QUERYPOS+ABM_SETPOS 重协商。
// 薄效果层（无分支，真机验收覆盖，不进单测——工单46 Testing Decisions）。
// 手段是 SHAppBarMessage（shell32，Win95→Win11 未变的承重墙）：消息送达 explorer
// 的 AppBar 服务，不依赖 Shell_TrayWnd 窗口可见性——原生任务栏已被工单50 隐藏
// （ShowWindow 视图态切换），AppBar 语义不受影响。
import koffi from 'koffi'
import type { EventLog } from '../panel-ipc'

const ABM_NEW = 0
const ABM_REMOVE = 1
const ABM_SETPOS = 2
const ABM_QUERYPOS = 3
const ABE_BOTTOM = 3
/** ABN_POSCHANGED：系统通知工作区重协商（其他 AppBar 变动等），经回调消息送达 */
export const ABN_POSCHANGED = 1

/** 物理像素矩形（SHAppBarMessage 与 GetWindowRect 同为物理口径） */
export interface AppBarRect {
  left: number
  top: number
  right: number
  bottom: number
}

const RECT = koffi.struct('TASKBAR_APPBAR_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
// APPBARDATA：x64 = 48B（cbSize 4 + pad 4 + hWnd 8 + uCallbackMessage 4 + uEdge 4 + rc 16 + lParam 8）
const APPBARDATA = koffi.struct('TASKBAR_APPBARDATA', {
  cbSize: 'uint32',
  hWnd: 'uintptr_t',
  uCallbackMessage: 'uint32',
  uEdge: 'uint32',
  rc: 'TASKBAR_APPBAR_RECT',
  lParam: 'intptr_t',
})

const shell32 = koffi.load('shell32.dll')
const user32 = koffi.load('user32.dll')
const SHAppBarMessage = shell32.func('uintptr_t __stdcall SHAppBarMessage(uint32 dwMessage, TASKBAR_APPBARDATA *pData)')
const RegisterWindowMessageW = user32.func('uint32 __stdcall RegisterWindowMessageW(const char16_t *lpString)')

/** AppBar 通知回调消息号（RegisterWindowMessage 全系统一致，进程内缓存） */
let callbackMessage = 0
export function appBarCallbackMessage(): number {
  if (!callbackMessage) callbackMessage = Number(RegisterWindowMessageW('AppBarMessage'))
  return callbackMessage
}

function appBarData(hwnd: number, rc: AppBarRect) {
  return {
    cbSize: koffi.sizeof(APPBARDATA) as number,
    hWnd: hwnd,
    uCallbackMessage: appBarCallbackMessage(),
    uEdge: ABE_BOTTOM,
    rc,
    lParam: 0,
  }
}

/** 注册 AppBar（条带窗创建后调用）。返回 false = 系统拒绝，调用方走降级档。 */
export function registerAppBar(hwnd: number, rc: AppBarRect, log: EventLog | null): boolean {
  const ok = Boolean(SHAppBarMessage(ABM_NEW, appBarData(hwnd, rc)))
  log?.append({ type: ok ? 'taskbar-appbar-registered' : 'taskbar-appbar-register-failed', hwnd })
  return ok
}

/** 注销 AppBar（条带窗销毁前调用）：工作区归还全屏。静默——销毁路径不为存证造分支。 */
export function removeAppBar(hwnd: number, log: EventLog | null): void {
  SHAppBarMessage(ABM_REMOVE, appBarData(hwnd, { left: 0, top: 0, right: 0, bottom: 0 }))
  log?.append({ type: 'taskbar-appbar-removed', hwnd })
}

/**
 * 协商占位（建窗后初次、ABN_POSCHANGED、display-metrics-changed 三入口同一函数）：
 * ABM_QUERYPOS 让系统按当前工作区裁剪提议矩形，ABM_SETPOS 提交生效。返回协商后
 * 矩形（物理像素）——调用方据它重排窗口，栏与占位严格同矩形。
 */
export function negotiateAppBarPos(hwnd: number, want: AppBarRect, log: EventLog | null, reason: string): AppBarRect {
  const data = appBarData(hwnd, { ...want })
  SHAppBarMessage(ABM_QUERYPOS, data) // 系统按当前工作区裁剪提议矩形（全宽化、避让其他 AppBar）
  SHAppBarMessage(ABM_SETPOS, data)
  const rc = { left: Number(data.rc.left), top: Number(data.rc.top), right: Number(data.rc.right), bottom: Number(data.rc.bottom) }
  log?.append({ type: 'taskbar-appbar-setpos', reason, rc })
  return rc
}
