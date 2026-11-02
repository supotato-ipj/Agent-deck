// 外部窗口事实统一接缝（工单370，spec #369 决策 6「复用现有任务栏顶层窗口枚举和合格
// 窗口过滤，在其上增加主屏与桌面 ID 条件」）：顶层窗口链式枚举骨架 + 窗口身份（pid/exe）
// + 特征位（可见样式/cloak 分位/工具窗/属主/APPWINDOW）+ 几何（GetWindowRect）+ 类名与
// 标题读取的**单一采集真源**。现有任务栏运行快照（windows.ts）与 Snap 探针（snap.ts）是
// 这条接缝上的两个投影，各自不再持枚举绑定面/枚举循环；后续主屏、桌面 ID 或几何控制类
// 条件加在投影的纯裁决层（shouldShowOnTaskbar / isSnapSessionMember 同层——几何与 cloak
// 分位事实已在本接缝产出），不复制枚举实现。
//
// 边界：
// - **只读接缝**：本模块零窗口改动能力（无改窗/移动/缩放/置前/投递 FFI）——效果面
//   （激活/还原/最小化/关闭）仍住在 windows.ts 的效果绑定表；后续窗口几何控制器是
//   spec #369 的独立适配层，不经本接缝扩散（离线守卫钉：retract-orchestration.spec.ts）。
// - **隐私**（ADR-0007 对 ADR-0002 的书面口子，仅限任务栏链路）：标题仅内存即时读取
//   （nativeWindowTitle，本文件是唯一入口），供 tooltip/多窗口列表/分屏成员资格即时
//   使用——永不写使用日志、永不落任何持久化。口子单文件收口自 windows.ts 移入本文件
//   （tests/usage/log.spec.ts 的 TITLE_READ_ALLOWLIST 同步钉此边界）。
// - **lazy-bind**（yield.ts / syskeys.ts 先例）：模块加载不触 FFI，bind() 首调才 require
//   koffi——离线纯函数测试零 FFI 实害。具名 struct 进程级单登（#153 教训：撞名即崩）。
// - **成本纪律**（Snap 探针在案预算，docs/audit/2026-10-25-t267-snap-probe-beat-cost.md，
//   t267 实测）：枚举骨架每窗只付投影甄别判（Snap：IsWindowVisible + IsWindowArranged
//   两次调用，常态一拍 0.374ms）；身份/特征/几何采集由甄别判选择性触发（Snap 身份先行，
//   arranged/追踪集命中才付 OpenProcess/exe/标题/cloaked——实测 58.4µs/窗）。
// - 采集失败口径（两投影既有同款）：单点取失败按「未采集到该拒绝位」/零矩形/空身份
//   回报（判据缺省通过的兼容口径），不抛不重试；窗口竞态销毁在判据上取安全方向。
import type { PhysRect } from '../../shared/retract'

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
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
/** 链式枚举终止护栏（两投影收敛前的同值双写，工单370 起单源） */
const MAX_WINDOWS = 2048

interface KoffiFunc {
  (...args: unknown[]): unknown
}

interface Bound {
  getTopWindow: KoffiFunc
  getWindow: KoffiFunc
  isWindowVisible: KoffiFunc
  /** IsWindowArranged（缺失符号时声明期抛错 ⇒ null = 识别不可用，严格降级） */
  isWindowArranged: KoffiFunc | null
  getWindowThreadProcessId: KoffiFunc
  getWindowTextLength: KoffiFunc
  getWindowText: KoffiFunc
  isIconic: KoffiFunc
  getWindowRect: KoffiFunc
  getClassNameW: KoffiFunc
  getWindowLong: KoffiFunc
  dwmGetWindowAttribute: KoffiFunc
  openProcess: KoffiFunc
  queryImageName: KoffiFunc
  closeHandle: KoffiFunc
}

let bound: Bound | null = null

function bind(): Bound {
  if (bound) return bound
  const koffi = require('koffi')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const dwmapi = koffi.load('dwmapi.dll')
  koffi.struct('WIN_FACTS_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
  // 识别不可用 = 声明期抛错被收编（spec #267 决策 11）：可用性记在 Bound 上，采集侧
  // 据此短路（零事实、available=false），分屏收栏整体关闭，最大化收栏/全屏让位不受影响
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
    isWindowArranged,
    getWindowThreadProcessId: user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)'),
    getWindowTextLength: user32.func('int __stdcall GetWindowTextLengthW(uintptr_t hWnd)'),
    getWindowText: user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, char16_t *lpString, int nMaxCount)'),
    isIconic: user32.func('bool __stdcall IsIconic(uintptr_t hWnd)'),
    getWindowRect: user32.func('bool __stdcall GetWindowRect(uintptr_t hWnd, _Out_ WIN_FACTS_RECT *r)'),
    getClassNameW: user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, uint16 *buf, int nMax)'),
    getWindowLong: user32.func('long __stdcall GetWindowLongW(uintptr_t hWnd, int nIndex)'),
    dwmGetWindowAttribute: dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hwnd, uint32 attr, void *pv, uint32 cb)'),
    openProcess: kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'),
    queryImageName: kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)'),
    closeHandle: kernel32.func('bool __stdcall CloseHandle(void *h)'),
  }
  return bound
}

/** 窗口所属进程 id（枚举竞态销毁不在本接缝兜底——调用方按 0 弃窗，两投影既有口径） */
export function pidOf(hwnd: number): number {
  const buf = Buffer.alloc(4)
  bind().getWindowThreadProcessId(hwnd, buf)
  return buf.readUInt32LE(0)
}

