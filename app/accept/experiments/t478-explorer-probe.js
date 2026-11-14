// 工单478 案2 活体探针（只读，零注入零打扰）：真机枚举 explorer.exe 的可见顶层窗，
// 按 shouldShowOnTaskbar 同款判据重放「任务栏运行态收编」裁决，再按 nativeFocusExeWindow
// 同款枚举序（z 序）重放「点击置前」的目标选择，按 decideAppClick 同款语义重放点击路由。
// 目的：实证「点击 explorer 图标从不打开」的当前活体形态（桌面宿主窗 Progman 是否被
// 收进运行态、置前目标落在哪个 hwnd）。不改动任何窗口状态——不调 ShowWindow/
// SetForegroundWindow，只读事实。
'use strict'
const os = require('os')
const koffi = require(process.env.T478_KOFFI_PATH || 'koffi')

const user32 = koffi.load('user32.dll')

const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, uint16 *text, int max)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, uint16 *text, int max)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 cmd)')
const IsIconic = user32.func('bool __stdcall IsIconic(uintptr_t hWnd)')
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()')
const dwmapi = koffi.load('dwmapi.dll')
const DwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32 attr, void *pv, uint32 cb)')
const kernel32 = koffi.load('kernel32.dll')
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)')
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const GW_OWNER = 4
const DWMWA_CLOAKED = 14
const DWMWA_EXCLUDED_FROM_PEEK = 12
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_APPWINDOW = 0x40000
const GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(uintptr_t hWnd, int index)')
const GWL_EXSTYLE = -20

function windowText(h) {
  const buf = new Uint16Array(512)
  const n = GetWindowTextW(h, buf, 512)
  return n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString('utf16le').slice(0, n) : ''
}
function className(h) {
  const buf = new Uint16Array(256)
  const n = GetClassNameW(h, buf, 256)
  return n > 0 ? Buffer.from(buf.buffer, 0, n * 2).toString('utf16le').slice(0, n) : ''
}
function pidOf(h) {
  const buf = Buffer.alloc(4)
  GetWindowThreadProcessId(h, buf)
  return buf.readUInt32LE(0)
}
function exeOfPid(pid) {
  const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
  if (!h) return ''
  try {
    const name = Buffer.alloc(1024)
    const size = Buffer.alloc(4)
    size.writeUInt32LE(510, 0)
    if (!QueryFullProcessImageNameW(h, 0, name, size)) return ''
    return name.toString('utf16le', 0, size.readUInt32LE(0) * 2)
  } finally { CloseHandle(h) }
}
function isCloaked(h) {
  const out = Buffer.alloc(4)
  const r = DwmGetWindowAttribute(h, DWMWA_CLOAKED, out, 4)
  return r === 0 && out.readUInt32LE(0) !== 0
}

const EnumWindows = null // 不用回调枚举（仓库 win-facts 实证形态：GetTopWindow+GetWindow 走 z 序）
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)')
const GW_HWNDNEXT = 2
const MAX_WINDOWS = 4096

// z 序（顶→底）枚举全部顶层窗
const tops = []
{
  let h = Number(GetTopWindow(0))
  let guard = 0
  while (h && guard++ < MAX_WINDOWS) {
    tops.push(h)
    h = Number(GetWindow(h, GW_HWNDNEXT))
  }
}

const rows = []
for (const h of tops) {
  if (!IsWindowVisible(h)) continue
  const pid = pidOf(h)
  if (!pid) continue
  const exe = exeOfPid(pid) || ''
  if (!/explorer\.exe$/i.test(exe.replace(/\//g, '\\'))) continue
  const ex = GetWindowLongW(h, GWL_EXSTYLE)
  const owner = Number(GetWindow(h, GW_OWNER))
  rows.push({
    hwnd: h,
    cls: className(h),
    title: windowText(h),
    pid,
    iconic: !!IsIconic(h),
    cloaked: isCloaked(h),
    toolWindow: !!(ex & WS_EX_TOOLWINDOW),
    appWindow: !!(ex & WS_EX_APPWINDOW),
    owned: owner !== 0,
    z: rows.length,
  })
}

// shouldShowOnTaskbar 同款判据重放（ownExe 取面板进程——本探针非面板，传不匹配值即可）
function shouldShow(w, ownExe) {
  if (w.cloaked) return false
  if (w.toolWindow) return false
  if (w.owned && !w.appWindow) return false
  if (!w.title) return false
  if (!w.exe) return false
  if (/(?:^|[\\/])(?:startmenuexperiencehost|searchhost)\.exe$/i.test(w.exe)) return false
  if (w.exe.toLowerCase() === ownExe.toLowerCase()) return false
  return true
}
const OWN = 'definitely-not-the-panel.exe'
const eligible = rows.filter((w) => shouldShow(w, OWN))
const fg = Number(GetForegroundWindow())

console.log(JSON.stringify({
  now: new Date().toISOString(),
  foregroundHwnd: fg,
  totalTopWindows: tops.length,
  visibleTopWindows: tops.filter((h) => IsWindowVisible(h)).length,
  explorerWindowsZOrder: rows,
  eligibleByShouldShowOnTaskbar: eligible.map((w) => ({ hwnd: w.hwnd, cls: w.cls, title: w.title, z: w.z })),
  focusTargetByNativeFocusExeWindow: eligible.length
    ? { hwnd: eligible[0].hwnd, cls: eligible[0].cls, title: eligible[0].title, z: eligible[0].z }
    : null,
  decideAppClickWindows: eligible.length
    ? eligible.map((w) => ({ hwnd: w.hwnd, title: w.title }))
    : [],
  decision: eligible.length === 0 ? 'launch (会启动)' : eligible.length === 1 ? (eligible[0].hwnd === fg ? 'minimize' : 'activate (置前单一窗)') : 'pick (弹选窗列表)',
}, null, 2))
