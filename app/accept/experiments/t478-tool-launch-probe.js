// 工单478 案3 活体探针：工具图标（MiniMax Code / ZCode / Qoder CN Launcher）慢启动归因
// 双形计量——
//   面板侧链路时延 = shell.openPath(exe) 的返回耗时（面板 launchExe 通道同实现：
//   desktop/adapter shellOpen → Electron shell.openPath；返回即「启动命令已发出」）；
//   工具自身冷启耗时 = openPath 返回 → 该 exe 首个合格顶层窗出现的时间差
//   （合格判据同 shouldShowOnTaskbar 口径）。
// 已在运行的工具不重复拉起（记 running-before，只计量置前链路 missing——首窗已存在）。
// 轮末 WM_CLOSE 关闭本轮新开的窗并核对清场，不留残留。
// 必须经 accept-guard 托管运行（拉起真实 GUI 应用，与验收轮互斥占桌面）。
'use strict'
const { app, shell } = require('electron')
const fs = require('fs')
const koffi = require(process.env.T478_KOFFI_PATH || 'koffi')

// 手钉清单真实路径（userData/taskbar-layout.json 现读；避免写死路径漂移）
const layoutPath = process.env.T478_LAYOUT_PATH
  || process.env.APPDATA + '\\agent-deck-panel\\taskbar-layout.json'
const WANT = [
  /MiniMax Code\.exe$/i,
  /ZCode\.exe$/i,
  /Qoder CN Launcher\.exe$/i,
]
const pinned = JSON.parse(fs.readFileSync(layoutPath, 'utf8')).pinned
const targets = []
for (const pat of WANT) {
  const hit = pinned.find((p) => pat.test(p.exe))
  if (hit) targets.push(hit)
  else targets.push({ exe: null, label: pat.source })
}

const user32 = koffi.load('user32.dll')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, char16_t *text, int max)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, char16_t *text, int max)')
const GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(uintptr_t hWnd, int index)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(uintptr_t hWnd, uint32 *pid)')
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 cmd)')
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)')
const dwmapi = koffi.load('dwmapi.dll')
const DwmGetWindowAttribute = dwmapi.func('int32 __stdcall DwmGetWindowAttribute(uintptr_t hWnd, uint32 attr, void *pv, uint32 cb)')
const kernel32 = koffi.load('kernel32.dll')
const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)')
const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *h, uint32 flags, char16_t *name, uint32 *size)')
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)')
const WS_EX_TOOLWINDOW = 0x80
const WS_EX_APPWINDOW = 0x40000
const GWL_EXSTYLE = -20
const GWL_STYLE = -16
const WS_CHILD = 0x40000000
const GW_OWNER = 4
const DWMWA_CLOAKED = 14

function textOf(fn, h, cap) {
  const buf = Buffer.alloc(cap * 2)
  const n = fn(h, buf, cap)
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''
}
function pidOf(h) {
  const buf = Buffer.alloc(4)
  GetWindowThreadProcessId(h, buf)
  return buf.readUInt32LE(0)
}
function exeOfPid(pid) {
  const h = OpenProcess(0x1000, false, pid)
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
function topWindows() {
  const out = []
  let h = Number(GetTopWindow(0)), i = 0
  while (h && i++ < 4096) { out.push(h); h = Number(GetWindow(h, 2)) }
  return out
}
// shouldShowOnTaskbar 同款口径（只用于「合格首窗」判定；ownExe 不匹配任何目标）
function eligibleOf(exePath) {
  const want = exePath.toLowerCase()
  const out = []
  for (const h of topWindows()) {
    if (!IsWindowVisible(h)) continue
    const pid = pidOf(h)
    if (!pid) continue
    const exe = exeOfPid(pid)
    if (exe.toLowerCase() !== want) continue
    const ex = GetWindowLongW(h, GWL_EXSTYLE)
    const st = GetWindowLongW(h, GWL_STYLE)
    const owner = Number(GetWindow(h, GW_OWNER))
    const cloaked = isCloaked(h)
    const toolWindow = !!(ex & WS_EX_TOOLWINDOW)
    const owned = owner !== 0
    const appWindow = !!(ex & WS_EX_APPWINDOW)
    const title = textOf(GetWindowTextW, h, 512)
    if (cloaked || toolWindow || (owned && !appWindow) || !title) continue
    if (st & WS_CHILD) continue
    out.push({ hwnd: h, cls: textOf(GetClassNameW, h, 256), title: title.slice(0, 60) })
  }
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  const evidence = { startedAt: new Date().toISOString(), targets: [] }
  for (const t of targets) {
    const row = { label: t.label, exe: t.exe }
    if (!t.exe) { row.error = '手钉清单无此路径'; evidence.targets.push(row); continue }
    const before = eligibleOf(t.exe)
    row.runningBefore = before.length > 0
    if (before.length > 0) {
      row.note = '已在运行（不重复拉起）；面板点击将走置前链路，本探针不计量置前'
      row.windowsBefore = before.slice(0, 3)
      evidence.targets.push(row)
      continue
    }
    // 面板侧链路（launchExe 同通道同实现）
    const t0 = Date.now()
    let openErr = ''
    try { openErr = await shell.openPath(t.exe) } catch (e) { openErr = 'THROW:' + e.message }
    row.panelSideMs = Date.now() - t0 // spawn 链时延（返回=启动命令已发出）
    row.openPathResult = openErr || '(empty=success)'
    // 工具自身冷启：轮询首个合格窗（≤120s 上界）
    const deadline = Date.now() + 120000
    let first = null
    while (Date.now() < deadline) {
      await sleep(400)
      const now = eligibleOf(t.exe).filter((w) => !before.some((b) => b.hwnd === w.hwnd))
      if (now.length > 0) { first = { at: Date.now(), window: now[0] }; break }
    }
    if (first) {
      row.toolColdStartMs = first.at - t0 - row.panelSideMs // 工具自身（openPath 返回→首窗）
      row.totalClickToWindowMs = first.at - t0 // 点击→首窗全景
      row.firstWindow = first.window
    } else {
      row.toolColdStartMs = null
      row.note = (row.note || '') + ' 120s 内未见合格首窗'
    }
    evidence.targets.push(row)
  }
  // 清场：关闭本轮新开的合格窗（WM_CLOSE 优雅径），核对无残留
  await sleep(1500)
  const cleanup = []
  for (const row of evidence.targets) {
    if (!row.firstWindow) continue
    const before = []
    PostMessageW(row.firstWindow.hwnd, 0x0010, 0, 0)
    cleanup.push({ hwnd: row.firstWindow.hwnd, wmClosePosted: true })
  }
  await sleep(2000)
  evidence.cleanup = cleanup
  evidence.residual = []
  for (const row of evidence.targets) {
    if (row.firstWindow) {
      const still = eligibleOf(row.exe).some((w) => w.hwnd === row.firstWindow.hwnd)
      evidence.residual.push({ label: row.label, hwnd: row.firstWindow.hwnd, stillVisible: still })
    }
  }
  evidence.finishedAt = new Date().toISOString()
  const out = process.env.T478_EVIDENCE_PATH || 't478-tool-launch-evidence.json'
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify(evidence, null, 2))
  app.quit()
})
