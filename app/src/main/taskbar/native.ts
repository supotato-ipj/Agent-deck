// 原生任务栏显隐（工单50，ADR-0007 主线）：任务栏接管开启时隐藏 Shell_TrayWnd，
// 还原走「与桌面图标隐藏同一模式」的 guard + watchdog 三条路径。
// 手段是 ShowWindow(SW_HIDE/SW_SHOW) 纯视图态切换——不写注册表、不碰 AppBar 状态，
// 用户既有任务栏偏好（自动隐藏等 StuckRects 设置）全程保持原样（验收电池比对
// StuckRects3 Settings 二进制前后不变把关）。
// 职责划分：隐藏/随开关还原由面板侧任务栏窗口控制器发起（条带窗生 = 原生隐、
// 条带窗灭 = 原生现，单点生效）；守卫（index.ts 默认分支）与还原守护
// （icon-restore-watch.cjs）只做死路径兜底——以视图事实为准，隐藏态才翻回。
// 还原是安全方向：宁可把别人藏起来的任务栏显出来，绝不给用户留无系统入口的桌面
// （v1 仅主屏——Shell_SecondaryTrayWnd 副屏栏不动，与 ADR-0007 多屏 Out of Scope 一致）。
import koffi from 'koffi'
import type { EventLog } from '../panel-ipc'

const SW_HIDE = 0
const SW_SHOW = 5

const user32 = koffi.load('user32.dll')
const FindWindowW = user32.func('uintptr_t __stdcall FindWindowW(const char16_t *lpClassName, const char16_t *lpWindowName)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(uintptr_t hWnd, int nCmdShow)')

/** 原生主任务栏句柄；explorer 不在场（崩溃重启间隙等）返回 0 */
export function nativeTrayWnd(): number {
  return Number(FindWindowW('Shell_TrayWnd', null))
}

/** 原生任务栏当前是否可见（视图事实；找不到句柄视同不可见） */
export function nativeTaskbarVisible(): boolean {
  const hwnd = nativeTrayWnd()
  return Boolean(hwnd && IsWindowVisible(hwnd))
}

/**
 * 隐藏原生任务栏（条带窗创建路径）。幂等：已隐藏/句柄缺位 = 未动作，返回 false——
 * 调用方（窗口控制器）据返回值记账「本次由我隐藏」，只还原自己藏的那次。
 * 成败以调用后视图事实为准，绝不信 ShowWindow 返回值：文档口径它返回的是「调用前
 * 可见性」而非成败，且对 Shell_TrayWnd（他进程窗口）实证连该口径都不成立——
 * 50 验收首轮实测 SW_HIDE/SW_SHOW 均返回 0 而视图已真实翻转（假失败陷阱）。
 */
export function hideNativeTaskbar(log: EventLog | null): boolean {
  const hwnd = nativeTrayWnd()
  if (!hwnd) {
    log?.append({ type: 'taskbar-hide-failed', reason: 'not-found' })
    return false
  }
  if (!IsWindowVisible(hwnd)) {
    log?.append({ type: 'taskbar-already-hidden' })
    return false
  }
  ShowWindow(hwnd, SW_HIDE)
  const ok = !IsWindowVisible(hwnd)
  log?.append({ type: ok ? 'taskbar-hidden' : 'taskbar-hide-failed', visibleAfter: nativeTaskbarVisible() })
  return ok
}

/** 还原（条带窗销毁路径）：仅当此刻确为隐藏态才翻回；调用方保证「本次由我隐藏」才调。
 * 成败判定同 hide 的视图事实纪律（ShowWindow 返回值不可信）。 */
export function showNativeTaskbar(log: EventLog | null, reason: string): void {
  const hwnd = nativeTrayWnd()
  if (!hwnd) {
    // explorer 已死：它重启会自建可见任务栏，无还原义务，记一笔降级
    log?.append({ type: 'taskbar-restore-skipped', reason, note: 'not-found' })
    return
  }
  if (IsWindowVisible(hwnd)) return // 已可见（用户/系统先一步翻回）：静默，不抢功
  ShowWindow(hwnd, SW_SHOW)
  const ok = Boolean(IsWindowVisible(hwnd))
  log?.append({ type: ok ? 'taskbar-restored' : 'taskbar-restore-failed', reason, visibleAfter: nativeTaskbarVisible() })
}

/**
 * 死路径兜底还原（守卫面板退出/还原守护 guard-dead 专用）：不依赖「本次由我隐藏」
 * 标记——守卫/守护无从查面板内存态，以视图事实为唯一判据（可见则绝不动）。
 * 静默空转：无可还原对象时不落存证（守卫每次退出一调，不为常态路径造噪声）。
 */
export function restoreNativeTaskbarIfHidden(log: EventLog | null, reason: string): void {
  const hwnd = nativeTrayWnd()
  if (!hwnd || IsWindowVisible(hwnd)) return
  ShowWindow(hwnd, SW_SHOW)
  const ok = Boolean(IsWindowVisible(hwnd))
  log?.append({ type: ok ? 'taskbar-restored' : 'taskbar-restore-failed', reason, visibleAfter: nativeTaskbarVisible() })
}

/** 一次性确保原生任务栏可见（--icon-restore 自救通道扩展：电池清场兜底与用户自救） */
export function forceShowNativeTaskbar(log: EventLog | null): void {
  const hwnd = nativeTrayWnd()
  if (!hwnd) {
    log?.append({ type: 'taskbar-restore-skipped', reason: 'force', note: 'not-found' })
    return
  }
  const wasVisible = Boolean(IsWindowVisible(hwnd))
  if (!wasVisible) ShowWindow(hwnd, SW_SHOW)
  const ok = Boolean(IsWindowVisible(hwnd))
  log?.append({ type: ok ? 'taskbar-restored' : 'taskbar-restore-failed', reason: 'force', wasVisible, visibleAfter: nativeTaskbarVisible() })
}
