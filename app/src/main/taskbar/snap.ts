// 分屏会话探针（工单269，spec #267）：Win11 系统 Snap 窗的事实采集与成员资格裁决。
//
// 真假只认公共 API IsWindowArranged（User32，Win10 1903+）——矩形永不提升身份
// （手拉半屏几何不触发，spec 用户故事 6/7；矩形只用于窗口→显示器映射，spec 决策 4）。
// 成员资格 = 真 Snap ∧ 非最小化 ∧ 落在目标显示器 ∧ 桌面宿主排除 ∧ 现有合格顶层窗口
// 过滤（shouldShowOnTaskbar，含自家进程排除）——裁决全在纯函数（isSnapSessionMember /
// snapSessionMembers / resolveSnapSession），FFI 采集（probeSnapWindows）只出事实不载裁决。
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
// 工单270（集合生命周期与可区分存证）：
// - 成员集合（snapSessionMembers）：多窗 Snap 同一集合生命周期——最小化其一/关闭其一
//   只出列不结束，最后一个成员消失才结束（票面验收判据 2/3）；
// - cloak 分位采集（cloakedShell）：DWMWA_CLOAKED 返回值按官方头分位（APP=1/SHELL=2/
//   INHERITED=4），SHELL 位即其他虚拟桌面——成员资格仍按「任何 cloak 即拒」的旧口径
//   （当前虚拟桌面隔离不放宽），分位只服务结束因果分类；
// - 结束因果分类（classifySnapSessionEnd）：会话结束时按**前成员去向**归类（最小化/
//   关闭/解除/虚拟桌面切换/换屏/未知），调用方落进 taskbar-snap-session 存证——真机可
//   判「会话因何结束」（spec 决策 14 可观测性）；探针采集支持**成员追踪集**（track 参数，
//   前成员句柄即便已解除 Snap 也照采事实——去向可分类，关闭则从枚举消失）。
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
/** cloak 分位（dwmapi.h 官方值）：应用自 cloak（挂起 UWP） */
const DWM_CLOAKED_APP = 0x1
/** cloak 分位（dwmapi.h 官方值）：壳 cloak——其他虚拟桌面 */
const DWM_CLOAKED_SHELL = 0x2
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
  /** DWM cloak（任何分位；成员资格按「任何 cloak 即拒」的旧口径） */
  cloaked: boolean
  /** cloak 的 SHELL 分位（DWM_CLOAKED_SHELL=2，官方头）——其他虚拟桌面（工单270 分位采集；只服务结束因果分类，不放宽成员资格） */
  cloakedShell: boolean
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

/**
 * 成员集合（工单270 集合生命周期）：目标显示器上的全部合格成员（快照序）。
 * 多窗 Snap 是**同一集合**——最小化其一/关闭其一只让该成员出列，最后一个成员消失
 * 才结束会话；返回集合供调用方做成员追踪（下一拍的前成员去向 = 结束因果分类的事实源）。
 * 与 resolveSnapSession 同一裁决（成员非空即活跃），单一实现不另判。
 */
export function snapSessionMembers(
  windows: readonly SnapWindowFact[],
  display: PhysRect,
  ownExe: string,
): SnapWindowFact[] {
  return windows.filter((w) => isSnapSessionMember(w, display, ownExe))
}

/** 会话结束的因果归类（工单270 可区分存证）：真机可判「最小化/关闭/解除/虚拟桌面切换」 */
export type SnapSessionEndCause =
  | 'minimized'
  | 'closed'
  | 'unsnapped'
  | 'desktop-switched'
  | 'left-display'
  | 'unknown'

/** 因果优先级：最能解释「整组成员同拍消失」的在前（虚拟桌面切换压过一切；用户动作
 * （最小化/解除）压过几何去向（换屏）；「从枚举消失」（关闭）垫底——它只说明缺席 */
const CAUSE_PRIORITY: readonly SnapSessionEndCause[] = [
  'desktop-switched', 'minimized', 'unsnapped', 'left-display', 'closed', 'unknown',
]

