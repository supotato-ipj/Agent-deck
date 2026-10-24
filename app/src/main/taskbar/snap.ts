// 分屏会话探针（工单269，spec #267）：Win11 系统 Snap 窗的事实采集与成员资格裁决。
//
// 真假只认公共 API IsWindowArranged（User32，Win10 1903+）——矩形永不提升身份
// （手拉半屏几何不触发，spec 用户故事 6/7；矩形只用于窗口→显示器映射，spec 决策 4）。
// 成员资格 = 真 Snap ∧ 非最小化 ∧ 落在目标显示器 ∧ 桌面宿主排除 ∧ 现有合格顶层窗口
// 过滤（shouldShowOnTaskbar，含自家进程排除）——裁决全在纯函数（isSnapSessionMember /
// resolveSnapSession），FFI 采集（probeSnapWindows）只出事实不载裁决。
//
// 严格降级（spec 决策 11）：IsWindowArranged 声明期缺失（koffi 按名解析，缺失符号同步
// 抛错——域笔记 2026-10-24 实机实证）⇒ bind 内 try/catch 收编为「识别不可用」
// （available=false、零事实），分屏收栏整体关闭，最大化收栏/全屏让位不受影响，
// 绝不退化为几何猜测。可用性事实由调用方落存证（window.ts 的 taskbar-snap-session）。
//
// 无补齐路径（工单268 真机定谳）：工作区释放后 Windows 自动把 Snap 窗重排到新底边
// （docs/audit/2026-10-24-t268-snap-window-rearrange-probe.md，三轮全一致、真 Snap 零
// 丢失）——本模块与调用方**不调任何窗口移动/改窗接口**。
//
// lazy-bind 单例（yield.ts / windows.ts 先例，syskeys.ts 头注纪律）：模块加载不触 FFI，
// 纯函数测试不引 koffi；离线测试只加载纯裁决面。

import { normalizeExe, shouldShowOnTaskbar } from './apps-plan'
import { nativeWindowTitle } from './windows'
import { DESKTOP_HOST_CLASSES } from '../../shared/retract'
import type { PhysRect } from '../../shared/retract'

const GW_HWNDNEXT = 2
const GW_OWNER = 4
const GWL_EXSTYLE = -20
const WS_EX_TOOLWINDOW = 0x00000080
const WS_EX_APPWINDOW = 0x00040000
const DWMWA_CLOAKED = 14
const MAX_WINDOWS = 2048
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getTopWindow: KoffiFunc
  getWindow: KoffiFunc
  isWindowVisible: KoffiFunc
  getWindowRect: KoffiFunc
  isIconic: KoffiFunc
  /** IsWindowArranged（缺失符号时声明期抛错 ⇒ null = 识别不可用，严格降级） */
  isWindowArranged: KoffiFunc | null
  getWindowThreadProcessId: KoffiFunc
  getClassNameW: KoffiFunc
  openProcess: KoffiFunc
  queryImageName: KoffiFunc
  closeHandle: KoffiFunc
  getWindowLong: KoffiFunc
  dwmGetWindowAttribute: KoffiFunc
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  koffi.struct('TASKBAR_SNAP_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  // 识别不可用 = 声明期抛错被收编（spec 决策 11）：可用性记在 Bound 上，采集侧据此
  // 短路（零事实、available=false），最大化收栏/全屏让位不受影响
  let isWindowArranged: KoffiFunc | null = null
  try {
    isWindowArranged = user32.func('bool __stdcall IsWindowArranged(uintptr_t hWnd)')
  } catch {
    isWindowArranged = null
  }
  bound = {
    getTopWindow: user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)'),
    getWindow: user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 uCmd)'),
    isWindowVisible: user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)'),
    getWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ TASKBAR_SNAP_RECT *r)'),
    isIconic: user32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    isWindowArranged,
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)'),
    getClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, uint16 *buf, int nMax)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    queryImageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
    getWindowLong: user32.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)'),
    dwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)'),
  }
  return bound
}

/**
 * 一枚顶层窗的 Snap 采集中间事实（FFI 采集，喂纯裁决）。特征位与 apps-plan 的
 * TaskbarWindowTraits 同名同义（结构兼容）；iconic/arranged 是分屏会话新增采集面
 * （枚举真源 windows.ts 的快照不记录这两位，本模块自采）。
 */
export interface SnapWindowFact {
  hwnd: number
  pid: number
  className: string
  exe: string
  title: string | null
  rect: PhysRect
  /** 最小化（IsIconic）——最小化的 Snap 窗不是会话成员（最后一个 Snap 最小化即会话结束） */
  iconic: boolean
  /** 真 Snap（IsWindowArranged）；null = 识别不可用（不猜，恒非成员） */
  arranged: boolean | null
  visible: boolean
  cloaked: boolean
  toolWindow: boolean
  owned: boolean
  appWindow: boolean
}

