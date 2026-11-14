'use strict'
const { app, shell } = require('electron')
const koffi = require(process.env.T478_KOFFI_PATH)
const user32 = koffi.load('user32.dll')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(uintptr_t hWnd)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(uintptr_t hWnd, char16_t *text, int max)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(uintptr_t hWnd, char16_t *text, int max)')
const GetTopWindow = user32.func('uintptr_t __stdcall GetTopWindow(uintptr_t hWnd)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t hWnd, uint32 cmd)')
const PostMessageW = user32.func('bool __stdcall PostMessageW(uintptr_t hWnd, uint32 msg, uintptr_t wp, intptr_t lp)')
function textOf(fn, h, cap) {
  const buf = Buffer.alloc(cap * 2)
  const n = fn(h, buf, cap)
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : ''
}
function windowsOfClass(cls) {
  const out = []
  let h = Number(GetTopWindow(0)), i = 0
  while (h && i++ < 4096) {
    if (IsWindowVisible(h)) {
      if (textOf(GetClassNameW, h, 256) === cls) out.push({ hwnd: h, title: textOf(GetWindowTextW, h, 512).slice(0, 50) })
    }
    h = Number(GetWindow(h, 2))
  }
  return out
}
app.whenReady().then(async () => {
  const target = 'C:' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) + 'notepad.exe'
  const before = windowsOfClass('Notepad')
  const t0 = Date.now()
  let result = ''
  try { result = await shell.openPath(target) } catch (e) { result = 'THROW:' + e.message }
  const openMs = Date.now() - t0
  await new Promise((r) => setTimeout(r, 2500))
  const after = windowsOfClass('Notepad')
  const opened = after.filter((w) => !before.some((b) => b.hwnd === w.hwnd))
  console.log(JSON.stringify({ target, openPathResult: result || '(empty=success)', openMs, openedCount: opened.length, opened }, null, 2))
  for (const w of opened) PostMessageW(w.hwnd, 0x0010, 0, 0)
  await new Promise((r) => setTimeout(r, 800))
  const remaining = windowsOfClass('Notepad').filter((w) => !before.some((b) => b.hwnd === w.hwnd))
  console.log(JSON.stringify({ cleanupClosed: opened.length - remaining.length, remainingAfterClose: remaining }, null, 2))
  app.quit()
})