/**
 * 结束因果分类（工单270 纯裁决）：会话从活跃翻为结束时，按**前成员的当拍去向**归类。
 *
 * 输入是上一拍成员的句柄集（调用方账本）与本拍采集事实（探针对追踪集照采——已解除
 * Snap 的前成员也在列，已关闭的从枚举消失）。逐窗去向：
 * - 不在当拍事实集 → closed（已关闭）；
 * - cloakedShell（SHELL 位 cloak）→ desktop-switched（切到其他虚拟桌面——桌面切换后
 *   原成员整体 cloak 但窗口仍在，这是它与「关闭」的分界）；
 * - iconic → minimized；arranged≠true → unsnapped；不与目标显示器相交 → left-display；
 * - 其余（app 位 cloak / 资格位翻转等罕见去向）→ unknown（不硬猜）。
 *
 * 多成员混合去向按 CAUSE_PRIORITY 取最高（整组同拍消失时「桌面切换」最能解释集合）。
 * 空追踪集 / 事实缺位 → unknown（账守卫，不抛——调用方可能因探针失败拍进入结束）。
 */
export function classifySnapSessionEnd(
  prevMemberHwnds: readonly number[],
  currentFacts: readonly SnapWindowFact[],
  display: PhysRect,
): SnapSessionEndCause {
  if (prevMemberHwnds.length === 0) return 'unknown'
  const byHwnd = new Map(currentFacts.map((f) => [f.hwnd, f]))
  let best: SnapSessionEndCause | null = null
  for (const hwnd of prevMemberHwnds) {
    const f = byHwnd.get(hwnd)
    let fate: SnapSessionEndCause
    if (!f) fate = 'closed'
    else if (f.cloakedShell) fate = 'desktop-switched'
    else if (f.iconic) fate = 'minimized'
    else if (f.arranged !== true) fate = 'unsnapped'
    else if (!rectsIntersect(f.rect, display)) fate = 'left-display'
    else fate = 'unknown'
    if (best === null || CAUSE_PRIORITY.indexOf(fate) < CAUSE_PRIORITY.indexOf(best)) best = fate
  }
  return best ?? 'unknown'
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

function traitsOf(b: Bound, hwnd: number): { toolWindow: boolean; owned: boolean; appWindow: boolean; cloaked: boolean; cloakedShell: boolean } {
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
  let cloakedShell = false
  try {
    const buf = Buffer.alloc(4)
    if (b.dwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, buf, 4) === 0) {
      const cloak = buf.readInt32LE(0)
      cloaked = cloak !== 0
      cloakedShell = (cloak & DWM_CLOAKED_SHELL) !== 0 // SHELL 位 = 其他虚拟桌面（工单270 分位采集）
    }
  } catch { /* DWM 态取不到按未 cloak */ }
  return { toolWindow, owned, appWindow, cloaked, cloakedShell }
}

/**
 * 采集一拍真 Snap 候选事实（链式枚举，不用 EnumWindows 回调——windows.ts 同款纪律）。
 * 成本口径：逐窗只付 IsWindowVisible + IsWindowArranged 两次廉价 user32 调用；身份与
 * 特征采集（OpenProcess/exe/标题/cloaked）只对 arranged=true 的窗付（Snap 窗常态 0–4 枚）。
 * 识别不可用 ⇒ 零事实 + available=false（调用方据此只关分屏收栏并落诊断）。
 *
 * 成员追踪集（工单270）：track 里的句柄（上一拍合格成员）即便已解除 Snap 也照采全量
 * 事实——结束因果分类要看它们的去向（最小化/解除/换桌面仍在列，已关闭才从枚举消失）；
 * 追踪集常态 ≤ 数枚，成本不增级。
 */
export function probeSnapWindows(track: readonly number[] = []): SnapProbeResult {
  const b = bind()
  if (!b.isWindowArranged) return { available: false, windows: [] }
  const trackSet = track.length > 0 ? new Set(track) : null
  const out: SnapWindowFact[] = []
  let h = b.getTopWindow(0) as number
  let guardCount = 0
  while (h && guardCount++ < MAX_WINDOWS) {
    if (b.isWindowVisible(h)) {
      let arranged = false
      try {
        arranged = Boolean(b.isWindowArranged?.(h))
      } catch { /* 单拍失效按非 Snap（安全方向，不猜） */ }
      if (arranged || trackSet?.has(h)) {
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
          arranged,
          visible: true,
          ...traitsOf(b, h),
        })
      }
    }
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return { available: true, windows: out }
}