/** 进程可执行文件绝对路径（单一语义：OpenProcess+QueryFullProcessImageNameW+CloseHandle 配对）；取不到（权限/已退出）归 '' */
export function exeOfPid(pid: number): string {
  const b = bind()
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

/**
 * 窗口标题即时读取的公开缝（工单269）：分屏会话成员资格复用现有合格过滤
 * （shouldShowOnTaskbar 需空标题判据），但**标题读取的隐私口子仍单文件收口**
 * （ADR-0007 唯一例外——tests/usage/log.spec.ts 的 TITLE_READ_ALLOWLIST 钉此边界），
 * 调用方（windows.ts / snap.ts）不直读标题。仅内存即时使用、永不持久化，同款纪律。
 * 空标题/取不到/已销毁归 null，不抛。
 */
export function nativeWindowTitle(hwnd: number): string | null {
  const b = bind()
  try {
    const len = b.getWindowTextLength(hwnd) as number
    if (len <= 0) return null
    const buf = Buffer.alloc((len + 2) * 2)
    const got = b.getWindowText(hwnd, buf, len + 2) as number
    if (got <= 0) return null
    return buf.toString('utf16le', 0, got * 2) || null
  } catch {
    return null
  }
}

/**
 * 窗口特征位采集（工单156 判据不落采集层的既有口径）：EXSTYLE 的工具窗/APPWINDOW 位、
 * GW_OWNER 属主、DWMWA_CLOAKED（挂起/其他桌面）及其 SHELL 分位（工单270——其他虚拟
 * 桌面，服务结束因果分类与后续桌面 ID 条件；成员资格仍按「任何 cloak 即拒」旧口径）。
 * 单点取失败按「未采集到该拒绝位」回报（判据缺省通过的兼容口径），不抛不重试。
 * 可见性位不在此采集——枚举骨架的甄别判已付 IsWindowVisible，投影按当拍甄别结果填。
 */
export interface WindowRejectTraits {
  cloaked: boolean
  cloakedShell: boolean
  toolWindow: boolean
  owned: boolean
  appWindow: boolean
}

export function windowTraits(hwnd: number): WindowRejectTraits {
  const b = bind()
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
      cloakedShell = (cloak & DWM_CLOAKED_SHELL) !== 0 // SHELL 位 = 其他虚拟桌面
    }
  } catch { /* DWM 态取不到按未 cloak */ }
  return { cloaked, cloakedShell, toolWindow, owned, appWindow }
}

/** 可见样式位（IsWindowVisible；最小化窗仍带该位——运行态含最小化的既有语义） */
export function isWindowVisible(hwnd: number): boolean {
  return Boolean(bind().isWindowVisible(hwnd))
}

/** 最小化（IsIconic；Snap 成员资格「最小化不计」与置前「先还原」共用） */
export function isIconic(hwnd: number): boolean {
  return Boolean(bind().isIconic(hwnd))
}

/** IsWindowArranged 可绑定可用（false = 分屏识别整体关闭的严格降级，spec #267 决策 11） */
export function arrangedAvailable(): boolean {
  return bind().isWindowArranged !== null
}

/**
 * 真 Snap 读数（IsWindowArranged，User32 公共 API，Win10 1903+）：单拍调用失效按
 * 非 Snap（安全方向，不猜、不重试）。调用前置 arrangedAvailable()；矩形永不提升身份
 * （手拉半屏几何不触发——spec #267 用户故事 6/7 的既有裁决）。
 */
export function readWindowArranged(hwnd: number): boolean {
  try {
    return Boolean(bind().isWindowArranged?.(hwnd))
  } catch {
    return false
  }
}

/** 窗口类名（Snap 桌面宿主排除判据的输入；竞态销毁按空串——空类名不命中排除表） */
export function windowClassName(hwnd: number): string {
  const b = bind()
  const buf = Buffer.alloc(512)
  const n = b.getClassNameW(hwnd, buf, 256) as number
  let out = ''
  for (let i = 0; i < n; i++) out += String.fromCharCode(buf.readUInt16LE(i * 2))
  return out
}

/** 窗口矩形（物理像素，GetWindowRect；竞态销毁按零矩形——正面积相交判否的安全方向） */
export function windowRect(hwnd: number): PhysRect {
  const b = bind()
  const r = { left: 0, top: 0, right: 0, bottom: 0 }
  try {
    if (!b.getWindowRect(hwnd, r)) return r
  } catch { /* 竞态销毁按零矩形（正面积相交判否——安全方向） */ }
  return r
}

/**
 * 顶层窗口链式枚举骨架（单一 walk，工单370 收敛）：GetTopWindow/GetWindow 链自顶向下
 * （不用 EnumWindows 回调——accept/lib/win32.js 实证形态，避免 FFI 回调生命周期问题），
 * MAX_WINDOWS 护栏，产出按 z 序通过甄别判的句柄集。每窗只付甄别判的调用成本；身份/
 * 特征/几何采集由投影对甄别通过的窗另行调本接缝原语（Snap 身份先行的成本纪律在此保持）。
 * 后续主屏/桌面 ID 条件加在投影纯裁决层（事实已含 rect / cloakedShell），不复制枚举。
 */
export function scanTopWindows(scout: (hwnd: number) => boolean): number[] {
  const b = bind()
  const out: number[] = []
  let h = b.getTopWindow(0) as number
  let guard = 0
  while (h && guard++ < MAX_WINDOWS) {
    if (scout(h)) out.push(h)
    h = b.getWindow(h, GW_HWNDNEXT) as number
  }
  return out
}
