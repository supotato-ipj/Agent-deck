// 原生桌面图标显隐守护（工单05）：隐藏 = explorer 桌面「查看 → 显示桌面图标」同一命令
// （SHELLDLL_DefView 的 WM_COMMAND 0x7402，explorer 同步写回注册表 HideIcons 偏好；
// Win11 26200 真机实证生效——脚本 scripts/exp-toggle.cjs 一轮，已删）。
// 由外层守卫进程（index.ts 默认分支）持有：面板拉起前隐藏、面板退出（含崩溃/强杀——
// taskkill /T 只清向下子树，杀面板进程杀不到父级守卫）后还原。还原条件唯一：本次由我
// 隐藏；用户自身偏好隐藏（HideIcons=1）则全程不动，避免顶掉用户设置。
// 显隐事实以 SysListView32 可见性为准、偏好以注册表为准，两者都进存证日志。
import { spawnSync } from 'node:child_process'
import koffi from 'koffi'
import type { EventLog } from './panel-ipc'

const WM_COMMAND = 0x0111
const TOGGLE_DESKTOP_ICONS = 0x7402
const SMTO_ABORTIFHUNG = 0x0002
const GW_HWNDNEXT = 2
const ADV_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced'

const user32 = koffi.load('user32.dll')
const FindWindowExW = user32.func('uintptr_t __stdcall FindWindowExW(uintptr_t, uintptr_t, const char16_t *, const char16_t *)')
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t, uint32)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t, uint16_t *, int)')
// lpdwResult 可为 NULL（Win32 文档允许），koffi 指针参数收 null
const SendMessageTimeoutW = user32.func('bool __stdcall SendMessageTimeoutW(uintptr_t, uint32, uintptr_t, intptr_t, uint32, uint32, void *)')

function className(hwnd: number): string {
  const buf = Buffer.alloc(512)
  const n = GetClassNameW(hwnd, buf, 256)
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(buf.readUInt16LE(i * 2))
  return s
}

/** DefView 宿主：无动态壁纸时在 Progman 下；Wallpaper Engine 等挂 WorkerW 后在 WorkerW 下 */
export function findDefView(): number {
  const progman = FindWindowExW(0, 0, 'Progman', null)
  if (progman) {
    const view = FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)
    if (view) return view
  }
  let h = GetTopWindow(0)
  let guard = 0
  while (h && guard++ < 2048) {
    if (className(h) === 'WorkerW') {
      const view = FindWindowExW(h, 0, 'SHELLDLL_DefView', null)
      if (view) return view
    }
    h = GetWindow(h, GW_HWNDNEXT)
  }
  return 0
}

/** 桌面图标 ListView（SHELLDLL_DefView 的子窗） */
export function desktopListView(): number {
  const view = findDefView()
  return view ? FindWindowExW(view, 0, 'SysListView32', null) : 0
}

/** 图标当前是否显示（视图事实，非注册表偏好） */
export function iconsVisible(): boolean {
  const lv = desktopListView()
  return Boolean(lv && IsWindowVisible(lv))
}

/** 注册表 HideIcons：1 = 用户偏好隐藏（explorer「查看」菜单持久值） */
export function prefHidden(): boolean {
  const r = spawnSync('reg', ['query', ADV_KEY, '/v', 'HideIcons'], { encoding: 'utf8', timeout: 8000 })
  const m = /\bHideIcons\s+REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(r.stdout ?? '')
  return m ? parseInt(m[1], 16) === 1 : false
}

/** 翻转桌面图标显隐（与 explorer 菜单同一命令；注册表由 explorer 同步回写） */
function toggleIcons(): boolean {
  const view = findDefView()
  if (!view) return false
  return Boolean(SendMessageTimeoutW(view, WM_COMMAND, TOGGLE_DESKTOP_ICONS, 0, SMTO_ABORTIFHUNG, 3000, null))
}

/** 图标承载生命周期：begin 在面板拉起前调，restore 幂等（多次路径共用） */
export class IconCarry {
  private hid = false
  private settled = false

  constructor(private readonly log: EventLog | null) {}

  /** 隐藏原生图标（若用户本就偏好隐藏则不动，仅记存证） */
  begin(): void {
    const wasHidden = prefHidden()
    if (!wasHidden) this.hid = toggleIcons()
    this.log?.append({
      type: this.hid ? 'icons-hidden' : wasHidden ? 'icons-already-hidden' : 'icons-hide-failed',
      prefHidden: wasHidden,
      viewVisible: iconsVisible(),
    })
    if (!wasHidden && !this.hid) {
      // 隐藏失败（DefView 缺位等）：面板照常拉起，双桌面降级可见于存证，绝不阻断启动
      console.error('[deck] 原生图标隐藏失败（SHELLDLL_DefView 不可达），面板将以双桌面降级运行')
    }
  }

  /** 还原（仅当本次由我隐藏且此刻确为隐藏态）；幂等。
   * 以视图事实（SysListView32 可见性）为准：用户在面板运行期手动重新显示了原生图标时，
   * 无条件再翻一次会把图标重新藏掉——违背「绝不留空桌面」（评审收编）。 */
  restore(reason: string): void {
    if (this.settled) return
    this.settled = true
    // 仅当「本次由我隐藏」且此刻仍隐藏才翻回；用户已手动重新显示则不动
    const ok = this.hid && !iconsVisible() ? toggleIcons() : true
    this.log?.append({
      type: ok ? 'icons-restored' : 'icons-restore-failed',
      reason,
      prefHiddenAfter: prefHidden(),
      viewVisibleAfter: iconsVisible(),
    })
  }

  /** 本次是否真的执行了隐藏（还原守护 icon-restore-watch 的拉起依据；用户本就偏好隐藏/隐藏失败时为 false） */
  didHide(): boolean {
    return this.hid
  }
}

/** 视图事实兜底还原（icon-restore-watch 守护专用）：仅当此刻确为隐藏态才翻回；幂等。
 * 与 IconCarry.restore 的差别：不依赖「本次由我隐藏」标记——守卫已死，守护无从查标记，
 * 死路径兜底以视图事实为唯一判据（可见则绝不动，防把别人显出来的藏回去）。 */
export function restoreIfHidden(log: EventLog | null, reason: string): void {
  const ok = iconsVisible() ? true : toggleIcons()
  log?.append({
    type: ok ? 'icons-restored' : 'icons-restore-failed',
    reason,
    prefHiddenAfter: prefHidden(),
    viewVisibleAfter: iconsVisible(),
  })
}

/** 一次性确保图标可见（--icon-restore：电池清场兜底与用户自救通道） */
export function forceShowIcons(log: EventLog | null): void {
  const wasHidden = prefHidden()
  const ok = wasHidden ? toggleIcons() : true
  log?.append({ type: ok ? 'icons-restored' : 'icons-restore-failed', reason: 'force', prefHidden: wasHidden, viewVisibleAfter: iconsVisible() })
}
