// 探针3b（问题2 机制判别）：程序化激活模拟「点击顶起」，判别 HWND_BOTTOM 对前台窗口是否生效。
// 场景：ref = 用户工作窗口（激活置顶）；panel = 面板样窗口（钉底）。
// 断言链：钉底 → 激活 panel（顶起+前台）→ 前台态重钉 → 是否回落到 ref 之下。
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const koffi = require('D:/test-folder/wallpaperengine-research--bugfix/app/node_modules/koffi')

const OUT = path.join(__dirname, 'probe3-result.json')
const log = []
const say = (s) => { log.push(s); console.log(s) }
const dump = (code) => {
  try { fs.writeFileSync(OUT, log.join('\n')) } catch { }
  app.exit(code)
}
setTimeout(() => { say('WATCHDOG TIMEOUT'); dump(2) }, 20000)
process.on('uncaughtException', (e) => { say('UNCAUGHT ' + (e && e.stack || e)); dump(3) })

const user32 = koffi.load('user32.dll')
const SetWindowPos = user32.func('bool __stdcall SetWindowPos(uintptr_t, uintptr_t, int, int, int, int, uint32)')
const GetWindow = user32.func('uintptr_t __stdcall GetWindow(uintptr_t, uint32)')
const GetForegroundWindow = user32.func('uintptr_t __stdcall GetForegroundWindow()')
const num = (v) => (typeof v === 'bigint' ? Number(v) : v)
const hwndOf = (win) => num(koffi.decode(win.getNativeWindowHandle(), 'uintptr_t'))

const HWND_BOTTOM = 1, HWND_TOP = 0
const GW_HWNDNEXT = 2
const SWP_NOSIZE = 0x0001, SWP_NOMOVE = 0x0002, SWP_NOACTIVATE = 0x0010, SWP_NOOWNERZORDER = 0x0200

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isAbove(a, b) {
  let h = a, guard = 0
  while (h && guard++ < 4096) {
    if (h === b) return true
    h = num(GetWindow(h, GW_HWNDNEXT))
  }
  return false
}

function pinBottom(hwnd) {
  return SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER)
}
function raiseTop(hwnd) {
  return SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOOWNERZORDER)
}

async function main() {
  const ref = new BrowserWindow({ x: 100, y: 400, width: 300, height: 200, show: false })
  ref.loadURL('data:text/html,<body style="background:#345">REF</body>')
  const panel = new BrowserWindow({
    x: 500, y: 400, width: 300, height: 200, show: false, frame: false, skipTaskbar: true,
  })
  panel.loadURL('data:text/html,<body style="background:#543">PANEL</body>')
  ref.once('ready-to-show', () => ref.show())
  panel.once('ready-to-show', () => panel.showInactive())
  await sleep(800)

  const refH = hwndOf(ref)
  const panelH = hwndOf(panel)
  const fg = () => num(GetForegroundWindow())

  // 0. 钉底基线
  say(`[0] pin ret=${pinBottom(panelH)} panelAboveRef=${isAbove(panelH, refH)} fgIsPanel=${fg() === panelH}`)
  await sleep(300)

  // 1. 模拟点击激活：先 HWND_TOP 顶起（激活伴随的顶起效果）+ programmatic focus
  raiseTop(panelH)
  panel.focus()
  await sleep(500)
  say(`[1] activated panelAboveRef=${isAbove(panelH, refH)} fgIsPanel=${fg() === panelH}`)

  // 2. 前台态重钉（方案A核心问题）
  const ret = pinBottom(panelH)
  await sleep(400)
  say(`[2] repin-while-fg ret=${ret} panelAboveRef=${isAbove(panelH, refH)} fgIsPanel=${fg() === panelH}`)

  // 3. 用户回到工作窗口：ref 激活后应回到 panel 之上
  ref.focus()
  await sleep(400)
  say(`[3] ref-refocused panelAboveRef=${isAbove(panelH, refH)} fgIsRef=${fg() === refH}`)

  // 4. 完整方案A演练：顶起+focus，focus 处理器里立即重钉
  panel.on('focus', () => { say(`[4] focus-handler repin ret=${pinBottom(panelH)} panelAboveRef(immediate)=${isAbove(panelH, refH)}`) })
  raiseTop(panelH)
  panel.focus()
  await sleep(400)
  say(`[4] plan-A settled panelAboveRef=${isAbove(panelH, refH)} fgIsPanel=${fg() === panelH}`)

  panel.destroy()
  ref.destroy()
  dump(0)
}

app.whenReady().then(main).catch((e) => { say('FAILED ' + (e && e.stack || e)); dump(1) })
