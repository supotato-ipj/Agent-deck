'use strict'
// 工单478 案2 活体探针B：实测「launch 通道」（explorer.exe 无参启动 → 是否开窗）。
// 与 ShellExecute('open', 'C:\Windows\explorer.exe') 等语义（CreateProcess explorer.exe）。
// 开出的 CabinetWClass 窗 3 秒内 PostMessage WM_CLOSE 清理，不留残留。
const { spawn } = require('child_process')
const koffi = require(process.env.T478_KOFFI_PATH)
const user32 = koffi.load('user32.dll')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, char16_t *text, int max)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, char16_t *text, int max)')
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 cmd)')
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function textOf(fn, h, cap) {
  const buf = Buffer.alloc(cap * 2)
  const n = fn(h, buf, cap)
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''
}
function cabinets() {
  const out = []
  let h = Number(GetTopWindow(0)), i = 0
  while (h && i++ < 4096) {
    if (IsWindowVisible(h)) {
      const cls = textOf(GetClassNameW, h, 256)
      if (cls === 'CabinetWClass') out.push({ hwnd: h, title: textOf(GetWindowTextW, h, 512).slice(0, 50) })
    }
    h = Number(GetWindow(h, 2))
  }
  return out
}
;(async () => {
  const before = cabinets()
  const p = spawn('explorer.exe', [], { stdio: 'ignore', detached: true })
  await sleep(2500)
  const after = cabinets()
  const opened = after.filter((w) => !before.some((b) => b.hwnd === w.hwnd))
  console.log(JSON.stringify({ beforeCount: before.length, afterCount: after.length, opened, spawnError: p.error ? String(p.error) : null, spawnPid: p.pid }, null, 2))
  for (const w of opened) PostMessageW(w.hwnd, 0x0010, 0, 0)
  await sleep(800)
  const remaining = cabinets().filter((w) => !before.some((b) => b.hwnd === w.hwnd))
  console.log(JSON.stringify({ cleanupClosed: opened.length - remaining.length, remainingAfterClose: remaining }, null, 2))
})()