/** 两矩形正面积相交（零面积接触不算——窗口→显示器映射的判据） */
function rectsIntersect(a: PhysRect, b: PhysRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/**
 * 分屏会话成员资格（工单269 纯裁决）：真 Snap 身份唯一准入（arranged 判真，矩形永不
 * 提升），再叠非最小化、目标显示器正面积相交、桌面宿主排除与现有合格顶层窗口过滤
 * （shouldShowOnTaskbar——含自家进程 exe 归一排除）。单窗即成员（不要求成对/互补、
 * 不读布局 ID）。
 */
export function isSnapSessionMember(w: SnapWindowFact, display: PhysRect, ownExe: string): boolean {
  if (w.arranged !== true) return false // 真假只认 IsWindowArranged——手拉半屏几何不入门
  if (w.iconic) return false // 最小化窗不计
  if (!rectsIntersect(w.rect, display)) return false // 按显示器隔离（副屏 Snap 不算本屏会话）
  if (DESKTOP_HOST_CLASSES.includes(w.className)) return false // 桌面宿主排除
  return shouldShowOnTaskbar(w, ownExe) // 现有合格顶层窗口过滤（cloaked/工具窗/属主/空标题/自家）
}

/**
 * 分屏会话裁决（工单269 纯裁决）：目标显示器上存在任一合格成员则会话活跃。会话按
 * 显示器参数隔离——不引入「任一副屏 Snap 导致主屏收栏」的全局判定（spec 决策 4）；
 * 识别不可用（arranged 全缺位）⇒ 恒无会话（严格降级，不几何猜测）。
 */
export function resolveSnapSession(
  windows: readonly SnapWindowFact[],
  display: PhysRect,
  ownExe: string,
): boolean {
  return windows.some((w) => isSnapSessionMember(w, display, ownExe))
}

/** 一拍采集的产出：识别可用性 + 真 Snap 候选事实集（只含 arranged=true 的窗——身份先行，贵采后置） */
export interface SnapProbeResult {
  /** IsWindowArranged 可绑定可用（false = 分屏收栏整体关闭的严格降级） */
  available: boolean
  windows: SnapWindowFact[]
}

function pidOf(b: Bound, hwnd: number): number {
  const buf = Buffer.alloc(4)
  b.getWindowThreadProcessId(hwnd, buf)
  return buf.readUInt32LE(0)
}

function exeOfPid(b: Bound, pid: number): string {
  const handle = b.openProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!handle) return ''
  try {
    const name = Buffer.alloc(1024) // 512 wchar
    const size = Buffer.alloc(4)
    size.writeUInt32LE(510, 0)
    if (!b.queryImageName(handle, 0, name, size)) return ''
    return name.toString('utf16le', 0, size.readUInt32LE(0) * 2)
  } finally {
    b.closeHandle(handle)
  }
}

function classNameOf(b: Bound, hwnd: number): string {
  const buf = Buffer.alloc(512)
  const n = b.getClassNameW(hwnd, buf, 256) as number
  let out = ''
  for (let i = 0; i < n; i++) out += String.fromCharCode(buf.readUInt16LE(i * 2))
  return out
}

function rectOf(b: Bound, hwnd: number): PhysRect {
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  try {
    if (!b.getWindowRect(hwnd, r)) return r
  } catch { /* 竞态销毁按零矩形（正面积相交判否——安全方向） */ }
  return r
}

function traitsOf(b: Bound, hwnd: number): { toolWindow: boolean; owned: boolean; appWindow: boolean; cloaked: boolean } {
  let toolWindow = false
  let appWindow = false
  try {
    const ex = Number(b.getWindowLong(hwnd, GWL_EXSTYLE)) | 0
    toolWindow = (ex & WS_EX_TOOLWINDOW) !== 0
    appWindow = (ex & WS_EX_APPWINDOW) !== 0
  } catch { /* 样式取不到（窗口竞态销毁）按无位 */ }
  let owned = false
  try {
    owned = Number(b.getWindow(hwnd, GW_OWNER)) !== 0
  } catch { /* 属主取不到按无属主 */ }
  let cloaked = false
  try {
    const buf = Buffer.alloc(4)
    if (b.dwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0) cloaked = buf.readInt32LE(0) !== 0
  } catch { /* DWM 态取不到按未 cloak */ }
  return { toolWindow, owned, appWindow, cloaked }
}

/**
 * 采集一拍真 Snap 候选事实（链式枚举，不用 EnumWindows 回调——windows.ts 同款纪律）。
 * 成本口径：逐窗只付 IsWindowVisible + IsWindowArranged 两次廉价 user32 调用；身份与
 * 特征采集（OpenProcess/exe/标题/cloaked）只对 arranged=true 的窗付（Snap 窗常态 0–4 枚）。
 * 识别不可用 ⇒ 零事实 + available=false（调用方据此只关分屏收栏并落诊断）。
 */
export function probeSnapWindows(): SnapProbeResult {
  const b = bind()
  if (!b.isWindowArranged) return { available: false, windows: [] }
  const out: SnapWindowFact[] = []
  let h = b.getTopWindow(0) as number
  let guardCount = 0
  while (h && guardCount++ < MAX_WINDOWS) {
    if (b.isWindowVisible(h)) {
      let arranged = false
      try {
        arranged = Boolean(b.isWindowArranged?.(h))
      } catch { /* 单拍失效按非 Snap（安全方向，不猜） */ }
      if (arranged) {
        const pid = pidOf(b, h)
        out.push({
          hwnd: h,
          pid,
          className: classNameOf(b, h),
          exe: pid ? exeOfPid(b, pid) : '',
          // 标题经 windows.ts 的公开缝读（隐私口子单文件收口，ADR-0007；本模块不直读）
          title: nativeWindowTitle(h),
          rect: rectOf(b, h),
          iconic: Boolean(b.isIconic(h)),
          arranged: true,
          visible: true,
          ...traitsOf(b, h),
        })
      }
    }
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return { available: true, windows: out }
}
